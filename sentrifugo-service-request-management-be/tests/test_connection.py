"""Tests for src.rabbitmq.connection."""
from unittest.mock import AsyncMock, patch

import pytest

from src.rabbitmq.connection import ensure_ready, is_connected


class TestIsConnected:
    def test_returns_false_when_no_connection(self):
        with patch("src.rabbitmq.connection.rabbitmq_connection", None):
            assert is_connected() is False

    def test_returns_false_when_closed(self):
        mock_conn = AsyncMock()
        mock_conn.is_closed = True
        with patch("src.rabbitmq.connection.rabbitmq_connection", mock_conn):
            assert is_connected() is False

    def test_returns_true_when_open(self):
        mock_conn = AsyncMock()
        mock_conn.is_closed = False
        with patch("src.rabbitmq.connection.rabbitmq_connection", mock_conn):
            assert is_connected() is True


class TestEnsureReady:
    """`ensure_ready` self-heals — with no live connection it re-runs
    `init_rabbitmq` before answering, so the relay and publishers recover on
    their own once the broker comes back and nobody has to restart the process.

    That makes "no connection" an input to a reconnect attempt rather than an
    answer, so both tests below stub `init_rabbitmq`. Leaving it unstubbed does
    not test anything: it dials the real broker from the .env, and on a machine
    where that broker is up the assertion is about the developer's network
    rather than the code. It also leaks the connection it opened past the end of
    the event loop.
    """

    async def test_returns_false_when_the_reconnect_fails(self):
        # `init_rabbitmq` swallows its own errors and leaves the global at None,
        # so a stub that does nothing is exactly a failed reconnect.
        with (
            patch("src.rabbitmq.connection.rabbitmq_connection", None),
            patch(
                "src.rabbitmq.connection.init_rabbitmq", new_callable=AsyncMock
            ) as init,
        ):
            assert await ensure_ready() is False
        init.assert_awaited_once()

    async def test_reconnects_when_there_is_no_connection(self):
        """The self-heal itself: no connection in, usable connection out."""
        import src.rabbitmq.connection as conn_mod

        healed = AsyncMock()
        healed.is_closed = False
        healed.ready = AsyncMock()

        async def _reconnect():
            conn_mod.rabbitmq_connection = healed

        with (
            patch("src.rabbitmq.connection.rabbitmq_connection", None),
            patch("src.rabbitmq.connection.init_rabbitmq", _reconnect),
        ):
            assert await ensure_ready() is True

    async def test_a_closed_connection_is_reopened(self):
        """Same path as above but reached through `is_closed` rather than None —
        a robust connection that dropped is still an object, so a check that
        only tested for None would sit on a dead socket forever."""
        import src.rabbitmq.connection as conn_mod

        dead = AsyncMock()
        dead.is_closed = True
        healed = AsyncMock()
        healed.is_closed = False
        healed.ready = AsyncMock()

        async def _reconnect():
            conn_mod.rabbitmq_connection = healed

        with (
            patch("src.rabbitmq.connection.rabbitmq_connection", dead),
            patch("src.rabbitmq.connection.init_rabbitmq", _reconnect),
        ):
            assert await ensure_ready() is True

    async def test_returns_true_when_ready(self):
        mock_conn = AsyncMock()
        mock_conn.is_closed = False
        mock_conn.ready = AsyncMock()
        with patch("src.rabbitmq.connection.rabbitmq_connection", mock_conn):
            assert await ensure_ready() is True

    async def test_returns_false_on_timeout(self):
        import asyncio

        async def slow_ready():
            await asyncio.sleep(10)

        mock_conn = AsyncMock()
        mock_conn.is_closed = False
        mock_conn.ready = slow_ready
        with patch("src.rabbitmq.connection.rabbitmq_connection", mock_conn):
            assert await ensure_ready() is False
