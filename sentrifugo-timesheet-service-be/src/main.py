from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import settings
from .database import close_db, init_db
from .exceptions import register_exception_handlers
from .rabbitmq import close_rabbitmq, init_rabbitmq, start_relay, stop_relay
from .valkey import close_valkey, init_valkey

logging.basicConfig(
    level=settings.LOG_LEVEL.upper(),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger("tsm")


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    await init_valkey()
    try:
        await init_rabbitmq()
        await start_relay()
    except Exception as e:
        logger.warning("rabbitmq.init.failed err=%s", e)

    from .approvals.cron import run_client_approval_reminder_cron
    from .timesheets.cron import run_employee_reminder_cron
    import asyncio
    client_approval_cron_task = asyncio.create_task(run_client_approval_reminder_cron())
    employee_reminder_cron_task = asyncio.create_task(run_employee_reminder_cron())

    logger.info("tsm.ready")
    try:
        yield
    finally:
        client_approval_cron_task.cancel()
        employee_reminder_cron_task.cancel()
        await stop_relay()
        await close_rabbitmq()
        await close_valkey()
        await close_db()
        logger.info("tsm.shutdown")


def create_app() -> FastAPI:
    app = FastAPI(
        title="Sentrifugo — Timesheet Management",
        version="0.1.0",
        lifespan=lifespan,
    )

    origins = settings.CORS_ORIGINS
    if origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=origins,
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )

    register_exception_handlers(app)

    @app.get("/healthz", tags=["health"])
    async def healthz() -> dict:
        return {"status": "ok", "service": "tsm"}

    @app.get("/readyz", tags=["health"])
    async def readyz() -> dict:
        from .database import _client as mongo_client
        from .rabbitmq import is_connected as rabbitmq_ok
        return {
            "mongo": mongo_client is not None,
            "rabbitmq": rabbitmq_ok(),
            "service": "tsm",
        }

    api_prefix = settings.API_PREFIX

    from .client_project_heads.router import router as client_project_heads_router
    from .clients.router import router as clients_router
    from .projects.router import router as projects_router
    from .tasks.router import router as tasks_router
    from .resources.router import router as resources_router
    from .timesheets.router import router as timesheets_router
    from .approvals.router import router as approvals_router
    from .settings.router import router as settings_router
    from .past_submissions.router import router as past_submissions_router
    from .reports.router import router as reports_router
    from .public.router import router as public_router
    from .analytics.router import router as analytics_router

    app.include_router(clients_router, prefix=api_prefix)
    app.include_router(client_project_heads_router, prefix=api_prefix)
    app.include_router(projects_router, prefix=api_prefix)
    app.include_router(tasks_router, prefix=api_prefix)
    app.include_router(resources_router, prefix=api_prefix)
    app.include_router(timesheets_router, prefix=api_prefix)
    app.include_router(approvals_router, prefix=api_prefix)
    app.include_router(settings_router, prefix=api_prefix)
    app.include_router(past_submissions_router, prefix=api_prefix)
    app.include_router(reports_router, prefix=api_prefix)
    app.include_router(analytics_router, prefix=api_prefix)
    app.include_router(public_router, prefix=api_prefix)

    return app


app = create_app()
