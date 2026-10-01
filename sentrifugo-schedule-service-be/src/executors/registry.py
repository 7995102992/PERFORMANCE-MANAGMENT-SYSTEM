from src.executors.base import BaseExecutor
from src.logger import logger

_executors: dict[str, BaseExecutor] = {}


def register_executor(executor: BaseExecutor) -> None:
    _executors[executor.task_type] = executor
    logger.info("Executor registered", task_type=executor.task_type, cls=type(executor).__name__)


def get_executor(task_type: str) -> BaseExecutor | None:
    return _executors.get(task_type)


def all_task_types() -> list[str]:
    return list(_executors.keys())


def register_all_executors() -> None:
    from src.executors.email_scheduler import EmailSchedulerExecutor
    from src.executors.process_inbound_emails import ProcessInboundEmailsExecutor
    from src.executors.leave_entitlement import LeaveEntitlementExecutor
    from src.executors.archive_service_request import ArchiveServiceRequestExecutor

    register_executor(EmailSchedulerExecutor())
    register_executor(ProcessInboundEmailsExecutor())
    register_executor(LeaveEntitlementExecutor())
    register_executor(ArchiveServiceRequestExecutor())
