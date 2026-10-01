from __future__ import annotations

from typing import Generic, TypeVar

from fastapi import Query
from pydantic import BaseModel, Field

T = TypeVar("T")


class PageParams(BaseModel):
    page: int = 1
    page_size: int = 25


def page_params(
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=200),
) -> PageParams:
    return PageParams(page=page, page_size=page_size)


class PageResult(BaseModel, Generic[T]):
    items: list[T] = Field(default_factory=list)
    page: int
    page_size: int
    total: int


def compute_skip(p: PageParams) -> int:
    return (p.page - 1) * p.page_size
