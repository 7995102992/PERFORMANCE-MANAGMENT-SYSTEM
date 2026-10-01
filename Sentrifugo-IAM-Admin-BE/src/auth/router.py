import json
from typing import Annotated

from fastapi import APIRouter, Depends, File, Request, UploadFile, status

from src import valkey
from src.exceptions import DomainException

from src.auth.utils.azure import get_azure_login_url, handle_azure_callback
from src.auth.utils.dependencies import get_current_user
from src.auth.schemas import (
    ActivateAccountRequest,
    AzureCallbackRequest,
    AzureLoginUrlResponse,
    ChangePasswordRequest,
    ConfirmEmailChangeRequest,
    ForgotPasswordRequest,
    LoginRequest,
    LogoutRequest,
    MeResponse,
    RefreshRequest,
    ResendActivationRequest,
    ResetPasswordRequest,
    TokenResponse,
    UserBase,
)
from src.auth.service import (
    activate_account,
    authenticate_user,
    change_password,
    confirm_email_change,
    forgot_password,
    logout as logout_service,
    mpin_login,
    refresh_access_token,
    register_mpin_device,
    resend_activation,
    reset_password,
)
from src.auth.schemas import MpinLoginRequest, MpinRegisterRequest, MpinRegisterResponse
from src.auth.utils.dependencies import _extract_token
from src.auth.utils.tools import verify_password
from src.auth.utils.user_session import get_user_session
from src.exceptions import DomainException
from src.users.utils import tools as user_repo
from src.users import service as users_service
from src.users.schemas import MeUpdate, UserResponse

router = APIRouter(prefix="/auth", tags=["auth"])

_CLIENT_TIMESHEET_PERMISSIONS = {
    "timesheet_management": {
        "acl": "editor",
        "actions": {
            "manage_settings": False,
            "manage_timesheet": False,
            "client_timesheet": True,
            "my_timesheet": False,
            "manage_projects": False,
            "view_reports": False,
            "manage_clients": False,
        },
    }
}


async def _get_tsm_client_permissions(email: str) -> dict:
    """Return client timesheet permissions if the email belongs to a TSM client or client project head."""
    from motor.motor_asyncio import AsyncIOMotorClient
    from src.config import settings

    try:
        client = AsyncIOMotorClient(settings.MONGODB_URL)
        db = client["sentrifugo_tsm"]

        found = await db["client_project_heads"].find_one(
            {"email": email, "deleted_on": None}
        )
        if not found:
            found = await db["clients"].find_one(
                {"contact_email": email, "deleted_on": None}
            )

        client.close()
        return _CLIENT_TIMESHEET_PERMISSIONS if found else {}
    except Exception:
        return {}


@router.post("/login", response_model=TokenResponse)
async def login(
    request: Request,
    body: LoginRequest,
) -> TokenResponse:
    """Tenant login (image 6). Accepts any active user."""
    return await authenticate_user(
        body,
        ip_address=request.client.host if request.client else "unknown",
        user_agent=request.headers.get("user-agent", "unknown"),
    )


@router.post("/portal/login", response_model=TokenResponse)
async def portal_login(
    request: Request,
    body: LoginRequest,
) -> TokenResponse:
    """Super-admin portal login (image 1).

    Server-side enforcement of the 'Only authorized platform administrators
    can access this portal' banner — rejects non-super-admins with 403.
    """
    return await authenticate_user(
        body,
        ip_address=request.client.host if request.client else "unknown",
        user_agent=request.headers.get("user-agent", "unknown"),
        require_super_admin=True,
    )


