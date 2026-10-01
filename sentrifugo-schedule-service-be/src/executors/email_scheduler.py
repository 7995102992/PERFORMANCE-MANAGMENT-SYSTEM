import asyncio
from datetime import datetime, timezone
from typing import Any

from src.email.alerts import alert_all_providers_failed
from src.email.health_monitor import is_provider_unhealthy
from src.email.providers.base import SendResult
from src.email.providers.registry import get_provider, send_with_fallback
from src.email.schemas import EmailPayload
from src.email.service import (
    check_rate_limit,
    increment_daily_count,
    insert_email_log,
    insert_scheduled_email,
    resolve_provider_template,
    set_idempotency_cache,
)
from src.audit import DebugLevel, emit_audit_safe
from src.executors.base import BaseExecutor, TaskContext, TaskResult, get_thread_pool
from src.logger import logger
from src.tenant.config import tenant_settings
from src.tenant.credentials import credential_registry
from src.tenant.service import get_tenant_config, resolve_fallback_chain, resolve_provider_for_tenant


class EmailSchedulerExecutor(BaseExecutor):
    @property
    def task_type(self) -> str:
        return "email.send"

    async def execute(self, payload: dict[str, Any], context: TaskContext) -> TaskResult:
        email = EmailPayload(**payload)

        if email.template_id.startswith("leave_"):
            logger.info(
                "Leave email dispatched",
                template_id=email.template_id,
                to=email.to,
                template_data=email.template_data,
                tenant_id=str(context.tenant_id),
                correlation_id=str(context.correlation_id),
            )

        if email.template_id == "onboarding_invite_v1" or context.event_type == "email.onboarding_invite":
            logger.info(
                "Onboarding invite email received",
                event_type=context.event_type,
                template_id=email.template_id,
                to=email.to,
                invite_url=email.template_data.get("invite_url"),
                template_data=email.template_data,
                tenant_id=str(context.tenant_id),
                correlation_id=str(context.correlation_id),
                idempotency_key=str(context.idempotency_key),
            )

        if email.scheduled_at and email.scheduled_at > datetime.now(timezone.utc):
            await insert_scheduled_email(context.db, context, email)
            logger.info(
                "Deferred email scheduled",
                tenant_id=str(context.tenant_id),
                scheduled_at=email.scheduled_at.isoformat(),
            )
            await emit_audit_safe(
                action="email.deferred",
                tenant_id=str(context.tenant_id),
                resource=f"email:{email.template_id}",
                debug_level=DebugLevel.EMPLOYEE,
                details={
                    "to": email.to,
                    "template_id": email.template_id,
                    "scheduled_at": email.scheduled_at.isoformat(),
                },
                correlation_id=str(context.correlation_id),
            )
            return TaskResult(success=True, detail="scheduled")

        tenant_config = await get_tenant_config(context.db, context.tenant_id)

        if context.redis_client and not await check_rate_limit(
            context.redis_client,
            context.tenant_id,
            daily_limit=tenant_config.daily_rate_limit if tenant_config else None,
        ):
            logger.warning("Rate limit exceeded", tenant_id=str(context.tenant_id))
            await emit_audit_safe(
                action="email.rate_limited",
                tenant_id=str(context.tenant_id),
                resource=f"email:{email.template_id}",
                details={"to": email.to, "template_id": email.template_id},
                correlation_id=str(context.correlation_id),
            )
            return TaskResult(success=False, detail="daily rate limit exceeded")

        primary_provider = resolve_provider_for_tenant(tenant_config)
        fallback_chain = resolve_fallback_chain(tenant_config)
        sender_email = tenant_config.sender_email if tenant_config else tenant_settings.DEFAULT_SENDER_EMAIL
        sender_name = tenant_config.sender_name if tenant_config else tenant_settings.DEFAULT_SENDER_NAME

        providers_to_try = [primary_provider] + [p for p in fallback_chain if p != primary_provider]
        template_refs: dict[str, str | None] = {}
        for pname in providers_to_try:
            try:
                ref = await resolve_provider_template(context.db, context.tenant_id, email.template_id, pname)
                template_refs[pname] = ref
            except Exception:
                template_refs[pname] = None

        tenant_id_str = str(context.tenant_id)

        loop = asyncio.get_running_loop()
        result = await loop.run_in_executor(
            get_thread_pool(),
            lambda: _send_sync(
                tenant_id=tenant_id_str,
                providers_to_try=providers_to_try,
                primary_provider=primary_provider,
                to=email.to,
                template_id=email.template_id,
                template_data=email.template_data,
                sender_email=sender_email,
                sender_name=sender_name,
                template_refs=template_refs,
            ),
        )

        if not result.success:
            await alert_all_providers_failed(
                tenant_id=tenant_id_str,
                event_type=context.event_type,
                to_email=email.to,
                correlation_id=str(context.correlation_id),
                providers_tried=", ".join(providers_to_try),
                error_summary=result.error or "Unknown",
            )
            await emit_audit_safe(
                action="email.all_providers_failed",
                tenant_id=tenant_id_str,
                resource=f"email:{email.template_id}",
                details={
                    "to": email.to,
                    "template_id": email.template_id,
                    "providers_tried": providers_to_try,
                    "error": result.error or "Unknown",
                },
                correlation_id=str(context.correlation_id),
            )
            return TaskResult(success=False, detail=result.error or "All providers failed")

        await insert_email_log(context.db, context, email, provider_used=result.provider)

        if context.redis_client:
            await increment_daily_count(context.redis_client, context.tenant_id)

        await emit_audit_safe(
            action="email.sent",
            tenant_id=tenant_id_str,
            resource=f"email:{email.template_id}",
            debug_level=DebugLevel.EMPLOYEE,
            details={
                "to": email.to,
                "template_id": email.template_id,
                "provider_used": result.provider,
                "message_id": result.provider_message_id,
            },
            correlation_id=str(context.correlation_id),
        )

        return TaskResult(
            success=True,
            detail=f"Sent via {result.provider}",
            data={"provider": result.provider, "message_id": result.provider_message_id},
        )


