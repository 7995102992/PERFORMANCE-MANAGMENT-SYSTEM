from datetime import datetime, timedelta, timezone

from fastapi import status

from src.auth.config import auth_settings
from src.auth.schemas import ChangePasswordRequest, LoginRequest, TokenResponse, UserBase
from src.auth.utils.activation import (
    delete_activation_token,
    generate_activation_token,
    get_user_id_by_activation_token,
    store_activation_token,
)
from src.auth.utils.email_change import (
    delete_email_change_token,
    generate_email_change_token,
    get_email_change_payload,
    store_email_change_token,
)
from src.auth.utils.email_events import (
    _frontend_base,
    publish_activation_email,
    publish_email_change_confirmation_email,
    publish_password_reset_email,
)
from src.auth.utils.password_reset import (
    delete_password_reset_token,
    generate_password_reset_token,
    get_user_id_by_password_reset_token,
    store_password_reset_token,
)
from src.auth.utils.sessions import (
    create_session,
    get_session_by_token,
    revoke_all_user_sessions,
    revoke_session,
)
from src.auth.utils.user_session import (
    create_user_session,
    delete_all_user_sessions_for_user,
    delete_user_session,
    revoke_access_token,
)
from src.auth.utils.mpin import (
    generate_device_token,
    store_device_token,
    get_device_session,
    touch_device_token,
    revoke_all_device_tokens,
    record_failed_attempt,
    is_device_locked,
    clear_failed_attempts,
    MAX_ATTEMPTS,
)
from src.auth.utils import login_throttle
from src.auth.utils.tools import fake_verify_password, get_password_hash, verify_password
from src.rabbitmq import DebugLevel, outbox
from src.auth.utils.oauth2 import (
    create_access_token,
    generate_refresh_token,
    hash_refresh_token,
)
from src.auth.models import PasswordHistoryDocument
from src.correlation import get_correlation_id
from src.models import ACCESS_STATUSES, StatusEnum
from src.exceptions import DomainException
from src.logger import logger
from src.users.utils import tools as repository


