"""RabbitMQ package — outbox is the single entry point for publishing.

All publishing must go through ``src.rabbitmq.outbox`` so messages survive
broker downtime via the transactional outbox + relay loop. Services should
never touch the connection directly.
"""

from src.rabbitmq import outbox
from src.rabbitmq.connection import (
    close_rabbitmq,
    init_rabbitmq,
    is_connected,
)
from src.rabbitmq.constants import DebugLevel
from src.rabbitmq.consumers import start_dept_consumer_task, stop_dept_consumer
from src.rabbitmq.outbox import publish_event, start_relay, stop_relay

__all__ = [
    "DebugLevel",
    "close_rabbitmq",
    "init_rabbitmq",
    "is_connected",
    "outbox",
    "publish_event",
    "start_dept_consumer_task",
    "start_relay",
    "stop_dept_consumer",
    "stop_relay",
]
