"""Nebius Token Factory client: chat (JSON and streaming) and embeddings.

Uses the OpenAI-compatible API with the models configured in the environment.
"""

from __future__ import annotations

import json
import logging
import re
import time
from collections.abc import Iterator
from functools import lru_cache
from typing import Literal, TypeVar

from openai import APIConnectionError, APITimeoutError, BadRequestError, InternalServerError, OpenAI, RateLimitError
from pydantic import BaseModel, ValidationError

from .config import get_settings

log = logging.getLogger(__name__)
T = TypeVar("T", bound=BaseModel)

TRANSIENT = (APIConnectionError, APITimeoutError, RateLimitError, InternalServerError)

# Nemotron 3 models reason (hidden "thinking" tokens) before answering, and those tokens
# count against max_tokens. "off" disables it (extraction, classification); "low" keeps a
# little; "on" leaves the model's default. Verified on Token Factory 2026-10-28.
Reasoning = Literal["off", "low", "on"]


def reasoning_options(reasoning: Reasoning) -> dict:
    if reasoning == "off":
        return {"extra_body": {"chat_template_kwargs": {"enable_thinking": False}}}
    if reasoning == "low":
        return {"reasoning_effort": "low"}
    return {}


@lru_cache(maxsize=1)
def client() -> OpenAI:
    s = get_settings()
    return OpenAI(base_url=s.token_factory_base_url, api_key=s.token_factory_api_key, timeout=120, max_retries=2)


def extract_json(text: str) -> str:
    """Pull the JSON object out of a reply that may include <think> blocks or ``` fences."""
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL)
    fenced = re.search(r"```(?:json)?\s*(\{.*\})\s*```", text, flags=re.DOTALL)
    if fenced:
        return fenced.group(1)
    start, end = text.find("{"), text.rfind("}")
    return text[start:end + 1] if start != -1 and end > start else text


def chat_json(model: str, system: str, user: str, schema: type[T], *, max_tokens: int = 2000,
              temperature: float = 0.0, reasoning: Reasoning = "off") -> tuple[T, dict]:
    """Ask for JSON matching `schema`; validate with Pydantic and retry once on invalid output.

    Returns (parsed, info) where info has the model, latency and token usage for tracing.
    """
    system = (f"{system}\n\nRespond with one JSON object only, matching this JSON schema:\n"
              f"{json.dumps(schema.model_json_schema())}")
    messages = [{"role": "system", "content": system}, {"role": "user", "content": user}]
    started = time.perf_counter()
    error = ""
    for attempt in (1, 2):
        try:
            r = client().chat.completions.create(model=model, messages=messages, temperature=temperature,
                                                 max_tokens=max_tokens, response_format={"type": "json_object"},
                                                 **reasoning_options(reasoning))
        except BadRequestError as e:  # model without JSON mode: fall back to instructions only
            if "response_format" not in str(e):
                raise
            r = client().chat.completions.create(model=model, messages=messages, temperature=temperature,
                                                 max_tokens=max_tokens, **reasoning_options(reasoning))
        content = r.choices[0].message.content or ""
        try:
            parsed = schema.model_validate_json(extract_json(content))
            usage = r.usage
            return parsed, {"model": model, "attempts": attempt, "ms": round((time.perf_counter() - started) * 1000),
                            "prompt_tokens": getattr(usage, "prompt_tokens", None),
                            "completion_tokens": getattr(usage, "completion_tokens", None)}
        except ValidationError as e:
            error = str(e)
            messages += [{"role": "assistant", "content": content},
                         {"role": "user", "content": f"That JSON was invalid: {error[:1500]}\nReply with corrected JSON only."}]
    raise ValueError(f"{model} returned invalid JSON twice: {error[:300]}")


def chat_stream(model: str, messages: list[dict], *, max_tokens: int = 1500,
                temperature: float = 0.3, reasoning: Reasoning = "low") -> Iterator[str]:
    """Stream the assistant's reply text, skipping any <think>...</think> reasoning."""
    stream = client().chat.completions.create(model=model, messages=messages, temperature=temperature,
                                              max_tokens=max_tokens, stream=True, **reasoning_options(reasoning))
    in_think = False
    buffer = ""
    for chunk in stream:
        if not chunk.choices:
            continue
        delta = chunk.choices[0].delta.content or ""
        buffer += delta
        # Hide reasoning sections some models emit inline.
        while buffer:
            if in_think:
                end = buffer.find("</think>")
                if end == -1:
                    buffer = buffer[-10:]
                    break
                buffer, in_think = buffer[end + 8:], False
            else:
                start = buffer.find("<think>")
                if start == -1:
                    safe = buffer[:-7] if len(buffer) > 7 else ""  # keep a tail in case a tag is split
                    if safe:
                        yield safe
                    buffer = buffer[len(safe):]
                    break
                if start:
                    yield buffer[:start]
                buffer, in_think = buffer[start + 7:], True
    if buffer and not in_think:
        yield buffer


def embed(texts: list[str], *, batch_size: int = 32) -> list[list[float]]:
    """Embed texts with EMBED_MODEL at EMBED_DIMENSIONS, retrying transient failures."""
    s = get_settings()
    vectors: list[list[float]] = []
    for i in range(0, len(texts), batch_size):
        batch = [t[:8000] for t in texts[i:i + batch_size]]
        for attempt in range(4):
            try:
                r = client().embeddings.create(model=s.embed_model, input=batch, dimensions=s.embed_dimensions)
                vectors += [d.embedding for d in sorted(r.data, key=lambda d: d.index)]
                break
            except TRANSIENT as e:
                if attempt == 3:
                    raise
                log.warning("embedding request failed (%s); retrying", e)
                time.sleep(2 ** attempt)
    return vectors
