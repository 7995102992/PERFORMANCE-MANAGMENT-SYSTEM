"""Common analytics response envelope.

A role dashboard is a list of TABS (descriptive / prescriptive / predictive),
each tab a list of SECTIONS, each section holding typed widgets (cards, charts,
tables). This shape is shared across every role so the frontend renders any
dashboard with one set of components — and mirrors the leave-service split of a
thin analytics layer over the domain collections.

Phase 1 (this module) only populates the ``descriptive`` tab; the
prescriptive/predictive tabs are part of the same envelope for later phases.
"""
from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, Field


class AnalyticsRole(StrEnum):
    EMPLOYEE = "employee"   # Requester — "my requests"
    EXECUTOR = "executor"   # Service specialist working assigned tickets
    MANAGER = "manager"     # Team lead / L1 approver over managed categories
    APPROVER = "approver"   # Formal L1/L2 approver
    CXO = "cxo"             # Org-wide executive view


class Card(BaseModel):
    """A single KPI tile."""
    id: str
    label: str
    value: float | int | str
    sub_label: str | None = None  # e.g. "64% resolution rate"
    intent: Literal["neutral", "good", "warning", "critical"] = "neutral"
    # Optional filter the frontend can apply when the card is clicked.
    filter: dict[str, Any] = Field(default_factory=dict)


class ChartSeries(BaseModel):
    name: str
    data: list[float]


class Chart(BaseModel):
    id: str
    title: str
    type: Literal["doughnut", "bar", "line"]
    labels: list[str]
    series: list[ChartSeries] = Field(default_factory=list)
    # Multi-series bar charts: stack the series instead of grouping them.
    stacked: bool = False


class Table(BaseModel):
    id: str
    title: str
    # columns: list of {"key","label","type"} where type ∈ text|number|date|badge
    columns: list[dict[str, str]] = Field(default_factory=list)
    rows: list[dict[str, Any]] = Field(default_factory=list)


class Alert(BaseModel):
    """A prescriptive recommendation / warning card."""
    id: str
    severity: Literal["info", "warning", "success", "critical"] = "info"
    title: str
    message: str


class Section(BaseModel):
    id: str
    title: str | None = None
    cards: list[Card] = Field(default_factory=list)
    alerts: list[Alert] = Field(default_factory=list)
    charts: list[Chart] = Field(default_factory=list)
    tables: list[Table] = Field(default_factory=list)


class Tab(BaseModel):
    key: Literal["descriptive", "prescriptive", "predictive"]
    label: str
    sections: list[Section] = Field(default_factory=list)


class DashboardResponse(BaseModel):
    role: AnalyticsRole
    role_label: str
    generated_at: datetime
    tabs: list[Tab] = Field(default_factory=list)


class BusinessUnitInfo(BaseModel):
    id: str
    name: str


class BusinessUnitsResponse(BaseModel):
    business_units: list[BusinessUnitInfo] = Field(default_factory=list)


class BuComparisonResponse(BaseModel):
    charts: list[Chart] = Field(default_factory=list)


class RoleInfo(BaseModel):
    role: AnalyticsRole
    label: str


class AvailableRoles(BaseModel):
    """Which dashboards the caller may view, plus the one to open by default."""
    roles: list[RoleInfo] = Field(default_factory=list)
    default: AnalyticsRole | None = None
