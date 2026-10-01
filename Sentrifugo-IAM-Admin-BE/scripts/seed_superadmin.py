"""Seed script to create (or repair) the super admin user in MongoDB.

Usage:
    python -m scripts.seed_superadmin

Set these in .env (or pass as environment variables):
    SUPERADMIN_EMAIL        (default: sethunarayanan.valaparambil@sagarsoft.in)
    SUPERADMIN_PASSWORD     (default: SuperAdmin@2026)
    SUPERADMIN_FIRST_NAME   (default: Sethu)
    SUPERADMIN_LAST_NAME    (default: <empty>)
    SUPERADMIN_PHONE        (default: unset)

On re-run:
    If the user already exists, this script ensures the admin flags are
    set correctly (is_super_admin=True, is_org_admin=False, cross-org).
    Passwords / names of existing users are NOT overwritten.
"""

import asyncio
import os
from datetime import datetime, timezone

from beanie import init_beanie
from motor.motor_asyncio import AsyncIOMotorClient

from src.auth.utils.tools import get_password_hash
from src.config import settings
from src.auth.models import UserDocument


SUPERADMIN_EMAIL = os.getenv("SUPERADMIN_EMAIL", "sethunarayanan.valaparambil@sagarsoft.in")
SUPERADMIN_PASSWORD = os.getenv("SUPERADMIN_PASSWORD", "SuperAdmin@2026")
SUPERADMIN_FIRST_NAME = os.getenv("SUPERADMIN_FIRST_NAME", "Sethu")
SUPERADMIN_LAST_NAME = os.getenv("SUPERADMIN_LAST_NAME", "")
SUPERADMIN_PHONE = os.getenv("SUPERADMIN_PHONE") or None


def _print_summary(user: UserDocument, *, is_new: bool) -> None:
    label = "seeded" if is_new else "already present"
    full_name = f"{user.first_name} {user.last_name}".strip()
    print(f"Super admin {label}:")
    print(f"  ID:              {user.id}")
    print(f"  Email:           {user.email}")
    print(f"  Name:            {full_name}")
    print(f"  Phone:           {user.phone or '<unset>'}")
    print(f"  auth_method:     {user.auth_method}")
    print(f"  status:          {user.status}")
    print(f"  is_super_admin:  {user.is_super_admin}")
    print(f"  is_org_admin:    {user.is_org_admin}")
    print(f"  organisation_id: {user.organisation_id or '<null — cross-org>'}")
    if is_new:
        print()
        print(f"  Password: {SUPERADMIN_PASSWORD}")
        print()
        print("IMPORTANT: Change the password after first login!")


async def seed():
    if not settings.MONGODB_URL:
        print("ERROR: MONGODB_URL is not configured. Check your .env file.")
        return

    client = AsyncIOMotorClient(settings.MONGODB_URL)
    db = client.get_default_database()

    await init_beanie(database=db, document_models=[UserDocument])

    existing = await UserDocument.find_one(
        UserDocument.email == SUPERADMIN_EMAIL,
        UserDocument.deleted_on == None,  # noqa: E711
    )

    if existing:
        repairs: dict = {}
        if not existing.is_super_admin:
            repairs["is_super_admin"] = True
        if existing.is_org_admin:
            repairs["is_org_admin"] = False
        if existing.organisation_id is not None:
            repairs["organisation_id"] = None
        if existing.status != "active":
            repairs["status"] = "active"

        if repairs:
            repairs["modified_by"] = "system"
            repairs["modified_on"] = datetime.now(timezone.utc)
            await existing.set(repairs)
            print(f"Super admin repaired: updated {list(repairs.keys())}")
        _print_summary(existing, is_new=False)
        client.close()
        return

    now = datetime.now(timezone.utc)
    superadmin = UserDocument(
        email=SUPERADMIN_EMAIL,
        password_hash=get_password_hash(SUPERADMIN_PASSWORD),
        auth_method="seeded",
        first_name=SUPERADMIN_FIRST_NAME,
        last_name=SUPERADMIN_LAST_NAME,
        phone=SUPERADMIN_PHONE,
        status="active",
        is_super_admin=True,
        is_org_admin=False,
        organisation_id=None,
        created_by="system",
        created_on=now,
        modified_by="system",
        modified_on=now,
    )

    await superadmin.insert()
    _print_summary(superadmin, is_new=True)

    client.close()


if __name__ == "__main__":
    asyncio.run(seed())
