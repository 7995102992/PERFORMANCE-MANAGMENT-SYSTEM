"""Reconcile every category's roster with its departments. Idempotent.

Not a one-shot migration: it runs against every category, rostered or not, and
converges each one on the same rule the category form now follows — the roster
lists every employee of the category's departments, department heads as
PRIMARY, everyone else SECONDARY. Run it as often as you like; it writes only
where the stored roster differs from that, so a second run reports `in_sync`
and touches nothing.

Reads IAM's MongoDB directly rather than its REST API. IAM authenticates users,
not services, so the API route needs a real person's JWT — pointless ceremony
for a maintenance run from a host that already has the database. The cost is
that this script is coupled to IAM's schema; if that changes, this breaks
rather than degrading.

Two things are written per category:

  1. `department_ids` — filled from the deprecated scalar when missing, so an
     old category carries the same shape a newly-created one does.
  2. `executors` — the reconciled roster, with the display snapshot the read
     path depends on, refreshed from IAM on every run.

WHAT IT OVERRIDES
    Someone deliberately left off a roster is added back: the model is "the
    department staffs the category", so an absent member reads as stale data
    rather than as a decision, and nothing in the stored document tells the two
    apart. An existing PRIMARY is never demoted, though — an admin who promoted
    someone outranks this script. A category meant to be narrower than its
    departments is what `roster_is_exclusive` plus a hand-built roster is for;
    do not point this at one.

WHERE THE DATA COMES FROM
    Three IAM collections, joined in memory:
      departments  _id, department_name, department_code, department_head
      employees    _id, user_id, emp_code, department_id, date_of_exit
      users        _id, email, first_name, last_name, status
    `employees` carries neither name nor email — both live on `users`, reached
    via `employee.user_id`. That same `user_id` is what SRM stores as an
    executor, so an employee record with no linked user cannot be one and is
    skipped.

    WARNING: SRM's own replica collections are *also* named `employees` and
    `departments`. Only the database name separates them, so --iam-db is
    required and a value matching SRM's own database is refused.

THE HEADS ARE WRITTEN, AS PRIMARY
    The roster is the whole truth: what the category form shows is what is
    stored, with nobody added implicitly and nobody filtered out. So a seeded
    category has to name its head the same way an admin would — an explicit
    PRIMARY row — or the head is simply absent from a list that claims to be
    complete, and every count drawn from it is short by one.

    This reverses an earlier default. Heads used to be skipped because the form
    stripped `is_department_head` rows on load, so seeded head rows were
    silently deleted by the first admin who saved the category. The form no
    longer filters, so that objection is gone. `--skip-heads` remains for a run
    that deliberately wants secondaries only.

    Note the backend still treats a head as an implicit primary
    (`resolve_primaries` unions them in, `_is_category_primary` falls back to
    the head check). Writing the row therefore grants no new authority — it
    makes the stored roster agree with the one on screen.

WHAT SEEDING ACTUALLY CHANGES
    A non-empty roster flips the category out of legacy mode. The executor pool
    is unaffected while `roster_is_exclusive` stays false (department members
    remain eligible via `_is_category_workforce`), and escalation targets are
    unchanged (`resolve_primaries` returns the heads either way). The one real
    change is the management tier: assign / reassign / escalate narrow from
    "manager ACL ∩ department" to the primaries, i.e. the heads. That applies
    to tickets that are already open, because authority is resolved live
    against the category on every read.

    This script never sets `roster_is_exclusive`. Leaving it false is what keeps
    the executor pool open to new joiners.

REVERSIBLE
    `$set executors: []` puts a category back into legacy mode exactly — the
    whole feature keys off whether the roster is empty. Phase 1 is not undone by
    that, and does not need to be.

PREREQUISITE
    The picker union in `list_eligible_executors` (a rostered non-exclusive
    category must still offer live department members). Without it, seeding
    makes every future new joiner invisible in the assign dropdown until an
    admin re-saves the category.

Usage (from repo root, with the SRM .env in place — nothing else to configure:
the IAM database defaults to `sentrifugo_iam` on the same cluster):

    python scripts/seed_category_rosters.py                    # dry run, writes nothing
    python scripts/seed_category_rosters.py --apply            # writes
    python scripts/seed_category_rosters.py --org <id> --apply # one organisation

    # Re-running is the normal case — it reconciles, so an already-correct
    # category reports `in_sync` and is not written. `--reset` exists only to
    # wipe the slate for a genuinely fresh start; the reconcile above does not
    # need it.
    python scripts/seed_category_rosters.py --reset
    python scripts/seed_category_rosters.py --reset --apply

    # only if this deployment differs from the norm
    python scripts/seed_category_rosters.py --iam-db <db> --iam-uri "mongodb://..."

Reporting is the default action; `--apply` is the only thing that writes.
Exits 1 if any category was skipped, 2 on a configuration refusal.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from bson import ObjectId  # noqa: E402
from motor.motor_asyncio import AsyncIOMotorClient  # noqa: E402

from src.categories.schemas import MAX_EXECUTORS  # noqa: E402
from src.categories.service import category_department_ids  # noqa: E402
from src.common.timestamps import utcnow  # noqa: E402
from src.config import settings  # noqa: E402
from src.database import close_db, init_db  # noqa: E402
from src.models import Category, CategoryExecutor, ExecutorRoleEnum  # noqa: E402

# IAM's database on every deployment so far (Sentrifugo-DevOps/environments/
# iam.env). It sits on the same cluster as SRM, so the connection URI from this
# service's own .env reaches it — only the database name differs.
IAM_DB_DEFAULT = "sentrifugo_iam"

# UserDocument.status — anything else counts as not employable.
_ACTIVE_USER_STATUS = {"active"}


async def _load_iam(
    iam_db, department_ids: list[ObjectId]
) -> tuple[dict[str, dict], dict[str, list[dict]], dict[str, dict]]:
    """Departments, their staff, and any head the staff sweep misses.

    Returns ({department_id: department}, {department_id: [member, ...]},
    {head_user_id: member}) where each member already carries the joined
    name/email off `users`.

    The third value exists because `Department.department_head` points into
    `users` and is never checked against `Employee.department_id`: a head whose
    own employee record sits in another department — or who heads two
    departments and can only belong to one — never comes back from the sweep
    below. They would then be absent from the roster this script writes, and a
    category whose only natural primary is that person would be seeded with
    secondaries only.
    """
    depts = {
        str(d["_id"]): d
        async for d in iam_db["departments"].find({"_id": {"$in": department_ids}})
    }

    employees = [
        e
        async for e in iam_db["employees"].find(
            {"department_id": {"$in": department_ids}}
        )
    ]

    user_ids = [e["user_id"] for e in employees if e.get("user_id")]
    users = {
        str(u["_id"]): u
        async for u in iam_db["users"].find({"_id": {"$in": user_ids}})
    }

    members: dict[str, list[dict]] = defaultdict(list)
    for emp in employees:
        uid = emp.get("user_id")
        if not uid:
            # No login account — SRM stores executors by user id, so this
            # person cannot be one.
            continue
        user = users.get(str(uid))
        if user is None:
            continue
        members[str(emp["department_id"])].append({**emp, "_user": user})

    # Heads the sweep above did not return, fetched by user id instead of by
    # department. A head with no employee record at all still yields a row —
    # `department_head` is a `users` reference, so the login account is the
    # only thing SRM actually needs; emp code and employee id degrade to blank
    # exactly as they do for an executor with no address.
    head_ids = {
        str(d["department_head"]) for d in depts.values() if d.get("department_head")
    }
    already = {str(m["user_id"]) for ms in members.values() for m in ms}
    wanted = [ObjectId(h) for h in head_ids - already if ObjectId.is_valid(h)]
    head_members: dict[str, dict] = {}
    if wanted:
        head_users = {
            str(u["_id"]): u
            async for u in iam_db["users"].find({"_id": {"$in": wanted}})
        }
        head_emps = {
            str(e["user_id"]): e
            async for e in iam_db["employees"].find({"user_id": {"$in": wanted}})
        }
        for uid, user in head_users.items():
            emp = head_emps.get(uid, {})
            head_members[uid] = {
                "_id": emp.get("_id"),
                "user_id": emp.get("user_id") or ObjectId(uid),
                "emp_code": emp.get("emp_code") or "",
                "date_of_exit": emp.get("date_of_exit"),
                "_user": user,
            }
    return depts, members, head_members


def _is_employable(member: dict) -> bool:
    """Active login and no recorded exit date.

    `employment_status` is an ObjectId into IAM master data, so interpreting it
    would mean another join for a value this migration does not need — the exit
    date and the account status answer the same question directly.
    """
    if member.get("date_of_exit"):
        return False
    status = str(member["_user"].get("status") or "").strip().lower()
    return status in _ACTIVE_USER_STATUS


def _row(member: dict, dept: dict, is_head: bool) -> CategoryExecutor:
    user = member["_user"]
    name = " ".join(
        p for p in (user.get("first_name"), user.get("last_name")) if p
    ).strip()
    return CategoryExecutor(
        user_id=member["user_id"],
        role=ExecutorRoleEnum.PRIMARY if is_head else ExecutorRoleEnum.SECONDARY,
        # None for a head with no employee record — it is a display label, and
        # `str(None)` would write the literal "None" into the snapshot.
        employee_id=str(member["_id"]) if member.get("_id") else None,
        emp_code=str(member.get("emp_code") or ""),
        name=name,
        email=str(user.get("email") or ""),
        department_id=dept["_id"],
        department_code=str(dept.get("department_code") or ""),
        department_name=str(dept.get("department_name") or ""),
    )


def _reconcile_one(
    cat: Category,
    depts: dict[str, dict],
    members: dict[str, list[dict]],
    head_members: dict[str, dict],
    include_heads: bool,
) -> tuple[str, dict | None, str]:
    """Bring one category's roster in line with its departments. Idempotent.

    Runs against every category, rostered or not, and writes only when the
    result differs from what is stored — so a second run reports `in_sync` and
    touches nothing.

    THE RULES, and why each one is what it is:

      * Every active employee of the category's departments belongs on the
        roster. Missing ones are added as SECONDARY.
      * Every department head is PRIMARY. A head stored as secondary is
        promoted; a head absent entirely is added.
      * An existing PRIMARY is never demoted. An admin who promoted someone
        deliberately outranks this script: the rule is "heads are primaries",
        not "only heads are primaries".
      * Rows for people who have left the category's departments, or left the
        company, are dropped. Not tidiness — the form submits every stored row
        back on save and `_resolve_executors` answers a row that is neither
        member nor head with a 400, so a stale row makes the category
        unsaveable through the UI.
      * Display fields (name, email, emp code, department labels) are refreshed
        from IAM every run, so a rename or a transfer stops showing the old
        value.

    WHAT THIS OVERRIDES: someone deliberately left off a roster gets added
    back. The model is "the department staffs the category", so an absent
    member reads as stale data rather than as a decision, and nothing in the
    stored document tells the two apart. A category meant to be narrower than
    its departments is what `roster_is_exclusive` plus a hand-built roster is
    for, and this script should not be pointed at it.
    """
    dept_ids = category_department_ids(cat)
    if not dept_ids:
        return ("orphan", None, "no department on the category")

    missing = [str(d) for d in dept_ids if str(d) not in depts]
    if missing:
        return ("unknown_dept", None, "department not in IAM: " + ", ".join(missing))

    head_ids = {
        str(depts[str(d)].get("department_head"))
        for d in dept_ids
        if depts[str(d)].get("department_head")
    }
    stored = {str(e.user_id): e for e in (cat.executors or [])}

    rows: list[CategoryExecutor] = []
    seen: set[str] = set()
    added = promoted = refreshed = 0
    skipped_inactive = 0
    missing_email = 0

    def _take(member: dict, dept: dict, uid: str, is_head: bool) -> None:
        nonlocal added, promoted, refreshed, missing_email
        was = stored.get(uid)
        # Keep a primary a primary: heads are primaries, and so is anyone an
        # admin promoted. Only a head is promoted *up* by this script.
        role = (
            ExecutorRoleEnum.PRIMARY
            if is_head or (was is not None and was.role == ExecutorRoleEnum.PRIMARY)
            else ExecutorRoleEnum.SECONDARY
        )
        row = _row(member, dept, role == ExecutorRoleEnum.PRIMARY)
        if was is None:
            added += 1
        elif was.role != role:
            promoted += 1
        elif was.model_dump() != row.model_dump():
            refreshed += 1
        if not row.email:
            missing_email += 1
        seen.add(uid)
        rows.append(row)

    for did in [str(d) for d in dept_ids]:
        dept = depts[did]
        for member in members.get(did, []):
            uid = str(member["user_id"])
            # Someone in two of the category's departments is one executor;
            # the first department wins, which only affects their label.
            if uid in seen:
                continue
            if not _is_employable(member):
                skipped_inactive += 1
                continue
            is_head = uid in head_ids
            if is_head and not include_heads:
                seen.add(uid)
                continue
            _take(member, dept, uid, is_head)

    # Heads the employee sweep could not see (see `_load_iam`), pinned to the
    # department they run rather than the one their employee record names.
    if include_heads:
        for did in [str(d) for d in dept_ids]:
            head_id = str(depts[did].get("department_head") or "")
            if not head_id or head_id in seen:
                continue
            member = head_members.get(head_id)
            if member is None or not _is_employable(member):
                continue
            _take(member, depts[did], head_id, True)

    dropped = [uid for uid in stored if uid not in seen]

    if not rows:
        return ("empty", None, "no eligible employees in these departments")
    if len(rows) > MAX_EXECUTORS:
        # Writing past the cap straight into Mongo bypasses the validator and
        # leaves a category the UI can never save again — every update would
        # fail `_validate_executors`. Skip loudly instead.
        return (
            "over_cap",
            None,
            "%d members exceeds MAX_EXECUTORS=%d" % (len(rows), MAX_EXECUTORS),
        )
    if not any(r.role == ExecutorRoleEnum.PRIMARY for r in rows):
        # Same trap as the cap above, reached a different way: `_validate_executors`
        # rejects a non-empty roster with no primary, and this script writes
        # straight to Mongo where nothing checks. Writing one would brick the
        # category — every UI edit afterwards, even a description typo, would
        # 422 with no way to fix it through the app.
        #
        # Reached when none of the category's departments has a `department_head`
        # in IAM (or with --skip-heads). Leaving the category as it stands is the
        # right outcome: whatever it has today keeps working.
        return (
            "no_primary",
            None,
            "no department head in IAM for these departments — left alone",
        )

    new_rows = [r.model_dump() for r in rows]
    old_rows = [e.model_dump() for e in (cat.executors or [])]
    needs_departments = not cat.department_ids
    if new_rows == old_rows and not needs_departments:
        return ("in_sync", None, "%d executor(s) already correct" % len(rows))

    update: dict = {"executors": new_rows, "modified_on": utcnow()}
    # Give an un-migrated category the same department shape a new one gets,
    # scalar mirror included.
    if needs_departments:
        update["department_ids"] = list(dept_ids)
        update["department_id"] = dept_ids[0]

    primaries = sum(1 for r in rows if r.role == ExecutorRoleEnum.PRIMARY)
    bits = ["%d executor(s), %d primary" % (len(rows), primaries)]
    if added:
        bits.append("+%d added" % added)
    if promoted:
        bits.append("%d role changed" % promoted)
    if dropped:
        bits.append("-%d no longer in these departments" % len(dropped))
    if refreshed:
        bits.append("%d snapshot refreshed" % refreshed)
    if skipped_inactive:
        bits.append("%d inactive/exited skipped" % skipped_inactive)
    if missing_email:
        bits.append("%d without an email" % missing_email)
    if needs_departments:
        bits.append("+ department_ids")
    return ("update", update, ", ".join(bits))


async def main(
    org_id: str | None,
    iam_db_name: str,
    iam_uri: str | None,
    apply: bool,
    include_heads: bool,
    reset: bool = False,
) -> int:
    if iam_db_name == settings.MONGO_DB_NAME and not iam_uri:
        print(
            f"REFUSING: --iam-db '{iam_db_name}' is SRM's own database.\n"
            "SRM keeps replica collections named `employees` and `departments` too,\n"
            "and they are lazily populated — seeding from them would produce rosters\n"
            "that look complete and are not. Point --iam-db at IAM's database."
        )
        return 2

    await init_db()
    iam_client = AsyncIOMotorClient(
        iam_uri or settings.MONGODB_URL, uuidRepresentation="standard"
    )
    iam_db = iam_client[iam_db_name]

    # Fail early and legibly rather than seeding nothing from a wrong database.
    if await iam_db["users"].estimated_document_count() == 0:
        print(f"REFUSING: no documents in {iam_db_name}.users — wrong database?")
        iam_client.close()
        await close_db()
        return 2

    query: dict = {"deleted_on": None}
    if org_id:
        query["organisation_id"] = ObjectId(org_id)

    if reset:
        # Standalone mode: clear and stop. Deliberately not fused with seeding —
        # "wipe every roster" and "write rosters" are different enough decisions
        # that running them from one invocation would hide the destructive half
        # behind the useful one.
        print(
            f"srm={settings.MONGO_DB_NAME} org={org_id or 'all'} — RESET\n"
        )
        rostered = await Category.find({**query, "executors": {"$ne": []}}).to_list()
        for c in rostered:
            print(f"  clear        {c.id} {c.name}: {len(c.executors)} executor(s)")
        if apply:
            for c in rostered:
                # `roster_is_exclusive` goes with it: update_category force-clears
                # the flag when a roster empties, and a lockdown pointing at an
                # empty roster would lock everyone out of the category.
                await c.set(
                    {
                        "executors": [],
                        "roster_is_exclusive": False,
                        "modified_on": utcnow(),
                    }
                )
            print(f"\nCleared {len(rostered)} category(ies).")
        else:
            print(f"\nDry run — {len(rostered)} category(ies) would be cleared.")
        iam_client.close()
        await close_db()
        return 0

    print(
        f"srm={settings.MONGO_DB_NAME} iam={iam_db_name} org={org_id or 'all'} "
        f"heads={'written' if include_heads else 'skipped'}\n"
    )

    categories = await Category.find(query).to_list()
    wanted: set[ObjectId] = set()
    for cat in categories:
        for d in category_department_ids(cat):
            wanted.add(ObjectId(str(d)))
    depts, members, head_members = await _load_iam(iam_db, list(wanted))
    headless = [
        d.get("department_name") or str(d["_id"])
        for d in depts.values()
        if not d.get("department_head")
    ]
    print(
        f"{len(categories)} category(ies), {len(depts)}/{len(wanted)} department(s) "
        f"resolved, {sum(len(v) for v in members.values())} staff row(s) loaded, "
        f"{len(head_members)} head(s) outside their own department.\n"
    )
    if headless:
        print(
            f"  {len(headless)} department(s) have no head in IAM: "
            f"{', '.join(sorted(headless))}\n"
            "  Categories staffed only from these are reported as no_primary and "
            "left alone.\n"
        )

    counts: dict[str, int] = defaultdict(int)
    written = 0
    for cat in categories:
        label = f"{cat.id} {cat.name}"
        try:
            outcome, update, detail = _reconcile_one(
                cat, depts, members, head_members, include_heads
            )
        except Exception as exc:  # noqa: BLE001
            # One malformed category must not abort a several-hundred-row run.
            counts["error"] += 1
            print(f"  error        {label}: {type(exc).__name__}: {exc}")
            continue

        counts[outcome] += 1
        print(f"  {outcome:<12} {label}: {detail}")
        if update and apply:
            await cat.set(update)
            written += 1

    print(
        "\n"
        f"{counts['update']} to update, {counts['in_sync']} already correct, "
        f"{counts['empty']} with no employees, {counts['over_cap']} over the cap, "
        f"{counts['no_primary']} with no department head, "
        f"{counts['orphan']} with no department, "
        f"{counts['unknown_dept']} pointing at a department IAM does not have, "
        f"{counts['error']} errored."
    )
    if counts["over_cap"]:
        print(
            f"  Over-cap categories were left alone. Roster them by hand in the UI,\n"
            f"  or raise MAX_EXECUTORS ({MAX_EXECUTORS}) in categories/schemas.py and\n"
            "  the mirror in CategoryForm.tsx first."
        )
    if counts["no_primary"]:
        print(
            "  no_primary categories were left un-rostered, which keeps them\n"
            "  working exactly as they do today (an empty roster means the\n"
            "  department handles the category). Set a department head in IAM and\n"
            "  re-run, or roster them by hand in the UI."
        )

    if not apply:
        print(f"Dry run — {counts['update']} category(ies) would be written.")
    else:
        print(f"Applied: {written} category(ies) written.")

    iam_client.close()
    await close_db()
    return (
        1
        if (
            counts["over_cap"]
            or counts["no_primary"]
            or counts["orphan"]
            or counts["unknown_dept"]
            or counts["error"]
        )
        else 0
    )


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument(
        "--iam-db",
        default=IAM_DB_DEFAULT,
        help=(
            f"IAM's MongoDB database name (default: {IAM_DB_DEFAULT}). Override "
            "only if this deployment names it differently — never point it at "
            "SRM's own database, see the module docstring."
        ),
    )
    ap.add_argument(
        "--iam-uri",
        help="Mongo URI for IAM, if it is not on the same cluster as SRM",
    )
    ap.add_argument("--org", help="Limit to one organisation_id (default: all)")
    ap.add_argument(
        "--apply",
        action="store_true",
        help="Write the changes. Without it the script only reports.",
    )
    ap.add_argument(
        "--skip-heads",
        action="store_true",
        help=(
            "Leave department heads out of the roster. The default writes them "
            "as PRIMARY rows so the stored roster matches the one the category "
            "form shows — see the module docstring."
        ),
    )
    ap.add_argument(
        "--reset",
        action="store_true",
        help=(
            "Clear every roster in scope and stop, so a later run can seed from "
            "scratch (the seed skips any category that already has one). "
            "DESTRUCTIVE: hand-curated rosters go too. Honours --org, and still "
            "needs --apply to write anything."
        ),
    )
    args = ap.parse_args()
    raise SystemExit(
        asyncio.run(
            main(
                args.org,
                args.iam_db,
                args.iam_uri,
                args.apply,
                not args.skip_heads,
                args.reset,
            )
        )
    )
