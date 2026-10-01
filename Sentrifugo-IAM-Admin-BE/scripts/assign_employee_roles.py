"""Assign the Manager / Employee role to an organisation's employees  (IAM).

Roles in this system are policy documents (`policies.is_role = true`) attached to
a user through `users.policy_ids`. This script derives who is a manager from the
org chart itself and attaches the right role to every employee's user account:

  - MANAGER  — the user is named as `l1_manager_id` or `l2_manager_id` on at
               least one employee of the org (both fields hold USER ids)
  - EMPLOYEE — everyone else

Employees marked as **exit** (employment_status = "Exit", or user status 'exit')
get NO role — a rehire with an older exited record still counts as current.

Direct Mongo writes (same pattern as the other migration scripts). Because the
service isn't involved, cached sessions are NOT invalidated — affected users pick
up the new role on their next login.

Modes:
    python -m scripts.assign_employee_roles --org-id <id>            # DRY RUN (writes nothing)
    python -m scripts.assign_employee_roles --org-id <id> --commit   # write (idempotent)
    python -m scripts.assign_employee_roles --revert                 # restore policy_ids from the last run's CSV

By default a user who already carries some OTHER role is left untouched (reported
as `kept_other_role`); pass --overwrite to replace their roles with the computed
one. Users with no role at all always get theirs.
"""
from __future__ import annotations

import argparse
import csv
import os
import sys
from collections import Counter
from datetime import datetime, timezone

from bson import ObjectId
from pymongo import MongoClient

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from src.config import settings  # noqa: E402

# ───────────────────────── config ─────────────────────────
IAM_DB = "sentrifugo_iam"
ORG_ID = ObjectId("6a481cbeefd9f278b3708209")            # Sagarsoft (India) Limited
MIGRATION_USER = ObjectId("6a481cbeefd9f278b370820a")   # audit actor: that org's admin

MANAGER_ROLE_ID = ObjectId("6a5777ac6b36da32c468679e")   # policies: "Manager"
EMPLOYEE_ROLE_ID = ObjectId("6a570cc79674971c2b065c0d")  # policies: "Employee"


# ───────────────────────── helpers ─────────────────────────
def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def ids_str(ids) -> str:
    """policy_ids -> "a|b" (CSV round-trip form; empty list -> "")."""
    return "|".join(str(i) for i in (ids or []))


def str_ids(s: str) -> list[ObjectId]:
    return [ObjectId(x) for x in (s or "").split("|") if x.strip()]


def resolve_roles(iam):
    """Load both role policies and check they are live roles of the target org."""
    out = {}
    for label, rid in (("MANAGER", MANAGER_ROLE_ID), ("EMPLOYEE", EMPLOYEE_ROLE_ID)):
        doc = iam["policies"].find_one({"_id": rid, "deleted_on": None})
        if not doc:
            raise SystemExit(f"ERROR: {label} role {rid} not found in {IAM_DB}.policies")
        if not doc.get("is_role"):
            raise SystemExit(f"ERROR: policy {rid} ({doc.get('name')}) is not a role (is_role=false)")
        if doc.get("organisation_id") != ORG_ID:
            raise SystemExit(f"ERROR: {label} role {rid} ({doc.get('name')}) belongs to org "
                             f"{doc.get('organisation_id')}, not {ORG_ID} — pass the matching "
                             f"--manager-role-id / --employee-role-id for this org")
        if not doc.get("is_active", True):
            print(f"   WARNING: {label} role {doc.get('name')!r} is inactive")
        out[label] = doc
    return out


def manager_user_ids(employees) -> set:
    """Users named as l1/l2 manager on any employee of the org (both hold user ids)."""
    mgrs = set()
    for e in employees:
        for f in ("l1_manager_id", "l2_manager_id"):
            v = e.get(f)
            if v:
                mgrs.add(v)
    return mgrs


