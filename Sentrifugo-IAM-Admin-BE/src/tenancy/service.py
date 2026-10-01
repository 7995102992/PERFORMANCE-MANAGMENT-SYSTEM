"""Super-admin organisation flows.

Composes the organisations repo + users repo + activation email to
implement the Add/View/Edit screens from the super-admin portal.

Administrator contact (name/email/phone) is persisted on a UserDocument
with is_org_admin=True and organisation_id=<new org>. The View endpoint
resolves that user to populate the 'Administrator Information' card.
"""

from datetime import datetime, timezone

from beanie import PydanticObjectId

from fastapi import status

from src.auth.service import send_activation_email
from src.correlation import get_correlation_id
from src.exceptions import DomainException
from src.logger import logger
from src.models import ModuleEnum, OrgModule, StatusEnum
from src.rabbitmq import DebugLevel, outbox
from src.tenancy.schemas import (
    AdministratorView,
    OrganisationCreate,
    OrganisationListItem,
    OrganisationResponse,
    OrganisationUpdate,
)
from src.tenancy.utils import tools as org_repo
from src.users.utils import tools as user_repo


def _serialize_modules(modules) -> list[dict]:
    """Normalize enabled_modules to plain dicts for event payloads."""
    if not modules:
        return []
    out = []
    for m in modules:
        if isinstance(m, OrgModule):
            out.append({"code": m.code.value, "is_active": m.is_active})
        elif isinstance(m, dict):
            code = m.get("code", "")
            out.append({
                "code": code.value if hasattr(code, "value") else str(code),
                "is_active": m.get("is_active", True),
            })
        else:
            out.append({"code": m.value if hasattr(m, "value") else str(m), "is_active": True})
    return out


async def create_organisation(
    data: OrganisationCreate,
    current_user_id: str | None = None,
) -> OrganisationResponse:
    """Create an organisation and its primary admin user in one flow.

    Wireframe mapping (image 3):
      - "Save as Draft"              → setup_status="draft", send_activation=False
      - "Save & Send Activation Link" → setup_status="pending", send_activation=True
    The caller (frontend) controls those two flags; we enforce consistency
    (send_activation=True while status=draft is rejected).

    Rollback: if admin user creation fails after the org is inserted, the
    org is soft-deleted so the user can retry from a clean slate.
    """
    if data.send_activation or data.setup_status == "draft":
        raise DomainException(
            message="Cannot send activation link on a draft organisation",
            code="INVALID_INPUT",
            status_code=status.HTTP_400_BAD_REQUEST,
        )

    if await org_repo.get_organisation_by_legal_name(data.legal_name):
        raise DomainException(
            message="An organisation with this name already exists",
            code="ORG_ALREADY_EXISTS",
            status_code=status.HTTP_409_CONFLICT,
        )

    if await user_repo.get_user_by_email(data.administrator.email):
        raise DomainException(
            message="A user with this email already exists",
            code="EMAIL_ALREADY_EXISTS",
            status_code=status.HTTP_409_CONFLICT,
        )

    now = datetime.now(timezone.utc)
    org_doc = {
        "legal_name": data.legal_name,
        "address_id": data.address_id,
        "date_of_incorporation": data.date_of_incorporation,
        "financial_year": data.financial_year,
        "currency": data.currency,
        "timezone": data.timezone,
        "logo_asset_id": data.logo_asset_id,
        "is_multiple_business_units": data.is_multiple_business_units,
        "is_active": data.is_active,
        "enabled_modules": data.enabled_modules,
        "setup_status": data.setup_status,
        "created_by": current_user_id,
        "created_on": now,
        "modified_by": current_user_id,
        "modified_on": now,
        "correlation_id": get_correlation_id(),
    }
    created_org = await org_repo.create_organisation(org_doc)


    name_parts = data.administrator.name.split(maxsplit=1)
    admin_doc = {
        "email": data.administrator.email,
        "password_hash": None,
        "auth_method": "local",
        "azure_oid": None,
        "first_name": name_parts[0],
        "last_name": name_parts[1] if len(name_parts) > 1 else "",
        "phone": data.administrator.phone,
        "avatar_url": None,
        "is_super_admin": False,
        "is_org_admin": True,
        "status": StatusEnum.INACTIVE,
        "last_login_at": None,
        "password_changed_at": now,
        "organisation_id": created_org["id"],
        "created_by": current_user_id,
        "created_on": now,
        "modified_by": current_user_id,
        "modified_on": now,
        "deleted_by": None,
        "deleted_on": None,
        "correlation_id": get_correlation_id(),
    }

    try:
        created_admin = await user_repo.create_user(admin_doc)
    except Exception as exc:
        logger.error(
            "Admin user creation failed after org insert — rolling back org",
            org_id=created_org["id"],
            error=str(exc),
        )
        await org_repo.update_organisation(
            created_org["id"],
            {"deleted_by": current_user_id, "deleted_on": datetime.now(timezone.utc)},
        )
        raise

    if data.send_activation:
        try:
            full_name = " ".join(
                p for p in [created_admin.get("first_name", ""), created_admin.get("last_name", "")] if p
            )
            await send_activation_email(
                created_admin["id"],
                created_admin["email"],
                full_name,
                tenant_id=str(created_org["id"]),
                is_admin_portal=True,  # org/super admins use the admin portal
            )
        except Exception as exc:
            # Email is best-effort — org + admin are created. Surface the
            # failure so the super admin can use 'Resend activation'.
            logger.error(
                "Activation email failed for new org admin",
                admin_id=created_admin["id"],
                org_id=created_org["id"],
                error=str(exc),
            )

    await outbox.publish(
        "organisation.created",
        {
            "correlation_id": get_correlation_id(),
            "organisation_id": created_org["id"],
            "legal_name": data.legal_name,
            "financial_year": data.financial_year,
            "currency": data.currency,
            "timezone": data.timezone,
            "is_multiple_business_units": data.is_multiple_business_units,
            "is_active": data.is_active,
            "enabled_modules": _serialize_modules(data.enabled_modules),
            "setup_status": data.setup_status,
            "created_by": current_user_id,
            "created_on": now.isoformat(),
            "modified_by": current_user_id,
            "modified_on": now.isoformat(),
            "deleted_by": None,
            "deleted_on": None,
            "admin_email": data.administrator.email,
        },
        idempotency_key=f"organisation.created:{created_org['id']}",
    )
    await outbox.publish_audit_log(
        module="organisations",
        actor_id=current_user_id or "system",
        action="created",
        resource=f"organisation:{created_org['id']}",
        debug_level=DebugLevel.ADMIN,
    )
    logger.info(
        "Organisation created",
        organisation_id=created_org["id"],
        legal_name=data.legal_name,
        setup_status=data.setup_status,
        admin_email=data.administrator.email,
    )

    return _to_response(created_org, created_admin)