async def authenticate_user(
    data: LoginRequest,
    ip_address: str,
    user_agent: str,
    require_super_admin: bool = False,
) -> TokenResponse:
    """Authenticate via email/password, return access + refresh tokens.

    If `require_super_admin` is True (e.g. the super-admin portal route),
    reject users who aren't super admins. The rejection happens AFTER the
    password check so the response time and error surface don't leak
    whether a given email belongs to a super admin.
    """
    # Brute-force / password-spray guard (F-07): reject early if this email/IP
    # has exceeded the failed-attempt threshold, before doing any password work.
    await login_throttle.check_not_locked(data.email, ip_address)

    user = await repository.get_user_by_email(data.email)
    if not user:
        # Constant-time (F-09): spend the same bcrypt time as a real user so the
        # response doesn't reveal whether the email exists.
        fake_verify_password(data.password)
        await login_throttle.record_failure(data.email, ip_address)
        await outbox.publish_audit_log(
            module="auth",
            actor_id=data.email,
            action="login_failed",
            resource=f"user:{data.email}",
            debug_level=DebugLevel.ADMIN,
            metadata={"reason": "unknown_user", "ip_address": ip_address},
        )
        raise DomainException(
            message="Incorrect email or password",
            code="UNAUTHORIZED",
            status_code=status.HTTP_401_UNAUTHORIZED,
        )
    # Password login is allowed for any account that has a local password set,
    # regardless of auth_method. SSO-only accounts have no password_hash and
    # fail naturally below, so they fall through to the standard error. This
    # lets a user log in with either their password or Microsoft SSO.
    if not user.get("password_hash"):
        # Constant-time (F-09): SSO-only accounts have no local hash; burn the
        # same bcrypt time so they're indistinguishable from a bad password.
        fake_verify_password(data.password)
        await login_throttle.record_failure(data.email, ip_address)
        raise DomainException(
            message="Incorrect email or password",
            code="UNAUTHORIZED",
            status_code=status.HTTP_401_UNAUTHORIZED,
        )
    if not verify_password(data.password, user["password_hash"]):
        await login_throttle.record_failure(data.email, ip_address)
        await outbox.publish_audit_log(
            module="auth",
            actor_id=user["id"],
            action="login_failed",
            resource=f"user:{user['id']}",
            debug_level=DebugLevel.ADMIN,
            organisation_id=str(user["organisation_id"]) if user.get("organisation_id") else None,
            metadata={"reason": "bad_password", "ip_address": ip_address},
        )
        raise DomainException(
            message="Incorrect email or password",
            code="UNAUTHORIZED",
            status_code=status.HTTP_401_UNAUTHORIZED,
        )

    if require_super_admin and not user.get("is_super_admin"):
        logger.info("Portal login denied for non-super-admin", user_id=user.get("id"))
        raise DomainException(
            message="This portal is restricted to platform administrators.",
            code="FORBIDDEN",
            status_code=status.HTTP_403_FORBIDDEN,
        )

    # Block users who cannot access the system. notice_period employees are
    # still working and must be allowed in; exit/inactive are blocked.
    if user.get("status") not in ACCESS_STATUSES:
        raise DomainException(
            message="Account is not activated. Please check your email for the activation link.",
            code="ACCOUNT_NOT_ACTIVATED",
            status_code=status.HTTP_403_FORBIDDEN,
        )

    # Check password expiry (skip for seeded users on first login)
    password_changed_at = user.get("password_changed_at")
    if password_changed_at is None and user.get("auth_method") == "seeded":
        # Seeded user first login — allow login but issue short-lived token
        # so they can call /auth/change-password
        await login_throttle.clear(data.email, ip_address)
        return await _issue_tokens(user, ip_address, user_agent, remember=data.remember)

    if auth_settings.PASSWORD_EXPIRY_DAYS > 0:
        if password_changed_at is None:
            raise DomainException(
                message="Password has expired. Please change your password.",
                code="PASSWORD_EXPIRED",
                status_code=status.HTTP_403_FORBIDDEN,
            )
        if password_changed_at.tzinfo is None:
            password_changed_at = password_changed_at.replace(tzinfo=timezone.utc)
        expiry_date = password_changed_at + timedelta(days=auth_settings.PASSWORD_EXPIRY_DAYS)
        if datetime.now(timezone.utc) > expiry_date:
            raise DomainException(
                message="Password has expired. Please change your password.",
                code="PASSWORD_EXPIRED",
                status_code=status.HTTP_403_FORBIDDEN,
            )

    await login_throttle.clear(data.email, ip_address)
    return await _issue_tokens(user, ip_address, user_agent, remember=data.remember)


async def refresh_access_token(
    refresh_token: str,
    ip_address: str,
    user_agent: str,
) -> TokenResponse:
    """Validate a refresh token and issue new access + refresh tokens."""
    token_hash = hash_refresh_token(refresh_token)
    session = await get_session_by_token(token_hash)
    if not session:
        logger.warning("Refresh failed: no session found for token hash", token_hash_prefix=token_hash[:8])
        raise DomainException(
            message="Invalid or expired refresh token",
            code="INVALID_REFRESH_TOKEN",
            status_code=status.HTTP_401_UNAUTHORIZED,
        )

    # Revoke the old session (rotate refresh token)
    await revoke_session(token_hash, session["user_id"])

    user = await repository.get_user_by_id(session["user_id"])
    if not user:
        logger.warning("Refresh failed: user not found", user_id=session["user_id"])
        raise DomainException(
            message="User not found",
            code="USER_NOT_FOUND",
            status_code=status.HTTP_401_UNAUTHORIZED,
        )

    # A soft-deleted or deactivated account must NOT be able to mint fresh tokens
    # via refresh (mirrors the status/deleted_on gate in authenticate_user). Purge
    # any lingering sessions + device tokens so cached access tokens die too.
    if user.get("deleted_on") is not None or user.get("status") not in ACCESS_STATUSES:
        logger.warning(
            "Refresh rejected: account deleted or not active",
            user_id=session["user_id"], status=user.get("status"),
        )
        await revoke_all_user_sessions(session["user_id"])
        await delete_all_user_sessions_for_user(session["user_id"])
        await revoke_all_device_tokens(session["user_id"])
        raise DomainException(
            message="Account is no longer active",
            code="ACCOUNT_INACTIVE",
            status_code=status.HTTP_401_UNAUTHORIZED,
        )

    return await _issue_tokens(
        user, ip_address, user_agent,
        remember=session.get("remember", False), event="token_refreshed",
    )


