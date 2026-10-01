from typing import Any

from src.executors.base import BaseExecutor, TaskContext, TaskResult
from src.logger import logger


class ArchiveServiceRequestExecutor(BaseExecutor):
    @property
    def task_type(self) -> str:
        return "servicerequest.archive"

    async def execute(self, payload: dict[str, Any], context: TaskContext) -> TaskResult:
        logger.info(
            "Archiving service request",
            tenant_id=str(context.tenant_id),
            correlation_id=str(context.correlation_id),
        )

        # TODO: move closed service requests to archive table,
        #       clean up attachments, update audit trail.

        # AUDIT TODO: once archiving logic lands, emit a business audit event
        # via src.audit.emit_audit_safe, e.g.:
        #   await emit_audit_safe(
        #       action="service_request.archived",
        #       tenant_id=str(context.tenant_id),
        #       resource=f"tenant:{context.tenant_id}",
        #       details={"archived_ids": [...], "count": ...},
        #       correlation_id=str(context.correlation_id),
        #   )
        return TaskResult(success=True, detail="service request archived")
