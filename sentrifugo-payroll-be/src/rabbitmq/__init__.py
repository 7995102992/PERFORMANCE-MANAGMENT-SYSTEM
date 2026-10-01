"""RabbitMQ package — outbox is the single entry point for publishing.

All publishing must go through ``src.rabbitmq.outbox`` so messages survive
broker downtime via the transactional outbox + relay loop. Services should
never touch the connection directly.
"""

from src.rabbitmq import iam_rpc, outbox
from src.rabbitmq.connection import (
    close_rabbitmq,
    init_rabbitmq,
    is_connected,
)
from src.rabbitmq.constants import DebugLevel
from src.rabbitmq.outbox import start_relay, stop_relay

__all__ = [
    "DebugLevel",
    "close_rabbitmq",
    "iam_rpc",
    "init_rabbitmq",
    "is_connected",
    "outbox",
    "start_relay",
    "stop_relay",
]
