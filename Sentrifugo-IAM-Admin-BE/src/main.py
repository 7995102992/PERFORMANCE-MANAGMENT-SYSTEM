from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from src.config import settings
from src.correlation import CorrelationIdMiddleware
from src.database import close_db, init_db, setup_db_context
from src.exceptions import DomainException, domain_exception_handler, global_exception_handler
from src.auth.router import router as auth_router
from src.dashboard.router import router as dashboard_router
from src.health.router import router as health_router
from src.lookups.router import router as lookups_router
from src.tenancy.router import router as organisations_router
from src.policies.router import router as policies_router
from src.location.router import router as location_router
from src.users.router import router as users_router
from src.modules.organisation.addresses.router import router as addresses_router
from src.modules.organisation.organisation.router import router as orgsetup_router
from src.modules.organisation.businessunit.router import router as business_units_router
from src.modules.organisation.department.router import router as departments_router
from src.modules.organisation.designation.router import router as designations_router
from src.modules.organisation.bands.router import router as bands_router
from src.modules.organisation.paygrades.router import router as paygrades_router
from src.modules.organisation.orgdocuments.router import router as orgdocuments_router
from src.modules.organisation.employees.router import router as employees_router
from src.assets_router import router as assets_router
from src.master_data.router import router as master_data_router
from src.modules.custom_fields.router import router as custom_fields_router
from src.modules.organisation.dependency_router import router as dependency_check_router
from src.modules.exit_management.router import router as exit_management_router
from src.modules.announcements.router import router as announcements_router
from src.logo_proxy import router as logo_proxy_router
from src.graph.router import router as graph_router
from src.logger import logger
from src.rabbitmq import close_rabbitmq, init_rabbitmq, start_relay, stop_relay
from src.valkey import close_valkey, init_valkey


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    logger.info("Initializing infrastructure connections...")
    await init_db()
    
    try:
        await init_valkey()
    except Exception as e:
        logger.warning(f"Failed to initialize Valkey on startup: {e}")
        
    try:
        await init_rabbitmq()
    except Exception as e:
        logger.warning(f"Failed to initialize RabbitMQ on startup: {e}")
    try:
        await start_relay()
    except Exception as e:
        logger.warning(f"Failed to start the outbox relay on startup: {e}")

    try:
        from src.graph import init_graph
        from src.graph.schema import start_graph_schema_task
        await init_graph()
        # Schema-ensure runs in the background and waits for Neo4j to be
        # reachable, so a down graph store never blocks or slows startup.
        start_graph_schema_task()
    except Exception as e:
        logger.warning(f"Failed to initialize Neo4j on startup: {e}")

    try:
        from src.modules.journey.consumer import start_journey_consumer_task
        start_journey_consumer_task()
    except Exception as e:
        logger.warning(f"Failed to start journey consumer on startup: {e}")

    try:
        from src.graph.projector import start_graph_projector_task
        start_graph_projector_task()
    except Exception as e:
        logger.warning(f"Failed to start graph projector on startup: {e}")

    try:
        from src.modules.organisation.employees.pending_scheduler import start_pending_changes_task
        start_pending_changes_task()
    except Exception as e:
        logger.warning(f"Failed to start pending-changes scheduler on startup: {e}")

    try:
        from src.rpc.employee_lookup import start_employee_lookup_rpc
        start_employee_lookup_rpc()
    except Exception as e:
        logger.warning(f"Failed to start employee lookup RPC server: {e}")

    try:
        from src.rpc.employee_pin import start_employee_pin_rpc
        start_employee_pin_rpc()
    except Exception as e:
        logger.warning(f"Failed to start employee pin RPC server: {e}")

    try:
        from src.rpc.employees_sync import start_employees_sync_rpc
        start_employees_sync_rpc()
    except Exception as e:
        logger.warning(f"Failed to start employees sync RPC server: {e}")

    try:
        from src.rpc.users_with_permission import start_users_with_permission_rpc
        start_users_with_permission_rpc()
    except Exception as e:
        logger.warning(f"Failed to start users-with-permission RPC server: {e}")

    # Expense-service directory queues. Gate 1 is unconditional, so without
    # reporting_manager the expense workflow cannot start at all.
    try:
        from src.rpc.reporting_manager import start_reporting_manager_rpc
        start_reporting_manager_rpc()
    except Exception as e:
        logger.warning(f"Failed to start reporting-manager RPC server: {e}")

    try:
        from src.rpc.reporting_line import start_reporting_line_rpc
        start_reporting_line_rpc()
    except Exception as e:
        logger.warning(f"Failed to start reporting-line RPC server: {e}")

    try:
        from src.rpc.permission_check import start_permission_check_rpc
        start_permission_check_rpc()
    except Exception as e:
        logger.warning(f"Failed to start permission-check RPC server: {e}")

    try:
        from src.rpc.permission_holders import start_permission_holders_rpc
        start_permission_holders_rpc()
    except Exception as e:
        logger.warning(f"Failed to start permission-holders RPC server: {e}")

    try:
        from src.rpc.employee_profiles import start_employee_profiles_rpc
        start_employee_profiles_rpc()
    except Exception as e:
        logger.warning(f"Failed to start employee-profiles RPC server: {e}")

    yield

    # Shutdown
    logger.info("Closing infrastructure connections...")
    try:
        from src.modules.organisation.employees.pending_scheduler import stop_pending_changes_task
        stop_pending_changes_task()
    except Exception as e:
        logger.warning(f"Failed to stop pending-changes scheduler: {e}")
    try:
        from src.modules.journey.consumer import stop_journey_consumer
        await stop_journey_consumer()
    except Exception as e:
        logger.warning(f"Failed to stop journey consumer: {e}")
    try:
        from src.graph.projector import stop_graph_projector
        await stop_graph_projector()
        from src.graph.schema import stop_graph_schema_task
        await stop_graph_schema_task()
        from src.graph import close_graph
        await close_graph()
    except Exception as e:
        logger.warning(f"Failed to stop graph projector: {e}")
    try:
        from src.rpc.employee_lookup import stop_employee_lookup_rpc
        await stop_employee_lookup_rpc()
    except Exception as e:
        logger.warning(f"Failed to stop employee lookup RPC server: {e}")
    try:
        from src.rpc.employee_pin import stop_employee_pin_rpc
        await stop_employee_pin_rpc()
    except Exception as e:
        logger.warning(f"Failed to stop employee pin RPC server: {e}")
    try:
        from src.rpc.employees_sync import stop_employees_sync_rpc
        await stop_employees_sync_rpc()
    except Exception as e:
        logger.warning(f"Failed to stop employees sync RPC server: {e}")
    try:
        from src.rpc.users_with_permission import stop_users_with_permission_rpc
        await stop_users_with_permission_rpc()
    except Exception as e:
        logger.warning(f"Failed to stop users-with-permission RPC server: {e}")
    try:
        from src.rpc.reporting_manager import stop_reporting_manager_rpc
        await stop_reporting_manager_rpc()
    except Exception as e:
        logger.warning(f"Failed to stop reporting-manager RPC server: {e}")
    try:
        from src.rpc.reporting_line import stop_reporting_line_rpc
        await stop_reporting_line_rpc()
    except Exception as e:
        logger.warning(f"Failed to stop reporting-line RPC server: {e}")
    try:
        from src.rpc.permission_check import stop_permission_check_rpc
        await stop_permission_check_rpc()
    except Exception as e:
        logger.warning(f"Failed to stop permission-check RPC server: {e}")
    try:
        from src.rpc.permission_holders import stop_permission_holders_rpc
        await stop_permission_holders_rpc()
    except Exception as e:
        logger.warning(f"Failed to stop permission-holders RPC server: {e}")
    try:
        from src.rpc.employee_profiles import stop_employee_profiles_rpc
        await stop_employee_profiles_rpc()
    except Exception as e:
        logger.warning(f"Failed to stop employee-profiles RPC server: {e}")
    await stop_relay() ## for rabbit mq outbound listener
    await close_db()
    await close_valkey()
    await close_rabbitmq()

