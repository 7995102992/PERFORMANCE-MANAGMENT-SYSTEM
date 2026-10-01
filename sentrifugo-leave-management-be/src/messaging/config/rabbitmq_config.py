import aio_pika

from src.logger import logger
from src.messaging.constants.exchanges import Exchanges
from src.messaging.constants.queues import Queues
from src.messaging.constants.routing_keys import RoutingKeys
from src.rabbitmq import get_rabbitmq_channel


async def declare_dlq_infrastructure() -> None:
    """Declare the shared dead-letter queue (DLQ) on RabbitMQ.

    The DLQ is the dead-letter target for the domain-events / IAM / RPC queues
    (``x-dead-letter-routing-key=Queues.DLQ``) and the retry middleware. Audit
    events are published to the shared ``audit_events`` exchange via the
    transactional outbox (see ``src/audit.py``); this service no longer declares
    its own audit exchange or runs a local audit consumer.
    """
    async with get_rabbitmq_channel() as channel:
        await channel.declare_queue(
            Queues.DLQ,
            durable=True,
        )
        logger.info("DLQ infrastructure declared", dlq=Queues.DLQ)


async def declare_domain_events_infrastructure() -> None:
    """Declare the domain_events exchange binding and a single inbound queue for all IAM entity events."""

    domain_event_routing_keys = [
        RoutingKeys.EMPLOYEE_CREATED,
        RoutingKeys.EMPLOYEE_UPDATED,
        RoutingKeys.EMPLOYEE_DELETED,
        RoutingKeys.BUSINESS_UNIT_CREATED,
        RoutingKeys.BUSINESS_UNIT_UPDATED,
        RoutingKeys.BUSINESS_UNIT_DELETED,
        RoutingKeys.DEPARTMENT_CREATED,
        RoutingKeys.DEPARTMENT_UPDATED,
        RoutingKeys.DEPARTMENT_DELETED,
        RoutingKeys.DESIGNATION_CREATED,
        RoutingKeys.DESIGNATION_UPDATED,
        RoutingKeys.DESIGNATION_DELETED,
        RoutingKeys.ORGANISATION_CREATED,
        RoutingKeys.ORGANISATION_UPDATED,
        RoutingKeys.ORGANISATION_DELETED,
        RoutingKeys.POLICY_CREATED,
        RoutingKeys.POLICY_DELETED,
        RoutingKeys.DOMAIN_USER_CREATED,
        RoutingKeys.EMPLOYMENT_STATUS_CREATED,
        RoutingKeys.EMPLOYMENT_STATUS_UPDATED,
        RoutingKeys.EMPLOYMENT_STATUS_DELETED,
        RoutingKeys.EMPLOYMENT_TYPE_CREATED,
        RoutingKeys.EMPLOYMENT_TYPE_UPDATED,
        RoutingKeys.EMPLOYMENT_TYPE_DELETED,
    ]

    async with get_rabbitmq_channel() as channel:
        domain_exchange = await channel.declare_exchange(
            Exchanges.DOMAIN_EVENTS,
            aio_pika.ExchangeType.TOPIC,
            durable=True,
        )

        domain_queue = await channel.declare_queue(
            Queues.DOMAIN_EVENTS,
            durable=True,
            arguments={
                "x-dead-letter-exchange": "",
                "x-dead-letter-routing-key": Queues.DLQ,
            },
        )

        for routing_key in domain_event_routing_keys:
            await domain_queue.bind(domain_exchange, routing_key=routing_key)

        logger.info(
            "Domain events infrastructure declared",
            exchange=Exchanges.DOMAIN_EVENTS,
            queue=Queues.DOMAIN_EVENTS,
        )


async def declare_iam_infrastructure() -> None:
    """Declare IAM exchange bindings and queues for ingesting BU/department data."""

    async with get_rabbitmq_channel() as channel:
        # Declare the IAM exchange (topic, published by the IAM service)
        iam_exchange = await channel.declare_exchange(
            Exchanges.IAM,
            aio_pika.ExchangeType.TOPIC,
            durable=True,
        )

        # Business unit queue
        bu_queue = await channel.declare_queue(
            Queues.BUSINESS_UNIT_SYNCED,
            durable=True,
            arguments={
                "x-dead-letter-exchange": "",
                "x-dead-letter-routing-key": Queues.DLQ,
            },
        )
        await bu_queue.bind(iam_exchange, routing_key=RoutingKeys.BUSINESS_UNIT_SYNCED)

        # Department queue
        dept_queue = await channel.declare_queue(
            Queues.DEPARTMENT_SYNCED,
            durable=True,
            arguments={
                "x-dead-letter-exchange": "",
                "x-dead-letter-routing-key": Queues.DLQ,
            },
        )
        await dept_queue.bind(iam_exchange, routing_key=RoutingKeys.DEPARTMENT_SYNCED)

        logger.info(
            "IAM infrastructure declared",
            exchange=Exchanges.IAM,
            bu_queue=Queues.BUSINESS_UNIT_SYNCED,
            dept_queue=Queues.DEPARTMENT_SYNCED,
        )


async def declare_shift_details_rpc_infrastructure() -> None:
    """Declare the durable queue that receives shift details Direct Reply-To RPC requests."""
    async with get_rabbitmq_channel() as channel:
        await channel.declare_queue(
            Queues.SHIFT_DETAILS_RPC,
            durable=True,
            arguments={
                "x-dead-letter-exchange": "",
                "x-dead-letter-routing-key": Queues.DLQ,
            },
        )
        logger.info("Shift details RPC queue declared", queue=Queues.SHIFT_DETAILS_RPC)


async def declare_leave_calendar_rpc_infrastructure() -> None:
    """Declare the durable queue that receives Direct Reply-To RPC requests."""
    async with get_rabbitmq_channel() as channel:
        await channel.declare_queue(
            Queues.LEAVE_CALENDAR_RPC,
            durable=True,
            arguments={
                "x-dead-letter-exchange": "",
                "x-dead-letter-routing-key": Queues.DLQ,
            },
        )
        logger.info("Leave calendar RPC queue declared", queue=Queues.LEAVE_CALENDAR_RPC)
