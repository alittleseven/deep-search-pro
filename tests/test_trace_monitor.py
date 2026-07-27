import asyncio
from typing import Any, Dict, List

from api.context import (
    reset_current_entity_context,
    reset_run_context,
    reset_thread_context,
    set_current_entity_context,
    set_run_context,
    set_thread_context,
)
from api.monitor import ConnectionManager, ToolMonitor, monitor
from api.trace_models import TraceEvent, TraceEventType, TraceNodeType, TraceStatus
from api.trace_store import InMemoryTraceStore, trace_store


class RecordingManager:
    def __init__(self, *, fail: bool = False) -> None:
        self.fail = fail
        self.events: List[TraceEvent] = []
        self.persisted_before_broadcast = False

    async def broadcast_event(self, event: TraceEvent) -> None:
        stored = await trace_store.list_events(event.run_id)
        self.persisted_before_broadcast = any(
            candidate.event_id == event.event_id for candidate in stored
        )
        self.events.append(event)
        if self.fail:
            raise RuntimeError("broadcast unavailable")


class FakeWebSocket:
    def __init__(self, *, fail_send: bool = False) -> None:
        self.accepted = False
        self.fail_send = fail_send
        self.sent: List[Dict[str, Any]] = []

    async def accept(self) -> None:
        self.accepted = True

    async def send_json(self, payload: Dict[str, Any]) -> None:
        if self.fail_send:
            raise RuntimeError("closed")
        self.sent.append(payload)

    async def send_text(self, message: str) -> None:
        self.sent.append({"text": message})


def test_monitor_persists_before_broadcast() -> None:
    async def scenario() -> None:
        await trace_store.clear_all()
        recorder = RecordingManager()
        previous_manager = monitor.websocket_manager
        monitor.set_websocket_manager(recorder)
        try:
            event = await monitor.emit_event(
                event=TraceEventType.RUN_STARTED,
                node_type=TraceNodeType.RUN,
                status=TraceStatus.RUNNING,
                message="x" * 5_000,
                thread_id="thread-1",
                run_id="run-1",
            )
            assert recorder.persisted_before_broadcast
            assert recorder.events == [event]
            assert len(event.message) < 5_000
            assert event.message.endswith("…<truncated>")
        finally:
            monitor.websocket_manager = previous_manager

    asyncio.run(scenario())


def test_monitor_saves_without_websocket_and_keeps_event_on_failure() -> None:
    async def scenario() -> None:
        await trace_store.clear_all()
        previous_manager = monitor.websocket_manager
        monitor.websocket_manager = None
        try:
            saved = await monitor.emit_event(
                event=TraceEventType.MESSAGE_SENT,
                thread_id="thread-1",
                run_id="run-1",
            )
            assert [event.event_id for event in await trace_store.list_events("run-1")] == [
                saved.event_id
            ]

            recorder = RecordingManager(fail=True)
            monitor.set_websocket_manager(recorder)
            failed_broadcast = await monitor.emit_event(
                event=TraceEventType.MESSAGE_SENT,
                thread_id="thread-1",
                run_id="run-1",
            )
            stored_ids = [
                event.event_id for event in await trace_store.list_events("run-1")
            ]
            assert failed_broadcast.event_id in stored_ids
        finally:
            monitor.websocket_manager = previous_manager

    asyncio.run(scenario())


def test_store_failure_prevents_broadcast() -> None:
    async def scenario() -> None:
        await trace_store.clear_all()
        previous_manager = monitor.websocket_manager
        monitor.websocket_manager = None
        try:
            await monitor.emit_event(
                event=TraceEventType.RUN_COMPLETED,
                thread_id="thread-1",
                run_id="run-terminal",
            )
            recorder = RecordingManager()
            monitor.set_websocket_manager(recorder)
            try:
                await monitor.emit_event(
                    event=TraceEventType.RUN_FAILED,
                    thread_id="thread-1",
                    run_id="run-terminal",
                )
            except ValueError:
                pass
            else:
                raise AssertionError("second terminal event should fail")
            assert recorder.events == []
        finally:
            monitor.websocket_manager = previous_manager

    asyncio.run(scenario())


