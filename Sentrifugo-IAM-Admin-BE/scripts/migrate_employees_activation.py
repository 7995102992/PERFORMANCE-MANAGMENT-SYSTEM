"""Employee migration — ACTIVATION variant.

Same migration as scripts/migrate_employees_active.py (BUs, departments,
designations, employees, org admins, report + clean CSV), EXCEPT active
employees are created PENDING (no password) and an activation email is sent to
each so they set their own password. The email is enqueued exactly like the
create flow: an activation/reset token is stored in Valkey and an event is
published to the outbox, which the relay -> RabbitMQ -> schedule service turns
into a real email.

Left/inactive employees and rehire (old-stint) records are never emailed.
Org admins (admin, SIL-01) are always created already-active with a password.

Requires Valkey + the outbox relay + the schedule service to be running for the
emails to actually go out.

Usage:
    cd Sentrifugo-IAM-Admin-BE
    python -m scripts.migrate_employees_activation              # DRY RUN (report only)
    python -m scripts.migrate_employees_activation --commit     # import + send activation
    python -m scripts.migrate_employees_activation --revert     # undo the import
"""

import asyncio

from scripts.migrate_employees_active import main

if __name__ == "__main__":
    asyncio.run(main(mode="activation"))
