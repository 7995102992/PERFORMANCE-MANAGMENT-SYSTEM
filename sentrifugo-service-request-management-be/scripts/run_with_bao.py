"""Run any migration/one-off script with secrets loaded LIVE from OpenBao.

Unlike scripts/pull_env_from_openbao.py (which writes a .env file), this pulls the
merged KV secrets (secret/shared/datastores + this service's path) straight into
os.environ and then executes the target module in the SAME process. pydantic
BaseSettings (src.config) reads real env vars BEFORE the .env file, so the target
picks these up even if a stale .env exists — nothing is written to disk. Any
subprocess the target spawns inherits the environment too.

The wrapper is only a prefix on the command — no target script needs to change.

Usage (from repo root):
    python -m scripts.run_with_bao scripts.<some_migration> --commit
    python -m scripts.run_with_bao scripts.<some_migration> --revert

Connection config (BAO_ADDR / BAO_TOKEN / BAO_KV_MOUNT / BAO_KV_PATH /
BAO_KV_SHARED_PATH) resolves like pull_env_from_openbao.py: env var -> .env -> default.
"""

from __future__ import annotations

import os
import runpy
import sys

try:
    import hvac  # noqa: F401
except ImportError:
    sys.exit("hvac is not installed. Run: pip install hvac  (or pip install -r requirements.txt)")

import hvac

from scripts.pull_env_from_openbao import (
    BOOTSTRAP_PREFIX,
    read_merged_secrets,
    resolve_config,
    resolve_token,
)


def load_bao_into_env() -> tuple[int, str, str, str, str]:
    """Read merged KV secrets and set each as an env var. Returns (count, addr, mount, path, shared)."""
    addr, mount, path, shared = resolve_config()
    client = hvac.Client(url=addr, token=resolve_token())
    if not client.is_authenticated():
        sys.exit(f"OpenBao auth failed at {addr}. Check BAO_TOKEN / server reachability.")

    secrets = read_merged_secrets(client, mount, path, shared)
    if not secrets:
        sys.exit(f"No secrets found at {mount}/{path} (+{shared}). Seed them first with seed_env_to_openbao.py.")

    count = 0
    for key, value in secrets.items():
        if key.startswith(BOOTSTRAP_PREFIX):
            continue
        os.environ[key] = "" if value is None else str(value)
        count += 1
    return count, addr, mount, path, shared


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit("usage: python -m scripts.run_with_bao <module> [args...]")

    module = sys.argv[1]
    count, addr, mount, path, shared = load_bao_into_env()
    print(f"Loaded {count} secrets from OpenBao ({addr}  {mount}/{{{shared},{path}}}) into the environment.")
    print(f"Running: {module} {' '.join(sys.argv[2:])}\n")

    sys.argv = [module, *sys.argv[2:]]
    runpy.run_module(module, run_name="__main__", alter_sys=True)


if __name__ == "__main__":
    main()
