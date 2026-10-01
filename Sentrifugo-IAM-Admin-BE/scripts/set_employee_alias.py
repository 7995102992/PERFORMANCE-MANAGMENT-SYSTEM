"""Set a secondary emp-code ALIAS on specific employees (no backfill).

Some employees carry an emp code that doesn't match the house format; the payslip
emp-lookup RPC resolves an employee by emp_code OR alias, so giving such an
employee an alias makes that lookup succeed. This targets ONLY the employees named
on the command line — it never touches any other document.

    # dry run — show what would change, write nothing
    python -m scripts.set_employee_alias --set SIL-0110=SSI-0110 --dry-run

    # apply one or many
    python -m scripts.set_employee_alias --set SIL-0110=SSI-0110 --set SIL-0250=SSI-0250

    # disambiguate when an emp_code exists in more than one organisation
    python -m scripts.set_employee_alias --set SIL-0110=SSI-0110 --org 6a4c8cae5457ae1842d39985

Safety: refuses to set an alias that already exists as another live employee's
emp_code or alias (it would make the lookup ambiguous).
"""
from __future__ import annotations
import argparse
import asyncio

from bson import ObjectId
from motor.motor_asyncio import AsyncIOMotorClient

from src.config import settings

LIVE = {"deleted_on": None}


def _pair(raw: str) -> tuple[str, str]:
    if "=" not in raw:
        raise argparse.ArgumentTypeError(f"expected EMPCODE=ALIAS, got {raw!r}")
    emp_code, alias = (p.strip() for p in raw.split("=", 1))
    if not emp_code or not alias:
        raise argparse.ArgumentTypeError(f"both sides required in {raw!r}")
    return emp_code, alias


async def main(pairs: list[tuple[str, str]], org: str | None, dry_run: bool) -> None:
    db = AsyncIOMotorClient(settings.MONGODB_URL).get_default_database()
    emps = db["employees"]

    org_oid = None
    if org:
        try:
            org_oid = ObjectId(org)
        except Exception:
            print(f"invalid --org id: {org!r}")
            return

    scope = dict(LIVE)
    if org_oid:
        scope["organisation_id"] = org_oid

    updated = skipped = 0
    for emp_code, alias in pairs:
        matches = await emps.find({**scope, "emp_code": emp_code}).to_list(length=10)
        if not matches:
            print(f"SKIP  {emp_code}: no live employee with this emp_code"
                  + (f" in org {org}" if org else ""))
            skipped += 1
            continue
        if len(matches) > 1:
            orgs = sorted({str(m.get("organisation_id")) for m in matches})
            print(f"SKIP  {emp_code}: {len(matches)} employees share this emp_code "
                  f"across orgs {orgs} — pass --org to disambiguate")
            skipped += 1
            continue

        emp = matches[0]
        emp_org = emp.get("organisation_id")

        # Alias must be unique within the org across BOTH emp_code and alias, or the
        # lookup could resolve to the wrong person.
        clash = await emps.find_one({
            **LIVE,
            "organisation_id": emp_org,
            "_id": {"$ne": emp["_id"]},
            "$or": [{"emp_code": alias}, {"alias": alias}],
        })
        if clash:
            print(f"SKIP  {emp_code}: alias {alias!r} already used by employee "
                  f"{clash.get('emp_code')} ({clash['_id']}) in the same org")
            skipped += 1
            continue

        if emp.get("alias") == alias:
            print(f"OK    {emp_code}: already has alias {alias!r} — no change")
            continue

        print(f"SET   {emp_code} ({emp['_id']}, org {emp_org}) -> alias {alias!r}"
              + (f"  [was {emp['alias']!r}]" if emp.get("alias") else ""))
        updated += 1
        if not dry_run:
            await emps.update_one({"_id": emp["_id"]}, {"$set": {"alias": alias}})

    verb = "would update" if dry_run else "updated"
    print(f"\n{verb}={updated}  skipped={skipped}")
    if dry_run:
        print("DRY RUN — no writes. Re-run without --dry-run to apply.")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--set", dest="pairs", action="append", type=_pair, required=True,
                    metavar="EMPCODE=ALIAS", help="repeatable; e.g. --set SIL-0110=SSI-0110")
    ap.add_argument("--org", default=None, help="organisation id, to disambiguate shared emp_codes")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    asyncio.run(main(a.pairs, a.org, a.dry_run))
