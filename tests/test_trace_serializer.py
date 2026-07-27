from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path

from pydantic import BaseModel

from api.trace_serializer import REDACTED_VALUE, sanitize_for_trace


class ExampleEnum(str, Enum):
    VALUE = "value"


class ExampleModel(BaseModel):
    path: Path
    created_at: datetime


@dataclass
class ExampleDataclass:
    name: str
    token: str


class BadString:
    def __str__(self) -> str:
        raise RuntimeError("cannot stringify")


def test_sensitive_keys_are_redacted_case_insensitively() -> None:
    value = {
        "api_key": "one",
        "APIKEY": "two",
        "Authorization": "three",
        "token": "four",
        "access_token": "five",
        "refresh_token": "six",
        "password": "seven",
        "secret": "eight",
        "cookie": "nine",
        "Set-Cookie": "ten",
    }

    sanitized = sanitize_for_trace(value)
    assert set(sanitized.values()) == {REDACTED_VALUE}


def test_nested_dicts_and_lists_are_redacted() -> None:
    sanitized = sanitize_for_trace(
        {
            "items": [
                {"password": "hidden"},
                {"nested": {"token": "hidden"}},
            ]
        }
    )
    assert sanitized["items"][0]["password"] == REDACTED_VALUE
    assert sanitized["items"][1]["nested"]["token"] == REDACTED_VALUE


def test_long_strings_and_collections_are_truncated() -> None:
    sanitized = sanitize_for_trace(
        {"text": "x" * 20, "items": list(range(8))},
        max_string_length=5,
        max_collection_items=3,
    )
    assert sanitized["text"].startswith("xxxxx")
    assert "truncated" in sanitized["text"]
    assert sanitized["items"][-1] == "<5 items truncated>"


def test_supported_python_types_become_json_safe() -> None:
    now = datetime.now(timezone.utc)
    sanitized = sanitize_for_trace(
        {
            "model": ExampleModel(path=Path("sample.txt"), created_at=now),
            "dataclass": ExampleDataclass(name="example", token="hidden"),
            "enum": ExampleEnum.VALUE,
            "set": {"a", "b"},
            "tuple": (1, 2),
        }
    )

    assert sanitized["model"]["path"] == "sample.txt"
    assert sanitized["model"]["created_at"] == now.isoformat()
    assert sanitized["dataclass"]["token"] == REDACTED_VALUE
    assert sanitized["enum"] == "value"
    assert sorted(sanitized["set"]) == ["a", "b"]
    assert sanitized["tuple"] == [1, 2]


def test_unserializable_object_and_cycles_use_safe_fallbacks() -> None:
    cyclic = []
    cyclic.append(cyclic)
    sanitized = sanitize_for_trace(
        {"bad": BadString(), "cyclic": cyclic},
    )
    assert sanitized["bad"] == "<unserializable BadString>"
    assert sanitized["cyclic"] == ["<circular_reference>"]


def test_non_finite_floats_are_converted_to_json_safe_strings() -> None:
    sanitized = sanitize_for_trace(
        {"nan": float("nan"), "infinity": float("inf")}
    )
    assert sanitized == {"nan": "nan", "infinity": "inf"}