async def get_user_by_email(email: str) -> UserBase | None:
    """Fetch a user by email from MongoDB. Used by JWT dependency."""
    user = await repository.get_user_by_email(email)
    if not user:
        return None
    return UserBase(
        id=user["id"],
        email=user["email"],
        first_name=user.get("first_name"),
        last_name=user.get("last_name"),
        is_super_admin=user.get("is_super_admin", False),
        is_org_admin=user.get("is_org_admin", False),
        organisation_id=user.get("organisation_id"),
    )


async def _issue_tokens(user: dict, ip_address: str, user_agent: str, remember: bool = False, event: str = "login") -> TokenResponse:
    """Create access token + refresh token + session record + user-session cache.

    `remember` selects the refresh-token lifetime: the long
    REMEMBER_REFRESH_TOKEN_EXPIRE_DAYS window when the user ticked "Remember me",
    otherwise the short REFRESH_TOKEN_EXPIRE_DAYS default.
    """
    access_token = create_access_token(data={"sub": user["email"], "uid": user["id"]})

    expire_days = (
        auth_settings.REMEMBER_REFRESH_TOKEN_EXPIRE_DAYS
        if remember
        else auth_settings.REFRESH_TOKEN_EXPIRE_DAYS
    )
    raw_refresh = generate_refresh_token(user["id"], expire_days)
    refresh_hash = hash_refresh_token(raw_refresh)
    expires_at = datetime.now(timezone.utc) + timedelta(days=expire_days)

    await create_session(
        user_id=user["id"],
        refresh_token_hash=refresh_hash,
        expires_at=expires_at,
        auth_method=user.get("auth_method", "local"),
        ip_address=ip_address,
        user_agent=user_agent,
        remember=remember,
    )

    # Downstream services look up user context by access token.
    await create_user_session(access_token, user)

    # Update last_login_at
    await repository.update_user(user["id"], {"last_login_at": datetime.now(timezone.utc)})

    await outbox.publish_audit_log(
        module="auth",
        actor_id=user["id"],
        action=event,
        resource=f"user:{user['id']}",
        debug_level=DebugLevel.EMPLOYEE,
        organisation_id=str(user["organisation_id"]) if user.get("organisation_id") else None,
        metadata={"auth_method": user.get("auth_method", "local"), "ip_address": ip_address},
    )

    return TokenResponse(
        access_token=access_token,
        refresh_token=raw_refresh,
        token_type="bearer",
    )