async def list_organisations(
    skip: int = 0,
    limit: int = 20,
    search: str | None = None,
    setup_status: str | None = None,
    is_active: bool | None = None,
) -> list[OrganisationListItem]:
    """Super-admin organisations list (image 2 dashboard & list view)."""
    orgs = await org_repo.list_organisations(
        skip=skip,
        limit=limit,
        search=search,
        setup_status=setup_status,
        is_active=is_active,
    )
    items = []
    for o in orgs:
        modules = o.get("enabled_modules") or []
        active_count = sum(
            1 for m in modules
            if (m.get("is_active", True) if isinstance(m, dict) else getattr(m, "is_active", True))
        )
        items.append(OrganisationListItem(
            id=o["id"],
            legal_name=o["legal_name"],
            is_active=o["is_active"],
            setup_status=o.get("setup_status"),
            enabled_modules_count=len(modules),
            active_modules_count=active_count,
            created_on=o.get("created_on"),
        ))
    return items


async def get_organisation(org_id: str) -> OrganisationResponse:
    """Fetch a single organisation + resolve its admin (image 4)."""
    org = await org_repo.get_organisation_by_id(org_id)
    if not org:
        raise DomainException(
            message="Organisation not found",
            code="ORG_NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )
    admin = await user_repo.get_org_admin(org_id)
    return _to_response(org, admin)


async def update_organisation(
    org_id: str,
    data: OrganisationUpdate,
    current_user_id: str | None = None,
) -> OrganisationResponse:
    """Partially update an organisation and/or its admin (image 5).

    The Edit screen shows admin Name/Email/Phone alongside org fields.
    Those live on the admin UserDocument, so admin_* fields in the payload
    are routed to the user record instead of the org record.
    """
    existing = await org_repo.get_organisation_by_id(org_id)
    if not existing:
        raise DomainException(
            message="Organisation not found",
            code="ORG_NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )

    now = datetime.now(timezone.utc)
    org_updates = data.model_dump(
        exclude_none=True,
        exclude={"administrator"},
    )

    if "legal_name" in org_updates and org_updates["legal_name"] != existing["legal_name"]:
        clash = await org_repo.get_organisation_by_legal_name(org_updates["legal_name"])
        if clash and clash["id"] != org_id:
            raise DomainException(
                message="An organisation with this name already exists",
                code="ORG_ALREADY_EXISTS",
                status_code=status.HTTP_409_CONFLICT,
            )

    if org_updates:
        org_updates["modified_by"] = current_user_id
        org_updates["modified_on"] = now
        org_updates["correlation_id"] = get_correlation_id()
        existing = await org_repo.update_organisation(org_id, org_updates)

    admin = await user_repo.get_org_admin(org_id)
    if data.administrator is not None:
        admin = await _apply_admin_update(
            org_id=org_id,
            current_admin=admin,
            patch=data.administrator,
            current_user_id=current_user_id,
            now=now,
        )

    changed_fields = list(data.model_dump(exclude_none=True, exclude={"administrator"}).keys())
    await outbox.publish(
        "organisation.updated",
        {
            "correlation_id": get_correlation_id(),
            "organisation_id": org_id,
            "legal_name": existing.get("legal_name"),
            "financial_year": existing.get("financial_year"),
            "currency": existing.get("currency"),
            "timezone": existing.get("timezone"),
            "is_multiple_business_units": existing.get("is_multiple_business_units"),
            "is_active": existing.get("is_active"),
            "enabled_modules": _serialize_modules(existing.get("enabled_modules")),
            "setup_status": existing.get("setup_status"),
            "created_by": existing.get("created_by"),
            "created_on": existing["created_on"].isoformat() if existing.get("created_on") else None,
            "modified_by": current_user_id,
            "modified_on": now.isoformat(),
            "deleted_by": existing.get("deleted_by"),
            "deleted_on": existing["deleted_on"].isoformat() if existing.get("deleted_on") else None,
            "changed_fields": changed_fields,
        },
        idempotency_key=f"organisation.updated:{org_id}:{now.isoformat()}",
    )
    await outbox.publish_audit_log(
        module="organisations",
        actor_id=current_user_id or "system",
        action="updated",
        resource=f"organisation:{org_id}",
        debug_level=DebugLevel.ADMIN,
        metadata={"changed_fields": changed_fields},
    )
    logger.info(
        "Organisation updated",
        organisation_id=org_id,
        changed_fields=changed_fields,
    )

    return _to_response(existing, admin)


async def _apply_admin_update(
    org_id: str,
    current_admin: dict | None,
    patch,  # AdministratorUpdate
    current_user_id: str | None,
    now: datetime,
) -> dict | None:
    """Route admin-card edits (name/phone) to the admin UserDocument.

    Email is immutable after creation — not accepted in AdministratorUpdate.
    """
    if current_admin is None:
        raise DomainException(
            message="Organisation has no administrator to update",
            code="ADMIN_NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )

    update_fields: dict = {}
    if patch.name is not None:
        name_parts = patch.name.split(maxsplit=1)
        update_fields["first_name"] = name_parts[0]
        update_fields["last_name"] = name_parts[1] if len(name_parts) > 1 else ""
    if patch.phone is not None:
        update_fields["phone"] = patch.phone

    if update_fields:
        update_fields["modified_by"] = current_user_id
        update_fields["modified_on"] = now
        return await user_repo.update_user(current_admin["id"], update_fields)

    return await user_repo.get_user_by_id(current_admin["id"])


def _to_response(org_doc: dict, admin_doc: dict | None) -> OrganisationResponse:
    administrator = None
    if admin_doc:
        full_name = " ".join(
            p for p in [admin_doc.get("first_name", ""), admin_doc.get("last_name", "")] if p
        )
        administrator = AdministratorView(
            user_id=admin_doc["id"],
            name=full_name,
            email=admin_doc["email"],
            phone=admin_doc.get("phone"),
            pending_email=admin_doc.get("pending_email"),
        )
    return OrganisationResponse(
        id=str(org_doc["id"]),
        legal_name=org_doc["legal_name"],
        logo_asset_id=str(org_doc["logo_asset_id"]) if org_doc.get("logo_asset_id") else None,
        is_active=org_doc["is_active"],
        enabled_modules=org_doc.get("enabled_modules") or [],
        administrator=administrator,
        created_on=org_doc.get("created_on"),
        modified_on=org_doc.get("modified_on"),
    )
