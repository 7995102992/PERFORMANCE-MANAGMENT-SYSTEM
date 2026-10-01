"""Tests for src.rabbitmq.constants."""
from src.rabbitmq.constants import (
    DebugLevel,
    DomainEventsRabbitMQConfig,
    AuditLoggingRabbitMQConfig,
    EmailEventsRabbitMQConfig,
    domain_events_config,
    audit_logging_config,
    email_events_config,
)


class TestExchangeConfigs:
    def test_domain_events_exchange_name(self):
        assert domain_events_config.EXCHANGE_NAME == "domain_events"

    def test_audit_events_exchange_name(self):
        assert audit_logging_config.EXCHANGE_NAME == "audit_events"

    def test_email_events_exchange_name(self):
        assert email_events_config.EXCHANGE_NAME == "email_events"

    def test_relay_defaults(self):
        assert domain_events_config.RELAY_INTERVAL_SECONDS == 5
        assert domain_events_config.RELAY_BATCH_SIZE == 50
        assert domain_events_config.MAX_RETRIES == 10


class TestDebugLevel:
    def test_ordering(self):
        assert DebugLevel.EMPLOYEE < DebugLevel.MANAGER < DebugLevel.HR < DebugLevel.ADMIN

    def test_values(self):
        assert int(DebugLevel.EMPLOYEE) == 1
        assert int(DebugLevel.ADMIN) == 4
