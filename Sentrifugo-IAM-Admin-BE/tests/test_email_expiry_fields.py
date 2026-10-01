"""IAM owns every email token TTL, so IAM owns how that TTL reads.

The consumer prints `expires_in_human` verbatim. If these tests loosen, the
activation and reset emails start telling users a window the tokens don't
actually honour.
"""

from unittest.mock import AsyncMock, patch

import pytest

from src.auth.config import auth_settings
from src.auth.utils import email_events
from src.auth.utils.email_events import humanize_ttl


@pytest.mark.parametrize(
    "seconds,expected",
    [
        (24 * 3600, "24 hours"),
        (3600, "1 hour"),          # plural-safe: "1 hours" ends up in screenshots
        (30 * 60, "30 minutes"),
        (60, "1 minute"),
        (90 * 60, "1 hour 30 minutes"),
    ],
)
def test_humanize_ttl_wording(seconds, expected):
    assert humanize_ttl(seconds) == expected


@pytest.mark.parametrize("seconds", [0, -300, 30])
def test_humanize_ttl_empty_when_unstatable(seconds):
    # Empty means "say nothing about expiry" — the consumer drops the sentence
    # rather than printing "0 minutes".
    assert humanize_ttl(seconds) == ""


async def _captured_payload(publish_coro) -> dict:
    with patch.object(email_events.outbox, "publish", new_callable=AsyncMock) as mock_publish:
        await publish_coro
    return mock_publish.await_args.args[1]["payload"]["template_data"]


@pytest.mark.asyncio
async def test_activation_email_carries_its_real_window():
    data = await _captured_payload(
        email_events.publish_activation_email("u@example.com", "Jane", "tok")
    )

    hours = auth_settings.ACTIVATION_TOKEN_EXPIRE_HOURS
    assert data["expires_in_seconds"] == hours * 3600
    assert data["expires_in_human"] == humanize_ttl(hours * 3600)


@pytest.mark.asyncio
async def test_password_reset_email_reflects_the_ttl_override():
    # The activation flow mints its fallback reset token with the activation
    # TTL, not the 30-minute default. Reading config here instead of taking the
    # caller's override is exactly the bug this parameter exists to prevent.
    data = await _captured_payload(
        email_events.publish_password_reset_email("u@example.com", "Jane", "tok", ttl_minutes=24 * 60)
    )

    assert data["expires_in_seconds"] == 24 * 3600
    assert data["expires_in_human"] == "24 hours"


@pytest.mark.asyncio
async def test_password_reset_email_defaults_to_configured_ttl():
    data = await _captured_payload(
        email_events.publish_password_reset_email("u@example.com", "Jane", "tok")
    )

    minutes = auth_settings.PASSWORD_RESET_TOKEN_EXPIRE_MINUTES
    assert data["expires_in_seconds"] == minutes * 60
    assert data["expires_in_human"] == humanize_ttl(minutes * 60)


@pytest.mark.asyncio
async def test_email_change_email_carries_its_real_window():
    data = await _captured_payload(
        email_events.publish_email_change_confirmation_email("new@example.com", "Jane", "tok")
    )

    hours = auth_settings.EMAIL_CHANGE_TOKEN_EXPIRE_HOURS
    assert data["expires_in_seconds"] == hours * 3600
    assert data["expires_in_human"] == humanize_ttl(hours * 3600)
