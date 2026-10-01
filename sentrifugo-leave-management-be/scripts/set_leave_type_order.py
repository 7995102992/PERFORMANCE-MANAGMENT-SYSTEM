"""Pin the display order of the leading leave types.

    1. Earned Leave
    2. Wellness Leave
    3. Work From Home
    4. Comp Off
    5. Loss of Pay

Leave types are listed in ``rank`` order everywhere - the admin table, the
employee's apply dropdown, the balance card. Only these need a fixed position;
every other type is intentionally left unranked and sorts after them,
alphabetically. This reproduces on another environment the ordering already
verified on QA.

Best-effort by design: an organisation is numbered over whichever of these it
actually has, densely and in the order above - so an org missing Work From Home
gets Earned 1, Wellness 2, Comp Off 3, Loss of Pay 4. An org with none of them
is left untouched. A missing type is never an error, because ranks are only
ever compared to each other; skipping one changes no relative order.

Matching is by NAME keyword (case-insensitive substring), because codes drift
between environments and even between deployments of the same seed - QA has
renamed Loss of Pay's code from ``LOP`` to ``LOSS_OF_PAY`` and Work From Home's
from ``WFH`` to ``WORK_FROM_HOME``. The known codes are still accepted as a
fallback so a renamed type is found anyway. If a keyword matches several types
the script prints all of them and picks the closest name, so an ambiguous match
is visible rather than silent.

Ranks are per-organisation. With no ``--org`` every organisation in the
database is processed independently; pass ``--org`` to target exactly one.

Usage:
    # Dry run - print what WOULD change (default):
    python -m scripts.set_leave_type_order

    # One organisation, dry run then apply:
    python -m scripts.set_leave_type_order --org 6a481cbeefd9f278b3708209
    python -m scripts.set_leave_type_order --org 6a481cbeefd9f278b3708209 --apply

    # Every organisation:
    python -m scripts.set_leave_type_order --apply

    # Also clear ranks on OTHER types in the same org, so nothing competes with
    # the leading positions (leaves them unranked, as on QA):
    python -m scripts.set_leave_type_order --org <id> --clear-others --apply

Idempotent: types already at the wanted rank are skipped.
"""

import argparse
import asyncio
from datetime import datetime, timezone

from motor.motor_asyncio import AsyncIOMotorClient

from src.config import settings
from src.utils import to_oid

COLLECTION = "leave_types"

# Priority order. Whichever of these an org actually has are numbered 1, 2, ...
# in this sequence; the rest of the org's types stay unranked.
#
# Keywords are deliberately specific. "work from home" rather than "work from",
# because an org can also carry "Work from Customer Location" - a looser keyword
# would match both and the wrong one could win.
TARGETS: list[dict] = [
    {
        "label": "Earned",
        "keywords": ("earned",),
        "codes": ("EARNED_LEAVE", "EL"),
    },
    {
        "label": "Wellness",
        "keywords": ("wellness",),
        "codes": ("WL", "WELLNESS_LEAVE"),
    },
    {
        "label": "Work From Home",
        "keywords": ("work from home",),
        "codes": ("WORK_FROM_HOME", "WFH"),
    },
    {
        "label": "Comp Off",
        # "Compensatory Days", "Comp Off", "Comp-Off" all land here. Matching is
        # by name, NOT the is_comp_off flag - other types (Weekly Off) carry
        # that flag without being the comp-off leave type.
        "keywords": ("comp off", "comp-off", "compensatory"),
        "codes": ("COMPENSATORY_DAYS", "COMP_OFF", "COMPOFF"),
    },
    {
        "label": "Loss of Pay",
        "keywords": ("loss of pay",),
        # "LOP" is only ever matched as an exact CODE, never as a name
        # substring, which would hit unrelated words.
        "codes": ("LOSS_OF_PAY", "LOP"),
    },
]


def _norm_name(value: str | None) -> str:
    """Fold a display name to a comparable form.

    Names are typed by hand and drift: "Comp Off", "comp off", "Comp-Off",
    "Work  From  Home" (double space), "Loss of Pay " (trailing space) are all
    the same type. Lowercase, turn separators into spaces, and collapse runs of
    whitespace, so any of those spellings compares equal.
    """
    text = str(value or "").lower()
    for separator in ("-", "_", "/", " "):  # incl. non-breaking space
        text = text.replace(separator, " ")
    return " ".join(text.split())


def _norm_code(value: str | None) -> str:
    """Fold a code the same way, to a single underscore-separated form.

    Lets ``WORK_FROM_HOME``, ``work from home`` and ``Work-From-Home`` all
    compare equal.
    """
    return _norm_name(value).replace(" ", "_").upper()


def _match_score(doc: dict, target: dict) -> tuple[int, int] | None:
    """How well a leave type matches a target, or None if it doesn't.

    Lower sorts better. Ranked: exact code hit, then name starting with the
    keyword, then name merely containing it - and among equals the shorter
    name, so "Earned Leave" beats "Earned Leave Encashment Adjustment".

    Both sides are normalised first, so casing and stray spacing never decide
    whether a type is found.
    """
    name = _norm_name(doc.get("name"))
    code = _norm_code(doc.get("code"))

    if code in {_norm_code(c) for c in target["codes"]}:
        return (0, len(name))
    for keyword in target["keywords"]:
        keyword = _norm_name(keyword)
        if name.startswith(keyword):
            return (1, len(name))
        if keyword in name:
            return (2, len(name))
    return None


