from src.config import settings

ENV = settings.ENVIRONMENT


class Queues:
    # Inbound from IAM
    USER_CREATED = f"{ENV}.lms.inbound.user.created.queue"
    DEPARTMENT_SYNCED = f"{ENV}.lms.inbound.department.synced.queue"
    BUSINESS_UNIT_SYNCED = f"{ENV}.lms.inbound.business_unit.synced.queue"

    # RPC
    RPC_REQUEST_EMPLOYEE = f"{ENV}.lms.rpc.request.employee.queue"
    RPC_REPLY = f"{ENV}.lms.rpc.reply.queue"
    LEAVE_CALENDAR_RPC = f"{ENV}.lms.rpc.leave_calendar.queue"
    SHIFT_DETAILS_RPC = f"{ENV}.lms.rpc.shift_details.queue"

    # Inbound from domain_events exchange
    DOMAIN_EVENTS = f"{ENV}.lms.inbound.domain_events.queue"

    # DLQ
    DLQ = f"{ENV}.lms.dlq.queue"

    # Audit
    AUDIT_LMS = f"{ENV}.audit.lms.queue"
