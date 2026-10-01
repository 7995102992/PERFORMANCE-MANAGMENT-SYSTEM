"""Global utility functions shared across modules."""

from src.auth.utils.tools import get_password_hash, verify_password

# ---------------------------------------------------------------------------
# Password
# ---------------------------------------------------------------------------

DEFAULT_PASSWORD = "test@123"
"""Default password set for auto-created users (e.g. when creating an employee).

The user should change it after first login (password reset flow).
"""


def hash_default_password() -> str:
    """Return the bcrypt hash of the default password."""
    return get_password_hash(DEFAULT_PASSWORD)


__all__ = [
    "DEFAULT_PASSWORD",
    "hash_default_password",
    "get_password_hash",
    "verify_password",
]
