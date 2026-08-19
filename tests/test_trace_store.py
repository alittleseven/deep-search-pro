import asyncio
from datetime import datetime, timedelta, timezone

import pytest

from api.trace_models import TraceEvent, TraceEventType, TraceStatus
from api.trace_store import InMemoryTraceStore


def make_event(
    run_id: str,
    *,
    thread_id: str = "thread-1",
    event_type: TraceEventType = TraceEventType.MESSAGE_SENT,
    timestamp: datetime = None,
) -> TraceEvent:
    return TraceEvent(
        thread_id=thread_id,
        run_id=run_id,
        event=event_type,
        timestamp=timestamp or datetime.now(timezone.utc),
    )


def test_sequences_start_at_one_and_are_independent_per_run() -> None:
    async def scenario() -> None:
        store = InMemoryTraceStore()
        first = await store.append(make_event("run-1"))
        second = await store.append(make_event("run-1"))
        other = await store.append(make_event("run-2"))
        assert (first.sequence, second.sequence, other.sequence) == (1, 2, 1)

    asyncio.run(scenario())


def test_concurrent_append_allocates_unique_sequences() -> None:
    async def scenario() -> None:
        store = InMemoryTraceStore()
        events = await asyncio.gather(
            *(store.append(make_event("run-1")) for _ in range(100))
        )
        assert sorted(event.sequence for event in events) == list(range(1, 101))

    asyncio.run(scenario())


def test_after_sequence_is_exclusive_and_limit_is_applied() -> None:
    async def scenario() -> None:
        store = InMemoryTraceStore()
        for _ in range(5):
            await store.append(make_event("run-1"))
        events = await store.list_events("run-1", after_sequence=2, limit=2)
        assert [event.sequence for event in events] == [3, 4]

    asyncio.run(scenario())


def test_run_summary_and_thread_order_follow_run_events() -> None:
    async def scenario() -> None:
        store = InMemoryTraceStore()
        base = datetime(2026, 1, 1, tzinfo=timezone.utc)
        await store.append(
            make_event(
                "older",
                event_type=TraceEventType.RUN_STARTED,
                timestamp=base,
            )
        )
        await store.append(
            make_event(
                "newer",
                event_type=TraceEventType.RUN_STARTED,
                timestamp=base + timedelta(seconds=1),
            )
        )
        await store.append(
            make_event(
                "newer",
                event_type=TraceEventType.RUN_COMPLETED,
                timestamp=base + timedelta(seconds=2),
            )
        )

        summary = await store.get_run("newer")
        assert summary is not None
        assert summary.status == TraceStatus.COMPLETED
        assert summary.started_at == base + timedelta(seconds=1)
        assert summary.ended_at == base + timedelta(seconds=2)
        assert summary.event_count == 2
        assert summary.last_sequence == 2
        runs = await store.list_runs("thread-1")
        assert [run.run_id for run in runs] == ["newer", "older"]

    asyncio.run(scenario())


def test_per_run_capacity_evicts_oldest_event_but_keeps_sequence() -> None:
    async def scenario() -> None:
        store = InMemoryTraceStore(max_events_per_run=2, max_runs=10)
        for _ in range(3):
            await store.append(make_event("run-1"))
        events = await store.list_events("run-1")
        summary = await store.get_run("run-1")
        assert [event.sequence for event in events] == [2, 3]
        assert summary is not None
        assert summary.event_count == 2
        assert summary.last_sequence == 3

    asyncio.run(scenario())


def test_run_capacity_evicts_oldest_run_and_updates_thread_index() -> None:
    async def scenario() -> None:
        store = InMemoryTraceStore(max_events_per_run=10, max_runs=2)
        await store.reserve_run("thread-1", "run-1")
        await store.reserve_run("thread-1", "run-2")
        await store.reserve_run("thread-2", "run-3")
        assert await store.get_run("run-1") is None
        assert [run.run_id for run in await store.list_runs("thread-1")] == [
            "run-2"
        ]

    asyncio.run(scenario())


def test_clear_run_removes_events_and_index() -> None:
    async def scenario() -> None:
        store = InMemoryTraceStore()
        await store.append(make_event("run-1"))
        await store.clear_run("run-1")
        assert await store.get_run("run-1") is None
        assert await store.list_runs("thread-1") == []

    asyncio.run(scenario())


def test_only_one_terminal_event_is_allowed() -> None:
    async def scenario() -> None:
        store = InMemoryTraceStore()
        await store.append(
            make_event("run-1", event_type=TraceEventType.RUN_COMPLETED)
        )
        with pytest.raises(ValueError):
            await store.append(
                make_event("run-1", event_type=TraceEventType.RUN_FAILED)
            )

    asyncio.run(scenario())