@router.post("/refresh", response_model=TokenResponse)
async def refresh(
    request: Request,
    body: RefreshRequest,
) -> TokenResponse:
    """Exchange a refresh token for new access + refresh tokens."""
    return await refresh_access_token(
        body.refresh_token,
        ip_address=request.client.host if request.client else "unknown",
        user_agent=request.headers.get("user-agent", "unknown"),
    )


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(
    body: LogoutRequest,
    current_user: Annotated[UserBase, Depends(get_current_user)],
    access_token: Annotated[str, Depends(_extract_token)],
) -> None:
    """End the current session.

    Deletes the access-token cache for the caller's token. If `refresh_token`
    is supplied, also revokes that refresh-token session; if `all_devices`
    is true, purges every session for the user.
    """
    await logout_service(
        user_id=current_user.id,
        access_token=access_token,
        refresh_token=body.refresh_token,
        all_devices=body.all_devices,
    )


@router.get("/me", response_model=MeResponse)
async def me(
    current_user: Annotated[UserBase, Depends(get_current_user)],
    access_token: Annotated[str, Depends(_extract_token)],
) -> MeResponse:
    """Return the authenticated user's full profile and resolved permissions."""
    user = await user_repo.get_user_by_id(current_user.id)
    if not user:
        raise DomainException(
            message="User not found",
            code="NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )

    permissions: dict = {}
    session = await get_user_session(access_token)
    if session:
        permissions = session.get("permissions", {})

    if not permissions:
        permissions = await _get_tsm_client_permissions(user["email"])

    for field in ("gender", "marital_status"):
        if field in user and user[field] is not None:
            user[field] = str(user[field])

    return MeResponse(
        **user,
        permissions=permissions,
        is_pin_exists=session.get("is_pin_exists", False) if session else False,
        payslip_admin=session.get("payslip_admin", False) if session else False,
    )


@router.put("/me", response_model=UserResponse)
async def update_me(
    data: MeUpdate,
    current_user: Annotated[UserBase, Depends(get_current_user)],
) -> UserResponse:
    """Update the authenticated user's own profile.

    Restricted to safe profile fields (name, phone, dob, gender, etc.).
    Email, status, role flags, and policies cannot be changed here.
    """
    return await users_service.update_me(current_user.id, data)


@router.post("/me/profile-photo", response_model=UserResponse)
async def upload_profile_photo(
    file: UploadFile = File(...),
    current_user: Annotated[UserBase, Depends(get_current_user)] = None,
) -> UserResponse:
    """Upload a profile photo for the authenticated user.

    Accepts JPEG/PNG images up to 2MB. Uploads to DO Spaces under the
    'profile-photos' folder and updates the user's avatar_url.
    """
    return await users_service.upload_profile_photo(current_user.id, file)


@router.delete("/me/profile-photo", response_model=UserResponse)
async def remove_profile_photo(
    current_user: Annotated[UserBase, Depends(get_current_user)],
) -> UserResponse:
    """Remove the authenticated user's profile photo (clears avatar_url and
    deletes the stored file). Returns the updated user."""
    return await users_service.delete_profile_photo(current_user.id)


@router.post("/activate")
async def activate(body: ActivateAccountRequest) -> dict:
    """Activate a user account via the email link token.

    Returns a ``password_reset_token`` so the frontend can redirect the
    user straight to the password-setup page — no second email needed.
    """
    return await activate_account(body.token)


@router.post("/resend-activation")
async def resend(body: ResendActivationRequest) -> dict:
    """Resend activation email for an inactive account."""
    return await resend_activation(body.email)


@router.post("/forgot-password")
async def forgot(body: ForgotPasswordRequest) -> dict:
    """Initiate the password-reset flow (wireframe 'Forgot Password?' link).

    Always returns the same success response — never confirms whether the
    email exists — to prevent account enumeration.
    """
    return await forgot_password(body.email)


@router.post("/reset-password")
async def reset(body: ResetPasswordRequest) -> dict:
    """Redeem a password-reset token and set a new password.

    Revokes all existing sessions on success so a compromised token can't
    be used to maintain access.
    """
    return await reset_password(body.token, body.new_password)


@router.post("/confirm-email-change")
async def confirm_email(body: ConfirmEmailChangeRequest) -> dict:
    """Redeem an email-change confirmation token sent to the new address.

    Used when a super admin queues a new email for an org admin via the
    Edit Organisation screen — the change stays pending until the admin
    clicks the link delivered to their new email.
    """
    return await confirm_email_change(body.token)


@router.post("/change-password")
async def change_pwd(
    body: ChangePasswordRequest,
    current_user: Annotated[UserBase, Depends(get_current_user)],
) -> dict:
    """Change the current user's password."""
    return await change_password(current_user.id, body)


# --- mPIN ---


@router.post("/mpin/register", response_model=MpinRegisterResponse)
async def mpin_register(
    body: MpinRegisterRequest,
    current_user: Annotated[UserBase, Depends(get_current_user)],
) -> MpinRegisterResponse:
    """Register the current device for mPIN login.

    Requires the user's current password as confirmation before issuing
    a device token. Call this after a successful normal (password or SSO) login.
    """
    user = await user_repo.get_user_by_id(current_user.id)
    if not user or not user.get("password_hash") or not verify_password(body.password, user["password_hash"]):
        raise DomainException(
            message="Incorrect password",
            code="INCORRECT_PASSWORD",
            status_code=status.HTTP_401_UNAUTHORIZED,
        )
    token = await register_mpin_device(current_user.id, organisation_id=current_user.organisation_id)
    return MpinRegisterResponse(device_token=token)


@router.post("/mpin/login", response_model=TokenResponse)
async def mpin_login_endpoint(
    request: Request,
    body: MpinLoginRequest,
) -> TokenResponse:
    """Authenticate using a registered device token + payslip PIN.

    On 5 consecutive wrong PINs the device token is locked for 15 minutes.
    A correct PIN resets the counter and slides the device token TTL by 30 days.
    """
    return await mpin_login(
        pin=body.pin,
        device_token=body.device_token,
        ip_address=request.client.host if request.client else "unknown",
        user_agent=request.headers.get("user-agent", "unknown"),
    )


# --- Azure SSO ---


# Auth-code flows are valid only for the duration of the login round-trip.
AZURE_FLOW_TTL_SECONDS = 600


@router.get("/azure/login", response_model=AzureLoginUrlResponse)
async def azure_login(portal: str = "admin") -> AzureLoginUrlResponse:
    """Get the Azure AD login URL. Frontend redirects the user here.

    ``portal`` selects which registered redirect URI to use: "admin" (default)
    or "user". Both share the same app registration.
    """
    from src.auth.config import auth_settings

    redirect_uri = (
        auth_settings.AZURE_REDIRECT_URI_USER if portal == "user"
        else auth_settings.AZURE_REDIRECT_URI
    )
    result = get_azure_login_url(redirect_uri)
    # The full MSAL flow (PKCE verifier, state, nonce) must be handed back
    # intact on callback, so stash it server-side keyed by state.
    await valkey.valkey_client.set(
        f"azure_flow:{result['state']}",
        json.dumps(result["flow"]),
        ex=AZURE_FLOW_TTL_SECONDS,
    )
    return AzureLoginUrlResponse(
        authorization_url=result["authorization_url"],
        state=result["state"],
    )


@router.post("/azure/callback", response_model=TokenResponse)
async def azure_callback(
    request: Request,
    body: AzureCallbackRequest,
) -> TokenResponse:
    """Exchange Azure auth code for app tokens. Login-only — no auto-provisioning."""
    key = f"azure_flow:{body.state}"
    raw_flow = await valkey.valkey_client.get(key)
    if not raw_flow:
        raise DomainException(
            message="Login session expired or invalid. Please try signing in again.",
            code="AZURE_FLOW_EXPIRED",
            status_code=status.HTTP_400_BAD_REQUEST,
        )
    # Single-use: drop the flow so a leaked code+state can't be replayed.
    await valkey.valkey_client.delete(key)

    return await handle_azure_callback(
        code=body.code,
        flow=json.loads(raw_flow),
        ip_address=request.client.host if request.client else "unknown",
        user_agent=request.headers.get("user-agent", "unknown"),
    )
