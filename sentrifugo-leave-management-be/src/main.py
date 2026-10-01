import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from src.config import settings
from src.database import close_db, init_db
from bson.errors import InvalidId
from src.exceptions import DomainException, domain_exception_handler, global_exception_handler, invalid_id_exception_handler
from src.health.router import router as health_router
from src.holiday_plans.router import router as holiday_plans_router
from src.holiday_classifications.router import router as holiday_classifications_router
from src.holiday_plan_employees.router import router as holiday_plan_employees_router
from src.employees.router import router as employees_router
from src.holidays.router import router as holidays_router
from src.work_calendar.router import router as work_calendar_router
from src.leave_types.router import router as leave_types_router
from src.leave_grant_policy.router import router as leave_grant_policy_router
from src.leave_plans.router import router as leave_plans_router
from src.leave_plan_assignments.router import router as leave_plan_assignments_router
from src.leave_plan_type_mapping.router import router as leave_plan_type_mapping_router
from src.entitlements.router import router as entitlements_router
from src.leave_requests.router import router as leave_requests_router
# from src.leave_requests.agent_router import router as leave_agent_router
# DEPRECATED (hidden for now): FugoAI agent chat endpoint (/api/v1/agent/chat).
# Frontend button is hidden; router left in the codebase but not mounted below.
# Re-enable by uncommenting this import and its include_router() call.
# from src.agent.router import router as agent_chat_router
from src.leave_plans.entitlement_router import router as leave_entitlements_router
from src.leave_policy.router import router as leave_policy_router
from src.year_end_processing.router import router as year_end_processing_router
from src.logger import logger
from src.messaging.config.rabbitmq_config import (
    declare_dlq_infrastructure,
    declare_domain_events_infrastructure,
    declare_iam_infrastructure,
    declare_leave_calendar_rpc_infrastructure,
    declare_shift_details_rpc_infrastructure,
)
from src.messaging.consumers.domain_events_consumer import start_domain_events_consumer
from src.messaging.consumers.iam_consumer import start_iam_consumer
from src.messaging.consumers.leave_calendar_rpc_consumer import start_leave_calendar_rpc_consumer
from src.messaging.consumers.shift_details_rpc_consumer import start_shift_details_rpc_consumer
from src.messaging.outbox.worker import start_relay, stop_relay
from src.rabbitmq import close_rabbitmq, init_rabbitmq
from src.redis import close_redis, init_redis
from src.leave_balance_processor.cron import run_leave_balance_cron
from src.year_end_processing.cron import run_year_end_cron
from src.holiday_reminder.cron import run_holiday_reminder_cron
from src.leave_escalation.cron import run_leave_escalation_cron
from src.employee_sync.cron import run_employee_sync_cron
from src.assets.router import router as assets_router
from src.manager.router import router as manager_router
from src.my_calendar.router import router as my_calendar_router
from src.leave_analytics.router import router as leave_analytics_router
from src.dashboard.router import router as dashboard_router
from src.reports.router import router as reports_router
from src.attendance.router import router as attendance_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    logger.info("Initializing infrastructure connections...")
    init_db()

    try:
        await init_redis()
    except Exception as e:
        logger.warning(f"Failed to initialize Redis on startup: {e}")

    try:
        await init_rabbitmq()

        # Declare exchanges, queues, and bindings
        await declare_dlq_infrastructure()
        await declare_iam_infrastructure()
        await declare_domain_events_infrastructure()
        await declare_leave_calendar_rpc_infrastructure()
        await declare_shift_details_rpc_infrastructure()

        # Start consumers
        await start_iam_consumer()
        await start_domain_events_consumer()

        await start_relay()
    except Exception as e:
        print(e)
        logger.warning(f"Failed to initialize RabbitMQ / messaging on startup: {e}")

    # Deliberately outside the block above: these two register in the background
    # and retry until the broker answers, declaring their own queues as they go.
    # Inside the try, a broker that is down at boot skips the whole block and the
    # RPC queues stay unconsumed until someone restarts the process — the caller
    # then waits out its timeout (or forever, for the untimed leave_calendar
    # client) with nothing in the logs to explain it.
    await start_leave_calendar_rpc_consumer()
    await start_shift_details_rpc_consumer()

    balance_cron_task = asyncio.create_task(run_leave_balance_cron())
    year_end_cron_task = asyncio.create_task(run_year_end_cron())
    holiday_reminder_cron_task = asyncio.create_task(run_holiday_reminder_cron())
    escalation_cron_task = asyncio.create_task(run_leave_escalation_cron())
    employee_sync_cron_task = asyncio.create_task(run_employee_sync_cron())

    # Attendance is read-only here: punches are written to MongoDB by the
    # separate collector service. This just ensures the read indexes exist.
    try:
        from src.attendance.service import ensure_indexes
        await ensure_indexes()
    except Exception as e:
        logger.warning(f"Failed to ensure attendance indexes: {e}")

    yield

    # Shutdown
    logger.info("Closing infrastructure connections...")
    await stop_relay()
    balance_cron_task.cancel()
    year_end_cron_task.cancel()
    holiday_reminder_cron_task.cancel()
    escalation_cron_task.cancel()
    employee_sync_cron_task.cancel()
    await close_db()
    await close_redis()
    await close_rabbitmq()

app = FastAPI(
    title="Sentrifugo LMS",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.add_exception_handler(DomainException, domain_exception_handler)
app.add_exception_handler(InvalidId, invalid_id_exception_handler)
app.add_exception_handler(Exception, global_exception_handler)

app.include_router(health_router)
app.include_router(holiday_plans_router)
app.include_router(holiday_classifications_router)
app.include_router(holiday_plan_employees_router)
app.include_router(employees_router)
app.include_router(holidays_router)
app.include_router(work_calendar_router)
app.include_router(leave_types_router)
app.include_router(leave_grant_policy_router)
app.include_router(leave_plans_router)
app.include_router(leave_plan_type_mapping_router)
app.include_router(leave_plan_assignments_router)
app.include_router(entitlements_router)
app.include_router(leave_requests_router)
# app.include_router(leave_agent_router)
# DEPRECATED (hidden for now): FugoAI agent chat endpoint. Re-enable by
# uncommenting the import above and this line.
# app.include_router(agent_chat_router)
app.include_router(leave_entitlements_router)
app.include_router(leave_policy_router)
app.include_router(year_end_processing_router)
app.include_router(assets_router)
app.include_router(manager_router)
app.include_router(my_calendar_router)
app.include_router(leave_analytics_router)
app.include_router(dashboard_router)
app.include_router(reports_router)
app.include_router(attendance_router)

if __name__ == "__main__":
    import uvicorn

    uvicorn.run("src.main:app", host="0.0.0.0", port=8000, reload=settings.ENVIRONMENT == "development")
