from typing import Any

from src.executors.base import BaseExecutor, TaskContext, TaskResult
from src.logger import logger


class LeaveEntitlementExecutor(BaseExecutor):
    @property
    def task_type(self) -> str:
        return "leave.entitlement"

    async def execute(self, payload: dict[str, Any], context: TaskContext) -> TaskResult:
        logger.info(
            "Processing leave entitlement",
            tenant_id=str(context.tenant_id),
            correlation_id=str(context.correlation_id),
        )

        # TODO: calculate entitlement accrual, update leave balances,
        #       handle carry-forward rules, notify employee.

        # AUDIT TODO: once the accrual logic lands, emit a business audit event
        # via src.audit.emit_audit_safe, e.g.:
        #   await emit_audit_safe(
        #       action="leave_entitlement.run",
        #       tenant_id=str(context.tenant_id),
        #       resource=f"tenant:{context.tenant_id}",
        #       details={"employees_processed": ..., "carry_forward": ...},
        #       correlation_id=str(context.correlation_id),
        #   )
        return TaskResult(success=True, detail="leave entitlement processed")
