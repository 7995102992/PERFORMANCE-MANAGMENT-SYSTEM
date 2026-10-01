"""Shared Pydantic field helpers."""
from __future__ import annotations

from typing import Annotated, Optional

from beanie import PydanticObjectId
from pydantic import BeforeValidator


def _blank_to_none(v):
    """Treat an empty/blank string as None.

    The frontend sends "" for unset optional id fields; without this an empty
    string would fail ObjectId validation (422). Runs before the ObjectId
    validator, so "" -> None and a real hex string passes through unchanged.
    """
    if v is None:
        return None
    if isinstance(v, str) and v.strip() == "":
        return None
    return v


# Optional ObjectId that tolerates "" / blank from the FE (coerced to None).
OptionalObjectId = Annotated[Optional[PydanticObjectId], BeforeValidator(_blank_to_none)]


def _drop_blank_ids(v):
    """Drop empty/blank entries from a list of ids before ObjectId validation.

    The FE may include "" placeholders in id lists; those would otherwise fail
    ObjectId validation (422). Non-list input is passed through unchanged.
    """
    if isinstance(v, list):
        return [x for x in v if not (x is None or (isinstance(x, str) and x.strip() == ""))]
    return v


# list[ObjectId] that tolerates / strips "" / blank entries from the FE.
ObjectIdList = Annotated[list[PydanticObjectId], BeforeValidator(_drop_blank_ids)]
