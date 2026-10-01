"""Requests export — Chapter 5.

CSV-only for v1 (see Q-114). Excel returns 501.
"""
from __future__ import annotations

import csv
import io
from datetime import datetime, time, timedelta, timezone
from typing import AsyncIterator

from ..auth.utils.dependencies import UserBase
from ..common.iam_helpers import user_name
from ..common.timestamps import utcnow
from ..exceptions import (
    ExportForbidden,
    ExportRangeTooWide,
    InvalidDateRange,
)
from ..integrations.iam_client import get_iam_client
from ..models import Category, RequestType, ServiceRequest
from .service_list import _role_of, _scoped_filter


def _resolve_range(
    date_range: str, start_date: str | None, end_date: str | None
) -> tuple[datetime, datetime]:
    now = utcnow()
    today = now.replace(hour=0, minute=0, second=0, microsecond=0)

    def day(y: int, m: int, d: int) -> datetime:
        return datetime(y, m, d, tzinfo=timezone.utc)

    if date_range == "current_month":
        start = today.replace(day=1)
        end = now
    elif date_range == "last_month":
        first_this = today.replace(day=1)
        last_month_end = first_this - timedelta(seconds=1)
        start = last_month_end.replace(day=1, hour=0, minute=0, second=0)
        end = first_this - timedelta(seconds=1)
    elif date_range == "last_3_months":
        start = today - timedelta(days=90)
        end = now
    elif date_range == "last_6_months":
        start = today - timedelta(days=180)
        end = now
    elif date_range == "current_year":
        start = day(today.year, 1, 1)
        end = now
    elif date_range == "last_year":
        start = day(today.year - 1, 1, 1)
        end = day(today.year - 1, 12, 31).replace(
            hour=23, minute=59, second=59
        )
    elif date_range == "custom":
        if not start_date or not end_date:
            raise InvalidDateRange()
        start = datetime.fromisoformat(start_date).replace(tzinfo=timezone.utc)
        end = datetime.fromisoformat(end_date).replace(
            hour=23, minute=59, second=59, tzinfo=timezone.utc
        )
        if end < start:
            raise InvalidDateRange()
        if (end - start).days > 366:
            raise ExportRangeTooWide()
    else:
        raise InvalidDateRange()
    return start, end


async def stream_export(
    user: UserBase,
    *,
    format_: str,
    date_range: str,
    start_date: str | None,
    end_date: str | None,
) -> AsyncIterator[bytes]:
    if format_ not in ("csv",):  # Excel deferred per Q-114
        yield b""  # pragma: no cover — caller should pre-check
        return
    start, end = _resolve_range(date_range, start_date, end_date)

    filt = await _scoped_filter(user)
    filt["submitted_on"] = {"$gte": start, "$lte": end}

    # Build lookup caches lazily — the query may return thousands of rows.
    iam = get_iam_client()
    cat_names: dict[str, str] = {}
    rt_names: dict[str, str] = {}

    async def _cat_name(cat_id: str) -> str:
        if cat_id not in cat_names:
            c = await Category.get(cat_id)
            cat_names[cat_id] = c.name if c else ""
        return cat_names[cat_id]

    async def _rt_name(rt_id: str) -> str:
        if rt_id not in rt_names:
            r = await RequestType.get(rt_id)
            rt_names[rt_id] = r.name if r else ""
        return rt_names[rt_id]

    async def _user_name(uid: str | None) -> str:
        if not uid:
            return ""
        u = await iam.get_user(uid, access_token=user.access_token)
        from ..common.iam_helpers import user_name as _uname
        return _uname(u) or uid

    # Header row.
    header = [
        "ticket_no", "request_type_name", "category_name", "requester_name",
        "priority", "status", "is_escalated", "created_on",
        "first_response_due_by", "resolution_due_by",
        "first_response_at", "resolved_at", "closed_at", "executor_name",
    ]
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(header)
    yield buf.getvalue().encode("utf-8")
    buf.seek(0)
    buf.truncate(0)

    cursor = (
        ServiceRequest.find(filt)
        .sort("-submitted_on")
    )
    async for sr in cursor:
        row = [
            sr.ticket_no,
            await _rt_name(sr.request_type_id),
            await _cat_name(sr.category_id),
            await _user_name(sr.requester_user_id),
            sr.priority.value if sr.priority else "",
            sr.request_status.value,
            str(sr.is_escalated).lower(),
            sr.submitted_on.isoformat() if sr.submitted_on else "",
            sr.first_response_due_by.isoformat() if sr.first_response_due_by else "",
            sr.resolution_due_by.isoformat() if sr.resolution_due_by else "",
            sr.first_response_at.isoformat() if sr.first_response_at else "",
            sr.resolved_at.isoformat() if sr.resolved_at else "",
            sr.closed_at.isoformat() if sr.closed_at else "",
            await _user_name(sr.executor_user_id),
        ]
        writer.writerow(row)
        yield buf.getvalue().encode("utf-8")
        buf.seek(0)
        buf.truncate(0)
