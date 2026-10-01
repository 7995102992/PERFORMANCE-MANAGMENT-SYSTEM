"""Purge one organisation's SRM data so testing can start from a clean slate.

Deletes, for a single ``--org``:

  * every service request, and everything hanging off one — approval decisions,
    comments, internal notes, attachments, handoff events, SLA deadlines
  * the catalogue — categories, request types, workflows, approval levels,
    approvers, escalation configs (skip with ``--keep-config``)
  * the ticket-number counter, so the next ticket is SR-<year>-000001
    (skip with ``--keep-counter``)

Reporting is the default action; ``--apply`` is the only thing that deletes.

WHY THE ORDER MATTERS
    `approval_levels` and `approvers` carry no ``organisation_id``. The only
    route to them is workflow → level → approver. Delete the workflows first
    and the rows beneath become not merely orphaned but unidentifiable — there
    is nothing left in the document tying them to this org. So every id is
    resolved up front, before anything is deleted.

    `sla_deadlines.service_request_id` is a **string**, not an ObjectId: the
    SLA store was ported off a Valkey ZSET whose members were strings. Matching
    it with ObjectIds deletes nothing and raises nothing, leaving live breach
    timers pointed at tickets that no longer exist — they fire, resolve no
    ticket, and mail whoever was assigned.

WHAT IT DOES NOT TOUCH
    departments, employees
        IAM replicas. SRM does not own them, they are re-synced from IAM, and
        deleting them here only breaks name resolution until the next sync.

    other organisations
        Every filter is pinned to ``--org``. Nothing is matched by name,
        prefix or "looks like test data".

    Valkey (VALKEY_DB=3)
        Holds the idempotency keys and is SHARED with the other services on
        this host. Do not flush it. A stale idempotency key only affects a
        replayed create carrying the same client key, which a fresh test run
        does not send.

    attachment blobs
        Only the ``attachments`` rows go. Object storage is not in this
        database, so the script prints the ``storage_key``s it is orphaning.

    outbox_events / org_sr_config
        Opt in with ``--purge-outbox`` / ``--purge-org-config``. Outbox rows
        already marked `sent` are a delivery record the relay ignores, and
        org_sr_config is setup (business hours, holidays, timezone, fiscal-year
        start) rather than test data — dropping it silently moves SLA maths onto
        the UTC/April defaults.

SAFETY
    ``--host-must-contain`` refuses to delete unless the Mongo URI contains the
    given substring, so reusing the command with a different URI cannot quietly
    hit another environment. Check the printed database name before applying:
    this host carries several SRM databases (sentrifugo_srm, purge_test_srm,
    sentrifugo_srm_test) and they are not interchangeable.

Exits 1 if anything was left behind, 2 on a configuration refusal.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from bson import ObjectId  # noqa: E402
from motor.motor_asyncio import AsyncIOMotorClient  # noqa: E402

from src.config import settings  # noqa: E402

# `$in` batches, to stay clear of the 16MB BSON document limit. An org with
# tens of thousands of tickets would otherwise build one oversized query.
CHUNK = 5000

# Ticket children. None of them carry `organisation_id`, so each is resolved
# through the ticket ids — a ticket-only delete orphans every one. The third
# element says whether the foreign key is stored as a string (see the module
# docstring on sla_deadlines).
TICKET_CHILDREN: list[tuple[str, str, bool]] = [
    ("approval_decisions", "service_request_id", False),
    ("comments", "service_request_id", False),
    ("internal_notes", "service_request_id", False),
    ("attachments", "service_request_id", False),
    ("handoff_events", "service_request_id", False),
    ("sla_deadlines", "service_request_id", True),
]


def _chunks(items: list[Any]) -> list[list[Any]]:
    return [items[i : i + CHUNK] for i in range(0, len(items), CHUNK)] or [[]]


async def _count(coll, field: str, ids: list[Any]) -> int:
    if not ids:
        return 0
    total = 0
    for batch in _chunks(ids):
        total += await coll.count_documents({field: {"$in": batch}})
    return total


async def _delete(coll, field: str, ids: list[Any]) -> int:
    if not ids:
        return 0
    total = 0
    for batch in _chunks(ids):
        res = await coll.delete_many({field: {"$in": batch}})
        total += res.deleted_count
    return total


async def _ids_of(coll, filt: dict[str, Any]) -> list[ObjectId]:
    return [d["_id"] async for d in coll.find(filt, {"_id": 1})]


async def main(
    org_id: str,
    apply: bool,
    keep_config: bool,
    keep_counter: bool,
    purge_outbox: bool,
    purge_org_config: bool,
    host_must_contain: str,
    uri: str | None,
    db_name: str | None,
) -> int:
    try:
        org_oid = ObjectId(org_id)
    except Exception:
        print(f"REFUSED: --org {org_id!r} is not a 24-character hex ObjectId.")
        return 2

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

    scope = "tickets only (catalogue kept)" if keep_config else "tickets + catalogue"
    print("=" * 74)
    print("  SRM organisation purge")
    print("=" * 74)
    print(f"  connection : {safe_uri}")
    print(f"  database   : {db.name}")
    print(f"  org        : {org_id}")
    print(f"  scope      : {scope}")
    print(f"  mode       : {'*** DELETING ***' if apply else 'REPORT ONLY (no --apply)'}")
    print("=" * 74)

    # Matched as ObjectId *or* string. The models declare PydanticObjectId so
    # everything the app writes is an ObjectId, but a document hand-inserted by
    # a script or an older migration can carry the string form — and the failure
    # mode of missing one is a leftover row in a slate you believe is clean.
    org_match = {"$in": [org_oid, org_id]}

    # ── 1. Resolve every id BEFORE deleting anything ───────────────────────
    tickets = [
        d
        async for d in db.service_requests.find(
            {"organisation_id": org_match}, {"_id": 1, "ticket_no": 1}
        )
    ]
    ticket_ids = [t["_id"] for t in tickets]
    ticket_id_strs = [str(i) for i in ticket_ids]
    ticket_nos = [t.get("ticket_no") for t in tickets if t.get("ticket_no")]

    category_ids: list[ObjectId] = []
    request_type_ids: list[ObjectId] = []
    workflow_ids: list[ObjectId] = []
    level_ids: list[ObjectId] = []
    approver_ids: list[ObjectId] = []
    if not keep_config:
        category_ids = await _ids_of(db.categories, {"organisation_id": org_match})
        request_type_ids = await _ids_of(db.request_types, {"organisation_id": org_match})
        workflow_ids = await _ids_of(db.workflows, {"organisation_id": org_match})
        # No organisation_id on either — the workflow chain is the only route in.
        for batch in _chunks(workflow_ids):
            if batch:
                level_ids += await _ids_of(db.approval_levels, {"workflow_id": {"$in": batch}})
        for batch in _chunks(level_ids):
            if batch:
                approver_ids += await _ids_of(
                    db.approvers, {"approval_level_id": {"$in": batch}}
                )

    # ── 2. Report the blast radius ─────────────────────────────────────────
    print(f"\nTickets: {len(ticket_ids)}")
    if ticket_nos:
        # Sorted, not find-order. Printing the first and last document Mongo
        # happened to return reads as a range while being neither end of one —
        # it understates the span, which is the wrong direction for a number
        # someone is eyeballing before a delete.
        _sorted_nos = sorted(ticket_nos)
        print(f"  {_sorted_nos[0]} … {_sorted_nos[-1]}")

    print("\nIn scope:")
    for coll_name, field, as_str in TICKET_CHILDREN:
        ids = ticket_id_strs if as_str else ticket_ids
        print(f"  {coll_name:<26}{await _count(db[coll_name], field, ids)}")
    print(f"  {'service_requests':<26}{len(ticket_ids)}")

    if not keep_config:
        esc = await _count(db.escalation_configs, "workflow_id", workflow_ids)
        print(f"  {'approvers':<26}{len(approver_ids)}")
        print(f"  {'approval_levels':<26}{len(level_ids)}")
        print(f"  {'escalation_configs':<26}{esc}")
        print(f"  {'workflows':<26}{len(workflow_ids)}")
        print(f"  {'request_types':<26}{len(request_type_ids)}")
        print(f"  {'categories':<26}{len(category_ids)}")

    # Blobs outlive their rows — object storage is not in this database.
    keys: list[str] = []
    for batch in _chunks(ticket_ids):
        if batch:
            keys += [
                a["storage_key"]
                async for a in db.attachments.find(
                    {"service_request_id": {"$in": batch}}, {"storage_key": 1, "_id": 0}
                )
                if a.get("storage_key")
            ]
    if keys:
        print(f"\nOrphaned attachment blobs ({len(keys)}) — delete these from object")
        print("storage separately; this script only removes the Mongo rows:")
        for k in keys[:20]:
            print(f"  {k}")
        if len(keys) > 20:
            print(f"  … {len(keys) - 20} more")

    # Extras — reported either way, so the report says what stays as well as
    # what goes.
    counter_filter = {"_id": {"$regex": f"^{org_id}:sr:"}}
    counters = [d async for d in db.counters.find(counter_filter)]
    print(
        f"\n  counters (ticket numbering): {len(counters)}"
        + (" — WILL RESET" if not keep_counter else " — kept")
    )
    for c in counters:
        print(f"      {c['_id']} = {c.get('value')}")

    # Outbox rows reach a ticket through four shapes depending on which
    # publisher wrote them; there is no single field to filter on.
    outbox_filter = {
        "$or": [
            {"payload.service_request_id": {"$in": ticket_id_strs}},   # publish_event
            {"payload.ticket_no": {"$in": ticket_nos}},                # domain events
            {"payload.metadata.organisation_id": org_id},              # emit_activity/emit_audit
            {"payload.tenant_id": org_id},                             # email_events envelope
        ]
    }
    n_outbox = await db.outbox_events.count_documents(outbox_filter)
    print(f"  outbox_events: {n_outbox}" + (" — WILL DELETE" if purge_outbox else " — kept"))

    n_cfg = await db.org_sr_config.count_documents({"organisation_id": org_match})
    print(
        f"  org_sr_config: {n_cfg}"
        + (" — WILL DELETE" if purge_org_config else " — kept")
    )

    if not apply:
        print("\n" + "-" * 74)
        print("REPORT ONLY — nothing was deleted. Re-run with --apply to delete.")
        print("-" * 74 + "\n")
        client.close()
        return 0

    # ── 3. Delete, children before parents ─────────────────────────────────
    print("\n" + "-" * 74)
    print("Deleting…")

    for coll_name, field, as_str in TICKET_CHILDREN:
        ids = ticket_id_strs if as_str else ticket_ids
        print(f"  {coll_name:<24}{await _delete(db[coll_name], field, ids)} deleted")

    res = await db.service_requests.delete_many({"organisation_id": org_match})
    print(f"  {'service_requests':<24}{res.deleted_count} deleted")

    if not keep_config:
        # Bottom-up. Ids were captured in step 1, so this order is about leaving
        # a coherent tree if the run dies partway, not about reachability.
        print(f"  {'approvers':<24}{await _delete(db.approvers, '_id', approver_ids)} deleted")
        print(f"  {'approval_levels':<24}{await _delete(db.approval_levels, '_id', level_ids)} deleted")
        print(f"  {'escalation_configs':<24}{await _delete(db.escalation_configs, 'workflow_id', workflow_ids)} deleted")
        print(f"  {'workflows':<24}{await _delete(db.workflows, '_id', workflow_ids)} deleted")
        print(f"  {'request_types':<24}{await _delete(db.request_types, '_id', request_type_ids)} deleted")
        print(f"  {'categories':<24}{await _delete(db.categories, '_id', category_ids)} deleted")

    if purge_outbox:
        res = await db.outbox_events.delete_many(outbox_filter)
        print(f"  {'outbox_events':<24}{res.deleted_count} deleted")

    if purge_org_config:
        res = await db.org_sr_config.delete_many({"organisation_id": org_match})
        print(f"  {'org_sr_config':<24}{res.deleted_count} deleted")

    if not keep_counter:
        # Deleted rather than zeroed: next_ticket_number upserts, so a missing
        # counter and a zeroed one behave identically, and a missing one cannot
        # be misread later as "this org has never raised a ticket".
        res = await db.counters.delete_many(counter_filter)
        print(f"  {'counters':<24}{res.deleted_count} deleted (next = SR-<year>-000001)")

    # ── 4. Verify ──────────────────────────────────────────────────────────
    print("\nVerifying…")
    leftovers = await db.service_requests.count_documents({"organisation_id": org_match})
    for coll_name, field, as_str in TICKET_CHILDREN:
        ids = ticket_id_strs if as_str else ticket_ids
        leftovers += await _count(db[coll_name], field, ids)
    if not keep_config:
        for coll_name in ("categories", "request_types", "workflows"):
            leftovers += await db[coll_name].count_documents({"organisation_id": org_match})
        leftovers += await _count(db.approval_levels, "_id", level_ids)
        leftovers += await _count(db.approvers, "_id", approver_ids)

    print(f"  rows remaining in scope: {leftovers}")
    print("-" * 74)
    print("Clean. Ready to test.\n" if leftovers == 0
          else "INCOMPLETE — rows remain. Investigate before testing.\n")

    client.close()
    return 0 if leftovers == 0 else 1


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument(
        "--org",
        required=True,
        help="organisation_id to purge. Required — there is no 'all' mode.",
    )
    ap.add_argument(
        "--apply",
        action="store_true",
        help="Delete. Without it the script only reports what it would delete.",
    )
    ap.add_argument(
        "--keep-config",
        action="store_true",
        help=(
            "Keep categories, request types, workflows, approval levels, "
            "approvers and escalation configs — wipe only the tickets. Use when "
            "you want to re-run the same scenarios against the same setup."
        ),
    )
    ap.add_argument(
        "--keep-counter",
        action="store_true",
        help=(
            "Leave the ticket-number counter alone, so numbering continues from "
            "where it stopped instead of restarting at SR-<year>-000001."
        ),
    )
    ap.add_argument(
        "--purge-outbox",
        action="store_true",
        help="Also delete outbox_events referring to this org (default: keep).",
    )
    ap.add_argument(
        "--purge-org-config",
        action="store_true",
        help=(
            "Also delete org_sr_config — business hours, holidays, timezone, "
            "fiscal-year start. Dropping it moves SLA maths onto the UTC/April "
            "defaults."
        ),
    )
    ap.add_argument(
        "--host-must-contain",
        default="168.144.29.6",
        help=(
            "Refuse to delete unless the Mongo URI contains this substring "
            "(default: testserv, 168.144.29.6 — testserv.sentrifugo.com resolves "
            "there). Note this is NOT the host in the repo's .env, which is "
            "168.144.156.236 and holds a different dataset entirely: pass --uri "
            "to reach testserv. Pass '' to disable the guard."
        ),
    )
    ap.add_argument("--uri", help="Mongo URI override (default: settings.MONGODB_URL)")
    ap.add_argument("--db", help="Database override (default: settings.MONGO_DB_NAME)")
    args = ap.parse_args()
    raise SystemExit(
        asyncio.run(
            main(
                args.org,
                args.apply,
                args.keep_config,
                args.keep_counter,
                args.purge_outbox,
                args.purge_org_config,
                args.host_must_contain,
                args.uri,
                args.db,
            )
        )
    )