async def change_password(user_id: str, data: ChangePasswordRequest) -> dict:
    """Change a user's password with history check and session revocation."""
    user = await repository.get_user_by_id(user_id)
    if not user:
        raise DomainException(
            message="User not found",
            code="USER_NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )

    # Verify current password
    if not user.get("password_hash") or not verify_password(data.current_password, user["password_hash"]):
        raise DomainException(
            message="Current password is incorrect",
            code="INCORRECT_PASSWORD",
            status_code=status.HTTP_400_BAD_REQUEST,
        )

    # Check new password against history
    if auth_settings.PASSWORD_HISTORY_COUNT > 0:
        history = await PasswordHistoryDocument.find(
            PasswordHistoryDocument.user_id == user_id,
        ).sort("-changed_at").limit(auth_settings.PASSWORD_HISTORY_COUNT).to_list()

        for entry in history:
            if verify_password(data.new_password, entry.password_hash):
                raise DomainException(
                    message=f"Cannot reuse any of the last {auth_settings.PASSWORD_HISTORY_COUNT} passwords",
                    code="PASSWORD_RECENTLY_USED",
                    status_code=status.HTTP_400_BAD_REQUEST,
                )

        # Also check against current password
        if verify_password(data.new_password, user["password_hash"]):
            raise DomainException(
                message="New password must be different from current password",
                code="PASSWORD_RECENTLY_USED",
                status_code=status.HTTP_400_BAD_REQUEST,
            )

    # Save current password to history
    now = datetime.now(timezone.utc)
    await PasswordHistoryDocument(
        user_id=user_id,
        password_hash=user["password_hash"],
        changed_at=now,
    ).insert()

    # Update password
    new_hash = get_password_hash(data.new_password)
    await repository.update_user(user_id, {
        "password_hash": new_hash,
        "password_changed_at": now,
        "correlation_id": get_correlation_id(),
    })

    # Revoke all sessions (force re-login) — both refresh and access-token caches
    await revoke_all_user_sessions(user_id)
    await delete_all_user_sessions_for_user(user_id)
    await revoke_all_device_tokens(user_id)

    await outbox.publish_audit_log(
        module="auth",
        actor_id=user_id,
        action="password_changed",
        resource=f"user:{user_id}",
        debug_level=DebugLevel.HR,
        organisation_id=str(user["organisation_id"]) if user.get("organisation_id") else None,
    )
    logger.info("Password changed", user_id=user_id)
    return {"message": "Password changed successfully"}


# ---------------------------------------------------------------------------
# Account activation
# ---------------------------------------------------------------------------
async def send_activation_email(
    user_id: str,
    email: str,
    full_name: str,
    tenant_id: str = "",
    is_admin_portal: bool = False,
) -> None:
    """Generate activation + password-reset tokens and publish a single email.

    The activation email now embeds a password-setup link as a fallback so
    the user can set their password even if they close the browser after
    clicking the activation link. Both tokens share the same TTL
    (``ACTIVATION_TOKEN_EXPIRE_HOURS``) so the two links in one email never
    expire apart.

    ``is_admin_portal`` routes super/org admins to the admin portal; all
    other users are sent to the user portal.
    """
    activation_token = generate_activation_token(user_id)
    await store_activation_token(user_id, activation_token)

    reset_ttl_minutes = auth_settings.ACTIVATION_TOKEN_EXPIRE_HOURS * 60
    reset_token = generate_password_reset_token(user_id, ttl_minutes=reset_ttl_minutes)
    reset_ttl_seconds = reset_ttl_minutes * 60
    await store_password_reset_token(user_id, reset_token, ttl_seconds=reset_ttl_seconds)

    reset_link = f"{_frontend_base(is_admin_portal)}/reset-password?token={reset_token}"

    await publish_activation_email(
        email, full_name, activation_token,
        tenant_id=tenant_id,
        reset_link=reset_link,
        is_admin_portal=is_admin_portal,
    )


async def activate_account(token: str) -> dict:
    """Redeem the activation token, activate the account, and return a
    password-reset token so the frontend can redirect straight to the
    'set password' page — no second email required.

    If the user closes the browser before setting their password they can
    use the fallback reset link already embedded in the original
    activation email, or go through the 'Forgot Password' flow.
    """
    user_id = await get_user_id_by_activation_token(token)
    if not user_id:
        raise DomainException(
            message="Invalid or expired activation token",
            code="INVALID_ACTIVATION_TOKEN",
            status_code=status.HTTP_400_BAD_REQUEST,
        )

    user = await repository.get_user_by_id(user_id)
    if not user:
        raise DomainException(
            message="User not found",
            code="USER_NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )

    # Edge #13 — a live activation token must NOT (re)activate an account that
    # has since been deleted or deactivated by an admin. Burn the token and
    # reject. Deactivation here = previously activated (activated_at set) but no
    # longer ACTIVE; such accounts are re-enabled by an admin, never via email.
    if user.get("deleted_on") is not None:
        await delete_activation_token(token)
        raise DomainException(
            message="Invalid or expired activation token",
            code="INVALID_ACTIVATION_TOKEN",
            status_code=status.HTTP_400_BAD_REQUEST,
        )
    if user.get("status") != StatusEnum.ACTIVE and user.get("activated_at") is not None:
        await delete_activation_token(token)
        raise DomainException(
            message="This account has been deactivated. Please contact your administrator.",
            code="ACCOUNT_DEACTIVATED",
            status_code=status.HTTP_403_FORBIDDEN,
        )

    await delete_activation_token(token)

    # Only a genuinely unactivated (inactive) account gets flipped to active.
    # active / notice_period / exit are all "already activated" — never reset.
    already_active = user.get("status") != StatusEnum.INACTIVE

    if not already_active:
        now = datetime.now(timezone.utc)
        update_fields = {
            "status": StatusEnum.ACTIVE,
            "modified_on": now,
            "correlation_id": get_correlation_id(),
        }
        # Stamp the first-activation time exactly once — this is the source of
        # truth for "pending activation". Preserve it if somehow already set.
        if not user.get("activated_at"):
            update_fields["activated_at"] = now
        await repository.update_user(user_id, update_fields)

        await outbox.publish_audit_log(
            module="auth",
            actor_id=user_id,
            action="activated",
            resource=f"user:{user_id}",
            debug_level=DebugLevel.HR,
            organisation_id=str(user["organisation_id"]) if user.get("organisation_id") else None,
        )
        logger.info("Account activated", user_id=user_id)

    reset_token = generate_password_reset_token(user_id)
    await store_password_reset_token(user_id, reset_token)

    msg = (
        "Account is already activated. You can now set your password."
        if already_active
        else "Account activated successfully. Please set your password."
    )
    return {"message": msg, "password_reset_token": reset_token}


async def register_mpin_device(user_id: str, organisation_id: str | None = None) -> str:
    """Issue a device token for mPIN login. Call after a successful normal login."""
    token = generate_device_token()
    await store_device_token(user_id, token)
    logger.info("mPIN device registered", user_id=user_id)
    await outbox.publish_audit_log(
        module="auth",
        actor_id=user_id,
        action="mpin_device_registered",
        resource=f"user:{user_id}",
        debug_level=DebugLevel.EMPLOYEE,
        organisation_id=organisation_id,
    )
    return token


async def mpin_login(
    pin: str,
    device_token: str,
    ip_address: str,
    user_agent: str,
) -> TokenResponse:
    """Authenticate using a device token + payslip PIN."""
    invalid_exc = DomainException(
        message="Invalid device token or PIN",
        code="MPIN_INVALID",
        status_code=status.HTTP_401_UNAUTHORIZED,
    )

    device = await get_device_session(device_token)
    if not device:
        raise invalid_exc

    user_id = device["user_id"]

    if await is_device_locked(device_token):
        await outbox.publish_audit_log(
            module="auth",
            actor_id=user_id,
            action="mpin_login_locked",
            resource=f"user:{user_id}",
            debug_level=DebugLevel.EMPLOYEE,
        )
        raise DomainException(
            message=f"Too many failed attempts. Try again in 15 minutes.",
            code="MPIN_LOCKED",
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
        )

    user = await repository.get_user_by_id(user_id)
    if not user or user.get("status") not in ACCESS_STATUSES:
        raise invalid_exc

    org_id = str(user.get("organisation_id", "")) or None

    # Fetch and decrypt the payslip PIN
    try:
        from beanie import PydanticObjectId
        from src.modules.employee_pin.models import EmployeePinDocument
        from src.modules.employee_pin.crypto import pin_decrypt
        import hmac as _hmac

        user_oid = PydanticObjectId(user_id)
        pin_doc = await EmployeePinDocument.get_motor_collection().find_one(
            {"user_id": user_oid, "deleted_on": None, "cipher_text": {"$ne": None}},
            {"cipher_text": 1, "iv_key": 1},
        )
        if not pin_doc:
            raise invalid_exc

        stored_pin = pin_decrypt(pin_doc["cipher_text"], pin_doc["iv_key"])
    except DomainException:
        raise
    except Exception:
        raise invalid_exc

    if not _hmac.compare_digest(stored_pin, pin):
        attempts = await record_failed_attempt(device_token)
        remaining = MAX_ATTEMPTS - attempts
        if remaining <= 0:
            await outbox.publish_audit_log(
                module="auth",
                actor_id=user_id,
                action="mpin_login_locked",
                resource=f"user:{user_id}",
                debug_level=DebugLevel.EMPLOYEE,
                organisation_id=org_id,
            )
            raise DomainException(
                message="Too many failed attempts. Device locked for 15 minutes.",
                code="MPIN_LOCKED",
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            )
        await outbox.publish_audit_log(
            module="auth",
            actor_id=user_id,
            action="mpin_login_failed",
            resource=f"user:{user_id}",
            debug_level=DebugLevel.EMPLOYEE,
            organisation_id=org_id,
            metadata={"attempts_remaining": remaining},
        )
        raise DomainException(
            message=f"Invalid PIN. {remaining} attempt(s) remaining.",
            code="MPIN_INVALID",
            status_code=status.HTTP_401_UNAUTHORIZED,
        )

    await clear_failed_attempts(device_token)
    await touch_device_token(device_token)

    logger.info("mPIN login successful", user_id=user_id)
    return await _issue_tokens(user, ip_address, user_agent, event="mpin_login")


async def logout(
    user_id: str,
    access_token: str,
    refresh_token: str | None,
    all_devices: bool,
) -> dict:
    """End the current session.

    - Always deletes the access-token cache entry for the current request.
    - If `refresh_token` is passed, hashes it and revokes that one session.
    - If `all_devices` is True, purges all sessions + access-token caches
      for the user (use for 'sign out everywhere' UX, or on security events).

    Idempotent — logging out twice is a no-op, not an error.
    """
    await delete_user_session(access_token, user_id=user_id)
    # Denylist the token so the stateless JWT cold path also rejects it (F-13).
    await revoke_access_token(access_token)

    if all_devices:
        await revoke_all_user_sessions(user_id)
        await delete_all_user_sessions_for_user(user_id)
        await revoke_all_device_tokens(user_id)
    elif refresh_token:
        await revoke_session(hash_refresh_token(refresh_token), user_id)

    await outbox.publish_audit_log(
        module="auth",
        actor_id=user_id,
        action="logout",
        resource=f"user:{user_id}",
        debug_level=DebugLevel.EMPLOYEE,
        metadata={"all_devices": all_devices},
    )
    logger.info("Logout", user_id=user_id, all_devices=all_devices)
    return {"message": "Logged out"}


async def _has_ended_employment_status(user_id) -> bool:
    """True when the user's linked employee is in an ended-employment status
    (Exit / Retired / Terminated / Absconded — all is_active=false in master data).

    Used to suppress activation emails for employees who have left. Returns
    False for non-employee accounts (super/org admins) and for any status
    that is still active.
    """
    from beanie import PydanticObjectId
    from src.modules.organisation.models import EmployeeDocument
    from src.master_data.models import MasterDataDocument

    try:
        oid = user_id if isinstance(user_id, PydanticObjectId) else PydanticObjectId(str(user_id))
    except Exception:
        return False

    employee = await EmployeeDocument.find_one(EmployeeDocument.user_id == oid)
    if not employee or not employee.employment_status:
        return False
    md = await MasterDataDocument.get(employee.employment_status)
    return bool(md and not md.is_active)


async def resend_activation(email: str) -> dict:
    """Resend activation email for an inactive account."""
    user = await repository.get_user_by_email(email)
    if not user:
        # Return success even if user not found to prevent email enumeration
        return {"message": "If the email exists, an activation link has been sent"}

    if user.get("status") != StatusEnum.INACTIVE:
        raise DomainException(
            message="Account is already activated",
            code="ALREADY_ACTIVATED",
            status_code=status.HTTP_400_BAD_REQUEST,
        )

    # Don't resend activation for employees in an ended-employment status
    # (Exit / Retired / Terminated / Absconded — all is_active=false in master data).
    if await _has_ended_employment_status(user["id"]):
        # Same generic response — no link is dispatched.
        return {"message": "If the email exists, an activation link has been sent"}

    full_name = " ".join(p for p in [user.get("first_name", ""), user.get("last_name", "")] if p)
    is_admin_portal = bool(user.get("is_super_admin") or user.get("is_org_admin"))
    await send_activation_email(
        user["id"], user["email"], full_name,
        tenant_id=str(user.get("organisation_id", "")),
        is_admin_portal=is_admin_portal,
    )
    await outbox.publish_audit_log(
        module="auth",
        actor_id=user["id"],
        action="activation_resent",
        resource=f"user:{user['id']}",
        debug_level=DebugLevel.HR,
        organisation_id=str(user["organisation_id"]) if user.get("organisation_id") else None,
        metadata={"self_service": True},
    )
    return {"message": "If the email exists, an activation link has been sent"}


# ---------------------------------------------------------------------------
# Forgot / Reset password
# ---------------------------------------------------------------------------
_FORGOT_PASSWORD_OK = {
    "message": "If the email exists, a password reset link has been sent",
}


async def forgot_password(email: str) -> dict:
    """Begin the password-reset flow.

    Always returns the same success response regardless of whether the
    email exists or the account is eligible — prevents account enumeration.
    Only users with a local password (auth_method in {local, seeded}) who
    are active get an email dispatched; SSO / inactive users are silently
    skipped.
    """
    user = await repository.get_user_by_email(email)
    if not user:
        return _FORGOT_PASSWORD_OK

    # SSO users can't reset a local password — tell nobody.
    if user.get("auth_method") not in ("local", "seeded"):
        logger.info("Password reset skipped for SSO user", user_id=user["id"])
        return _FORGOT_PASSWORD_OK

    # Unactivated accounts should go through the activation flow, not reset.
    if user.get("status") not in ACCESS_STATUSES:
        logger.info("Password reset skipped for inactive user", user_id=user["id"])
        return _FORGOT_PASSWORD_OK

    token = generate_password_reset_token(user["id"])
    await store_password_reset_token(user["id"], token)
    full_name = " ".join(p for p in [user.get("first_name", ""), user.get("last_name", "")] if p)
    is_admin_portal = bool(user.get("is_super_admin") or user.get("is_org_admin"))
    await publish_password_reset_email(
        user["email"], full_name, token,
        tenant_id=str(user.get("organisation_id", "")),
        is_admin_portal=is_admin_portal,
    )
    await outbox.publish_audit_log(
        module="auth",
        actor_id=user["id"],
        action="password_reset_requested",
        resource=f"user:{user['id']}",
        debug_level=DebugLevel.ADMIN,
        organisation_id=str(user["organisation_id"]) if user.get("organisation_id") else None,
    )
    return _FORGOT_PASSWORD_OK


async def reset_password(token: str, new_password: str) -> dict:
    """Complete the password-reset flow by redeeming the token.

    On success: writes the new password hash + password_changed_at, appends
    the OLD hash to password history, deletes the one-time token, and
    revokes all existing sessions (refresh + access-token caches) so the
    attacker — if the token leaked — is kicked out along with everyone else.
    """
    user_id = await get_user_id_by_password_reset_token(token)
    if not user_id:
        raise DomainException(
            message="Invalid or expired reset token",
            code="INVALID_RESET_TOKEN",
            status_code=status.HTTP_400_BAD_REQUEST,
        )

    user = await repository.get_user_by_id(user_id)
    if not user:
        await delete_password_reset_token(token)
        raise DomainException(
            message="User not found",
            code="USER_NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )

    if user.get("status") not in ACCESS_STATUSES:
        raise DomainException(
            message="Please activate your account first using the activation link in your email.",
            code="ACCOUNT_NOT_ACTIVATED",
            status_code=status.HTTP_403_FORBIDDEN,
        )

    now = datetime.now(timezone.utc)

    # Password-history check — same policy as change_password.
    if auth_settings.PASSWORD_HISTORY_COUNT > 0:
        history = await PasswordHistoryDocument.find(
            PasswordHistoryDocument.user_id == user_id,
        ).sort("-changed_at").limit(auth_settings.PASSWORD_HISTORY_COUNT).to_list()

        for entry in history:
            if verify_password(new_password, entry.password_hash):
                raise DomainException(
                    message=f"Cannot reuse any of the last {auth_settings.PASSWORD_HISTORY_COUNT} passwords",
                    code="PASSWORD_RECENTLY_USED",
                    status_code=status.HTTP_400_BAD_REQUEST,
                )

        if user.get("password_hash") and verify_password(new_password, user["password_hash"]):
            raise DomainException(
                message="New password must be different from current password",
                code="PASSWORD_RECENTLY_USED",
                status_code=status.HTTP_400_BAD_REQUEST,
            )

    # Archive the old hash (if any) before overwriting.
    if user.get("password_hash"):
        await PasswordHistoryDocument(
            user_id=user_id,
            password_hash=user["password_hash"],
            changed_at=now,
        ).insert()

    await repository.update_user(user_id, {
        "password_hash": get_password_hash(new_password),
        "password_changed_at": now,
        "modified_on": now,
    })
    await delete_password_reset_token(token)

    # Kick everybody out — refresh and access-token caches both.
    await revoke_all_user_sessions(user_id)
    await delete_all_user_sessions_for_user(user_id)

    await outbox.publish_audit_log(
        module="auth",
        actor_id=user_id,
        action="password_reset_completed",
        resource=f"user:{user_id}",
        debug_level=DebugLevel.HR,
        organisation_id=str(user["organisation_id"]) if user.get("organisation_id") else None,
    )
    logger.info("Password reset", user_id=user_id)
    return {"message": "Password reset successfully"}


# ---------------------------------------------------------------------------
# Email-change flow (double opt-in via confirmation link to the NEW address)
# ---------------------------------------------------------------------------
async def initiate_email_change(user_id: str, new_email: str) -> dict:
    """Queue a pending email change and send a confirmation link.

    Validates that `new_email` isn't already in use (either as an active
    email or as another user's pending_email), stores the request in
    Valkey and on the UserDocument, and emails the NEW address. The old
    email stays active until the user clicks the confirmation link.
    """
    # Emails are case-insensitive — normalize so compare/clash/store are consistent.
    new_email = (new_email or "").strip().lower()
    user = await repository.get_user_by_id(user_id)
    if not user:
        raise DomainException(
            message="User not found",
            code="USER_NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )

    if user["email"] == new_email:
        # No-op — caller is asking to change to the same value.
        return {"message": "Email unchanged"}

    # Hard collision on active email
    clash = await repository.get_user_by_email(new_email)
    if clash and clash["id"] != user_id:
        raise DomainException(
            message="A user with this email already exists",
            code="EMAIL_ALREADY_EXISTS",
            status_code=status.HTTP_409_CONFLICT,
        )

    token = generate_email_change_token(user_id)
    await store_email_change_token(user_id, new_email, token)
    await repository.update_user(user_id, {
        "pending_email": new_email,
        "modified_on": datetime.now(timezone.utc),
    })
    full_name = " ".join(p for p in [user.get("first_name", ""), user.get("last_name", "")] if p)
    await publish_email_change_confirmation_email(new_email, full_name, token, tenant_id=str(user.get("organisation_id", "")))
    await outbox.publish_audit_log(
        module="auth",
        actor_id=user_id,
        action="email_change_initiated",
        resource=f"user:{user_id}",
        debug_level=DebugLevel.ADMIN,
        organisation_id=str(user["organisation_id"]) if user.get("organisation_id") else None,
        metadata={"new_email": new_email},
    )
    logger.info("Email change initiated", user_id=user_id)
    return {"message": "Confirmation email sent to the new address"}


async def confirm_email_change(token: str) -> dict:
    """Redeem an email-change token and swap the user's email address.

    Safety: re-checks that the new email isn't now taken by someone else
    (race against another sign-up) and that the user hasn't been soft-deleted.
    Revokes all sessions so existing clients re-authenticate with the new
    identifier.
    """
    payload = await get_email_change_payload(token)
    if not payload:
        raise DomainException(
            message="Invalid or expired confirmation token",
            code="INVALID_EMAIL_CHANGE_TOKEN",
            status_code=status.HTTP_400_BAD_REQUEST,
        )

    user_id = payload["user_id"]
    new_email = (payload["new_email"] or "").strip().lower()

    user = await repository.get_user_by_id(user_id)
    if not user:
        await delete_email_change_token(token)
        raise DomainException(
            message="User not found",
            code="USER_NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )

    # Race: someone else registered the email in the meantime.
    clash = await repository.get_user_by_email(new_email)
    if clash and clash["id"] != user_id:
        await delete_email_change_token(token)
        raise DomainException(
            message="Email address is no longer available",
            code="EMAIL_ALREADY_EXISTS",
            status_code=status.HTTP_409_CONFLICT,
        )

    now = datetime.now(timezone.utc)
    await repository.update_user(user_id, {
        "email": new_email,
        "pending_email": None,
        "modified_on": now,
    })
    await delete_email_change_token(token)

    # Boot existing sessions — the login identifier changed.
    await revoke_all_user_sessions(user_id)
    await delete_all_user_sessions_for_user(user_id)

    await outbox.publish_audit_log(
        module="auth",
        actor_id=user_id,
        action="email_changed",
        resource=f"user:{user_id}",
        debug_level=DebugLevel.ADMIN,
        organisation_id=str(user["organisation_id"]) if user.get("organisation_id") else None,
        metadata={"new_email": new_email},
    )
    logger.info("Email changed", user_id=user_id, new_email=new_email)
    return {"message": "Email address updated successfully"}
