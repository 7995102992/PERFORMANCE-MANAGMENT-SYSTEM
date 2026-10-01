from contextvars import ContextVar

from beanie import init_beanie
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from motor.motor_asyncio import AsyncIOMotorClient, AsyncIOMotorDatabase

from src.config import settings
from src.logger import logger

# Connection pools (created once at startup)
pg_engine = None
pg_session_maker = None
mongo_client: AsyncIOMotorClient | None = None
mongo_db: AsyncIOMotorDatabase | None = None

# Per-request context (PostgreSQL only — Beanie manages MongoDB globally)
_pg_session_var: ContextVar[AsyncSession | None] = ContextVar("pg_session", default=None)


async def init_db():
    global pg_engine, pg_session_maker, mongo_client, mongo_db
    
    if settings.DATABASE_TYPE == 'sql':
        pg_engine = create_async_engine(settings.POSTGRES_URL, echo=settings.ENVIRONMENT == "development")
        pg_session_maker = async_sessionmaker(pg_engine, expire_on_commit=False, class_=AsyncSession)
        logger.info("PostgreSQL engine initialized")

    if settings.DATABASE_TYPE == 'nosql':
        mongo_client = AsyncIOMotorClient(settings.MONGODB_URL)
        mongo_db = mongo_client.get_default_database()

        from src.models import (
            AclDocument,
            AssetDocument,
            ModuleDocument,
            OutboxEventDocument,
            PermissionDocument,
        )
        from src.auth.models import UserDocument, PasswordHistoryDocument
        from src.policies.models import PolicyDocument, ModuleAclPermissionDocument
        from src.modules.organisation.models import (
            AddressDocument,
            BandDocument,
            BusinessUnitDocument,
            DepartmentDocument,
            DesignationDocument,
            DocumentAcknowledgementDocument,
            DocumentFolderDocument,
            EmployeeDocument,
            OrgDocumentDocument,
            OrgDocumentVersionDocument,
            OrganisationDocument,
            PayGradeDocument,
        )
        from src.master_data.models import MasterDataDocument
        from src.modules.journey.models import (
            JourneyTimelineDocument,
            JourneyMetricsDocument,
            JourneyProcessedEventDocument,
        )
        from src.modules.custom_fields.models import (
            CustomFieldDefinitionDocument,
            CustomFieldOptionDocument,
            CustomFieldValueDocument,
        )
        from src.modules.exit_management.models import (
            ExitRequestDocument,
            ExitInterviewDocument,
            ITAssetReturnDocument,
            AdminTaskDocument,
            FinanceClearanceDocument,
            DepartmentChecklistDocument,
        )
        from src.modules.employee_pin.models import EmployeePinDocument
        from src.modules.announcements.models import AnnouncementDocument

        await init_beanie(
            database=mongo_db,
            document_models=[
                UserDocument,
                PasswordHistoryDocument,
                AclDocument,
                ModuleDocument,
                PermissionDocument,
                PolicyDocument,
                ModuleAclPermissionDocument,
                OutboxEventDocument,
                AssetDocument,
                AddressDocument,
                OrganisationDocument,
                BusinessUnitDocument,
                BandDocument,
                DepartmentDocument,
                DesignationDocument,
                PayGradeDocument,
                DocumentFolderDocument,
                OrgDocumentDocument,
                OrgDocumentVersionDocument,
                DocumentAcknowledgementDocument,
                EmployeeDocument,
                MasterDataDocument,
                JourneyTimelineDocument,
                JourneyMetricsDocument,
                JourneyProcessedEventDocument,
                CustomFieldDefinitionDocument,
                CustomFieldOptionDocument,
                CustomFieldValueDocument,
                ExitRequestDocument,
                ExitInterviewDocument,
                ITAssetReturnDocument,
                AdminTaskDocument,
                FinanceClearanceDocument,
                DepartmentChecklistDocument,
                EmployeePinDocument,
                AnnouncementDocument,
            ],
        )
        logger.info("MongoDB + Beanie ODM initialized")

        # One-shot migration: backfill emp_code_prefix for any BU that lacks it
        await _backfill_bu_emp_code_prefix()

        # One-shot migration: drop legacy unique index on custom_field_definitions
        # that scoped uniqueness by (organisation_id, key) only. The new index also
        # includes entity_type, so the old one would still block valid duplicates.
        await _drop_legacy_custom_field_def_index()

        # One-shot migration: backfill activated_at for already-active users so
        # they aren't mistaken for "pending activation".
        await _backfill_user_activated_at()

    if not settings.DATABASE_TYPE:
        logger.warning("No database URLs configured")


