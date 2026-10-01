from typing import Any

from fastapi import APIRouter, Depends
from langchain_core.messages import HumanMessage

from src.database import get_db_session
from src.dependencies import UserBase, get_current_user, require_development_env
from src.leave_requests.agent.graph import create_leave_agent
from src.leave_requests.agent.wrapper import (
    AgentLeaveResponse,
    UnifiedLeaveRequest,
    build_structured_message,
    parse_agent_response,
)

router = APIRouter(prefix="/leave-agent", tags=["Leave Agent"])


@router.post("", response_model=AgentLeaveResponse, dependencies=[Depends(require_development_env)])
async def leave_agent(
    body: UnifiedLeaveRequest,
    current_user: UserBase = Depends(get_current_user),
    db: Any = Depends(get_db_session),
) -> AgentLeaveResponse:
    """Unified leave management endpoint — accepts chat text or structured JSON.

    ── Chat mode ──────────────────────────────────────────────────────────────
    {
        "message": "I want 3 days off from 5 May for a family trip"
    }

    The agent converses naturally: resolves leave type, runs eligibility, offers
    LOP if balance is short, and confirms before submitting.

    ── Structured mode ────────────────────────────────────────────────────────
    {
        "structured": {
            "leave_type_id": "...",          // or "leave_type_name": "Annual Leave"
            "start_date": "2026-05-05",      // or full ISO datetime
            "end_date":   "2026-05-07",
            "note":       "Family trip",
            "loss_of_pay": false             // true = employee pre-authorised LOP
        }
    }

    The agent runs the full eligibility pipeline deterministically (no back-and-forth).
    If a check fails it stops and reports; if all pass it submits with a risk note.

    ── Response ───────────────────────────────────────────────────────────────
    {
        "mode":       "chat" | "structured",
        "response":   "<agent reply>",
        "submitted":  true | false,
        "request_id": "<id> or null",
        "risk_level": "HIGH" | "MEDIUM" | "LOW" | null
    }
    """
    if body.structured is not None:
        mode = "structured"
        prompt = build_structured_message(body.structured)
    else:
        mode = "chat"
        prompt = body.message  # type: ignore[assignment]

    agent = create_leave_agent(db, current_user.user_id)
    result = await agent.ainvoke({"messages": [HumanMessage(content=prompt)]})
    response_text: str = result["messages"][-1].content

    parsed = parse_agent_response(response_text)
    return AgentLeaveResponse(mode=mode, response=response_text, **parsed)
