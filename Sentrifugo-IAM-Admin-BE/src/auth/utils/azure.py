"""Azure AD SSO integration using MSAL."""

import msal
from fastapi import status

from src.auth.config import auth_settings
from src.auth.schemas import TokenResponse
from src.auth.service import _issue_tokens
from src.exceptions import DomainException
from src.logger import logger
from src.models import ACCESS_STATUSES
from src.users.utils import tools as repository


def _get_msal_app() -> msal.ConfidentialClientApplication:
    """Create an MSAL confidential client for Azure AD."""
    if not auth_settings.AZURE_CLIENT_ID or not auth_settings.AZURE_TENANT_ID:
        raise DomainException(
            message="Azure SSO is not configured",
            code="SSO_NOT_CONFIGURED",
            status_code=status.HTTP_501_NOT_IMPLEMENTED,
        )
    authority = f"https://login.microsoftonline.com/{auth_settings.AZURE_TENANT_ID}"
    return msal.ConfidentialClientApplication(
        client_id=auth_settings.AZURE_CLIENT_ID,
        client_credential=auth_settings.AZURE_CLIENT_SECRET,
        authority=authority,
    )


def get_azure_login_url(redirect_uri: str | None = None) -> dict:
    """Generate the Azure AD authorization URL for the frontend to redirect to.

    ``redirect_uri`` selects which registered callback to use (admin vs user
    portal); it must exactly match one registered in Azure. Defaults to the
    admin portal URI.
    """
    app = _get_msal_app()
    flow = app.initiate_auth_code_flow(
        scopes=auth_settings.AZURE_SCOPES,
        redirect_uri=redirect_uri or auth_settings.AZURE_REDIRECT_URI,
    )
    return {
        "authorization_url": flow["auth_uri"],
        "state": flow["state"],
        "flow": flow,
    }


async def handle_azure_callback(
    code: str,
    flow: dict,
    ip_address: str,
    user_agent: str,
) -> TokenResponse:
    """Exchange Azure auth code for tokens and create/find user."""
    app = _get_msal_app()

    result = app.acquire_token_by_auth_code_flow(flow, {"code": code, "state": flow.get("state")})
    if "error" in result:
        logger.error("Azure token exchange failed", error=result.get("error_description"))
        raise DomainException(
            message=result.get("error_description", "Azure authentication failed"),
            code="AZURE_AUTH_FAILED",
            status_code=status.HTTP_401_UNAUTHORIZED,
        )

    # Extract user info from the ID token claims
    id_token_claims = result.get("id_token_claims", {})
    azure_oid = id_token_claims.get("oid")
    email = id_token_claims.get("preferred_username") or id_token_claims.get("email")

    if not email or not azure_oid:
        raise DomainException(
            message="Could not extract user info from Azure token",
            code="AZURE_INVALID_TOKEN",
            status_code=status.HTTP_401_UNAUTHORIZED,
        )

    # Login-only: the user must already be provisioned in our system. We never
    # auto-register an account from an SSO login. Match by azure_oid first, then
    # fall back to email (first SSO login for an admin-created local user).
    user = await repository.get_user_by_azure_oid(azure_oid)
    if not user:
        user = await repository.get_user_by_email(email)

    if not user:
        logger.info("Rejected Azure SSO login for unprovisioned account", email=email, azure_oid=azure_oid)
        raise DomainException(
            message="This Microsoft account is not registered. Please contact your administrator.",
            code="USER_NOT_PROVISIONED",
            status_code=status.HTTP_403_FORBIDDEN,
        )

    # Block users who cannot access the system (inactive, exited, etc.).
    # notice_period employees are still working and remain allowed in.
    if user.get("status") not in ACCESS_STATUSES:
        raise DomainException(
            message="Account is not active. Please contact your administrator.",
            code="ACCOUNT_NOT_ACTIVE",
            status_code=status.HTTP_403_FORBIDDEN,
        )

    # First SSO login for a user created with a local/seeded auth_method:
    # link their Azure object id so subsequent logins match by oid. We keep the
    # existing auth_method (e.g. local) so the account can still log in with its
    # password — SSO and password are both valid once the oid is linked.
    if not user.get("azure_oid"):
        await repository.update_user(user["id"], {
            "azure_oid": azure_oid,
        })
        user["azure_oid"] = azure_oid

    return await _issue_tokens(user, ip_address, user_agent)