def _send_sync(
    tenant_id: str,
    providers_to_try: list[str],
    primary_provider: str,
    to: str,
    template_id: str,
    template_data: dict[str, Any],
    sender_email: str,
    sender_name: str,
    template_refs: dict[str, str | None],
) -> SendResult:
    """Runs in ThreadPoolExecutor — creates its own event loop for async provider calls."""
    return asyncio.run(
        _send_with_refs(
            tenant_id, providers_to_try, primary_provider,
            to, template_id, template_data, sender_email, sender_name, template_refs,
        )
    )


async def _send_with_refs(
    tenant_id: str,
    providers_to_try: list[str],
    primary_provider: str,
    to: str,
    template_id: str,
    template_data: dict[str, Any],
    sender_email: str,
    sender_name: str,
    template_refs: dict[str, str | None],
) -> SendResult:
    """Try each provider with pre-resolved template refs."""
    errors: dict[str, str] = {}

    # Deprioritize providers the health monitor currently considers unhealthy:
    # try healthy ones first, unhealthy ones only as a last resort. We never skip
    # entirely, so delivery is still attempted even if every provider looks down.
    healthy = [p for p in providers_to_try if not is_provider_unhealthy(tenant_id, p)]
    unhealthy = [p for p in providers_to_try if is_provider_unhealthy(tenant_id, p)]

    for provider_name in healthy + unhealthy:
        provider = get_provider(provider_name)
        if not provider:
            errors[provider_name] = f"Unknown provider: {provider_name}"
            continue

        creds = credential_registry.get(tenant_id, provider_name)
        if not creds:
            errors[provider_name] = "No credentials configured"
            continue

        try:
            result = await provider.send(
                to=to,
                template_id=template_id,
                template_data=template_data,
                sender_email=sender_email,
                sender_name=sender_name,
                credentials=creds,
                provider_template_ref=template_refs.get(provider_name),
            )
            if result.success:
                return result
            errors[provider_name] = result.error or "Send returned failure"
        except Exception as e:
            errors[provider_name] = str(e)

    return SendResult(
        success=False,
        provider=primary_provider,
        error=f"All providers failed: {errors}",
    )