# ───────────────────────── build ─────────────────────────
def build(iam, active_only: bool, overwrite: bool):
    employees = list(iam["employees"].find(
        {"organisation_id": ORG_ID, "deleted_on": None},
        {"emp_code": 1, "user_id": 1, "l1_manager_id": 1, "l2_manager_id": 1,
         "employment_status": 1},
    ))
    # Manager set comes from ALL employees — someone only ex-employees report to is
    # still a manager — even though exited people are skipped below.
    mgrs = manager_user_ids(employees)
    # employment_status values that mean the person has left ("Exit" master data).
    exit_ids = {d["_id"] for d in iam["master_data"].find({"key": "exit"}, {"_id": 1})}

    users = {u["_id"]: u for u in iam["users"].find(
        {"organisation_id": ORG_ID, "deleted_on": None},
        {"email": 1, "first_name": 1, "last_name": 1, "status": 1, "policy_ids": 1},
    )}

    # One row per USER, not per employee record: rehires/conversions leave the same
    # person with several employee rows (SIL-0780 + SIL-C-5077), and the role lives
    # on the user account.
    by_user: dict = {}
    st = Counter()
    for e in sorted(employees, key=lambda x: x.get("emp_code") or ""):
        uid = e.get("user_id")
        code = (e.get("emp_code") or "").strip()
        if not uid:
            st["no_user_id"] += 1
            continue
        row = {"code": code, "exit": e.get("employment_status") in exit_ids}
        if uid in by_user:
            by_user[uid].append(row)
            st["extra_employee_row"] += 1
        else:
            by_user[uid] = [row]

    plan = []
    for uid, rows in by_user.items():
        code = " / ".join(r["code"] for r in rows if r["code"])
        u = users.get(uid)
        if not u:
            st["user_missing"] += 1
            continue
        # Exited people get no role at all. A rehire keeps several employee rows —
        # only "all rows exited" counts as exited.
        if all(r["exit"] for r in rows) or u.get("status") == "exit":
            st["skipped_exit"] += 1
            continue
        if active_only and u.get("status") != "active":
            st["skipped_not_active"] += 1
            continue

        is_mgr = uid in mgrs
        role_id = MANAGER_ROLE_ID if is_mgr else EMPLOYEE_ROLE_ID
        before = list(u.get("policy_ids") or [])

        if role_id in before:
            action, after = "already_has_role", before
        elif before:
            if overwrite:
                action, after = "overwritten", [role_id]
            else:
                action, after = "kept_other_role", before
        else:
            action, after = "assigned", [role_id]

        st[action] += 1
        st["MANAGER" if is_mgr else "EMPLOYEE"] += 1
        plan.append({
            "emp_code": code,
            "user_id": str(uid),
            "email": u.get("email") or "",
            "name": " ".join(x for x in (u.get("first_name"), u.get("last_name")) if x),
            "user_status": u.get("status") or "",
            "role": "MANAGER" if is_mgr else "EMPLOYEE",
            "role_id": str(role_id),
            "action": action,
            "policy_ids_before": ids_str(before),
            "policy_ids_after": ids_str(after),
        })
    return plan, mgrs, st


# ───────────────────────── write / revert ─────────────────────────
def commit(iam, plan) -> int:
    n = 0
    for r in plan:
        if r["action"] not in ("assigned", "overwritten"):
            continue
        iam["users"].update_one(
            {"_id": ObjectId(r["user_id"])},
            {"$set": {"policy_ids": str_ids(r["policy_ids_after"]),
                      "modified_by": str(MIGRATION_USER),
                      "modified_on": now_utc()}},
        )
        n += 1
    return n


def revert(iam, csv_path) -> int:
    """Restore policy_ids to what the last run recorded in `policy_ids_before`."""
    if not os.path.exists(csv_path):
        raise SystemExit(f"ERROR: no previous run to revert — {csv_path} not found")
    with open(csv_path, encoding="utf-8-sig", newline="") as f:
        rows = list(csv.DictReader(f))
    n = 0
    for r in rows:
        if r.get("action") not in ("assigned", "overwritten"):
            continue
        iam["users"].update_one(
            {"_id": ObjectId(r["user_id"])},
            {"$set": {"policy_ids": str_ids(r["policy_ids_before"]),
                      "modified_by": str(MIGRATION_USER),
                      "modified_on": now_utc()}},
        )
        n += 1
    print(f"  users restored: {n}  (source: {csv_path})")
    return n


