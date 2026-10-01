from typing import Any

from src.executors.base import BaseExecutor, TaskContext, TaskResult
from src.logger import logger


class ProcessInboundEmailsExecutor(BaseExecutor):
    @property
    def task_type(self) -> str:
        return "email.inbound"

    async def execute(self, payload: dict[str, Any], context: TaskContext) -> TaskResult:
        logger.info(
            "Processing inbound email",
            tenant_id=str(context.tenant_id),
            correlation_id=str(context.correlation_id),
        )

        # TODO: parse inbound email payload, extract attachments,
        #       route to appropriate internal handler, update ticket/case.

        # AUDIT TODO: once inbound routing logic lands, emit a business audit
        # event via src.audit.emit_audit_safe, e.g.:
        #   await emit_audit_safe(
        #       action="inbound_email.processed",
        #       tenant_id=str(context.tenant_id),
        #       resource=f"tenant:{context.tenant_id}",
        #       details={"from": ..., "routed_to": ..., "ticket_id": ...},
        #       correlation_id=str(context.correlation_id),
        #   )
        return TaskResult(success=True, detail="inbound email processed")
