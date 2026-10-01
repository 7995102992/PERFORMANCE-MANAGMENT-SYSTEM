import uuid
from datetime import datetime, timezone

from sqlalchemy import Boolean, Column, DateTime, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    pass


class InboxEvent(Base):
    __tablename__ = "inbox_events"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(String(255), nullable=False)
    idempotency_key = Column(UUID(as_uuid=True), nullable=False)
    event_type = Column(String(255), nullable=False)
    correlation_id = Column(UUID(as_uuid=True), nullable=False)
    payload = Column(JSONB, nullable=False)
    status = Column(String(20), nullable=False, default="received")
    error_detail = Column(Text, nullable=True)
    received_at = Column(DateTime(timezone=True), nullable=False, default=lambda: datetime.now(timezone.utc))
    processed_at = Column(DateTime(timezone=True), nullable=True)

    __table_args__ = (
        UniqueConstraint("tenant_id", "idempotency_key", name="uq_inbox_tenant_idempotency"),
        Index("idx_inbox_events_tenant_status", "tenant_id", "status"),
        Index("idx_inbox_events_received_at", "received_at"),
    )


class EmailLog(Base):
    __tablename__ = "email_log"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(String(255), nullable=False)
    idempotency_key = Column(UUID(as_uuid=True), nullable=False)
    correlation_id = Column(UUID(as_uuid=True), nullable=False)
    to_email = Column(String(320), nullable=False)
    template_id = Column(String(255), nullable=False)
    template_data = Column(JSONB, nullable=False, default=dict)
    provider_used = Column(String(50), nullable=True)
    status = Column(String(20), nullable=False, default="queued")
    attempts = Column(Integer, nullable=False, default=0)
    error_detail = Column(Text, nullable=True)
    scheduled_at = Column(DateTime(timezone=True), nullable=True)
    sent_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, default=lambda: datetime.now(timezone.utc))

    __table_args__ = (
        UniqueConstraint("tenant_id", "idempotency_key", name="uq_email_log_tenant_idempotency"),
        Index("idx_email_log_tenant_status", "tenant_id", "status"),
    )


class TenantEmailConfig(Base):
    __tablename__ = "tenant_email_config"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(String(255), nullable=False, unique=True)
    primary_provider = Column(String(50), nullable=False, default="brevo")
    fallback_chain = Column(JSONB, nullable=False, default=list)
    sender_email = Column(String(320), nullable=False)
    sender_name = Column(String(255), nullable=False, default="")
    daily_rate_limit = Column(Integer, nullable=False, default=1000)
    is_active = Column(Boolean, nullable=False, default=True)
    created_at = Column(DateTime(timezone=True), nullable=False, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime(timezone=True), nullable=True)


class TemplateMapping(Base):
    __tablename__ = "template_mappings"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(String(255), nullable=False)
    template_id = Column(String(255), nullable=False)
    provider = Column(String(50), nullable=False)
    provider_template_ref = Column(String(512), nullable=False)
    is_active = Column(Boolean, nullable=False, default=True)

    __table_args__ = (
        UniqueConstraint("tenant_id", "template_id", "provider", name="uq_template_tenant_provider"),
        Index("idx_template_mapping_lookup", "tenant_id", "template_id"),
    )
