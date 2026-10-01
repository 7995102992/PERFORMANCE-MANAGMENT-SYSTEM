"""
Input normalisation and response parsing for the unified leave agent endpoint.

Two input modes:
  chat       — free-form message string from a chat UI
  structured — explicit JSON fields from a form or programmatic client

Both are converted to a single deterministic prompt for the LangGraph agent.
The agent's text reply is then parsed back into structured metadata.
"""

import re
from typing import Optional

from pydantic import BaseModel, model_validator


# ─── Input schemas ─────────────────────────────────────────────────────────────

class StructuredLeaveInput(BaseModel):
    """Leave request submitted as structured JSON (e.g. from a form or API client).

    Provide either leave_type_id (preferred) or leave_type_name (agent resolves it).
    Dates can be "YYYY-MM-DD" or full ISO 8601 — time defaults to 09:00:00 / 17:00:00.
    """

    leave_type_id: Optional[str] = None
    leave_type_name: Optional[str] = None
    start_date: str
    end_date: str
    note: Optional[str] = None
    loss_of_pay: bool = False

    @model_validator(mode="after")
    def must_identify_leave_type(self) -> "StructuredLeaveInput":
        if not self.leave_type_id and not self.leave_type_name:
            raise ValueError("Provide either leave_type_id or leave_type_name.")
        return self


class UnifiedLeaveRequest(BaseModel):
    """Unified request accepted by POST /leave-agent.

    Supply exactly one of:
      message    — free-form chat text (e.g. "I need 3 days off from 5 May")
      structured — JSON object with explicit leave fields
    """

    message: Optional[str] = None
    structured: Optional[StructuredLeaveInput] = None

    @model_validator(mode="after")
    def exactly_one_mode(self) -> "UnifiedLeaveRequest":
        has_message = self.message is not None and self.message.strip() != ""
        has_structured = self.structured is not None
        if has_message == has_structured:  # both or neither
            raise ValueError("Provide exactly one of 'message' or 'structured'.")
        return self


# ─── Response schema ───────────────────────────────────────────────────────────

class AgentLeaveResponse(BaseModel):
    """Response returned by POST /leave-agent."""

    mode: str                        # "chat" | "structured"
    response: str                    # agent's human-readable reply
    submitted: bool = False          # True when a leave request was created
    request_id: Optional[str] = None # populated when submitted=True
    risk_level: Optional[str] = None # HIGH | MEDIUM | LOW when submitted=True


# ─── Prompt construction ───────────────────────────────────────────────────────

def _normalise_datetime(value: str, default_time: str) -> str:
    """Append a default time component when only a date string is supplied."""
    value = value.strip()
    if "T" in value or " " in value:
        return value
    return f"{value}T{default_time}"


def build_structured_message(data: StructuredLeaveInput) -> str:
    """Convert a StructuredLeaveInput into a deterministic agent directive.

    The prompt is self-contained — the agent must not ask clarifying questions.
    All decisions about LOP, rejection, and submission are encoded upfront.
    """
    start = _normalise_datetime(data.start_date, "09:00:00")
    end = _normalise_datetime(data.end_date, "17:00:00")

    if data.leave_type_id:
        lt_ref = f"leave_type_id='{data.leave_type_id}'"
    else:
        lt_ref = (
            f"leave type named '{data.leave_type_name}' "
            f"(call list_leave_types to resolve the ID before proceeding)"
        )

    if data.loss_of_pay:
        lop_directive = (
            "Loss of Pay (LOP) has been explicitly pre-authorised by the employee. "
            "If the balance check fails, call apply_leave with loss_of_pay=True — "
            "do NOT ask for confirmation."
        )
    else:
        lop_directive = (
            "Do NOT apply as Loss of Pay. "
            "If the balance check fails, stop immediately, report the exact shortfall, "
            "and do not submit the request."
        )

    note_line = data.note or "(none provided)"

    return (
        "Process the following leave application without asking any clarifying questions.\n\n"
        f"  Leave type : {lt_ref}\n"
        f"  Start      : {start}\n"
        f"  End        : {end}\n"
        f"  Note       : {note_line}\n"
        f"  LOP policy : {lop_directive}\n\n"
        "Required steps (execute in order):\n"
        "1. call check_leave_eligibility — evaluate every item in the report.\n"
        "2. If any non-balance validation fails → stop, report the issue, do NOT submit.\n"
        "3. If balance is insufficient and LOP is not pre-authorised → stop, report the "
        "shortfall (include available days and required days), do NOT submit.\n"
        "4. If all checks pass OR LOP is pre-authorised → call apply_leave "
        "(with loss_of_pay=True when LOP is pre-authorised).\n"
        "5. Finish with a concise summary: outcome, Request ID (if submitted), "
        "duration, and risk level."
    )


# ─── Response parsing ──────────────────────────────────────────────────────────

def parse_agent_response(text: str) -> dict:
    """Extract structured metadata from the agent's plain-text reply.

    Returns a dict with keys: submitted (bool), request_id (str|None),
    risk_level (str|None).
    """
    result: dict = {"submitted": False, "request_id": None, "risk_level": None}

    # Request ID — matches "Request ID : <id>" or "Request ID | <id>"
    id_match = re.search(r"Request\s+ID\s*[:\|]\s*(\S+)", text, re.IGNORECASE)
    if id_match:
        result["submitted"] = True
        result["request_id"] = id_match.group(1).rstrip(".,;)")

    # Risk level — matches "Risk level : HIGH" or "[RISK: MEDIUM"
    risk_match = re.search(
        r"(?:Risk\s+level\s*[:\|]|RISK:)\s*(HIGH|MEDIUM|LOW)", text, re.IGNORECASE
    )
    if risk_match:
        result["risk_level"] = risk_match.group(1).upper()

    return result
