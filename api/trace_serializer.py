from dataclasses import fields, is_dataclass
from datetime import date, datetime
from enum import Enum
import math
from pathlib import Path
from typing import Any, Dict, Mapping, Optional, Set

from pydantic import BaseModel

from api.trace_models import TraceError


REDACTED_VALUE = "***REDACTED***"
DEFAULT_MAX_DEPTH = 8
DEFAULT_MAX_STRING_LENGTH = 4_000
DEFAULT_MAX_COLLECTION_ITEMS = 100

_SENSITIVE_KEYS = {
    "api_key",
    "apikey",
    "authorization",
    "token",
    "access_token",
    "refresh_token",
    "password",
    "secret",
    "cookie",
    "set-cookie",
}


def _safe_string(value: Any, max_length: int) -> str:
    try:
        text = str(value)
    except Exception:
        text = f"<unserializable {type(value).__name__}>"
    if len(text) <= max_length:
        return text
    return f"{text[:max_length]}…<truncated>"


def sanitize_for_trace(
    value: Any,
    *,
    max_depth: int = DEFAULT_MAX_DEPTH,
    max_string_length: int = DEFAULT_MAX_STRING_LENGTH,
    max_collection_items: int = DEFAULT_MAX_COLLECTION_ITEMS,
) -> Any:
    """Return a bounded, redacted value safe for JSON serialization."""

    seen: Set[int] = set()

    def convert(current: Any, depth: int) -> Any:
        if current is None or isinstance(current, (bool, int)):
            return current
        if isinstance(current, float):
            return current if math.isfinite(current) else _safe_string(current, 32)
        if isinstance(current, Enum):
            return convert(current.value, depth + 1)
        if isinstance(current, str):
            return _safe_string(current, max_string_length)
        if isinstance(current, (datetime, date)):
            return current.isoformat()
        if isinstance(current, Path):
            return _safe_string(current, max_string_length)
        if depth >= max_depth:
            return "<max_depth_exceeded>"

        track_identity = isinstance(
            current,
            (BaseModel, Mapping, list, tuple, set),
        ) or is_dataclass(current)
        identity = id(current)
        if track_identity:
            if identity in seen:
                return "<circular_reference>"
            seen.add(identity)

        try:
            if isinstance(current, BaseModel):
                return convert(current.model_dump(mode="python"), depth + 1)
            if is_dataclass(current) and not isinstance(current, type):
                values = {
                    field.name: getattr(current, field.name)
                    for field in fields(current)
                }
                return convert(values, depth + 1)
            if isinstance(current, Mapping):
                result: Dict[str, Any] = {}
                items = list(current.items())
                for key, item in items[:max_collection_items]:
                    safe_key = _safe_string(key, max_string_length)
                    if safe_key.lower() in _SENSITIVE_KEYS:
                        result[safe_key] = REDACTED_VALUE
                    else:
                        result[safe_key] = convert(item, depth + 1)
                if len(items) > max_collection_items:
                    result["__truncated_items__"] = len(items) - max_collection_items
                return result
            if isinstance(current, (list, tuple, set)):
                values = list(current)
                converted = [
                    convert(item, depth + 1)
                    for item in values[:max_collection_items]
                ]
                if len(values) > max_collection_items:
                    converted.append(
                        f"<{len(values) - max_collection_items} items truncated>"
                    )
                return converted
            return _safe_string(current, max_string_length)
        finally:
            if track_identity:
                seen.discard(identity)

    return convert(value, 0)


def normalize_trace_error(
    error: Any,
    *,
    max_string_length: int = DEFAULT_MAX_STRING_LENGTH,
) -> Optional[TraceError]:
    if error is None:
        return None
    if isinstance(error, TraceError):
        return TraceError(
            type=(
                _safe_string(error.type, max_string_length)
                if error.type is not None
                else None
            ),
            message=_safe_string(error.message, max_string_length),
            code=(
                _safe_string(error.code, max_string_length)
                if error.code is not None
                else None
            ),
            details=sanitize_for_trace(
                error.details,
                max_string_length=max_string_length,
            ),
        )
    if isinstance(error, BaseException):
        return TraceError(
            type=type(error).__name__,
            message=_safe_string(error, max_string_length),
        )
    if isinstance(error, Mapping):
        safe = sanitize_for_trace(
            error,
            max_string_length=max_string_length,
        )
        message = safe.get("message") if isinstance(safe, dict) else None
        return TraceError(
            type=(
                _safe_string(safe.get("type"), max_string_length)
                if isinstance(safe, dict) and safe.get("type") is not None
                else None
            ),
            message=_safe_string(message or "Trace error", max_string_length),
            code=(
                _safe_string(safe.get("code"), max_string_length)
                if isinstance(safe, dict) and safe.get("code") is not None
                else None
            ),
            details=safe.get("details") if isinstance(safe, dict) else safe,
        )
    return TraceError(message=_safe_string(error, max_string_length))
