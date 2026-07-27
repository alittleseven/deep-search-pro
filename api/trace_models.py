from datetime import datetime, timezone
from enum import Enum
from typing import Any, Dict, List, Optional
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field, field_validator


class TraceEventType(str, Enum):
    RUN_STARTED = "run_started"
    RUN_COMPLETED = "run_completed"
    RUN_FAILED = "run_failed"
    AGENT_STARTED = "agent_started"
    AGENT_COMPLETED = "agent_completed"
    AGENT_FAILED = "agent_failed"
    MODEL_STARTED = "model_started"
    MODEL_COMPLETED = "model_completed"
    MODEL_FAILED = "model_failed"
    TOOL_STARTED = "tool_started"
    TOOL_COMPLETED = "tool_completed"
    TOOL_FAILED = "tool_failed"
    RETRIEVAL_STARTED = "retrieval_started"
    RETRIEVAL_ITEM = "retrieval_item"
    RETRIEVAL_COMPLETED = "retrieval_completed"
    RETRIEVAL_FAILED = "retrieval_failed"
    REPORT_STARTED = "report_started"
    REPORT_COMPLETED = "report_completed"
    REPORT_FAILED = "report_failed"
    MESSAGE_SENT = "message_sent"
    SESSION_CREATED = "session_created"


class TraceNodeType(str, Enum):
    RUN = "run"
    INPUT = "input"
    AGENT = "agent"
    MODEL = "model"
    TOOL = "tool"
    RETRIEVER = "retriever"
    REPORT = "report"
    OUTPUT = "output"
    MESSAGE = "message"


class TraceStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    WAITING = "waiting"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class TraceError(BaseModel):
    model_config = ConfigDict(frozen=True)

    type: Optional[str] = None
    message: str
    code: Optional[str] = None
    details: Any = None


class TraceEvent(BaseModel):
    """Canonical trace event.

    ``type`` and ``data`` are deprecated compatibility fields for existing
    monitor-event clients. They remain available for schema 1.x and may be
    removed in schema 2.0. New integrations should consume the typed fields.
    """

    model_config = ConfigDict(frozen=True)

    schema_version: str = "1.0"
    type: str = "monitor_event"
    event_id: str = Field(default_factory=lambda: str(uuid4()))
    thread_id: str
    run_id: str
    sequence: int = Field(default=0, ge=0)

    event: TraceEventType
    node_type: Optional[TraceNodeType] = None
    status: Optional[TraceStatus] = None

    entity_id: Optional[str] = None
    parent_id: Optional[str] = None
    source_id: Optional[str] = None
    target_id: Optional[str] = None
    tool_call_id: Optional[str] = None

    name: Optional[str] = None
    message: Optional[str] = None

    timestamp: datetime = Field(default_factory=utc_now)
    started_at: Optional[datetime] = None
    ended_at: Optional[datetime] = None
    duration_ms: Optional[int] = Field(default=None, ge=0)

    input: Any = None
    output: Any = None
    error: Optional[TraceError] = None
    metadata: Dict[str, Any] = Field(default_factory=dict)
    data: Dict[str, Any] = Field(default_factory=dict)

    @field_validator("event_id")
    @classmethod
    def validate_event_id(cls, value: str) -> str:
        UUID(value)
        return value

    @field_validator("timestamp", "started_at", "ended_at")
    @classmethod
    def normalize_utc_datetime(
        cls,
        value: Optional[datetime],
    ) -> Optional[datetime]:
        if value is None:
            return None
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("trace timestamps must include timezone information")
        return value.astimezone(timezone.utc)


class RunSummary(BaseModel):
    model_config = ConfigDict(frozen=True)

    thread_id: str
    run_id: str
    status: TraceStatus = TraceStatus.PENDING
    started_at: Optional[datetime] = None
    ended_at: Optional[datetime] = None
    event_count: int = Field(default=0, ge=0)
    last_sequence: int = Field(default=0, ge=0)


class TraceListResponse(BaseModel):
    run_id: str
    events: List[TraceEvent]
    last_sequence: int
    has_more: bool


class ThreadRunsResponse(BaseModel):
    thread_id: str
    runs: List[RunSummary]
