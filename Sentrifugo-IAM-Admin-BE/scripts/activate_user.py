"""Activate a single user directly in the DB — no email/Brevo needed.

Mirrors the activation the seed scripts perform: set the user's status to
ACTIVE and write a bcrypt password hash (via the app's own get_password_hash),
so a freshly-created org admin (or any user) can log in immediately without the
email activation / password-reset flow.

Used by the Playwright e2e journey, which creates an org via the super-admin UI
and then activates that org admin here before logging in as them.

Usage:
    cd Sentrifugo-IAM-Admin-BE
    python -m scripts.activate_user <email> <password>
"""

import asyncio
import sys
from datetime import datetime, timezone

from beanie import init_beanie
from motor.motor_asyncio import AsyncIOMotorClient

from src.auth.models import UserDocument
from src.auth.utils.tools import get_password_hash
from src.config import settings
from src.master_data.models import MasterDataDocument
from src.models import StatusEnum
from src.modules.organisation.models import (
    AddressDocument,
    BandDocument,
    BusinessUnitDocument,
    DepartmentDocument,
    DesignationDocument,
    EmployeeDocument,
    OrganisationDocument,
    PayGradeDocument,
)
from src.policies.models import ModuleAclPermissionDocument, PolicyDocument


async def activate(email: str, password: str) -> None:
    if not settings.MONGODB_URL:
        print("ERROR: MONGODB_URL not configured.")
        sys.exit(1)

    client = AsyncIOMotorClient(settings.MONGODB_URL)
    db = client.get_default_database()
    await init_beanie(
        database=db,
        document_models=[
            UserDocument, MasterDataDocument,
            OrganisationDocument, BusinessUnitDocument, DepartmentDocument,
            DesignationDocument, BandDocument, PayGradeDocument,
            EmployeeDocument, AddressDocument,
            PolicyDocument, ModuleAclPermissionDocument,
        ],
    )

    # The user is created synchronously by the super-admin org-create call,
    # but allow a few retries in case of any lag.
    user = None
    for _ in range(10):
        user = await UserDocument.find_one(UserDocument.email == email)
        if user:
            break
        await asyncio.sleep(1)

    if not user:
        print(f"ERROR: user not found: {email}")
        client.close()
        sys.exit(2)

    user.status = StatusEnum.ACTIVE
    user.password_hash = get_password_hash(password)
    user.password_changed_at = datetime.now(timezone.utc)
    await user.save()
    client.close()
    print(f"OK activated {email}")


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python -m scripts.activate_user <email> <password>")
        sys.exit(1)
    asyncio.run(activate(sys.argv[1], sys.argv[2]))
