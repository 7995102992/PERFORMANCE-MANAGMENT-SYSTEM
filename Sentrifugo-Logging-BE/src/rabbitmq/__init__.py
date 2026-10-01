"""Public API for the RabbitMQ subsystem.

Services publish via :mod:`src.rabbitmq.outbox` only. Direct ``aio_pika``
usage and direct access to the connection singleton are forbidden outside
this package.
"""

from src.rabbitmq import outbox
from src.rabbitmq.connection import close_rabbitmq, init_rabbitmq, is_connected
from src.rabbitmq.constants import DebugLevel
from src.rabbitmq.outbox import start_relay, stop_relay

__all__ = [
    "init_rabbitmq",
    "close_rabbitmq",
    "is_connected",
    "start_relay",
    "stop_relay",
    "outbox",
    "DebugLevel",
]

