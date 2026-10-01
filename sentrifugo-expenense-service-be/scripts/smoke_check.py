"""Standalone connectivity smoke check for the expense service dependencies.

Run after `docker compose up -d` (or after `pull_env_from_openbao.py`) to confirm
MongoDB, Valkey and RabbitMQ are reachable with the current `.env`:

    python -m scripts.smoke_check

Targets are read from `src.config.settings`, so this checks exactly what the app
would connect to. Prints a PASS/FAIL line per backend and exits non-zero if any
required backend is unreachable — useful in CI / deploy gates. This is committed
(unlike `local_scripts/`) because it contains no secrets and is safe for everyone
to run.
"""

from __future__ import annotations

import asyncio
import sys

from src import valkey
from src.config import settings
from src.database import close_db, get_mongo, init_db
from src.rabbitmq import close_rabbitmq, init_rabbitmq, is_connected
from src.valkey import close_valkey, init_valkey


def _pass(backend: str, target: str) -> None:
    print(f"[PASS] {backend:<9} reachable  ({target})")


def _fail(backend: str, target: str, exc: object) -> None:
    print(f"[FAIL] {backend:<9} UNREACHABLE ({target}): {exc}")


def _mongo_target() -> str:
    host = getattr(settings, "MONGO_DB_HOST", "?")
    port = getattr(settings, "MONGO_DB_PORT", "?")
    name = getattr(settings, "MONGO_DB_NAME", "sentrifugo_expense")
    return f"{host}:{port}/{name}"


def _valkey_target() -> str:
    return f"{getattr(settings, 'VALKEY_HOST', '?')}:{getattr(settings, 'VALKEY_PORT', '?')}"


def _rabbitmq_target() -> str:
    url = str(getattr(settings, "RABBITMQ_URL", "?"))
    # Never print credentials: keep only the host part of amqp://user:pass@host:port/vhost
    return url.rsplit("@", 1)[-1] if "@" in url else url


async def check_mongo() -> bool:
    target = _mongo_target()
    try:
        await init_db()
        await get_mongo().command("ping")
    except Exception as exc:
        _fail("MongoDB", target, exc)
        return False
    _pass("MongoDB", target)
    return True


async def check_valkey() -> bool:
    target = _valkey_target()
    try:
        await init_valkey()
        if not (valkey.valkey_client and await valkey.valkey_client.ping()):
            _fail("Valkey", target, "no client / ping returned falsy")
            return False
    except Exception as exc:
        _fail("Valkey", target, exc)
        return False
    _pass("Valkey", target)
    return True


async def check_rabbitmq() -> bool:
    target = _rabbitmq_target()
    try:
        await init_rabbitmq()
        if not is_connected():
            _fail("RabbitMQ", target, "not connected")
            return False
    except Exception as exc:
        _fail("RabbitMQ", target, exc)
        return False
    _pass("RabbitMQ", target)
    return True


async def _close_all() -> None:
    for closer in (close_rabbitmq, close_valkey, close_db):
        try:
            await closer()
        except Exception:  # teardown must never mask the check result
            pass


async def main() -> int:
    print("Expense service - connectivity smoke check\n")
    results = {
        "MongoDB": await check_mongo(),
        "Valkey": await check_valkey(),
        "RabbitMQ": await check_rabbitmq(),
    }
    await _close_all()

    failed = [name for name, ok in results.items() if not ok]
    print()
    if failed:
        print(f"RESULT: FAIL - unreachable: {', '.join(failed)}")
        return 1
    print("RESULT: PASS - all backends reachable")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
