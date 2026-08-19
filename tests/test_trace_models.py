from datetime import datetime, timezone
from uuid import UUID

import pytest
from pydantic import ValidationError

from api.trace_models import (
    TraceError,
    TraceEvent,
    TraceEventType,
    TraceStatus,
)


def test_trace_event_defaults_are_uuid_utc_and_json_safe() -> None:
    event = TraceEvent(
        thread_id="thread-1",
        run_id="run-1",
        event=TraceEventType.RUN_STARTED,
    )

    UUID(event.event_id)
    assert event.schema_version == "1.0"
    assert event.sequence == 0
    assert event.type == "monitor_event"
    assert event.metadata == {}
    assert event.data == {}
    assert event.timestamp.utcoffset() == timezone.utc.utcoffset(event.timestamp)
    dumped = event.model_dump(mode="json")
    assert dumped["event"] == "run_started"
    assert dumped["timestamp"].endswith("Z")


def test_trace_error_model_and_status_serialize() -> None:
    event = TraceEvent(
        thread_id="thread-1",
        run_id="run-1",
        event=TraceEventType.RUN_FAILED,
        status=TraceStatus.FAILED,
        error=TraceError(
            type="ValueError",
            message="bad input",
            code="INVALID",
            details={"field": "query"},
        ),
    )

    dumped = event.model_dump(mode="json")
    assert dumped["status"] == "failed"
    assert dumped["error"]["message"] == "bad input"


def test_trace_event_rejects_naive_datetimes() -> None:
    with pytest.raises(ValidationError):
        TraceEvent(
            thread_id="thread-1",
            run_id="run-1",
            event=TraceEventType.RUN_STARTED,
            timestamp=datetime.now(),
        )


def test_trace_event_normalizes_aware_datetime_to_utc() -> None:
    event = TraceEvent(
        thread_id="thread-1",
        run_id="run-1",
        event=TraceEventType.RUN_STARTED,
        timestamp=datetime.now().astimezone(),
    )
    assert event.timestamp.tzinfo == timezone.utc


def test_trace_event_rejects_invalid_enum() -> None:
    with pytest.raises(ValidationError):
        TraceEvent(
            thread_id="thread-1",
            run_id="run-1",
            event="not_an_event",
        )
