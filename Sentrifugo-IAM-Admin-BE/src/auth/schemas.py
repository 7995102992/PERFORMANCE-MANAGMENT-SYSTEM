from datetime import datetime

from pydantic import Field

from src.models import CustomModel


class LoginRequest(CustomModel):
    email: str
    password: str
    # When true, issue a long-lived ("Remember me") refresh token.
    remember: bool = False


class MpinRegisterRequest(CustomModel):
    password: str


class MpinRegisterResponse(CustomModel):
    device_token: str


class MpinLoginRequest(CustomModel):
    pin: str
    device_token: str


class ChangePasswordRequest(CustomModel):
    current_password: str
    new_password: str = Field(min_length=8, max_length=128)


class TokenResponse(CustomModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"


class RefreshRequest(CustomModel):
    refresh_token: str


class LogoutRequest(CustomModel):
    """Optional body for logout.

    Without `refresh_token` we can only kill the current access-token cache;
    the refresh token would remain valid until its natural TTL. Pass it to
    also revoke the refresh token so the device is fully signed out.
    """
    refresh_token: str | None = None
    all_devices: bool = False


class AzureCallbackRequest(CustomModel):
    code: str
    state: str


class AzureLoginUrlResponse(CustomModel):
    authorization_url: str
    state: str


class ActivateAccountRequest(CustomModel):
    """Activates the account by redeeming the token.

    No password is required here — on success the backend sends a
    password-reset email so the user sets their password via the
    standard reset flow.
    """
    token: str


class ResendActivationRequest(CustomModel):
    email: str


class ForgotPasswordRequest(CustomModel):
    """Initiates the password-reset flow from the 'Forgot Password?' link."""
    email: str


class ResetPasswordRequest(CustomModel):
    """Redeems a reset token and sets a new password.

    Same length bounds as ChangePasswordRequest / ActivateAccountRequest.
    """
    token: str
    new_password: str = Field(min_length=8, max_length=128)


class ConfirmEmailChangeRequest(CustomModel):
    """Completes a pending email-change by redeeming the confirmation token."""
    token: str


class UserBase(CustomModel):
    """Lightweight user representation used in auth context (JWT guard)."""
    id: str
    email: str
    first_name: str | None = None
    last_name: str | None = None
    is_super_admin: bool = False
    is_org_admin: bool = False
    organisation_id: str | None = None


class MeResponse(CustomModel):
    """Full profile for the authenticated user, including resolved permissions."""
    id: str
    email: str
    auth_method: str
    first_name: str
    last_name: str
    middle_name: str | None = None
    phone: str | None = None
    avatar_url: str | None = None
    avatar_asset_id: str | None = None
    dob: datetime | None = None
    gender: str | None = None
    marital_status: str | None = None
    status: str
    organisation_id: str | None = None
    is_super_admin: bool = False
    is_org_admin: bool = False
    pending_email: str | None = None
    policy_ids: list[str] = []
    last_login_at: datetime | None = None
    password_changed_at: datetime | None = None
    created_on: datetime | None = None
    modified_on: datetime | None = None
    permissions: dict = {}
    is_pin_exists: bool = False
    payslip_admin: bool = False
