import asyncio
from collections import defaultdict

from src.email.alerts import alert_provider_health_check_failed
from src.email.config import email_settings
from src.email.providers.registry import get_provider
from src.logger import logger
from src.tenant.credentials import credential_registry

_monitor_task: asyncio.Task | None = None

_failure_counts: dict[tuple[str, str], int] = defaultdict(int)
_alerted: set[tuple[str, str]] = set()


def is_provider_unhealthy(tenant_id: str, provider: str) -> bool:
    """True if this (tenant, provider) has hit the consecutive-failure threshold.

    The send path uses this to deprioritize known-bad providers (try them last
    instead of first) so it stops paying the full per-send timeout on a provider
    the monitor already knows is down. Uses ``.get`` so it never inserts keys
    into the defaultdict.
    """
    return _failure_counts.get((tenant_id, provider), 0) >= email_settings.HEALTH_CHECK_CONSECUTIVE_FAILURES


async def start_health_monitor() -> None:
    global _monitor_task
    _monitor_task = asyncio.create_task(_health_check_loop())
    logger.info(
        "Provider health monitor started",
        interval_seconds=email_settings.HEALTH_CHECK_INTERVAL_SECONDS,
    )


async def stop_health_monitor() -> None:
    if _monitor_task and not _monitor_task.done():
        _monitor_task.cancel()
        try:
            await _monitor_task
        except asyncio.CancelledError:
            pass
    logger.info("Provider health monitor stopped")


async def _health_check_loop() -> None:
    while True:
        try:
            await _run_health_checks()
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.error("Health check loop error", error=str(e))
        await asyncio.sleep(email_settings.HEALTH_CHECK_INTERVAL_SECONDS)


async def _run_health_checks() -> None:
    entries = credential_registry.all_tenant_providers()
    if not entries:
        return

    for tenant_id, provider_name, creds in entries:
        provider = get_provider(provider_name)
        if not provider:
            continue

        key = (tenant_id, provider_name)
        try:
            healthy = await provider.health_check(credentials=creds)
        except Exception as e:
            healthy = False
            logger.warning(
                "Provider health check exception",
                tenant_id=tenant_id,
                provider=provider_name,
                error=str(e),
            )

        if healthy:
            if key in _failure_counts:
                if _failure_counts[key] >= email_settings.HEALTH_CHECK_CONSECUTIVE_FAILURES:
                    logger.info(
                        "Provider recovered",
                        tenant_id=tenant_id,
                        provider=provider_name,
                        prior_failures=_failure_counts[key],
                    )
                _failure_counts.pop(key, None)
                _alerted.discard(key)
            continue

        _failure_counts[key] += 1
        count = _failure_counts[key]

        if count >= email_settings.HEALTH_CHECK_CONSECUTIVE_FAILURES and key not in _alerted:
            await alert_provider_health_check_failed(
                tenant_id=tenant_id,
                provider=provider_name,
                consecutive_failures=count,
                error="Health check returned unhealthy or raised an exception",
            )
            _alerted.add(key)
