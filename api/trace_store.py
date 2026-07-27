import asyncio
import os
from collections import OrderedDict, deque
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Deque, Dict, List, Optional

from api.trace_models import (
    RunSummary,
    TraceEvent,
    TraceEventType,
    TraceStatus,
)


DEFAULT_MAX_EVENTS_PER_RUN = 5_000
DEFAULT_MAX_RUNS = 100


def _positive_env_int(name: str, default: int) -> int:
    raw_value = os.getenv(name)
    if raw_value is None:
        return default
    try:
        parsed = int(raw_value)
    except ValueError:
        return default
    return parsed if parsed > 0 else default


@dataclass
class _RunRecord:
    thread_id: str
    run_id: str
    events: Deque[TraceEvent]
    status: TraceStatus = TraceStatus.PENDING
    started_at: Optional[datetime] = None
    ended_at: Optional[datetime] = None
    last_sequence: int = 0
    terminal_event_id: Optional[str] = None

    def summary(self) -> RunSummary:
        return RunSummary(
            thread_id=self.thread_id,
            run_id=self.run_id,
            status=self.status,
            started_at=self.started_at,
            ended_at=self.ended_at,
            event_count=len(self.events),
            last_sequence=self.last_sequence,
        )


class InMemoryTraceStore:
    """Capacity-bounded, process-local trace store.

    Runs are evicted oldest-first by insertion order. Within a run, the oldest
    retained event is evicted first while sequence numbers continue increasing.
    """

    def __init__(
        self,
        *,
        max_events_per_run: Optional[int] = None,
        max_runs: Optional[int] = None,
    ) -> None:
        self.max_events_per_run = (
            max_events_per_run
            if max_events_per_run is not None
            else _positive_env_int(
                "TRACE_MAX_EVENTS_PER_RUN",
                DEFAULT_MAX_EVENTS_PER_RUN,
            )
        )
        self.max_runs = (
            max_runs
            if max_runs is not None
            else _positive_env_int(
                "TRACE_MAX_RUNS",
                DEFAULT_MAX_RUNS,
            )
        )
        if self.max_events_per_run <= 0 or self.max_runs <= 0:
            raise ValueError("trace store capacities must be positive")
        self._runs: "OrderedDict[str, _RunRecord]" = OrderedDict()
        self._thread_runs: Dict[str, "OrderedDict[str, None]"] = {}
        self._lock = asyncio.Lock()

    async def reserve_run(self, thread_id: str, run_id: str) -> RunSummary:
        async with self._lock:
            existing = self._runs.get(run_id)
            if existing is not None:
                if existing.thread_id != thread_id:
                    raise ValueError("run_id is already assigned to another thread")
                return existing.summary()
            record = self._create_run_locked(thread_id, run_id)
            return record.summary()

    async def append(self, event: TraceEvent) -> TraceEvent:
        async with self._lock:
            record = self._runs.get(event.run_id)
            if record is None:
                record = self._create_run_locked(event.thread_id, event.run_id)
            elif record.thread_id != event.thread_id:
                raise ValueError("trace event thread_id does not match its run")

            is_terminal = event.event in {
                TraceEventType.RUN_COMPLETED,
                TraceEventType.RUN_FAILED,
            }
            if is_terminal and record.terminal_event_id is not None:
                raise ValueError("a run may contain only one terminal event")

            next_sequence = record.last_sequence + 1
            stored_event = event.model_copy(update={"sequence": next_sequence})
            if len(record.events) >= self.max_events_per_run:
                record.events.popleft()
            record.events.append(stored_event)
            record.last_sequence = next_sequence
            self._update_summary_locked(record, stored_event)
            return stored_event

    async def list_events(
        self,
        run_id: str,
        after_sequence: Optional[int] = None,
        limit: Optional[int] = None,
    ) -> List[TraceEvent]:
        async with self._lock:
            record = self._runs.get(run_id)
            if record is None:
                return []
            boundary = after_sequence if after_sequence is not None else -1
            events = [
                event for event in record.events if event.sequence > boundary
            ]
            if limit is not None:
                events = events[:limit]
            return list(events)

    async def list_runs(self, thread_id: str) -> List[RunSummary]:
        async with self._lock:
            run_ids = self._thread_runs.get(thread_id)
            if run_ids is None:
                return []
            summaries = [
                self._runs[run_id].summary()
                for run_id in run_ids
                if run_id in self._runs
            ]
            minimum = datetime.min.replace(tzinfo=timezone.utc)
            return sorted(
                summaries,
                key=lambda summary: summary.started_at or minimum,
                reverse=True,
            )

    async def get_run(self, run_id: str) -> Optional[RunSummary]:
        async with self._lock:
            record = self._runs.get(run_id)
            return record.summary() if record is not None else None

    async def clear_run(self, run_id: str) -> None:
        async with self._lock:
            self._remove_run_locked(run_id)

    async def clear_all(self) -> None:
        async with self._lock:
            self._runs.clear()
            self._thread_runs.clear()

    def _create_run_locked(self, thread_id: str, run_id: str) -> _RunRecord:
        while len(self._runs) >= self.max_runs:
            oldest_run_id = next(iter(self._runs))
            self._remove_run_locked(oldest_run_id)
        record = _RunRecord(
            thread_id=thread_id,
            run_id=run_id,
            events=deque(),
        )
        self._runs[run_id] = record
        self._thread_runs.setdefault(thread_id, OrderedDict())[run_id] = None
        return record

    def _remove_run_locked(self, run_id: str) -> None:
        record = self._runs.pop(run_id, None)
        if record is None:
            return
        thread_index = self._thread_runs.get(record.thread_id)
        if thread_index is None:
            return
        thread_index.pop(run_id, None)
        if not thread_index:
            self._thread_runs.pop(record.thread_id, None)

    @staticmethod
    def _update_summary_locked(record: _RunRecord, event: TraceEvent) -> None:
        if event.event == TraceEventType.RUN_STARTED:
            record.status = TraceStatus.RUNNING
            record.started_at = event.started_at or event.timestamp
        elif event.event == TraceEventType.RUN_COMPLETED:
            record.status = TraceStatus.COMPLETED
            record.ended_at = event.ended_at or event.timestamp
            record.terminal_event_id = event.event_id
        elif event.event == TraceEventType.RUN_FAILED:
            record.status = (
                TraceStatus.CANCELLED
                if event.status == TraceStatus.CANCELLED
                else TraceStatus.FAILED
            )
            record.ended_at = event.ended_at or event.timestamp
            record.terminal_event_id = event.event_id


trace_store = InMemoryTraceStore()
