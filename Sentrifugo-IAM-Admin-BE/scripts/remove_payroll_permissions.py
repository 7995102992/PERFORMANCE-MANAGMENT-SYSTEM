"""Remove new_payroll and employee_payroll from the database.

Deletes:
  - permissions collection rows where key in (new_payroll, employee_payroll)
  - module_acl_permissions (grants) rows referencing those permission keys

Safe to re-run — uses deleteMany which is a no-op when rows are already gone.

Usage:
    python -m scripts.remove_payroll_permissions --dry-run
    python -m scripts.remove_payroll_permissions
"""
from __future__ import annotations

import argparse
import asyncio

from motor.motor_asyncio import AsyncIOMotorClient

from src.config import settings

CODES = ["new_payroll", "employee_payroll"]


async def main(dry_run: bool) -> None:
    client = AsyncIOMotorClient(settings.MONGODB_URL)
    db = client.get_default_database()

    perms_col = db["permissions"]
    grants_col = db["module_acl_permissions"]

    # Find affected permission documents
    perms = await perms_col.find({"key": {"$in": CODES}}).to_list(length=None)
    perm_ids = [p["_id"] for p in perms]

    print(f"Permissions to delete ({len(perms)}):")
    for p in perms:
        print(f"  {p.get('key')} — {p['_id']}")

    grants = await grants_col.find({"permission_id": {"$in": CODES}}).to_list(length=None)
    print(f"\nGrant rows to delete ({len(grants)}):")
    for g in grants:
        print(f"  policy={g.get('policy_id')} module={g.get('module_id')} perm={g.get('permission_id')}")

    if dry_run:
        print("\n[dry-run] No changes made.")
        client.close()
        return

    if perm_ids:
        result = await perms_col.delete_many({"_id": {"$in": perm_ids}})
        print(f"\nDeleted {result.deleted_count} permission(s).")

    if grants:
        result = await grants_col.delete_many({"permission_id": {"$in": CODES}})
        print(f"Deleted {result.deleted_count} grant row(s).")

    print("Done.")
    client.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    asyncio.run(main(dry_run=args.dry_run))
