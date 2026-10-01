"""One-off backfill for SR-2026-000059. This ticket and no other.

WHY
    `trigger_l2_approval` never set `approval_triggered_at`; only the L1 path
    (`submit_for_approval`) did. Because `approve` clears `current_level_index`
    the moment a decision lands, that field is the only remaining evidence that
    a ticket ever went through an approval — so SR-2026-000059, which was sent
    straight to L2 without an L1, carries none.

    The approval itself is intact: the `approval_decisions` row (level 2,
    approved, 2026-09-02T12:05:53.122Z), the email and the audit trail are all
    correct. Only the display broke. The Tracker rendered the approval row as
    `hidden` while the ticket was active and, now that it is `resolved`,
    relabels it "Skipped — approval not triggered" — on an approval that
    demonstrably happened.

    Fixed in code on feature/sr-hotfix. This repairs the one document written
    before that fix.

SCOPE
    Exactly one document, addressed by _id AND ticket_no, both hard-coded
    below. There is no --ticket flag and no org sweep: at the time of writing
    this is the only affected ticket in the database, and a one-off repair
    should not carry a mechanism for touching anything else.

    If more affected tickets appear later, verify with:

        db.service_requests.countDocuments({
          deleted_on: null,
          level_2_approver_user_id: { $ne: null },
          approval_triggered_at: null })

    and write a fresh script for them rather than widening this one.

WHAT IT WRITES
    approval_triggered_at  — when the first approval was raised
    level_2_triggered_at   — level 2's own clock (added with the code fix)

    Both to the same value, which is correct here: the L2 trigger *is* the
    first approval on this ticket. Nothing else is modified — no status, no
    decision row, no emails, no re-publishing.

WHERE THE VALUE COMES FROM
    The `submitted_for_approval` outbox row. `publish_event` fires immediately
    after `sr.save()` in `trigger_l2_approval`, so its `created_at` is the
    trigger time to within milliseconds. Nothing is inferred: if that row has
    been purged the script REPORTS THE BOUNDS AND REFUSES, because a wrong
    value silently corrupts approval-latency analytics rather than failing
    loudly. Pick one deliberately in that case.

    The value is bounds-checked before it is written — at or after
    `first_response_at` (which `trigger_l2_approval` requires) and at or before
    the L2 `decided_at`. A trigger later than its own decision would feed
    negative hours into the decision-latency average in
    `analytics.metrics.descriptive`.

ORDER
    Deploy the code fix FIRST, then run this. `ServiceRequest` is Pydantic
    `extra="ignore"`, so a build predating the model change reads
    `level_2_triggered_at` fine but silently DROPS it on the next `sr.save()`.

SAFETY
    Reporting is the default action; ``--apply`` is the only thing that writes.
    ``--host-must-contain`` refuses to write unless the Mongo URI contains the
    given substring, so reusing the command with a different URI cannot quietly
    hit another environment. Check the printed database name before applying.

    The update is guarded on ``approval_triggered_at: None``, so a re-run after
    a successful apply matches nothing rather than overwriting.

USAGE
    python scripts/backfill_sr_2026_000059.py
    python scripts/backfill_sr_2026_000059.py --apply --host-must-contain <host>

ROLLBACK
    db.service_requests.updateOne(
      { _id: ObjectId("6a9803f91609a9c0efe93ee5") },
      { $set: { approval_triggered_at: null },
        $unset: { level_2_triggered_at: "" } })

Exits 1 if the ticket was left unrepaired, 2 on a configuration refusal.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from bson import ObjectId  # noqa: E402
from motor.motor_asyncio import AsyncIOMotorClient  # noqa: E402

from src.config import settings  # noqa: E402

# The one document this script exists to repair. Both are checked, so pointing
# it at a database where that _id belongs to a different ticket refuses rather
# than writing to the wrong row.
TICKET_NO = "SR-2026-000059"
SR_ID = ObjectId("6a9803f91609a9c0efe93ee5")


def _fmt(value: Any) -> str:
    if isinstance(value, datetime):
        return value.isoformat(timespec="milliseconds")
    return "—" if value is None else str(value)


async def main(
    apply: bool,
    host_must_contain: str,
    uri: str | None,
    db_name: str | None,
) -> int:
    mongo_uri = uri or settings.MONGODB_URL
    if apply and host_must_contain and host_must_contain not in mongo_uri:
        print(
            f"REFUSED: the Mongo URI does not contain {host_must_contain!r}.\n"
            "         This guard exists so the command cannot be pointed at a\n"
            "         different environment by swapping the URI. Pass\n"
            "         --host-must-contain '' to disable it deliberately."
        )
        return 2

    client = AsyncIOMotorClient(mongo_uri, uuidRepresentation="standard")
    db = client[db_name or settings.MONGO_DB_NAME]

    safe_uri = mongo_uri
    if "@" in safe_uri:
        safe_uri = safe_uri[: safe_uri.index("://") + 3] + "***@" + safe_uri.split("@", 1)[1]

    print("=" * 74)
    print(f"  SRM one-off backfill — {TICKET_NO}")
    print("=" * 74)
    print(f"  connection : {safe_uri}")
    print(f"  database   : {db.name}")
    print(f"  target     : {SR_ID}")
    print(f"  mode       : {'*** WRITING ***' if apply else 'REPORT ONLY (no --apply)'}")
    print("=" * 74)

    # ── 1. The ticket ──────────────────────────────────────────────────────
    sr = await db.service_requests.find_one({"_id": SR_ID, "ticket_no": TICKET_NO})
    if sr is None:
        print(
            f"\nREFUSED: {TICKET_NO} not found at {SR_ID} in {db.name}.\n"
            "         Either this is the wrong database, or that _id belongs to\n"
            "         a different ticket. Nothing written.\n"
        )
        return 2

    print(f"\n  status            : {sr.get('request_status')}")
    print(f"  first_response_at : {_fmt(sr.get('first_response_at'))}")
    print(f"  approval_trig_at  : {_fmt(sr.get('approval_triggered_at'))}")
    print(f"  level_2_trig_at   : {_fmt(sr.get('level_2_triggered_at'))}")
    print(f"  L1 approver       : {_fmt(sr.get('level_1_approver_user_id'))}")
    print(f"  L2 approver       : {_fmt(sr.get('level_2_approver_user_id'))}")

    if sr.get("approval_triggered_at") is not None:
        print("\n  Already backfilled. Nothing to do.\n")
        return 0
    if not sr.get("level_2_approver_user_id"):
        print("\nREFUSED: no L2 approver snapshot — not the L2-direct case.\n")
        return 2
    if sr.get("level_1_approver_user_id"):
        print(
            "\nREFUSED: this ticket carries an L1 snapshot, so it is not the\n"
            "         L2-direct case this script was written for.\n"
        )
        return 2

    # ── 2. Upper bound — the L2 decision ───────────────────────────────────
    decision = await db.approval_decisions.find_one(
        {"service_request_id": SR_ID, "level_index": 2, "deleted_on": None}
    )
    if decision is None:
        print("\nREFUSED: no level-2 approval_decision — nothing was approved.\n")
        return 2
    decided_at = decision.get("decided_at")
    print(f"  L2 decided_at     : {_fmt(decided_at)}  ({decision.get('decision')})")

    # ── 3. Exact value — the outbox row trigger_l2_approval published ──────
    # Matched on the payload rather than event_type: "submitted_for_approval"
    # is absent from outbox.ROUTING_KEYS so it resolves through the default
    # branch, and an older build may have keyed it differently.
    # service_request_id (stored as a string) + level_index is already unique.
    row = await db.outbox_events.find_one(
        {"payload.service_request_id": str(SR_ID), "payload.level_index": 2},
        sort=[("created_at", 1)],
    )
    if row is None or not isinstance(row.get("created_at"), datetime):
        print(
            "\nREFUSED: no usable submitted_for_approval outbox row — the exact\n"
            f"         trigger time is unrecoverable. It lies between\n"
            f"         {_fmt(sr.get('first_response_at'))} and {_fmt(decided_at)}.\n"
            "         Choose a value deliberately and hard-code it rather than\n"
            "         letting this script guess. Nothing written.\n"
        )
        return 1
    triggered_at: datetime = row["created_at"]
    print(f"  outbox created_at : {_fmt(triggered_at)}  <- value to write")

    # ── 4. Bounds ──────────────────────────────────────────────────────────
    first_response_at = sr.get("first_response_at")
    if isinstance(first_response_at, datetime) and triggered_at < first_response_at:
        print(
            f"\nREFUSED: trigger {_fmt(triggered_at)} precedes first response\n"
            f"         {_fmt(first_response_at)} — impossible. Nothing written.\n"
        )
        return 1
    if isinstance(decided_at, datetime) and triggered_at > decided_at:
        print(
            f"\nREFUSED: trigger {_fmt(triggered_at)} is after its own decision\n"
            f"         {_fmt(decided_at)} — would yield negative approval\n"
            "         latency in analytics. Nothing written.\n"
        )
        return 1

    wait_min = (decided_at - triggered_at).total_seconds() / 60
    print(f"  => L2 waited {wait_min:.1f} minutes before being approved")
    print(f"\n  Plan: approval_triggered_at = level_2_triggered_at = {_fmt(triggered_at)}")

    if not apply:
        print("\n  REPORT ONLY — nothing written. Re-run with --apply.\n")
        return 0

    # ── 5. Apply ───────────────────────────────────────────────────────────
    res = await db.service_requests.update_one(
        # Guarded on None so a re-run cannot overwrite a good value.
        {"_id": SR_ID, "ticket_no": TICKET_NO, "approval_triggered_at": None},
        {"$set": {
            "approval_triggered_at": triggered_at,
            "level_2_triggered_at": triggered_at,
        }},
    )
    print(f"\n  matched={res.matched_count} modified={res.modified_count}")

    # ── 6. Verify ──────────────────────────────────────────────────────────
    after = await db.service_requests.find_one(
        {"_id": SR_ID},
        {"ticket_no": 1, "request_status": 1,
         "approval_triggered_at": 1, "level_2_triggered_at": 1},
    )
    if after is None or after.get("approval_triggered_at") is None:
        print("\n  FAILED: post-write verification — field still empty.\n")
        return 1

    print(f"  approval_trig_at  : {_fmt(after.get('approval_triggered_at'))}")
    print(f"  level_2_trig_at   : {_fmt(after.get('level_2_triggered_at'))}")
    print(
        f"\n  Done. Reopen {TICKET_NO} — the Approval Level 2 row should now read\n"
        '  as completed with its decision time instead of "Skipped".\n'
    )
    return 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--apply", action="store_true", help="write (default: report only)")
    ap.add_argument(
        "--host-must-contain",
        default="",
        help="refuse to write unless the Mongo URI contains this substring",
    )
    ap.add_argument("--uri", help="Mongo URI override (default: settings.MONGODB_URL)")
    ap.add_argument("--db", help="Database override (default: settings.MONGO_DB_NAME)")
    args = ap.parse_args()

    raise SystemExit(
        asyncio.run(
            main(
                apply=args.apply,
                host_must_contain=args.host_must_contain,
                uri=args.uri,
                db_name=args.db,
            )
        )
    )
