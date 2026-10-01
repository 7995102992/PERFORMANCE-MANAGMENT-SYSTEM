"""HTTP endpoints for payslip PIN management.

POST /pin/regenerate  — generate (or replace) the caller's PIN and email it.
POST /pin/verify      — constant-time compare against the caller's current PIN.
"""
from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel

from src.auth.utils.authorization import require_permission
from src.auth.utils.dependencies import _extract_token
from src.auth.utils.tools import verify_password
from src.exceptions import DomainException
from src.modules.employee_pin.service import regenerate_pin, verify_pin
from src.users.utils import tools as user_repo

router = APIRouter(prefix="/pin", tags=["pin"])


class RegeneratePinRequest(BaseModel):
    password: str


class VerifyPinRequest(BaseModel):
    pin: str


class VerifyPinResponse(BaseModel):
    valid: bool
    pin_set: bool
    locked: bool = False
    retry_after: int = 0


async def _verify_password(user_id: str, password: str) -> None:
    user = await user_repo.get_user_by_id(user_id)
    if not user or not user.get("password_hash") or not verify_password(password, user["password_hash"]):
        raise DomainException(
            message="Incorrect password",
            code="INCORRECT_PASSWORD",
            status_code=status.HTTP_401_UNAUTHORIZED,
        )


@router.post("/regenerate", status_code=status.HTTP_200_OK)
async def regenerate_my_pin(
    body: RegeneratePinRequest,
    request: Request,
    current_user=Depends(require_permission("core_hr", "my_payroll")),
    access_token: str = Depends(_extract_token),
):
    """Regenerate the caller's payslip PIN and email it to them."""
    await _verify_password(current_user.id, body.password)
    result = await regenerate_pin(
        user_id=current_user.id,
        organisation_id=current_user.organisation_id or "",
    )
    if result is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    # Reflect the new pin state in the active Valkey session immediately.
    try:
        from src import valkey
        from src.auth.utils.user_session import SESSION_PREFIX
        import json
        key = f"{SESSION_PREFIX}{access_token}"
        raw = await valkey.valkey_client.get(key)
        if raw:
            payload = json.loads(raw)
            payload["is_pin_exists"] = True
            ttl = await valkey.valkey_client.ttl(key)
            await valkey.valkey_client.set(key, json.dumps(payload), ex=ttl if ttl > 0 else None)
    except Exception:
        pass

    return {"message": "PIN regenerated and emailed successfully"}


@router.post("/verify", response_model=VerifyPinResponse)
async def verify_my_pin(
    body: VerifyPinRequest,
    current_user=Depends(require_permission("core_hr", "my_payroll")),
):
    """Verify the caller's submitted PIN against their stored PIN.

    Delegates to :func:`service.verify_pin` so the HTTP path shares the RPC path's
    rate limit (5 fails → 15-min cooldown), constant-time compare, and audit —
    closing the brute-force bypass the two surfaces previously had.
    """
    result = await verify_pin(
        user_id=current_user.id,
        organisation_id=current_user.organisation_id or "",
        pin=body.pin,
    )
    return VerifyPinResponse(**result)
