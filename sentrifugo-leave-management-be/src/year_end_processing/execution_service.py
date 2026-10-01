import uuid
from datetime import datetime, timezone
from typing import List, Optional, Tuple

from motor.motor_asyncio import AsyncIOMotorDatabase

from src.audit import emit_audit
from src.balance_tracker import upsert_balance as tracker_upsert_balance
from src.logger import logger
from src.utils import to_oid
from src.year_end_processing.calculation_service import calculate
from src.year_end_processing.schemas import (
    ExecutionStatus,
    NegativeBalanceRule,
    PayoutCarryConfig,
    ProcessingType,
)

EXECUTION_COLLECTION = "leave_year_end_execution"
LEDGER_COLLECTION = "leave_entitlement_ledger"
PLAN_TYPE_MAPPING_COLLECTION = "leave_plan_type_mapping"
EMPLOYEE_PLAN_COLLECTION = "employee_leave_plans"
PAYROLL_EVENTS_COLLECTION = "payroll_events"

SYSTEM_USER_ID = "system"
BATCH_SIZE = 500


async def _get_leave_type_ids_for_plan(db: AsyncIOMotorDatabase, leave_plan_id: str) -> List[str]:
    docs = await db[PLAN_TYPE_MAPPING_COLLECTION].find(
        {"leave_plan_id": to_oid(leave_plan_id)},
        {"leave_type_id": 1},
    ).to_list(length=None)
    ids = {str(d["leave_type_id"]) for d in docs}
    # Plans created before the mapping collection store their types embedded on the
    # plan doc — union them in so year-end doesn't silently skip those plans.
    plan = await db["leave_plans"].find_one(
        {"_id": to_oid(leave_plan_id)}, {"leave_type_ids": 1}
    )
    ids.update(str(x) for x in (plan or {}).get("leave_type_ids", []))
    return list(ids)


async def _get_carry_forward_map(
    db: AsyncIOMotorDatabase, leave_plan_id: str
) -> dict:
    """
    Per-leave-type carry-forward flags from the plan's entitlement config.

    The flag (set per leave type in the Entitlement step) gates WHICH types may
    carry forward; the Year-End config still decides HOW MUCH. Only leave types
    that explicitly carry the flag are included — legacy plans whose posting
    cycles predate the flag return an empty map and keep the old behaviour
    (carry forward governed solely by the Year-End config).
    """
    result: dict = {}

    # 1) Legacy fallback: plan entitlement posting cycles.
    ent = await db["leave_entitlement_configurations"].find_one(
        {"leave_plan_id": to_oid(leave_plan_id), "deleted_on": None}
    )
    if ent:
        cycles = (
            ((ent.get("entitlement") or {}).get("distribution") or {}).get("posting_cycles")
        ) or []
        for c in cycles:
            lt = c.get("leave_type_id")
            if lt is not None and "carry_forward" in c:
                result[str(lt)] = bool(c.get("carry_forward"))

    # 2) The leave type now owns its carry-forward flag — it takes precedence.
    lt_ids = await _get_leave_type_ids_for_plan(db, leave_plan_id)
    if lt_ids:
        docs = await db["leave_types"].find(
            {"_id": {"$in": [to_oid(x) for x in lt_ids]}},
            {"_id": 1, "accrual": 1},
        ).to_list(length=None)
        for d in docs:
            acc = d.get("accrual") or {}
            if "carry_forward" in acc:
                result[str(d["_id"])] = bool(acc.get("carry_forward"))

    return result


