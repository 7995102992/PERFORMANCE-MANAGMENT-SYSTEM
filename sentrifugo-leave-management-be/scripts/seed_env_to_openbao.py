"""Seed this service's .env into OpenBao (QA / testserv).

One-shot / occasional: reads a local .env file and pushes this service's OWN
KEY=VALUE pairs into OpenBao's KV v2 engine at `secret/lms`.

IMPORTANT — the shared datastore creds (Mongo/Valkey/Neo4j/RabbitMQ) are managed
CENTRALLY in `secret/shared/datastores` by Sentrifugo-DevOps/openbao/provision.sh.
This script SKIPS those keys by default so it never forks the shared datastore
config. Pass --include-shared only if you deliberately want to override them here.

BAO_* keys are LOCAL bootstrap config (connection + token). They are NEVER pushed
to OpenBao — storing the access token inside the store it unlocks is circular.

Usage (from repo root):
    python scripts/seed_env_to_openbao.py                 # seeds ./.env (service keys only)
    python scripts/seed_env_to_openbao.py --env-file .env.qa
    python scripts/seed_env_to_openbao.py --include-shared # also push datastore creds
    python scripts/seed_env_to_openbao.py --dry-run

Connection config resolves in this order: real env var -> ./.env -> default.
    BAO_ADDR                    OpenBao address (default: http://openbao:8200)
    BAO_TOKEN                   token with write access (or a BAO_TOKEN_FILE / .bao-token file)
    BAO_KV_MOUNT / BAO_KV_PATH  KV mount + path (default: secret / lms)
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

try:
    import hvac
except ImportError:
    sys.exit("hvac is not installed. Run: pip install hvac  (or pip install -r requirements.txt)")

# Default is the compose service name `openbao` — works from INSIDE a container on
# the same docker network as OpenBao (how the services reach it). On the QA host
# itself use http://127.0.0.1:8200; from a laptop use an SSH tunnel. testserv only
# publishes OpenBao to 127.0.0.1:8200, so the public IP 168.144.29.6 will NOT work.
# Override anytime with the BAO_ADDR env var.
DEFAULT_ADDR = "http://openbao:8200"
DEFAULT_MOUNT = "secret"
DEFAULT_PATH = "lms"
# Keys with this prefix are local bootstrap config, never stored in OpenBao.
BOOTSTRAP_PREFIX = "BAO_"
# Datastore creds live once in secret/shared/datastores (managed by DevOps
# provision.sh) — mirrors that script's SHARED_KEYS so we don't fork them per service.
SHARED_KEYS = {
    "MONGO_DB_HOST", "MONGO_DB_PORT", "MONGO_DB_USER", "MONGO_DB_PASSWORD",
    "NEO4J_HOST", "NEO4J_PORT", "NEO4J_USER", "NEO4J_PASSWORD",
    "VALKEY_HOST", "VALKEY_PORT", "VALKEY_USER", "VALKEY_PASSWORD", "RABBITMQ_URL",
}


def parse_env_file(path: Path) -> dict[str, str]:
    data: dict[str, str] = {}
    if not path.is_file():
        return data
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if key.startswith("export "):
            key = key[len("export "):].strip()
        if key:
            data[key] = value.strip()
    return data


def _local_env() -> dict[str, str]:
    return parse_env_file(Path(".env"))


def resolve_config() -> tuple[str, str, str]:
    local = _local_env()
    addr = os.environ.get("BAO_ADDR") or local.get("BAO_ADDR") or DEFAULT_ADDR
    mount = os.environ.get("BAO_KV_MOUNT") or local.get("BAO_KV_MOUNT") or DEFAULT_MOUNT
    path = os.environ.get("BAO_KV_PATH") or local.get("BAO_KV_PATH") or DEFAULT_PATH
    return addr, mount, path


def resolve_token() -> str:
    token = os.environ.get("BAO_TOKEN")
    if token:
        return token.strip()
    token_file = Path(os.environ.get("BAO_TOKEN_FILE", ".bao-token"))
    if token_file.is_file():
        return token_file.read_text(encoding="utf-8").strip()
    token = _local_env().get("BAO_TOKEN")
    if token:
        return token.strip()
    sys.exit(
        "No OpenBao token. Set $BAO_TOKEN, add BAO_TOKEN to .env, or use a .bao-token "
        "file (the root token is printed by openbao/scripts/init.sh)."
    )


def main() -> None:
    ap = argparse.ArgumentParser(description="Seed a .env file into OpenBao KV v2.")
    ap.add_argument("--env-file", default=".env", help="path to the .env to seed (default: .env)")
    ap.add_argument("--include-shared", action="store_true",
                    help="also push shared datastore keys (default: skip; they are managed in secret/shared/datastores)")
    ap.add_argument("--dry-run", action="store_true", help="print keys that would be written, then exit")
    args = ap.parse_args()

    env_path = Path(args.env_file)
    if not env_path.is_file():
        sys.exit(f".env file not found: {env_path}")

    parsed = parse_env_file(env_path)
    skipped_boot = sorted(k for k in parsed if k.startswith(BOOTSTRAP_PREFIX))
    skipped_shared = [] if args.include_shared else sorted(k for k in parsed if k in SHARED_KEYS)
    drop = set(skipped_boot) | set(skipped_shared)
    secrets = {k: v for k, v in parsed.items() if k not in drop}
    if not secrets:
        sys.exit(f"No service KEY=VALUE entries found in {env_path} (after skipping bootstrap/shared keys).")

    addr, mount, path = resolve_config()

    print(f"Parsed {len(secrets)} service keys from {env_path}:")
    for key in secrets:
        print(f"  - {key}")
    if skipped_boot:
        print(f"Skipping {len(skipped_boot)} bootstrap key(s): {', '.join(skipped_boot)}")
    if skipped_shared:
        print(f"Skipping {len(skipped_shared)} shared datastore key(s) (managed in secret/shared/datastores): "
              f"{', '.join(skipped_shared)}")

    if args.dry_run:
        print(f"\n[dry-run] would write to {addr}  {mount}/{path}. Nothing sent.")
        return

    client = hvac.Client(url=addr, token=resolve_token())
    if not client.is_authenticated():
        sys.exit(f"OpenBao auth failed at {addr}. Check BAO_TOKEN / server reachability.")

    client.secrets.kv.v2.create_or_update_secret(mount_point=mount, path=path, secret=secrets)
    print(f"\nSeeded {len(secrets)} secrets to {addr}  {mount}/{path}.")


if __name__ == "__main__":
    main()
