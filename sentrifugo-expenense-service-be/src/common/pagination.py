"""Shared pagination types used by every list endpoint."""

from __future__ import annotations

from fastapi import Query
from pydantic import BaseModel, Field


class PageParams(BaseModel):
    """Normalised page/page-size pair resolved from the query string."""

    page: int = 1
    page_size: int = 25


def page_params(
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=200),
) -> PageParams:
    """FastAPI dependency yielding validated pagination parameters.

    Args:
        page: 1-based page number.
        page_size: Items per page, capped at 200.

    Returns:
        The validated :class:`PageParams`.
    """
    return PageParams(page=page, page_size=page_size)


class PageResult[T](BaseModel):
    """Envelope returned by paginated list endpoints."""

    items: list[T] = Field(default_factory=list)
    page: int
    page_size: int
    total: int


def compute_skip(p: PageParams) -> int:
    """Translate page parameters into a Mongo ``skip`` offset.

    Args:
        p: The resolved pagination parameters.

    Returns:
        Number of documents to skip.
    """
    return (p.page - 1) * p.page_size
