from enum import IntEnum


class DomainEventsRabbitMQConfig:
    EXCHANGE_NAME = "domain_events"
    RELAY_INTERVAL_SECONDS = 5
    RELAY_BATCH_SIZE = 50
    MAX_RETRIES = 10


class AuditLoggingRabbitMQConfig:
    EXCHANGE_NAME = "audit_events"
    # Consumer-side bindings (this service is the consumer of audit_events).
    QUEUE_NAME = "logging_service_audit"
    # `audit.#` matches one-OR-MORE segments. `audit.*` matched exactly one, so a
    # producer that ever published a multi-segment key (e.g. audit.task.succeeded
    # without collapsing dots) would be silently dropped as unroutable. `#` makes
    # this catch-all sink robust to any audit routing key.
    ROUTING_PATTERN = "audit.#"


class EmailEventsRabbitMQConfig:
    EXCHANGE_NAME = "email_events"


class DebugLevel(IntEnum):
    EMPLOYEE = 1
    MANAGER = 2
    HR = 3
    ADMIN = 4


domain_events_config = DomainEventsRabbitMQConfig()
audit_logging_config = AuditLoggingRabbitMQConfig()
email_events_config = EmailEventsRabbitMQConfig()