async def _get_carry_cap_map(
    db: AsyncIOMotorDatabase, leave_plan_id: str
) -> dict:
    """
    Per-leave-type carry cap + encashment, from the leave type's accrual config.

    ``carry_forward_count`` caps HOW MUCH may carry forward (the Year-End config
    decides the gross carry; this trims it). ``encashable`` decides where the
    trimmed overflow goes — paid out when the type is encashable, expired
    otherwise. Only leave types that carry an accrual sub-document are included;
    legacy types are absent and keep the old behaviour (no cap).
    """
    result: dict = {}
    lt_ids = await _get_leave_type_ids_for_plan(db, leave_plan_id)
    if not lt_ids:
        return result
    docs = await db["leave_types"].find(
        {"_id": {"$in": [to_oid(x) for x in lt_ids]}},
        {"_id": 1, "accrual": 1},
    ).to_list(length=None)
    for d in docs:
        acc = d.get("accrual")
        if not acc:
            continue
        result[str(d["_id"])] = {
            "count": acc.get("carry_forward_count"),
            "encashable": bool(acc.get("encashable")),
            "encash_percentage": acc.get("encash_percentage"),
        }
    return result


async def _compute_balance_for_employee(
    db: AsyncIOMotorDatabase, employee_user_id: str, leave_type_ids: List[str]
) -> Tuple[float, dict]:
    """Returns (total_available, {leave_type_id_str: available_balance_hours}).

    Reads the SOURCE-OF-TRUTH balance tracker (keyed by user_id, fed by BOTH accrual
    and approval) rather than aggregating the mixed-key entitlement ledger — so used
    leave and admin credits are correctly reflected. The disposal base is the
    AVAILABLE balance (clamped tracker minus active holds): pending-hold hours stay
    reserved for the in-flight request and are not carried/expired away.
    """
    if not leave_type_ids:
        return 0.0, {}

    from src.leave_holds.service import get_active_hold_hours

    lt_oids = [to_oid(x) for x in leave_type_ids]
    rows = await db["leave_employee_balance_tracker"].find(
        {"user_id": to_oid(employee_user_id), "leave_type_id": {"$in": lt_oids}}
    ).to_list(length=None)
    raw_by = {str(r["leave_type_id"]): float(r.get("balance_hours") or 0.0) for r in rows}

    per_type: dict = {}
    for lt in leave_type_ids:
        lt_str = str(lt)
        raw = raw_by.get(lt_str, 0.0)
        held = await get_active_hold_hours(db, employee_user_id, lt_str)
        # Do NOT pre-clamp raw to 0: a genuine over-drawn (raw < 0) balance must
        # stay negative so negative-balance recovery actually fires. For the normal
        # raw >= 0 case this is identical to the old max(raw,0) - held. (Over-reserve
        # guards keep held <= raw in practice, so this rarely goes negative.)
        per_type[lt_str] = raw - held

    total = sum(per_type.values())
    return total, per_type


async def _create_ledger_entry(
    db: AsyncIOMotorDatabase,
    employee_id: str,
    leave_type_id: str,
    transaction_type: str,
    amount: float,
    year: int,
    leave_plan_id: str,
    dry_run: bool,
) -> None:
    if amount <= 0 or dry_run:
        return
    doc = {
        "_id": str(uuid.uuid4()),
        "employee_id": to_oid(employee_id),
        "leave_type_id": leave_type_id,
        "transaction_type": transaction_type,
        "amount": amount,
        "reference_id": None,
        "note": f"Year-end processing {year} for leave plan {leave_plan_id}",
        "created_on": datetime.now(timezone.utc),
        "created_by": SYSTEM_USER_ID,
        "metadata": {"year": year, "leave_plan_id": leave_plan_id},
    }
    await db[LEDGER_COLLECTION].insert_one(doc)


async def _create_payroll_event(
    db: AsyncIOMotorDatabase,
    employee_id: str,
    leave_plan_id: str,
    year: int,
    amount: float,
    dry_run: bool,
) -> None:
    if dry_run:
        return
    doc = {
        "_id": str(uuid.uuid4()),
        "employee_id": employee_id,
        "leave_plan_id": leave_plan_id,
        "event_type": "LEAVE_NEGATIVE_BALANCE_RECOVERY",
        "amount": abs(amount),
        "year": year,
        "created_on": datetime.now(timezone.utc),
        "created_by": SYSTEM_USER_ID,
    }
    await db[PAYROLL_EVENTS_COLLECTION].insert_one(doc)


