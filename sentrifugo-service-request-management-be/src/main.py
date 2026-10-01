"""SRM ASGI entrypoint.

Lifespan bootstraps Mongo → Valkey → RabbitMQ per Foundation §2, mounts all
chapter routers behind `/api/v1/service-requests`, and attaches exception
handlers for DomainException + Pydantic validation errors.
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .config import settings
from .database import close_db, init_db
from .exceptions import register_exception_handlers
from .integrations.iam_client import close_iam_client
from .integrations.logging_client import close_logging_client
from .internal.router import router as internal_router
from .rabbitmq import (
    close_rabbitmq,
    init_rabbitmq,
    start_dept_consumer_task,
    start_relay,
    stop_dept_consumer,
    stop_relay,
)
from .requests.sla_scheduler import start_sla_ticker, stop_sla_ticker
from .requests.token_purge_scheduler import (
    start_token_purge_ticker,
    stop_token_purge_ticker,
)
from .valkey import close_valkey, init_valkey

logging.basicConfig(
    level=settings.LOG_LEVEL.upper(),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger("srm")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Order per Foundation §2: Mongo → Valkey → RabbitMQ.
    await init_db()
    await init_valkey()
    await init_rabbitmq()
    await start_relay()
    start_dept_consumer_task()
    await start_sla_ticker()
    await start_token_purge_ticker()
    logger.info("srm.ready")
    try:
        yield
    finally:
        await stop_token_purge_ticker()
        await stop_sla_ticker()
        await stop_dept_consumer()
        await stop_relay()
        await close_rabbitmq()
        await close_valkey()
        await close_iam_client()
        await close_logging_client()
        await close_db()
        logger.info("srm.shutdown")


def create_app() -> FastAPI:
    app = FastAPI(
        title="Sentrifugo — Service Request Management",
        version="0.1.0-phase1",
        lifespan=lifespan,
    )

    # --- CORS ---
    origins = settings.CORS_ORIGINS
    if origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=origins,
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )

    # --- Exception handlers ---
    register_exception_handlers(app)

    # --- Health (always unauth) ---
    @app.get("/healthz", tags=["health"])
    async def healthz() -> dict:
        return {"status": "ok", "service": "srm", "phase": "1"}

    @app.get("/readyz", tags=["health"])
    async def readyz() -> dict:
        from .database import _client as mongo_client  # noqa: PLC0415
        from .rabbitmq import is_connected as rabbitmq_is_connected  # noqa: PLC0415
        return {
            "mongo": mongo_client is not None,
            "rabbitmq": rabbitmq_is_connected(),
            "service": "srm",
        }

    # --- /me endpoint (proxies to IAM) ---
    @app.get(f"{settings.API_PREFIX}/me", tags=["auth"])
    async def me(request: Request):
        from .integrations.iam_client import get_iam_client
        token = request.headers.get("Authorization", "").removeprefix("Bearer ").strip()
        if not token:
            return JSONResponse({"detail": "Missing bearer token"}, status_code=401)
        iam = get_iam_client()
        resp = await iam._request("GET", "/auth/me", access_token=token)
        if resp.status_code >= 400:
            try:
                body = resp.json()
            except Exception:
                body = {"detail": resp.text}
            return JSONResponse(body, status_code=resp.status_code)
        return resp.json()

    # --- Routers ---
    api_prefix = settings.API_PREFIX

    # Chapter routers.
    from .categories.router import router as categories_router
    from .request_types.router import router as request_types_router
    from .workflows.router import router as workflows_router
    from .dashboard.router import router as dashboard_router
    from .requests.router import router as requests_router
    from .analytics.router import router as analytics_router
    app.include_router(request_types_router, prefix=api_prefix)
    app.include_router(categories_router, prefix=api_prefix)
    app.include_router(workflows_router, prefix=api_prefix)
    app.include_router(dashboard_router, prefix=api_prefix)
    app.include_router(requests_router, prefix=api_prefix)
    app.include_router(analytics_router, prefix=api_prefix)

    # IAM proxy routers.
    from .departments.router import router as departments_router
    from .employees.router import router as employees_router
    app.include_router(departments_router, prefix=api_prefix)
    app.include_router(employees_router, prefix=api_prefix)

    # Act-from-email. No auth dependency by design — the caller is identified
    # by a single-use token, and every endpoint re-enters the normal domain path.
    from .public.router import router as public_router
    app.include_router(public_router, prefix=api_prefix)

    app.include_router(internal_router, prefix=api_prefix)

    return app


app = create_app()