def test_legacy_report_tool_uses_context_and_new_protocol() -> None:
    async def scenario() -> None:
        await trace_store.clear_all()
        previous_manager = monitor.websocket_manager
        monitor.websocket_manager = None
        thread_token = set_thread_context("thread-legacy")
        run_token = set_run_context("run-legacy")
        entity_token = set_current_entity_context("agent-root")
        try:
            pending = monitor.report_tool(
                "search",
                {"api_key": "hidden", "query": "safe"},
            )
            event = await pending
            assert event.event == TraceEventType.TOOL_STARTED
            assert event.type == "monitor_event"
            assert event.thread_id == "thread-legacy"
            assert event.run_id == "run-legacy"
            assert event.parent_id == "agent-root"
            assert event.sequence == 1
            assert event.input["api_key"] == "***REDACTED***"
            assert event.data["tool_name"] == "search"
        finally:
            reset_current_entity_context(entity_token)
            reset_run_context(run_token)
            reset_thread_context(thread_token)
            monitor.websocket_manager = previous_manager

    asyncio.run(scenario())


def test_connection_manager_broadcasts_to_multiple_clients() -> None:
    async def scenario() -> None:
        manager = ConnectionManager()
        first = FakeWebSocket()
        second = FakeWebSocket()
        first_state = await manager.connect(first, "thread-1", "run-1")
        second_state = await manager.connect(second, "thread-1", "run-1")
        await manager.complete_replay(first_state, [])
        await manager.complete_replay(second_state, [])

        event = TraceEvent(
            thread_id="thread-1",
            run_id="run-1",
            sequence=1,
            event=TraceEventType.MESSAGE_SENT,
        )
        await manager.broadcast_event(event)
        assert first.sent[0]["event_id"] == event.event_id
        assert second.sent[0]["event_id"] == event.event_id
        assert await manager.connection_count("run-1") == 2

        await manager.disconnect(first, "run-1")
        assert await manager.connection_count("run-1") == 1
        next_event = event.model_copy(
            update={"event_id": str(__import__("uuid").uuid4()), "sequence": 2}
        )
        await manager.broadcast_event(next_event)
        assert len(first.sent) == 1
        assert len(second.sent) == 2

    asyncio.run(scenario())


def test_replay_registration_race_buffers_without_losing_events() -> None:
    async def scenario() -> None:
        store = InMemoryTraceStore()
        manager = ConnectionManager()
        historical = await store.append(
            TraceEvent(
                thread_id="thread-1",
                run_id="run-1",
                event=TraceEventType.RUN_STARTED,
            )
        )
        websocket = FakeWebSocket()
        state = await manager.connect(websocket, "thread-1", "run-1")
        snapshot = await store.list_events("run-1")

        raced = await store.append(
            TraceEvent(
                thread_id="thread-1",
                run_id="run-1",
                event=TraceEventType.MESSAGE_SENT,
            )
        )
        await manager.broadcast_event(raced)
        await manager.complete_replay(state, snapshot)

        assert [item["event_id"] for item in websocket.sent] == [
            historical.event_id,
            raced.event_id,
        ]
        assert [item["sequence"] for item in websocket.sent] == [1, 2]

    asyncio.run(scenario())


def test_connections_for_different_runs_do_not_receive_each_others_events() -> None:
    async def scenario() -> None:
        manager = ConnectionManager()
        first = FakeWebSocket()
        second = FakeWebSocket()
        first_state = await manager.connect(first, "thread-1", "run-1")
        second_state = await manager.connect(second, "thread-1", "run-2")
        await manager.complete_replay(first_state, [])
        await manager.complete_replay(second_state, [])
        await manager.broadcast_event(
            TraceEvent(
                thread_id="thread-1",
                run_id="run-1",
                sequence=1,
                event=TraceEventType.MESSAGE_SENT,
            )
        )
        assert len(first.sent) == 1
        assert second.sent == []

    asyncio.run(scenario())


def test_failed_connection_is_removed_without_affecting_others() -> None:
    async def scenario() -> None:
        manager = ConnectionManager()
        failed = FakeWebSocket(fail_send=True)
        healthy = FakeWebSocket()
        failed_state = await manager.connect(failed, "thread-1", "run-1")
        healthy_state = await manager.connect(healthy, "thread-1", "run-1")
        await manager.complete_replay(failed_state, [])
        await manager.complete_replay(healthy_state, [])
        await manager.broadcast_event(
            TraceEvent(
                thread_id="thread-1",
                run_id="run-1",
                sequence=1,
                event=TraceEventType.MESSAGE_SENT,
            )
        )
        assert await manager.connection_count("run-1") == 1
        assert len(healthy.sent) == 1

    asyncio.run(scenario())