# API docs exposed only when explicitly enabled or in local dev (F-08). In prod
# /docs, /redoc and /openapi.json return 404 so the full API surface isn't public.
_ENABLE_DOCS = settings.DOCS_ENABLED or settings.ENVIRONMENT == "development"

app = FastAPI(
    title="Sentrifugo-BE-Boilerplate",
    version="1.0.0",
    lifespan=lifespan,
    dependencies=[Depends(setup_db_context)],
    docs_url="/docs" if _ENABLE_DOCS else None,
    redoc_url="/redoc" if _ENABLE_DOCS else None,
    openapi_url="/openapi.json" if _ENABLE_DOCS else None,
)

app.add_middleware(CorrelationIdMiddleware)
# M3: never send credentials together with a wildcard origin. Credentials are
# only enabled when explicit, non-wildcard origins are configured — otherwise
# we fail closed (no credentialed CORS) rather than reflect "*" with cookies.
_cors_origins = settings.CORS_ORIGINS
_allow_credentials = bool(_cors_origins) and "*" not in _cors_origins
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=_allow_credentials,
    allow_methods=["*"],
    allow_headers=["*"],
    # Content-Disposition must be exposed or a cross-origin fetch cannot read
    # the real filename off a download response (attachments, exports).
    expose_headers=["X-Correlation-ID", "Content-Disposition"],
)

app.add_exception_handler(DomainException, domain_exception_handler)
app.add_exception_handler(Exception, global_exception_handler)

app.include_router(auth_router)
app.include_router(dashboard_router)
app.include_router(health_router)
app.include_router(lookups_router)
app.include_router(organisations_router)
app.include_router(policies_router)
app.include_router(location_router)
app.include_router(users_router)
app.include_router(addresses_router)
app.include_router(orgsetup_router)
app.include_router(business_units_router)
app.include_router(departments_router)
app.include_router(designations_router)
app.include_router(orgdocuments_router)
app.include_router(employees_router)
app.include_router(assets_router)
app.include_router(bands_router)
app.include_router(paygrades_router)
app.include_router(master_data_router)
app.include_router(custom_fields_router)
app.include_router(dependency_check_router)
app.include_router(exit_management_router)
app.include_router(announcements_router)
from src.modules.journey.router import router as journey_router
app.include_router(journey_router)
from src.modules.directory.router import router as directory_router
app.include_router(directory_router)
from src.modules.employee_pin.router import router as employee_pin_router
app.include_router(employee_pin_router)
app.include_router(logo_proxy_router)
from src.modules.audit_logs.router import router as audit_logs_router
app.include_router(audit_logs_router)
app.include_router(graph_router)

if __name__ == "__main__":
    import uvicorn

    uvicorn.run("src.main:app", host="0.0.0.0", port=8000, reload=settings.ENVIRONMENT == "development")
