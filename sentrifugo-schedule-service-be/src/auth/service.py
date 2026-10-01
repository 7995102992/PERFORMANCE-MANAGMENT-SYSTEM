from fastapi.security import OAuth2PasswordRequestForm
from fastapi import status
from src.audit import DebugLevel, emit_audit_safe
from src.auth.utils import verify_password, get_password_hash, create_access_token
from src.auth.schemas import TokenResponse, UserBase
from src.exceptions import DomainException

# Mock user database
fake_users_db = {
    "admin": {
        "username": "admin",
        "full_name": "Admin User",
        "email": "admin@example.com",
        "hashed_password": get_password_hash("secret123"),
    }
}

async def authenticate_user(form_data: OAuth2PasswordRequestForm) -> TokenResponse:
    user = fake_users_db.get(form_data.username)
    if not user:
        await emit_audit_safe(
            action="auth.login_failed",
            actor_id=form_data.username,
            resource=f"user:{form_data.username}",
            details={"reason": "unknown_user"},
        )
        raise DomainException(message="Incorrect username or password", code="UNAUTHORIZED", status_code=status.HTTP_401_UNAUTHORIZED)
    if not verify_password(form_data.password, user["hashed_password"]):
        await emit_audit_safe(
            action="auth.login_failed",
            actor_id=form_data.username,
            resource=f"user:{form_data.username}",
            details={"reason": "bad_password"},
        )
        raise DomainException(message="Incorrect username or password", code="UNAUTHORIZED", status_code=status.HTTP_401_UNAUTHORIZED)

    access_token = create_access_token(data={"sub": user["username"]})
    await emit_audit_safe(
        action="auth.login_succeeded",
        actor_id=user["username"],
        resource=f"user:{user['username']}",
    )
    return TokenResponse(access_token=access_token, token_type="bearer")

async def get_user(username: str) -> UserBase | None:
    if username in fake_users_db:
        return UserBase(**fake_users_db[username])
    return None