async def process_single_employee(
    db: AsyncIOMotorDatabase,
    leave_plan_id: str,
    employee_id: str,
    year: int,
    processing_type: ProcessingType,
    payout_carry_config: Optional[PayoutCarryConfig],
    negative_balance_rule: NegativeBalanceRule,
    leave_type_ids: List[str],
    dry_run: bool,
    user_id: str,
    carry_forward_map: Optional[dict] = None,
    carry_cap_map: Optional[dict] = None,
    employee_user_id: Optional[str] = None,
) -> dict:
    """Process year-end for a single employee. Returns the execution record dict.

    ``user_id`` is the ACTOR (who ran year-end); ``employee_user_id`` is the
    employee's own user_id, the key the balance tracker is stored under.
    """
    logs: List[str] = []

    # The balance lives on the tracker keyed by the employee's user_id. Resolve it
    # from the employee record when the caller didn't supply it.
    if not employee_user_id:
        _emp = await db["employees"].find_one({"_id": to_oid(employee_id)}, {"user_id": 1})
        employee_user_id = str(_emp["user_id"]) if _emp and _emp.get("user_id") else None

    # Idempotency check
    existing = await db[EXECUTION_COLLECTION].find_one(
        {
            "leave_plan_id": to_oid(leave_plan_id),
            "employee_id": to_oid(employee_id),
            "year": year,
        }
    )
    if existing:
        logs.append(f"Already processed for year {year}; skipping")
        return existing

    total_balance, per_type_balance = await _compute_balance_for_employee(
        db, employee_user_id or employee_id, leave_type_ids
    )

    total_payout = 0.0
    total_carry = 0.0
    total_expired = 0.0
    total_encashed = 0.0
    total_negative_recovered = 0.0
    # Per-type breakdown consumed by leave analytics and stored on the execution
    # record. MUST be initialized here: the positive-balance branch below and the
    # negative/zero branches all add to it, and it is returned unconditionally —
    # without this init, process_single_employee raises NameError for every
    # employee and run_year_end_execution silently counts them all as failed.
    per_type_details: dict = {}

    # NOTE (known limitation): branch selection uses the AGGREGATE total across all
    # leave types. If one type were negative and another positive, the whole employee
    # would take the negative path and the positive type would bypass carry-cap /
    # encashment. This is only reachable when a leave type can hold a NEGATIVE balance,
    # which requires negative_balance.allow_negative_balance = true — a setting that is
    # OFF by default and not used. If negative balances are ever enabled, switch this
    # to a PER-leave-type sign decision (each type carried/capped/recovered on its own).
    if total_balance < 0:
        logs.append(f"Negative balance detected: {total_balance}")
        negative_recovered = abs(total_balance)

        leave_type_details = []
        for lt_id, bal in per_type_balance.items():
            lt_id_str = str(lt_id) if not isinstance(lt_id, str) else lt_id
            if bal < 0 and negative_balance_rule != NegativeBalanceRule.CARRY_FORWARD_DEFICIT:
                closing = 0.0
            else:
                closing = bal
            leave_type_details.append({
                "leave_type_id": lt_id_str,
                "opening_balance": bal,
                "payout_amount": 0.0,
                "encashed_amount": 0.0,
                "carry_forward_amount": max(closing, 0.0),
                "expired_amount": 0.0,
                "closing_balance": closing,
            })

        if negative_balance_rule == NegativeBalanceRule.RESET_TO_ZERO:
            logs.append("RESET_TO_ZERO: adjusting negative balance to 0")
            for lt_id, bal in per_type_balance.items():
                if bal < 0:
                    await _create_ledger_entry(
                        db, employee_id, lt_id,
                        "YEAR_END_NEGATIVE_RECOVERY", abs(bal), year, leave_plan_id, dry_run
                    )
                per_type_details[lt_id] = {
                    "opening_balance": bal, "payout": 0.0, "carry_forward": 0.0,
                    "expired": 0.0, "closing_balance": 0.0,
                }
            total_negative_recovered = negative_recovered

        elif negative_balance_rule == NegativeBalanceRule.DEDUCT_FROM_PAYROLL:
            logs.append("DEDUCT_FROM_PAYROLL: creating payroll recovery event")
            await _create_payroll_event(db, employee_id, leave_plan_id, year, total_balance, dry_run)
            for lt_id, bal in per_type_balance.items():
                if bal < 0:
                    await _create_ledger_entry(
                        db, employee_id, lt_id,
                        "YEAR_END_NEGATIVE_RECOVERY", abs(bal), year, leave_plan_id, dry_run
                    )
                per_type_details[lt_id] = {
                    "opening_balance": bal, "payout": 0.0, "carry_forward": 0.0,
                    "expired": 0.0, "closing_balance": 0.0,
                }
            total_negative_recovered = negative_recovered

        else:
            logs.append("CARRY_FORWARD_DEFICIT: negative balance carried to next cycle")
            for lt_id, bal in per_type_balance.items():
                per_type_details[lt_id] = {
                    "opening_balance": bal, "payout": 0.0, "carry_forward": 0.0,
                    "expired": 0.0, "closing_balance": bal,
                }

        closing_balance = 0.0 if negative_balance_rule != NegativeBalanceRule.CARRY_FORWARD_DEFICIT else total_balance

    else:
        leave_type_details = []
        for lt_id, bal in per_type_balance.items():
            lt_id_str = str(lt_id) if not isinstance(lt_id, str) else lt_id
            if bal <= 0:
                per_type_details[lt_id] = {
                    "opening_balance": bal, "payout": 0.0, "carry_forward": 0.0,
                    "expired": 0.0, "closing_balance": bal,
                }
                leave_type_details.append({
                    "leave_type_id": lt_id_str,
                    "opening_balance": bal,
                    "payout_amount": 0.0,
                    "encashed_amount": 0.0,
                    "carry_forward_amount": 0.0,
                    "expired_amount": 0.0,
                    "closing_balance": 0.0,
                })
                continue
            payout = carry = expired = encashed = 0.0
            cap_cfg = (carry_cap_map or {}).get(lt_id_str)

            if cap_cfg is not None:
                # ── Leave-type-driven year-end ───────────────────────────────
                # Year-end behaviour is defined entirely on the leave type — no
                # plan-level processing mode. For each type, on the employee's
                # remaining balance (= credited − used):
                #   1. carry  = min(balance, carry_forward_count) when carry-forward
                #      is enabled, else 0.
                #   2. leftover = balance − carry.
                #   3. encashed = leftover × encash_percentage% when encashable;
                #      the rest of the leftover is reset/expired. Non-encashable →
                #      the whole leftover expires.
                carries = bool((carry_forward_map or {}).get(lt_id_str, False))
                cap = cap_cfg.get("count")
                encashable = bool(cap_cfg.get("encashable"))
                pct = cap_cfg.get("encash_percentage")

                if carries:
                    # carry_forward_count is configured in DAYS; the balance is in
                    # HOURS, so convert the cap to hours before comparing (CF2).
                    limit = (cap * 8.0) if cap is not None else bal
                    carry = min(bal, limit)
                leftover = bal - carry
                if encashable and pct:
                    encashed = leftover * (float(pct) / 100.0)
                    expired = leftover - encashed
                else:
                    expired = leftover

                logs.append(
                    f"[{lt_id}] per-type year-end: balance={bal}, carry={carry}, "
                    f"encashed={encashed} ({pct or 0}%), reset={expired}"
                    + (f" (carry cap {cap})" if cap is not None else "")
                )
            else:
                # ── Legacy fallback: plan Year-End config drives the split ────
                payout, carry, expired, calc_logs = calculate(
                    processing_type, bal, payout_carry_config
                )
                logs.extend([f"[{lt_id}] {log}" for log in calc_logs])

                # Honour the per-type carry-forward gate even on legacy plans.
                if (
                    carry_forward_map is not None
                    and not carry_forward_map.get(lt_id_str, True)
                    and carry > 0
                ):
                    logs.append(
                        f"[{lt_id}] carry-forward disabled for this leave type; {carry} expired instead"
                    )
                    expired += carry
                    carry = 0.0

            leave_type_details.append({
                "leave_type_id": lt_id_str,
                "opening_balance": bal,
                "payout_amount": payout,
                "encashed_amount": encashed,
                "carry_forward_amount": carry,
                "expired_amount": expired,
                "closing_balance": carry,
            })
            # Mirror into per_type_details for analytics. In per-type year-end the
            # cash paid out is the encashed amount (the legacy plan-config path uses
            # `payout`); surface both so the "paid out" figure is never dropped.
            per_type_details[lt_id_str] = {
                "opening_balance": bal,
                "payout": payout + encashed,
                "carry_forward": carry,
                "expired": expired,
                "closing_balance": carry,
            }

            await _create_ledger_entry(
                db, employee_id, lt_id, "YEAR_END_PAYOUT", payout, year, leave_plan_id, dry_run
            )
            await _create_ledger_entry(
                db, employee_id, lt_id, "YEAR_END_ENCASH", encashed, year, leave_plan_id, dry_run
            )
            await _create_ledger_entry(
                db, employee_id, lt_id, "YEAR_END_EXPIRY", expired, year, leave_plan_id, dry_run
            )

            # Enforce on the real balance: remove the non-carried portion (payout +
            # encash + expire == balance − carry) from the tracker, so only the
            # carried amount remains spendable in the new year. (CF1)
            removed = payout + encashed + expired
            if removed > 0 and not dry_run and employee_user_id:
                await tracker_upsert_balance(
                    db, employee_user_id, lt_id_str, leave_plan_id, -removed, SYSTEM_USER_ID
                )

            total_payout += payout
            total_encashed += encashed
            total_carry += carry
            total_expired += expired

        closing_balance = total_carry

    processed_at = datetime.now(timezone.utc)
    execution_doc = {
        "_id": str(uuid.uuid4()),
        "leave_plan_id": to_oid(leave_plan_id),
        "year": year,
        "employee_id": to_oid(employee_id),
        "opening_balance": total_balance,
        "payout_amount": total_payout,
        "encashed_amount": total_encashed,
        "carry_forward_amount": total_carry,
        "expired_amount": total_expired,
        "negative_recovered_amount": total_negative_recovered,
        "closing_balance": closing_balance,
        "per_type_details": per_type_details,
        "leave_type_details": leave_type_details,
        "execution_status": ExecutionStatus.SUCCESS,
        "execution_logs": logs,
        "processed_at": processed_at,
        "created_on": processed_at,
        "created_by": to_oid(user_id) if user_id != SYSTEM_USER_ID else None,
        "updated_on": None,
        "updated_by": None,
        "deleted_on": None,
        "deleted_by": None,
    }

    if not dry_run:
        await db[EXECUTION_COLLECTION].insert_one(execution_doc)
        logger.info(
            "Year-end execution record created",
            employee_id=employee_id,
            leave_plan_id=leave_plan_id,
            year=year,
        )

    return execution_doc


