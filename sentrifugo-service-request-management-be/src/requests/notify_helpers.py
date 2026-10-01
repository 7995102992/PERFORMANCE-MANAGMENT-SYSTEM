"""Who to email about a ticket, and the comment thread to quote to them.

Ticket-scoped notification fan-out lived inline in `service_actions`, where it
had drifted to "mail the requester and nobody else". Both helpers here answer a
question the whole ticket lifecycle asks — who is involved, and what has been
said — so comment mails and approval mails can agree on it.

Everything is best-effort: an unresolvable user is logged and skipped, never
raised, because these run inside the fire-and-forget email blocks.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from ..common.email_resolver import resolve_user_info
from ..common.iam_helpers import user_name
from ..integrations.iam_client import get_iam_client
from ..models import Category, Comment, ServiceRequest

logger = logging.getLogger(__name__)

# How much of the thread to carry into an email. Enough to give an approver the
# story without turning the mail into the whole ticket.
COMMENT_HISTORY_LIMIT = 20
COMMENT_BODY_LIMIT = 500
# Newest N comments carried in `comments_text`. Sized for the client, not the
# wire: Gmail clips a message past ~102 KB, so an uncapped thread gets cut
# mid-conversation with the CTA below the fold.
COMMENT_THREAD_LIMIT = 20


def tab_for_role(role: str) -> str:
    """Which phone tab this recipient's deep link should open.

    One comment mails people who sit on three different tabs — the requester
    reads it under My Tickets, the roster under To Execute, an approver under
    Team Tickets — so the link has to vary per recipient, not per email type.
    """
    from ..email_events import TAB_EXECUTE, TAB_MY, TAB_TEAM

    if role == "requester":
        return TAB_MY
    if role.startswith("approver_"):
        return TAB_TEAM
    return TAB_EXECUTE  # executor, primary_assignee, roster_*


async def ticket_recipients(
    sr: ServiceRequest,
    *,
    exclude_user_ids: set[str] | None = None,
    access_token: str | None = None,
    include_approvers: bool = True,
) -> list[dict[str, str]]:
    """Everyone who should hear about activity on this ticket.

    The union of:
      * the requester,
      * the assigned executor and the primary assignee,
      * the category's executor roster (the people who work this category —
        `Category.executors`, primary and secondary alike),
      * the snapshotted L1/L2 approvers, once the executor has raised the
        ticket for approval (`include_approvers`).

    Returns ``[{user_id, email, name, role}]`` deduplicated by lowercased
    email, with `exclude_user_ids` removed — pass the actor so nobody is
    mailed about their own action. `role` is advisory, for logging.

    Roster entries carry an email snapshot taken when the roster was saved;
    entries predating that snapshot fall back to a live IAM lookup rather than
    being silently dropped.
    """
    excluded = {str(u) for u in (exclude_user_ids or set())}
    out: list[dict[str, str]] = []
    seen_emails: set[str] = set()
    seen_users: set[str] = set()

    async def _add(user_id: Any, role: str, email: str = "", name: str = "") -> None:
        if not user_id:
            return
        uid = str(user_id)
        if uid in excluded or uid in seen_users:
            return
        seen_users.add(uid)
        addr = (email or "").strip()
        display = (name or "").strip()
        if not addr:
            info = await resolve_user_info(uid, access_token=access_token)
            addr = (info.get("email") or "").strip()
            display = display or info.get("name") or addr
        if not addr:
            logger.warning("notify.recipient_unresolved user_id=%s role=%s", uid, role)
            return
        key = addr.lower()
        if key in seen_emails:
            return
        seen_emails.add(key)
        out.append(
            {"user_id": uid, "email": addr, "name": display or addr, "role": role}
        )

    await _add(sr.requester_user_id, "requester")
    await _add(sr.executor_user_id, "executor")
    await _add(sr.primary_assignee_user_id, "primary_assignee")

    # The category roster is the authoritative "who works this category"; it is
    # the same audience mailed on ticket creation (department_intimation).
    try:
        cat = await Category.get(sr.category_id)
    except Exception:  # noqa: BLE001
        cat = None
    for ex in list((cat.executors if cat else None) or []):
        await _add(
            ex.user_id,
            f"roster_{ex.role.value if hasattr(ex.role, 'value') else ex.role}",
            email=ex.email or "",
            name=ex.name or "",
        )

    if include_approvers:
        # Only populated once submit-for-approval snapshotted them, so an
        # approval that was never raised loops nobody in.
        await _add(sr.level_1_approver_user_id, "approver_l1")
        await _add(sr.level_2_approver_user_id, "approver_l2")

    return out


# The email renderer does literal substitution and HTML-escapes values, so this
# block must be plain text. IST has no DST, so a fixed offset is exact and needs
# no tzdata on the host.
_DISPLAY_TZ = timezone(timedelta(hours=5, minutes=30))
_THREAD_TS = "%d-%m-%Y %H:%M"


def format_comment_thread(
    entries: list[dict[str, str]],
    *,
    newest_marker: str = "  (new)",
    limit: int = COMMENT_THREAD_LIMIT,
    full_thread_link: str = "",
) -> str:
    """Render the thread as the plain-text block `comments_text` expects.

    Oldest first; each entry is an ``author · timestamp`` line followed by the
    body, separated by a blank line, with the newest entry marked. Timestamps
    are pre-formatted here — `comments_text` is free text, not one of the
    renderer's auto-formatted date fields, so whatever we send is what prints.

    Only the newest `limit` entries are included, with a leading note naming
    how many were dropped. The cap is about rendering, not just payload size:
    Gmail clips a message over ~102 KB behind "[Message clipped]", which would
    truncate the conversation mid-thread and push the CTA below the fold. A
    long thread is better summarised than silently cut by the client.
    """
    omitted = max(0, len(entries) - limit) if limit else 0
    if omitted:
        entries = entries[-limit:]
    lines: list[str] = []
    if omitted:
        note = f"… {omitted} earlier comment{'s' if omitted != 1 else ''} omitted"
        if full_thread_link:
            note += f" — view the full thread: {full_thread_link}"
        lines.append(note)
    last = len(entries) - 1
    for i, e in enumerate(entries):
        stamp = e.get("created_on") or ""
        if stamp:
            try:
                dt = datetime.fromisoformat(str(stamp).replace("Z", "+00:00"))
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                stamp = dt.astimezone(_DISPLAY_TZ).strftime(_THREAD_TS)
            except ValueError:
                pass
        header = f"{e.get('author_name') or 'Unknown'} · {stamp}".rstrip()
        if i == last:
            header += newest_marker
        lines.append(f"{header}\n{e.get('body') or ''}".rstrip())
    return "\n\n".join(lines)


async def comment_thread_text(
    sr: ServiceRequest,
    *,
    access_token: str | None = None,
    full_thread_link: str = "",
) -> str:
    """`comments_text` for this ticket: the entire thread, newest marked.

    The template renders a Conversation card showing past *and* present, not
    just the new comment, so the history travels with every send — capped at
    the newest `COMMENT_THREAD_LIMIT` with a note naming what was dropped. It
    always contains at least the triggering comment, so it is never empty.

    Built once per comment and reused for every recipient: the thread is the
    same for all of them, and re-reading it per recipient would multiply the
    query by the size of the fan-out.
    """
    entries = await comment_history(sr, access_token=access_token, limit=0)
    return format_comment_thread(entries, full_thread_link=full_thread_link)


async def comment_history(
    sr: ServiceRequest,
    *,
    access_token: str | None = None,
    limit: int = COMMENT_HISTORY_LIMIT,
) -> list[dict[str, str]]:
    """The ticket's comment thread, oldest first, shaped for an email template.

    Returns at most `limit` entries as ``[{author_name, body, created_on}]``.
    When the thread is longer than the limit the **most recent** `limit` are
    kept — an approver needs the latest exchange, not the opening lines.
    `limit=0` means no cap, which is what `comments_text` wants: the template
    renders the full conversation.
    """
    try:
        rows = (
            await Comment.find({"service_request_id": sr.id, "deleted_on": None})
            .sort("+created_on")
            .to_list()
        )
    except Exception:  # noqa: BLE001
        logger.warning("notify.comment_history_failed sr=%s", str(sr.id))
        return []
    if not rows:
        return []
    if limit:
        rows = rows[-limit:]
    try:
        authors = await get_iam_client().get_users(
            list({str(c.author_user_id) for c in rows}), access_token=access_token
        )
    except Exception:  # noqa: BLE001
        authors = {}
    return [
        {
            "author_name": user_name(authors.get(str(c.author_user_id)))
            or str(c.author_user_id),
            "body": (c.body or "")[:COMMENT_BODY_LIMIT] if limit else (c.body or ""),
            "created_on": c.created_on.isoformat() if c.created_on else "",
        }
        for c in rows
    ]
