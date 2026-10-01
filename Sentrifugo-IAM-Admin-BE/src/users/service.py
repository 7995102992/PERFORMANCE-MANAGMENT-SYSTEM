from datetime import datetime, timezone

from beanie import PydanticObjectId
from fastapi import status

from src.auth.schemas import UserBase
from src.auth.service import send_activation_email
from src.auth.utils.tools import get_password_hash
from src.auth.utils.user_session import delete_all_user_sessions_for_user
from src.auth.utils.sessions import revoke_all_user_sessions
from src.auth.utils.mpin import revoke_all_device_tokens
from src.correlation import get_correlation_id
from src.exceptions import DomainException
from src.logger import logger
from src.models import StatusEnum, is_activation_pending
from src.policies.utils import grants as policy_repo
from src.rabbitmq import DebugLevel, outbox
from src.users.utils import tools as repository
from src.assets import asset_service
from src.users.schemas import UserCreate, UserResponse, UserUpdate


def _scope_org(caller: UserBase | None) -> str | None:
    """Return the org_id to filter queries by, or None for no scoping.

    Super admins (and an absent caller, e.g. in unit tests) see all orgs.
    """
    if caller is None or caller.is_super_admin:
        return None
    return caller.organisation_id


def _resolve_target_org(caller: UserBase | None, requested_org: str | None) -> str | None:
    """Resolve which org a new entity should belong to.

    - Super admins (or no caller) can specify any org or leave it null.
    - Non-admins always land in their own org; any requested_org is ignored.
    """
    if caller is None or caller.is_super_admin:
        return requested_org
    return caller.organisation_id


async def create_user(
    data: UserCreate,
    current_user_id: str | None = None,
    caller: UserBase | None = None,
) -> UserResponse:
    """Create a new user after checking for duplicates."""
    if await repository.get_user_by_email(data.email):
        raise DomainException(
            message="Email already exists",
            code="EMAIL_ALREADY_EXISTS",
            status_code=status.HTTP_409_CONFLICT,
        )

    if data.auth_method == "local" and not data.password and not data.send_activation:
        raise DomainException(
            message="Password is required for local auth (or set send_activation=true)",
            code="PASSWORD_REQUIRED",
            status_code=status.HTTP_400_BAD_REQUEST,
        )

    if data.auth_method == "azure_sso" and not data.azure_oid:
        raise DomainException(
            message="Azure OID is required for SSO auth",
            code="AZURE_OID_REQUIRED",
            status_code=status.HTTP_400_BAD_REQUEST,
        )

    is_local = data.auth_method == "local"

    now = datetime.now(timezone.utc)
    user_doc = {
        "email": data.email,
        "password_hash": get_password_hash(data.password) if data.password else None,
        "auth_method": data.auth_method,
        "azure_oid": data.azure_oid,
        "first_name": data.first_name,
        "last_name": data.last_name,
        "middle_name": data.middle_name,
        "phone": data.phone,
        "avatar_url": data.avatar_url,
        "avatar_asset_id": data.avatar_asset_id,
        "dob": data.dob,
        "gender": data.gender,
        "marital_status": data.marital_status,
        "is_org_admin": data.is_org_admin,
        "status": StatusEnum.INACTIVE if is_local else StatusEnum.ACTIVE,
        "last_login_at": None,
        "password_changed_at": now if data.password else None,
        "organisation_id": _resolve_target_org(caller, data.organisation_id),
        "created_by": current_user_id,
        "created_on": now,
        "modified_by": current_user_id,
        "modified_on": now,
        "deleted_by": None,
        "deleted_on": None,
        "correlation_id": get_correlation_id(),
    }
    created = await repository.create_user(user_doc)

    await outbox.publish(
        "user.created",
        {
            "correlation_id": get_correlation_id(),
            "user_id": created["id"],
            "email": created["email"],
            "first_name": created["first_name"],
            "last_name": created["last_name"],
            "auth_method": created["auth_method"],
            "status": created["status"],
            "created_on": created["created_on"].isoformat() if created.get("created_on") else None,
        },
        idempotency_key=f"user.created:{created['id']}",
    )

    await outbox.publish_audit_log(
        module="users",
        actor_id=current_user_id or "system",
        action="created",
        resource=f"user:{created['id']}",
        debug_level=DebugLevel.HR,
        organisation_id=str(user_doc["organisation_id"]) if user_doc.get("organisation_id") else None,
    )

    if is_local or data.send_activation:
        is_admin_portal = bool(created.get("is_super_admin") or created.get("is_org_admin"))
        await send_activation_email(
            created["id"], created["email"], _full_name(created),
            tenant_id=str(created.get("organisation_id", "")),
            is_admin_portal=is_admin_portal,
        )

    return _to_response(created)