async def _get_employee_ids_for_plan(db: AsyncIOMotorDatabase, leave_plan_id: str) -> List[str]:
    """Resolve employees assigned to a plan via department_ids on the plan document."""
    plan = await db["leave_plans"].find_one(
        {"_id": to_oid(leave_plan_id), "deleted_on": None},
        {"department_ids": 1},
    )
    if not plan:
        return []

    dept_ids = list(plan.get("department_ids") or [])
    if not dept_ids:
        return []

    emp_docs = await db["employees"].find(
        {"department_id": {"$in": dept_ids}, "is_deleted": {"$ne": True}},
        {"_id": 1},
    ).to_list(length=None)

    return [str(doc["_id"]) for doc in emp_docs]


async def run_year_end_execution(
    db: AsyncIOMotorDatabase,
    leave_plan_id: str,
    year: int,
    processing_type: ProcessingType,
    payout_carry_config: Optional[PayoutCarryConfig],
    negative_balance_rule: NegativeBalanceRule,
    dry_run: bool,
    user_id: str,
) -> dict:
    """Batch-process year-end for all employees on the leave plan."""
    leave_type_ids = await _get_leave_type_ids_for_plan(db, leave_plan_id)
    carry_forward_map = await _get_carry_forward_map(db, leave_plan_id)
    carry_cap_map = await _get_carry_cap_map(db, leave_plan_id)

    total_processed = 0
    total_success = 0
    total_failed = 0

    # employee_leave_plans is populated externally (IAM) and may be empty/ambiguous,
    # so iterate the REAL employees on the plan via the same scope filter accrual
    # uses — that yields each employee's _id AND user_id (the balance-tracker key).
    from src.employment_status import get_inactive_status_ids
    from src.leave_balance_processor.processor import _build_employee_filter
    _plan_doc = await db["leave_plans"].find_one({"_id": to_oid(leave_plan_id)}, {"org_id": 1})
    _plan_org_id = str(_plan_doc["org_id"]) if _plan_doc and _plan_doc.get("org_id") else None
    emp_filter = await _build_employee_filter(db, leave_plan_id, _plan_org_id) if _plan_org_id else None

    # Exited/inactive employees must not be year-end processed (no payout/ledger
    # events for staff who have left). Resolve the inactive status ids once.
    inactive_status_ids = await get_inactive_status_ids(db)
    # Normalize to strings: get_inactive_status_ids returns ObjectIds, but an
    # employee's employment_status may be stored as a str (legacy) or ObjectId —
    # a raw ``in`` comparison would silently fail to skip a string-typed status.
    inactive_status_strs = {str(x) for x in inactive_status_ids}

    skip = 0
    while emp_filter is not None:
        employee_docs = await db["employees"].find(
            emp_filter, {"_id": 1, "user_id": 1, "employment_status": 1}
        ).skip(skip).limit(BATCH_SIZE).to_list(length=None)

        if not employee_docs:
            break

        for emp_doc in employee_docs:
            employee_id = str(emp_doc["_id"])
            employee_user_id = str(emp_doc["user_id"]) if emp_doc.get("user_id") else None
            if str(emp_doc.get("employment_status")) in inactive_status_strs:
                logger.info(
                    "Skipping year-end for inactive/exited employee",
                    employee_id=employee_id,
                    leave_plan_id=leave_plan_id,
                    year=year,
                )
                continue
            try:
                await process_single_employee(
                    db=db,
                    leave_plan_id=leave_plan_id,
                    employee_id=employee_id,
                    year=year,
                    processing_type=processing_type,
                    payout_carry_config=payout_carry_config,
                    negative_balance_rule=negative_balance_rule,
                    leave_type_ids=leave_type_ids,
                    dry_run=dry_run,
                    user_id=user_id,
                    carry_forward_map=carry_forward_map,
                    carry_cap_map=carry_cap_map,
                    employee_user_id=employee_user_id,
                )
                total_success += 1
            except Exception as exc:
                logger.error(
                    "Year-end processing failed for employee",
                    employee_id=employee_id,
                    leave_plan_id=leave_plan_id,
                    year=year,
                    error=str(exc),
                )
                total_failed += 1
            total_processed += 1

        skip += BATCH_SIZE

    logger.info(
        "Year-end batch execution complete",
        leave_plan_id=leave_plan_id,
        year=year,
        total_processed=total_processed,
        total_success=total_success,
        total_failed=total_failed,
        dry_run=dry_run,
    )

    _plan = await db["leave_plans"].find_one({"_id": to_oid(leave_plan_id)}, {"org_id": 1})
    _org_id = str(_plan["org_id"]) if _plan and _plan.get("org_id") else None
    await emit_audit(
        action="year_end.executed",
        resource=f"year_end:{leave_plan_id}:{year}",
        actor_id="system",
        organisation_id=_org_id,
        details={
            "total_processed": total_processed,
            "total_success": total_success,
            "total_failed": total_failed,
        },
    )

    return {
        "total_processed": total_processed,
        "total_success": total_success,
        "total_failed": total_failed,
        "dry_run": dry_run,
        "year": year,
    }
