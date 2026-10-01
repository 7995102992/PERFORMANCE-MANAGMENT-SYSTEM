from langchain_anthropic import ChatAnthropic
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_core.runnables import Runnable

from src.config import settings


def build_chat_model() -> Runnable:
    """
    Returns the chat model used by the agent: Claude Haiku as primary,
    Gemini Flash as fallback.

    RunnableWithFallbacks transparently retries on the next model when the
    primary raises (rate limit, transient API error, 5xx, etc.). Both models
    support OpenAI-style tool calling, so the same `.bind_tools(...)` call
    works for either side of the fallback.
    """
    primary = ChatAnthropic(
        model=settings.ANTHROPIC_HAIKU_MODEL,
        api_key=settings.ANTHROPIC_API_KEY,
        max_tokens=2048,
        temperature=0,
    )
    fallback = ChatGoogleGenerativeAI(
        model=settings.GEMINI_MODEL,
        google_api_key=settings.GEMINI_API_KEY,
        temperature=0,
    )
    return primary.with_fallbacks([fallback])