async def get_user(user_id: str, caller: UserBase | None = None) -> UserResponse:
    """Fetch a single user by id, scoped to caller's org (super admins see all)."""
    user = await repository.get_user_by_id(user_id)
    if not user:
        raise DomainException(
            message="User not found",
            code="USER_NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )
    scope = _scope_org(caller)
    if scope is not None and user.get("organisation_id") != scope:
        # Cross-org lookup — hide existence
        raise DomainException(
            message="User not found",
            code="USER_NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )
    return _to_response(user)


async def list_users(
    skip: int = 0,
    limit: int = 20,
    caller: UserBase | None = None,
    is_org_admin: bool | None = None,
    organisation_id: str | None = None,
) -> list[UserResponse]:
    """Return a paginated list of users, scoped to caller's org."""
    org_scope = _scope_org(caller)
    if org_scope is None and organisation_id is not None:
        org_scope = organisation_id
    users = await repository.list_users(
        skip, limit,
        organisation_id=org_scope,
        is_org_admin=is_org_admin,
    )
    return [_to_response(u) for u in users]


async def search_users(
    query: str,
    skip: int = 0,
    limit: int = 20,
    caller: UserBase | None = None,
) -> list[UserResponse]:
    """Search users by email or display name, scoped to caller's org."""
    users = await repository.search_users(query, skip, limit, organisation_id=_scope_org(caller))
    return [_to_response(u) for u in users]


async def update_user(
    user_id: str,
    data: UserUpdate,
    current_user_id: str | None = None,
    caller: UserBase | None = None,
) -> UserResponse:
    """Partially update a user, scoped to caller's org."""
    update_fields = data.model_dump(exclude_none=True)
    if not update_fields:
        raise DomainException(
            message="No fields to update",
            code="INVALID_INPUT",
            status_code=status.HTTP_400_BAD_REQUEST,
        )

    # Org scope check (hide existence across orgs)
    existing = await repository.get_user_by_id(user_id)
    if not existing:
        raise DomainException(
            message="User not found",
            code="USER_NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )
    scope = _scope_org(caller)
    if scope is not None and existing.get("organisation_id") != scope:
        raise DomainException(
            message="User not found",
            code="USER_NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )

    update_fields["modified_by"] = current_user_id
    update_fields["modified_on"] = datetime.now(timezone.utc)
    update_fields["correlation_id"] = get_correlation_id()
    user = await repository.update_user(user_id, update_fields)
    if not user:
        raise DomainException(
            message="User not found",
            code="USER_NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )
    # Deactivating an account must terminate its live credentials (H8): a user
    # flipped to INACTIVE keeps no valid sessions, cached access tokens, or mPIN
    # device tokens. Applied here as well as in delete_user so any status change
    # to INACTIVE is covered.
    if str(update_fields.get("status")) == StatusEnum.INACTIVE:
        await revoke_all_user_sessions(user_id)
        await delete_all_user_sessions_for_user(user_id)
        await revoke_all_device_tokens(user_id)
    await outbox.publish_audit_log(
        module="users",
        actor_id=current_user_id or "system",
        action="updated",
        resource=f"user:{user_id}",
        debug_level=DebugLevel.MANAGER,
        organisation_id=str(user["organisation_id"]) if user.get("organisation_id") else None,
        metadata={"changed_fields": list(data.model_dump(exclude_none=True).keys())},
    )
    return _to_response(user)


async def update_me(
    user_id: str,
    data,
) -> UserResponse:
    """Self-service profile update for the authenticated user.

    Restricted to safe profile fields (see MeUpdate). No org-scope check —
    the caller is updating themselves.
    """
    update_fields = data.model_dump(exclude_none=True)
    if not update_fields:
        raise DomainException(
            message="No fields to update",
            code="INVALID_INPUT",
            status_code=status.HTTP_400_BAD_REQUEST,
        )

    update_fields["modified_by"] = user_id
    update_fields["modified_on"] = datetime.now(timezone.utc)
    update_fields["correlation_id"] = get_correlation_id()

    user = await repository.update_user(user_id, update_fields)
    if not user:
        raise DomainException(
            message="User not found",
            code="USER_NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )
    await outbox.publish_audit_log(
        module="users",
        actor_id=user_id,
        action="self_updated",
        resource=f"user:{user_id}",
        debug_level=DebugLevel.MANAGER,
        organisation_id=str(user["organisation_id"]) if user.get("organisation_id") else None,
        metadata={"changed_fields": list(data.model_dump(exclude_none=True).keys())},
    )
    return _to_response(user)


ALLOWED_PHOTO_TYPES = {"image/jpeg", "image/png"}
MAX_PHOTO_SIZE = 2 * 1024 * 1024  # 2 MB


async def upload_profile_photo(user_id: str, file) -> UserResponse:
    """Upload a profile photo and update the user's avatar_url."""

    file_bytes = await file.read()
    content_type = file.content_type or "application/octet-stream"

    if len(file_bytes) > MAX_PHOTO_SIZE:
        raise DomainException(
            message="File exceeds 2MB limit",
            code="FILE_TOO_LARGE",
            status_code=status.HTTP_400_BAD_REQUEST,
        )
    if content_type not in ALLOWED_PHOTO_TYPES:
        raise DomainException(
            message="Only JPEG and PNG images are allowed",
            code="INVALID_FILE_TYPE",
            status_code=status.HTTP_400_BAD_REQUEST,
        )

    # Remember the current photo so it can be discarded once the new one is
    # saved — otherwise every re-upload leaks an orphan in Spaces.
    existing = await repository.get_user_by_id(user_id)
    previous_asset_id = (existing or {}).get("avatar_asset_id")

    await file.seek(0)
    asset = await asset_service.upload(file, "profile-photos")

    update_fields = {
        "avatar_url": asset.file_url,
        "avatar_asset_id": str(asset.id),
        "modified_by": user_id,
        "modified_on": datetime.now(timezone.utc),
        "correlation_id": get_correlation_id(),
    }
    user = await repository.update_user(user_id, update_fields)
    if not user:
        raise DomainException(
            message="User not found",
            code="USER_NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )
    await _publish_avatar_changed(user_id, user, idempotency_suffix=str(asset.id))
    await _discard_asset(previous_asset_id)
    await outbox.publish_audit_log(
        module="users",
        actor_id=user_id,
        action="profile_photo_updated",
        resource=f"user:{user_id}",
        debug_level=DebugLevel.MANAGER,
        organisation_id=str(user["organisation_id"]) if user.get("organisation_id") else None,
        metadata={"asset_url": asset.file_url},
    )
    return _to_response(user)


async def delete_profile_photo(user_id: str) -> UserResponse:
    """Remove the user's profile photo: clear avatar_url/avatar_asset_id and
    delete the stored asset. Idempotent — a user with no photo is a no-op."""
    existing = await repository.get_user_by_id(user_id)
    if not existing:
        raise DomainException(
            message="User not found",
            code="USER_NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )
    previous_asset_id = existing.get("avatar_asset_id")
    if not existing.get("avatar_url") and not previous_asset_id:
        return _to_response(existing)

    user = await repository.update_user(
        user_id,
        {
            "avatar_url": None,
            "avatar_asset_id": None,
            "modified_by": user_id,
            "modified_on": datetime.now(timezone.utc),
            "correlation_id": get_correlation_id(),
        },
    )
    if not user:
        raise DomainException(
            message="User not found",
            code="USER_NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )
    await _publish_avatar_changed(user_id, user, idempotency_suffix="removed")
    await _discard_asset(previous_asset_id)
    await outbox.publish_audit_log(
        module="users",
        actor_id=user_id,
        action="profile_photo_removed",
        resource=f"user:{user_id}",
        debug_level=DebugLevel.MANAGER,
        organisation_id=str(user["organisation_id"]) if user.get("organisation_id") else None,
    )
    return _to_response(user)


async def _publish_avatar_changed(user_id: str, user: dict, *, idempotency_suffix: str) -> None:
    """Fan the new avatar out to the other services. They replicate IAM users
    from ``user.updated`` (LMS, SRM…) — without this event a photo uploaded
    here never reaches a leave request, calendar or ticket screen."""
    await outbox.publish(
        "user.updated",
        {
            "correlation_id": get_correlation_id(),
            "user_id": user_id,
            "avatar_url": user.get("avatar_url"),
            "avatar_asset_id": user.get("avatar_asset_id"),
            "changed_fields": ["avatar_url", "avatar_asset_id"],
        },
        idempotency_key=f"user.avatar_changed:{user_id}:{idempotency_suffix}",
    )


async def _discard_asset(asset_id: str | None) -> None:
    """Best-effort delete of a superseded/removed photo. Storage cleanup must
    never fail the profile update that already succeeded."""
    if not asset_id:
        return
    try:
        await asset_service.delete(PydanticObjectId(asset_id))
    except Exception as exc:  # noqa: BLE001
        logger.warning("Failed to discard old profile photo", asset_id=asset_id, error=str(exc))


async def delete_user(
    user_id: str,
    current_user_id: str | None = None,
    caller: UserBase | None = None,
) -> None:
    """Soft-delete a user, scoped to caller's org."""
    user = await repository.get_user_by_id(user_id)
    if not user:
        raise DomainException(
            message="User not found",
            code="USER_NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )
    scope = _scope_org(caller)
    if scope is not None and user.get("organisation_id") != scope:
        raise DomainException(
            message="User not found",
            code="USER_NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )

    now = datetime.now(timezone.utc)
    await repository.update_user(user_id, {
        "deleted_by": current_user_id,
        "deleted_on": now,
        "modified_by": current_user_id,
        "modified_on": now,
        "status": StatusEnum.INACTIVE,
        "correlation_id": get_correlation_id(),
    })
    # Kick the deleted account out everywhere (H8): revoke refresh sessions,
    # purge cached access-token sessions, and drop mPIN device tokens so a
    # soft-deleted user can neither keep using nor refresh existing credentials.
    await revoke_all_user_sessions(user_id)
    await delete_all_user_sessions_for_user(user_id)
    await revoke_all_device_tokens(user_id)
    # Downstream replicas (e.g. Leave Management) gate on the user account
    # lifecycle — without this event their `users` copy never learns of the
    # deletion.
    await outbox.publish(
        "user.deleted",
        {
            "correlation_id": get_correlation_id(),
            "user_id": user_id,
        },
        idempotency_key=f"user.deleted:{user_id}",
    )
    await outbox.publish_audit_log(
        module="users",
        actor_id=current_user_id or "system",
        action="deleted",
        resource=f"user:{user_id}",
        debug_level=DebugLevel.HR,
        organisation_id=str(user["organisation_id"]) if user.get("organisation_id") else None,
    )


# ---------------------------------------------------------------------------
# Policy attachment — users.policy_ids CRUD
#
# The policy is looked up in PolicyDocument (new model). Org-match guard:
# policy and user must share an organisation_id (null matches null for
# super-admin-owned globals). Caller must be a super admin, or an org admin
# acting within their own tenant — the `require_permission('users', 'update')`
# gate in the router handles that and _check_user_in_scope double-locks it.
# ---------------------------------------------------------------------------
async def attach_policy_to_user(
    user_id: str,
    policy_id: str,
    caller: UserBase | None = None,
) -> UserResponse:
    user = await repository.get_user_by_id(user_id)
    if not user:
        raise DomainException(
            message="User not found",
            code="USER_NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )
    scope = _scope_org(caller)
    if scope is not None and user.get("organisation_id") != scope:
        # Cross-org lookup — hide existence.
        raise DomainException(
            message="User not found",
            code="USER_NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )

    policy = await policy_repo.get_policy_by_id(policy_id)
    if not policy:
        raise DomainException(
            message="Policy not found",
            code="POLICY_NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )
    if scope is not None and policy.get("organisation_id") != scope:
        raise DomainException(
            message="Policy not found",
            code="POLICY_NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )

    # Tenant boundary: user and policy must share an org. Null matches null.
    if policy.get("organisation_id") != user.get("organisation_id"):
        raise DomainException(
            message="User and policy belong to different organisations",
            code="ORG_MISMATCH",
            status_code=status.HTTP_400_BAD_REQUEST,
        )

    updated = await repository.attach_policy(user_id, policy_id)
    if not updated:
        # Race — user disappeared between the two reads.
        raise DomainException(
            message="User not found",
            code="USER_NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )

    # Cached session is now stale — drop it so the next request rebuilds.
    try:
        await delete_all_user_sessions_for_user(user_id)
    except Exception as exc:
        logger.warning(
            "Failed to invalidate permissions cache after attach",
            user_id=user_id, error=str(exc),
        )

    await outbox.publish(
        "user.updated",
        {
            "correlation_id": get_correlation_id(),
            "user_id": user_id,
            "policy_ids": [str(pid) for pid in (updated.get("policy_ids") or [])],
        },
        idempotency_key=f"user.policy_attached:{user_id}:{policy_id}",
    )

    logger.info("Policy attached to user", user_id=user_id, policy_id=policy_id)
    return _to_response(updated)


async def detach_policy_from_user(
    user_id: str,
    policy_id: str,
    caller: UserBase | None = None,
) -> None:
    user = await repository.get_user_by_id(user_id)
    if not user:
        raise DomainException(
            message="User not found",
            code="USER_NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )
    scope = _scope_org(caller)
    if scope is not None and user.get("organisation_id") != scope:
        raise DomainException(
            message="User not found",
            code="USER_NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )

    was_attached, _ = await repository.detach_policy(user_id, policy_id)
    if not was_attached:
        raise DomainException(
            message="Policy is not attached to this user",
            code="POLICY_NOT_ATTACHED",
            status_code=status.HTTP_404_NOT_FOUND,
        )

    try:
        await delete_all_user_sessions_for_user(user_id)
    except Exception as exc:
        logger.warning(
            "Failed to invalidate permissions cache after detach",
            user_id=user_id, error=str(exc),
        )

    user_after = await repository.get_user_by_id(user_id)
    await outbox.publish(
        "user.updated",
        {
            "correlation_id": get_correlation_id(),
            "user_id": user_id,
            "policy_ids": [str(pid) for pid in ((user_after or {}).get("policy_ids") or [])],
        },
        idempotency_key=f"user.policy_detached:{user_id}:{policy_id}",
    )

    logger.info("Policy detached from user", user_id=user_id, policy_id=policy_id)


async def resend_activation_for_user(user_id: str, caller: UserBase) -> dict:
    """Admin-triggered resend of the activation email for a pending account.

    Scoping mirrors the rest of the module: super admins may resend for any
    user; org admins only for users in their own org. Guards run in order:
    not-deleted -> in-scope -> local-auth -> pending-activation.
    """
    user = await repository.get_user_by_id(user_id)
    if not user or user.get("deleted_on") is not None:
        raise DomainException(
            message="User not found",
            code="USER_NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )

    # Org scope — hide existence across orgs (same pattern as get_user).
    scope = _scope_org(caller)
    if scope is not None and user.get("organisation_id") != scope:
        raise DomainException(
            message="User not found",
            code="USER_NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )

    # SSO accounts have no email-activation flow.
    if user.get("auth_method") not in ("local", "seeded"):
        raise DomainException(
            message="This account uses SSO and cannot be activated via email.",
            code="SSO_ACCOUNT",
            status_code=status.HTTP_400_BAD_REQUEST,
        )

    # Only never-activated (pending) accounts are eligible.
    if not is_activation_pending(user):
        if user.get("status") == StatusEnum.ACTIVE:
            raise DomainException(
                message="Account is already activated.",
                code="ALREADY_ACTIVATED",
                status_code=status.HTTP_409_CONFLICT,
            )
        raise DomainException(
            message="This account is deactivated, not pending activation.",
            code="NOT_PENDING_ACTIVATION",
            status_code=status.HTTP_409_CONFLICT,
        )

    # Don't resend activation for employees in an ended-employment status
    # (Exit / Retired / Terminated / Absconded — all is_active=false in master data).
    from src.auth.service import _has_ended_employment_status
    if await _has_ended_employment_status(user["id"]):
        raise DomainException(
            message="This employee's employment has ended; activation cannot be resent.",
            code="EMPLOYMENT_ENDED",
            status_code=status.HTTP_409_CONFLICT,
        )

    await send_activation_email(
        user["id"], user["email"], _full_name(user),
        tenant_id=str(user.get("organisation_id", "")),
    )
    await outbox.publish_audit_log(
        module="users",
        actor_id=str(caller.id),
        action="activation_resent",
        resource=f"user:{user['id']}",
        debug_level=DebugLevel.HR,
        organisation_id=str(user["organisation_id"]) if user.get("organisation_id") else None,
    )
    logger.info("Activation email resent", user_id=user["id"], by=str(caller.id))
    return {"message": "Activation email has been resent."}


def _full_name(doc: dict) -> str:
    parts = [doc.get("first_name", ""), doc.get("middle_name"), doc.get("last_name", "")]
    return " ".join(p for p in parts if p)


def _to_response(user_doc: dict) -> UserResponse:
    return UserResponse(
        id=user_doc["id"],
        email=user_doc["email"],
        auth_method=user_doc["auth_method"],
        azure_oid=user_doc.get("azure_oid"),
        first_name=user_doc["first_name"],
        last_name=user_doc["last_name"],
        middle_name=user_doc.get("middle_name"),
        phone=user_doc.get("phone"),
        avatar_url=user_doc.get("avatar_url"),
        avatar_asset_id=user_doc.get("avatar_asset_id"),
        dob=user_doc.get("dob"),
        gender=user_doc.get("gender"),
        marital_status=user_doc.get("marital_status"),
        status=StatusEnum(user_doc["status"]),
        organisation_id=user_doc.get("organisation_id"),
        is_org_admin=bool(user_doc.get("is_org_admin", False)),
        pending_email=user_doc.get("pending_email"),
        policy_ids=list(user_doc.get("policy_ids") or []),
        last_login_at=user_doc.get("last_login_at"),
        password_changed_at=user_doc.get("password_changed_at"),
        activated_at=user_doc.get("activated_at"),
        activation_pending=is_activation_pending(user_doc),
        created_on=user_doc.get("created_on"),
        modified_on=user_doc.get("modified_on"),
    )