def _resolve(items: list[dict], target: dict, org_key: str) -> dict | None:
    """The one leave type in this org that is `target`, or None."""
    scored = [(score, d) for d in items if (score := _match_score(d, target)) is not None]
    if not scored:
        return None
    scored.sort(key=lambda pair: pair[0])
    if len(scored) > 1:
        print(
            f"org={org_key}: NOTE - {len(scored)} types match '{target['label']}': "
            + ", ".join(f"[{d.get('code')}] {d.get('name')}" for _, d in scored)
            + f"  -> using [{scored[0][1].get('code')}] {scored[0][1].get('name')}"
        )
    return scored[0][1]


async def set_order(
    apply: bool, org_id: str | None, clear_others: bool, actor_id: str | None = None
) -> None:
    if not settings.MONGODB_URL:
        print("ERROR: MONGODB_URL is not configured. Check your .env file.")
        return

    # Validated up front: a bad id must fail before anything is written, not
    # halfway through the loop leaving the collection half-updated.
    actor_oid = None
    if actor_id:
        try:
            actor_oid = to_oid(actor_id)
        except Exception:
            print(f"ERROR: --actor {actor_id!r} is not a valid ObjectId.")
            return

    client = AsyncIOMotorClient(settings.MONGODB_URL)
    db = client.get_default_database()

    query: dict = {"deleted_on": None}
    if org_id:
        query["org_id"] = {"$in": [to_oid(org_id), str(org_id)]}

    docs = await db[COLLECTION].find(
        query, {"_id": 1, "org_id": 1, "name": 1, "code": 1, "rank": 1, "created_by": 1}
    ).to_list(length=None)

    if not docs:
        print("No leave types found for that filter. Nothing to do.")
        client.close()
        return

    # Ranks are per-org, so decide org by org.
    groups: dict[str, list[dict]] = {}
    for d in docs:
        groups.setdefault(str(d.get("org_id")), []).append(d)

    planned: list[tuple[dict, int | None]] = []
    touched_orgs = 0

    for org_key in sorted(groups):
        items = groups[org_key]

        # Rank densely over whatever was found: all five present -> 1..5; a gap
        # in the middle just shifts the rest up. Only the relative order is ever
        # read, so a dense sequence is always correct.
        found = [(target, doc) for target in TARGETS if (doc := _resolve(items, target, org_key))]
        if not found:
            print(f"org={org_key}: nothing to order (none of the listed leave types present)")
            continue

        touched_orgs += 1
        target_ids = set()
        for position, (target, doc) in enumerate(found, start=1):
            target_ids.add(doc["_id"])
            if doc.get("rank") != position:
                planned.append((doc, position))

        if clear_others:
            for doc in items:
                if doc["_id"] not in target_ids and doc.get("rank") is not None:
                    planned.append((doc, None))
        else:
            # Not clearing, but ranks elsewhere still sort among the leading
            # positions - surface them as one line instead of leaving it
            # silent (an org can have many, so don't print one line each).
            others = sorted(
                (d for d in items if d["_id"] not in target_ids and d.get("rank") is not None),
                key=lambda d: d["rank"],
            )
            if others:
                listed = ", ".join(f"[{d.get('code')}]={d['rank']}" for d in others[:8])
                more = f", +{len(others) - 8} more" if len(others) > 8 else ""
                print(
                    f"org={org_key}: NOTE - {len(others)} other type(s) already ranked and kept "
                    f"as-is ({listed}{more}). Use --clear-others to unset them."
                )

    if touched_orgs == 0:
        print("\nNo organisation has an Earned or Wellness leave type. Nothing to do.")
        client.close()
        return

    if not planned:
        print(f"\nOrder already correct in {touched_orgs} organisation(s). Nothing to do.")
        client.close()
        return

    print(f"\n{'APPLYING' if apply else 'DRY RUN'} - {len(planned)} change(s) across {touched_orgs} org(s):\n")
    for doc, rank in planned:
        current = doc.get("rank") if doc.get("rank") is not None else "(none)"
        target = rank if rank is not None else "(cleared)"
        print(
            f"  org={doc.get('org_id')}  [{doc.get('code')}] {doc.get('name')}"
            f"   rank {current} -> {target}"
        )

    if not apply:
        print("\nDry run only - no changes written. Re-run with --apply to update.")
        client.close()
        return

    now = datetime.now(timezone.utc)
    for doc, rank in planned:
        # updated_by is an ObjectId column (see AuditMixin) and the response
        # model coerces it with ObjectId(v) on every read. Writing a label like
        # "..._script" here parses fine on the way in and then makes
        # GET /leave-types fail with a 400 for the whole org. Attribute the
        # change to a real user: the --actor admin, else whoever created the
        # type. Never a free-text string.
        actor = actor_oid or doc.get("created_by")
        update: dict = {"rank": rank, "updated_on": now}
        if actor is not None:
            update["updated_by"] = actor
        await db[COLLECTION].update_one({"_id": doc["_id"]}, {"$set": update})
    print(f"\nDone. Updated {len(planned)} leave type(s).")
    client.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="Write the ranks (default is dry run)")
    parser.add_argument("--org", help="Organisation id to target (default: every organisation)")
    parser.add_argument(
        "--clear-others",
        action="store_true",
        help="Unset rank on every other leave type in the same org",
    )
    parser.add_argument(
        "--actor",
        help=(
            "Admin user id (ObjectId) to record as updated_by. "
            "Defaults to whoever created each leave type."
        ),
    )
    args = parser.parse_args()
    asyncio.run(set_order(args.apply, args.org, args.clear_others, args.actor))
