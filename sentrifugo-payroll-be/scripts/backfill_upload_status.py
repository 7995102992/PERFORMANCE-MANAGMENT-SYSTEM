"""One-time backfill of ``UploadedPayslipDocument.status``.

Uploads created before the ``status`` field existed have no value stored, so a
``status=processed`` filter on ``GET /payslips/uploads`` never matches them. This
stamps each upload: ``processed`` when it populated payslips, else ``uploaded``.
Safe to re-run (idempotent); leaves ``processed``/``failed`` rows untouched.

    python -m scripts.backfill_upload_status
"""
from __future__ import annotations

import asyncio

from src.database import close_db, init_db
from src.payslips import service


async def main() -> None:
    await init_db()
    try:
        tally = await service.backfill_upload_statuses()
        print(f"[ok] upload status backfill: {tally}")
    finally:
        await close_db()


if __name__ == "__main__":
    asyncio.run(main())