async def _backfill_user_activated_at():
    """Set activated_at for existing ACTIVE users that predate the field.

    activated_at is the source of truth for 'pending activation'. Any user who
    is already ACTIVE has obviously activated, so stamp them with their
    modified_on (or created_on) so they're never flagged pending.
    """
    from src.auth.models import UserDocument

    try:
        result = await UserDocument.get_motor_collection().update_many(
            {
                "status": "active",  # StatusEnum.ACTIVE
                "deleted_on": None,
                "$or": [{"activated_at": None}, {"activated_at": {"$exists": False}}],
            },
            [{"$set": {"activated_at": {"$ifNull": ["$modified_on", "$created_on"]}}}],
        )
        if result.modified_count:
            logger.info(f"Backfilled activated_at for {result.modified_count} active users")
    except Exception as e:
        logger.warning(f"activated_at backfill failed: {e}")


async def _backfill_bu_emp_code_prefix():
    """Assign a random 3-letter prefix to any BU missing emp_code_prefix."""
    import random
    import string
    from src.modules.organisation.models import BusinessUnitDocument

    try:
        # Find BUs where emp_code_prefix is missing or null
        bus = await BusinessUnitDocument.find(
            {"$or": [{"emp_code_prefix": None}, {"emp_code_prefix": {"$exists": False}}]}
        ).to_list()

        if not bus:
            return

        # Track used prefixes per org so we don't collide
        used_by_org: dict[str, set[str]] = {}
        for bu in bus:
            org_key = str(bu.organisation_id)
            if org_key not in used_by_org:
                # Preload already-used prefixes for this org
                existing = await BusinessUnitDocument.find(
                    {"organisation_id": bu.organisation_id, "emp_code_prefix": {"$ne": None}}
                ).to_list()
                used_by_org[org_key] = {e.emp_code_prefix for e in existing if e.emp_code_prefix}

        for bu in bus:
            org_key = str(bu.organisation_id)
            used = used_by_org[org_key]
            # Generate a 3-letter uppercase code not already used
            for _ in range(50):
                candidate = "".join(random.choices(string.ascii_uppercase, k=3))
                if candidate not in used:
                    break
            else:
                # Fallback: append digits until unique
                candidate = "".join(random.choices(string.ascii_uppercase, k=2)) + str(random.randint(0, 9))
            used.add(candidate)
            bu.emp_code_prefix = candidate
            if bu.emp_code_last_number is None:
                bu.emp_code_last_number = 0
            await bu.save()

        logger.info(f"Backfilled emp_code_prefix for {len(bus)} business units")
    except Exception as e:
        logger.warning(f"BU emp_code_prefix backfill failed: {e}")


async def _drop_legacy_custom_field_def_index():
    """Drop the pre-existing `organisation_id_1_key_1` unique index on
    custom_field_definitions, if present. The new composite index
    (organisation_id, entity_type, key) replaces it."""
    try:
        coll = mongo_db.get_collection("custom_field_definitions")
        index_info = await coll.index_information()
        for name, spec in index_info.items():
            keys = spec.get("key", [])
            if (
                spec.get("unique")
                and len(keys) == 2
                and keys[0][0] == "organisation_id"
                and keys[1][0] == "key"
            ):
                await coll.drop_index(name)
                logger.info(f"Dropped legacy custom_field_definitions index '{name}'")
    except Exception as e:
        logger.warning(f"Legacy custom_field_definitions index drop failed: {e}")


async def close_db():
    if pg_engine:
        await pg_engine.dispose()
    if mongo_client:
        mongo_client.close()


async def setup_db_context():
    """App-level dependency for per-request PostgreSQL sessions.

    MongoDB no longer needs per-request context — Beanie manages it globally.
    """
    pg_token = None
    session = None

    if pg_session_maker:
        session = pg_session_maker()
        pg_token = _pg_session_var.set(session)

    try:
        yield
        if session:
            await session.commit()
    except Exception:
        if session:
            await session.rollback()
        raise
    finally:
        if session:
            await session.close()
        if pg_token:
            _pg_session_var.reset(pg_token)


def get_pg() -> AsyncSession:
    """Get the current request's PostgreSQL session."""
    session = _pg_session_var.get()
    if session is None:
        raise RuntimeError("No PostgreSQL session — is POSTGRES_URL configured?")
    return session


def get_mongo() -> AsyncIOMotorDatabase:
    """Get the Motor database instance (for health check ping and raw queries)."""
    if mongo_db is None:
        raise RuntimeError("No MongoDB connection — is MONGODB_URL configured?")
    return mongo_db
