from typing import Annotated

from fastapi import APIRouter, Depends, Query, status

from src.auth.utils.authorization import require_permission
from src.auth.utils.dependencies import get_current_user
from src.auth.schemas import UserBase
from src.users.schemas import UserCreate, UserResponse, UserUpdate
from src.users import service

router = APIRouter(prefix="/users", tags=["users"])


# Directory reads (list/search/get) stay open to any authenticated user so
# colleague-pickers keep working, but non-admins must not receive the sensitive
# fields that make the directory a phishing/enumeration aid (F-06): admin flags,
# login/password timestamps, DOB, phone, policy assignments, pending email.
_REDACTED_FIELDS = {
    "is_org_admin": False,
    "last_login_at": None,
    "password_changed_at": None,
    "dob": None,
    "phone": None,
    "policy_ids": [],
    "pending_email": None,
    "azure_oid": None,
    "activated_at": None,
    "activation_pending": False,
    "gender": None,
    "marital_status": None,
}


def _is_privileged(user: UserBase) -> bool:
    return bool(user.is_super_admin or user.is_org_admin)


def _public_view(u: UserResponse) -> UserResponse:
    """Minimal directory view for non-privileged callers."""
    return u.model_copy(update=_REDACTED_FIELDS)


@router.post("", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
async def create_user(
    data: UserCreate,
    current_user: Annotated[UserBase, Depends(require_permission("users", "create_resource"))],
) -> UserResponse:
    """Create a new user."""
    return await service.create_user(data, current_user_id=current_user.id, caller=current_user)


@router.get("", response_model=list[UserResponse])
async def list_users(
    current_user: Annotated[UserBase, Depends(get_current_user)],
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=20, ge=1, le=100),
    is_org_admin: bool | None = Query(default=None, description="Filter by org-admin role"),
    organisation_id: str | None = Query(default=None, description="Filter by org (super-admin only)"),
) -> list[UserResponse]:
    """List users, scoped to the caller's organisation (super admins see all)."""
    users = await service.list_users(
        skip, limit, caller=current_user,
        is_org_admin=is_org_admin, organisation_id=organisation_id,
    )
    if _is_privileged(current_user):
        return users
    return [_public_view(u) for u in users]


@router.get("/search", response_model=list[UserResponse])
async def search_users(
    current_user: Annotated[UserBase, Depends(get_current_user)],
    q: str = Query(min_length=1, description="Search by email or display name"),
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=20, ge=1, le=100),
) -> list[UserResponse]:
    """Search users, scoped to the caller's organisation."""
    users = await service.search_users(q, skip, limit, caller=current_user)
    if _is_privileged(current_user):
        return users
    return [_public_view(u) for u in users]


@router.get("/{user_id}", response_model=UserResponse)
async def get_user(
    user_id: str,
    current_user: Annotated[UserBase, Depends(get_current_user)],
) -> UserResponse:
    """Get a single user by id, scoped to the caller's organisation."""
    user = await service.get_user(user_id, caller=current_user)
    if _is_privileged(current_user):
        return user
    return _public_view(user)


@router.put("/{user_id}", response_model=UserResponse)
async def update_user(
    user_id: str,
    data: UserUpdate,
    current_user: Annotated[UserBase, Depends(require_permission("users", "create_resource"))],
) -> UserResponse:
    """Update a user, scoped to the caller's organisation."""
    return await service.update_user(
        user_id, data, current_user_id=current_user.id, caller=current_user
    )


@router.delete("/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_user(
    user_id: str,
    current_user: Annotated[UserBase, Depends(require_permission("users", "create_resource"))],
) -> None:
    """Soft-delete a user, scoped to the caller's organisation."""
    await service.delete_user(user_id, current_user_id=current_user.id, caller=current_user)


@router.post("/{user_id}/resend-activation")
async def resend_activation(
    user_id: str,
    current_user: Annotated[UserBase, Depends(require_permission("users", "create_resource"))],
) -> dict:
    """Resend the activation email for a pending user (admin action).

    Super admins → any user; org admins → users in their own org. Rejects
    already-active, deactivated, SSO, deleted, or out-of-scope targets.
    """
    return await service.resend_activation_for_user(user_id, caller=current_user)


# ---------------------------------------------------------------------------
# Policy attachment — user.policy_ids CRUD
# ---------------------------------------------------------------------------
@router.post("/{user_id}/policies/{policy_id}", response_model=UserResponse)
async def attach_policy(
    user_id: str,
    policy_id: str,
    current_user: Annotated[UserBase, Depends(require_permission("users", "create_resource"))],
) -> UserResponse:
    """Attach a policy to a user. Idempotent — attaching twice is a no-op.

    Policy and user must share an organisation_id (null matches null for
    super-admin-owned global policies).
    """
    return await service.attach_policy_to_user(user_id, policy_id, caller=current_user)


@router.delete(
    "/{user_id}/policies/{policy_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def detach_policy(
    user_id: str,
    policy_id: str,
    current_user: Annotated[UserBase, Depends(require_permission("users", "create_resource"))],
) -> None:
    """Detach a policy from a user. 404 if the policy wasn't attached."""
    await service.detach_policy_from_user(user_id, policy_id, caller=current_user)
