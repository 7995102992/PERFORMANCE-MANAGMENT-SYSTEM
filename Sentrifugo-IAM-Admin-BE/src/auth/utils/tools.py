"""Password hashing utilities."""

from passlib.context import CryptContext

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


def verify_password(plain_password: str, hashed_password: str) -> bool:
    return pwd_context.verify(plain_password, hashed_password)


# Precomputed once at import, with the same bcrypt cost as real password hashes
# (both go through pwd_context), so a login attempt for a non-existent or
# password-less account spends the same time in bcrypt as a real one.
_DUMMY_HASH = pwd_context.hash("sentrifugo-timing-equaliser")


def fake_verify_password(plain_password: str) -> None:
    """Run a bcrypt verify against a fixed dummy hash and discard the result.

    Called on the user-not-found / no-local-password login paths so their
    response time matches the real verification path, closing the login timing
    side-channel that otherwise reveals which emails are valid accounts (F-09).
    """
    pwd_context.verify(plain_password, _DUMMY_HASH)


def get_password_hash(password: str) -> str:
    return pwd_context.hash(password)
