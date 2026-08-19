import asyncio
import importlib.util
import sys
import threading
import types

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

# The project declares python-multipart, but the isolated test interpreter may
# not have optional upload dependencies installed. These tests do not exercise
# uploads, so provide only the import surface FastAPI checks during route setup.
if importlib.util.find_spec("multipart") is None:
    multipart_module = types.ModuleType("multipart")
    multipart_module.__version__ = "0.0-test"
    multipart_parser_module = types.ModuleType("multipart.multipart")
    multipart_parser_module.parse_options_header = lambda value: (value, {})
    sys.modules["multipart"] = multipart_module
    sys.modules["multipart.multipart"] = multipart_parser_module

from api import server
from api.monitor import monitor
from api.trace_models import TraceEvent, TraceEventType, TraceNodeType, TraceStatus
from api.trace_store import trace_store


def clear_store() -> None:
    asyncio.run(trace_store.clear_all())


def test_task_returns_thread_and_distinct_run_ids(monkeypatch) -> None:
    async def no_op(query: str, thread_id: str, run_id: str) -> None:
        return None

    clear_store()
    monkeypatch.setattr(server, "execute_deep_agent", no_op)
    with TestClient(server.app) as client:
        first = client.post(
            "/api/task",
            json={"query": "first", "thread_id": "thread-shared"},
        )
        second = client.post(
            "/api/task",
            json={"query": "second", "thread_id": "thread-shared"},
        )
        generated = client.post(
            "/api/task",
            json={"query": "generated thread"},
        )

    assert first.status_code == 200
    assert first.json()["thread_id"] == "thread-shared"
    assert first.json()["run_id"] != second.json()["run_id"]
    assert first.json()["status"] == "started"
    assert generated.json()["thread_id"]
    assert generated.json()["run_id"]


def test_trace_query_after_sequence_limit_and_not_found() -> None:
    async def seed() -> None:
        await trace_store.clear_all()
        for _ in range(4):
            await trace_store.append(
                TraceEvent(
                    thread_id="thread-1",
                    run_id="run-1",
                    event=TraceEventType.MESSAGE_SENT,
                )
            )

    asyncio.run(seed())
    with TestClient(server.app) as client:
        response = client.get(
            "/api/runs/run-1/trace",
            params={"after_sequence": 1, "limit": 2},
        )
        missing = client.get("/api/runs/missing/trace")
        invalid = client.get(
            "/api/runs/run-1/trace",
            params={"after_sequence": -1},
        )

    assert response.status_code == 200
    assert [event["sequence"] for event in response.json()["events"]] == [2, 3]
    assert response.json()["last_sequence"] == 3
    assert response.json()["has_more"] is True
    assert missing.status_code == 404
    assert invalid.status_code == 422


def test_thread_runs_are_returned_newest_first() -> None:
    async def seed() -> None:
        await trace_store.clear_all()
        await trace_store.append(
            TraceEvent(
                thread_id="thread-1",
                run_id="run-1",
                event=TraceEventType.RUN_STARTED,
            )
        )
        await asyncio.sleep(0.001)
        await trace_store.append(
            TraceEvent(
                thread_id="thread-1",
                run_id="run-2",
                event=TraceEventType.RUN_STARTED,
            )
        )

    asyncio.run(seed())
    with TestClient(server.app) as client:
        response = client.get("/api/threads/thread-1/runs")

    assert response.status_code == 200
    assert [run["run_id"] for run in response.json()["runs"]] == [
        "run-2",
        "run-1",
    ]


def test_websocket_replays_history_after_sequence_and_keeps_ping_pong() -> None:
    async def seed() -> None:
        await trace_store.clear_all()
        for event_type in (
            TraceEventType.RUN_STARTED,
            TraceEventType.MESSAGE_SENT,
            TraceEventType.RUN_COMPLETED,
        ):
            await trace_store.append(
                TraceEvent(
                    thread_id="thread-1",
                    run_id="run-1",
                    event=event_type,
                )
            )

    asyncio.run(seed())
    with TestClient(server.app) as client:
        with client.websocket_connect(
            "/ws/thread-1?run_id=run-1&after_sequence=1"
        ) as websocket:
            second = websocket.receive_json()
            third = websocket.receive_json()
            websocket.send_text("ping")
            pong = websocket.receive_json()

    assert [second["sequence"], third["sequence"]] == [2, 3]
    assert pong == {
        "type": "pong",
        "message": "服务端已收到: ping",
    }


def test_websocket_rejects_unknown_or_wrong_thread_run() -> None:
    async def seed() -> None:
        await trace_store.clear_all()
        await trace_store.reserve_run("thread-1", "run-1")

    asyncio.run(seed())
    with TestClient(server.app) as client:
        with pytest.raises(WebSocketDisconnect) as missing:
            with client.websocket_connect(
                "/ws/thread-1?run_id=missing"
            ):
                pass
        with pytest.raises(WebSocketDisconnect) as wrong_thread:
            with client.websocket_connect(
                "/ws/thread-2?run_id=run-1"
            ):
                pass

    assert missing.value.code == 4404
    assert wrong_thread.value.code == 4404


def test_two_websocket_clients_receive_same_live_event(monkeypatch) -> None:
    gate = threading.Event()

    async def gated_run(query: str, thread_id: str, run_id: str) -> None:
        await asyncio.to_thread(gate.wait)
        await monitor.emit_event(
            event=TraceEventType.RUN_STARTED,
            node_type=TraceNodeType.RUN,
            status=TraceStatus.RUNNING,
            entity_id=run_id,
            thread_id=thread_id,
            run_id=run_id,
        )

    clear_store()
    monkeypatch.setattr(server, "execute_deep_agent", gated_run)
    with TestClient(server.app) as client:
        started = client.post(
            "/api/task",
            json={"query": "live", "thread_id": "thread-live"},
        ).json()
        url = (
            f"/ws/{started['thread_id']}?run_id={started['run_id']}"
            "&after_sequence=0"
        )
        with client.websocket_connect(url) as first:
            with client.websocket_connect(url) as second:
                gate.set()
                first_event = first.receive_json()
                second_event = second.receive_json()

    assert first_event["event_id"] == second_event["event_id"]
    assert first_event["sequence"] == second_event["sequence"] == 1