# ───────────────────────── outputs ─────────────────────────
def write_outputs(scripts_dir, mode, plan, roles, st):
    csv_path = os.path.join(scripts_dir, "role_assignment_clean.csv")
    md_path = os.path.join(scripts_dir, "role_assignment_report.md")

    cols = ["emp_code", "user_id", "email", "name", "user_status", "role", "role_id",
            "action", "policy_ids_before", "policy_ids_after"]
    with open(csv_path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        for r in plan:
            w.writerow(r)

    L = [
        "# Employee role assignment report",
        "",
        f"- Generated: {datetime.now().isoformat(sep=' ', timespec='seconds')}  (mode: **{mode}**)",
        f"- Target DB: `{IAM_DB}`  ·  org_id: `{ORG_ID}`",
        f"- Manager role: `{roles['MANAGER']['name']}` (`{MANAGER_ROLE_ID}`)",
        f"- Employee role: `{roles['EMPLOYEE']['name']}` (`{EMPLOYEE_ROLE_ID}`)",
        "",
        "## Rule",
        "",
        "A user is a **manager** if any employee of this org names them as `l1_manager_id` "
        "or `l2_manager_id`; everyone else is an **employee**. The role is attached to the "
        "user account via `users.policy_ids`.",
        "",
        "## Result",
        "",
        "| bucket | count |",
        "| --- | --- |",
        f"| user accounts in scope | {len(plan)} |",
        f"| → manager role | {st['MANAGER']} |",
        f"| → employee role | {st['EMPLOYEE']} |",
        f"| assigned (had no role) | {st['assigned']} |",
        f"| overwritten (--overwrite) | {st['overwritten']} |",
        f"| already had the role | {st['already_has_role']} |",
        f"| kept an existing other role | {st['kept_other_role']} |",
        f"| skipped — marked as exit (no role) | {st['skipped_exit']} |",
        f"| skipped — user not active (--active-only) | {st['skipped_not_active']} |",
        f"| skipped — employee has no user_id | {st['no_user_id']} |",
        f"| skipped — user record missing/deleted | {st['user_missing']} |",
        f"| extra employee rows folded into one user | {st['extra_employee_row']} |",
        "",
        "## Notes",
        "",
        "- Sessions are not invalidated by a direct DB write: users see the new role after "
        "their next login.",
        f"- Per-user detail (incl. the previous `policy_ids`): `scripts/{os.path.basename(csv_path)}`.",
        "- `--revert` restores every row this run changed to its recorded previous value.",
        "",
    ]
    with open(md_path, "w", encoding="utf-8") as f:
        f.write("\n".join(L))
    return csv_path, md_path


# ───────────────────────── main ─────────────────────────
def main():
    global ORG_ID, MANAGER_ROLE_ID, EMPLOYEE_ROLE_ID
    ap = argparse.ArgumentParser()
    ap.add_argument("--commit", action="store_true")
    ap.add_argument("--revert", action="store_true", help="restore policy_ids from the last run's CSV")
    ap.add_argument("--org-id", help="organisation id (default: built-in)")
    ap.add_argument("--manager-role-id", help="policy id of the Manager role (default: built-in)")
    ap.add_argument("--employee-role-id", help="policy id of the Employee role (default: built-in)")
    ap.add_argument("--overwrite", action="store_true",
                    help="replace roles on users that already carry a different one")
    ap.add_argument("--active-only", action="store_true",
                    help="only assign to users with status='active'")
    args = ap.parse_args()
    mode = "COMMIT" if args.commit else "REVERT" if args.revert else "DRY-RUN"

    if args.org_id:
        ORG_ID = ObjectId(args.org_id)
    if args.manager_role_id:
        MANAGER_ROLE_ID = ObjectId(args.manager_role_id)
    if args.employee_role_id:
        EMPLOYEE_ROLE_ID = ObjectId(args.employee_role_id)

    scripts_dir = os.path.dirname(os.path.abspath(__file__))
    client = MongoClient(settings.MONGODB_URL, serverSelectionTimeoutMS=8000)
    client.admin.command("ping")
    iam = client[IAM_DB]
    print(f"== employee role assignment ==  mode={mode}  target_db={IAM_DB}  org={ORG_ID}\n")

    if args.revert:
        revert(iam, os.path.join(scripts_dir, "role_assignment_clean.csv"))
        client.close()
        return

    roles = resolve_roles(iam)
    print(f"roles: MANAGER={roles['MANAGER']['name']!r} ({MANAGER_ROLE_ID})  "
          f"EMPLOYEE={roles['EMPLOYEE']['name']!r} ({EMPLOYEE_ROLE_ID})")

    plan, mgrs, st = build(iam, args.active_only, args.overwrite)
    print(f"user accounts in scope: {len(plan)}   distinct manager users (l1/l2): {len(mgrs)}"
          + (f"   (+{st['extra_employee_row']} extra employee rows folded in)"
             if st["extra_employee_row"] else "") + "\n")

    print("── assignment ──")
    print(f"   manager role : {st['MANAGER']}")
    print(f"   employee role: {st['EMPLOYEE']}")
    print("\n── actions ──")
    print(f"   assigned (had no role)      : {st['assigned']}")
    print(f"   overwritten (--overwrite)   : {st['overwritten']}")
    print(f"   already had the role        : {st['already_has_role']}")
    print(f"   kept an existing other role : {st['kept_other_role']}"
          + ("" if args.overwrite else "   (re-run with --overwrite to replace)"))
    print(f"   skipped, marked as exit     : {st['skipped_exit']}")
    if st["skipped_not_active"]:
        print(f"   skipped, user not active    : {st['skipped_not_active']}")
    if st["no_user_id"] or st["user_missing"]:
        print(f"   skipped, no user account    : {st['no_user_id'] + st['user_missing']}")

    print("\n── sample (first 5 to change) ──")
    for r in [x for x in plan if x["action"] in ("assigned", "overwritten")][:5]:
        print(f"   {r['emp_code']:>10} | {r['role']:8} | {r['email']:40} | {r['action']}")

    if args.commit:
        print(f"\n== COMMIT: writing to {IAM_DB}.users ==")
        n = commit(iam, plan)
        print(f"  users updated: {n}")
        print("Done.")
    else:
        print("\nDRY-RUN — nothing written. Re-run with --commit to write, --revert to undo.")

    csv_path, md_path = write_outputs(scripts_dir, mode, plan, roles, st)
    print(f"\nReport : {md_path}")
    print(f"Clean CSV: {csv_path}  ({len(plan)} rows)")
    client.close()


if __name__ == "__main__":
    main()
