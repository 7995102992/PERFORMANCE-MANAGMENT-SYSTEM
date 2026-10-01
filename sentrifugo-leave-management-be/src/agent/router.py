from typing import Optional
from uuid import uuid4

from fastapi import APIRouter, Depends
from langchain_core.messages import AIMessage, HumanMessage, RemoveMessage
from pydantic import BaseModel

from src.agent.agent import agent
from src.dependencies import UserBase, get_current_user
from src.logger import logger


# ─────────────────────────────────────────────────────────────────────────────
# DEPRECATED (hidden for now — logic intact, do NOT remove).
# The FugoAI agent chat button that consumed POST /api/v1/agent/chat has been
# hidden in the frontend. This router is no longer mounted in src/main.py
# (its `include_router` is commented out). Kept in place so it can be re-enabled
# by uncommenting the registration in main.py — no code changes needed here.
# ─────────────────────────────────────────────────────────────────────────────
router = APIRouter(prefix="/api/v1/agent", tags=["Agent Chat"])


class ChatRequest(BaseModel):
    message: str
    thread_id: Optional[str] = None


class ChatResponse(BaseModel):
    thread_id: str
    reply: str


def _scoped_thread_id(user_id: str, thread_id: str) -> str:
    """
    Namespace thread_ids by user so checkpointer history cannot leak between
    users — even if a client passes another user's thread_id.
    """
    return f"{user_id}:{thread_id}"


async def _sanitize_thread_state(config: dict) -> None:
    """Remove AIMessages with unanswered tool calls from the thread's checkpointed state.

    This can happen when the server is interrupted mid-execution: the LLM's tool-call
    AIMessage was written to the MemorySaver but the ToolMessage responses never
    arrived. LangGraph rejects the malformed history on the next invocation with
    "AIMessages with tool_calls that do not have a corresponding ToolMessage".
    We fix it by deleting the orphaned AIMessages before the next invoke.
    """
    try:
        state = await agent.aget_state(config)
        if not state or not state.values.get("messages"):
            return

        messages = state.values["messages"]

        # Collect every tool_call_id that already has a ToolMessage response
        responded_ids: set[str] = {
            msg.tool_call_id
            for msg in messages
            if hasattr(msg, "tool_call_id") and msg.tool_call_id
        }

        # Find AIMessages whose tool_calls are not fully answered
        to_remove = [
            RemoveMessage(id=msg.id)
            for msg in messages
            if isinstance(msg, AIMessage)
            and msg.tool_calls
            and not {tc["id"] for tc in msg.tool_calls}.issubset(responded_ids)
        ]

        if to_remove:
            logger.warning(
                "Removing orphaned tool-call AIMessages from thread state",
                thread=config.get("configurable", {}).get("thread_id"),
                count=len(to_remove),
            )
            await agent.aupdate_state(config, {"messages": to_remove})
    except Exception as exc:
        # Never let cleanup failure block the user's request
        logger.warning("Thread state sanitization failed", error=str(exc))


@router.post("/chat", response_model=ChatResponse)
async def chat(
    body: ChatRequest,
    current_user: UserBase = Depends(get_current_user),
) -> ChatResponse:
    """
    Single conversational endpoint.

    - Omit `thread_id` to start a new conversation; the server returns the
      generated id which the client must echo on subsequent turns.
    - Pass `thread_id` to continue an existing conversation; the agent's
      checkpointer rehydrates the message history automatically.
    """
    thread_id = body.thread_id or str(uuid4())
    config = {
        "configurable": {
            "thread_id": _scoped_thread_id(current_user.user_id, thread_id),
        },
        "metadata": {
            "user_id": current_user.user_id,
            "org_id": current_user.org_id,
        },
    }

    # Remove any orphaned tool-call messages left by a previously interrupted run
    await _sanitize_thread_state(config)

    try:
        result = await agent.ainvoke(
            {"messages": [HumanMessage(content=body.message)]},
            config=config,
        )
    except Exception as exc:
        err_str = str(exc)
        # If the history is still invalid after sanitization (e.g. the state was
        # partially corrupted in a way we couldn't detect), fall back to a brand-new
        # thread so the user gets a response rather than a 500.
        if "AIMessages with tool_calls" in err_str or "INVALID_CHAT_HISTORY" in err_str:
            logger.warning(
                "Thread history still invalid after sanitization — starting fresh thread",
                original_thread_id=thread_id,
            )
            thread_id = str(uuid4())
            config["configurable"]["thread_id"] = _scoped_thread_id(
                current_user.user_id, thread_id
            )
            result = await agent.ainvoke(
                {"messages": [HumanMessage(content=body.message)]},
                config=config,
            )
        else:
            logger.error("Agent invocation failed", error=err_str, thread_id=thread_id)
            raise

    messages = result.get("messages", [])
    reply = messages[-1].content if messages else ""
    return ChatResponse(thread_id=thread_id, reply=reply)
