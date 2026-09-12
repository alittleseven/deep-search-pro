import asyncio
import importlib.util
import sys
import tempfile
import types
from pathlib import Path

from api.context import get_run_context, get_thread_context
from api.monitor import monitor
from api.trace_models import TraceEventType, TraceStatus
from api.trace_store import trace_store


class FakeMessage:
    tool_calls = []
    content = "final answer"


class TaskCallMessage:
    content = ""
    tool_calls = [
        {
            "name": "task",
            "id": "subagent-call-1",
            "args": {
                "subagent_type": "数据库查询助手",
                "description": "查询产品库存",
            },
        }
    ]


class TaskResultMessage:
    tool_calls = []
    tool_call_id = "subagent-call-1"
    status = "success"
    content = "库存查询完成"


class FakeDeepAgent:
    def __init__(self) -> None:
        self.fail = False
        self.chunks = None

    async def astream(self, payload, config):
        if self.fail:
            raise RuntimeError("model failure")
        if self.chunks is not None:
            for chunk in self.chunks:
                yield chunk
            return
        yield {"model": {"messages": [FakeMessage()]}}


def load_main_agent_module(monkeypatch):
    fake_graph = FakeDeepAgent()

    def module(name: str, **attributes):
        value = types.ModuleType(name)
        for key, attribute in attributes.items():
            setattr(value, key, attribute)
        monkeypatch.setitem(sys.modules, name, value)

    module(
        "agent.subagents.knowledge_base_agent",
        knowledge_base_agent={},
    )
    module(
        "agent.subagents.database_query_agent",
        database_query_agent={},
    )
    module(
        "agent.subagents.network_search_agent",
        network_search_agent={},
    )
    module("tools.markdown_tools", generate_markdown=lambda: None)
    module("tools.pdf_tools", convert_md_to_pdf=lambda: None)
    module("tools.upload_file_read_tool", read_file_content=lambda: None)
    module("deepagents", create_deep_agent=lambda **kwargs: fake_graph)
    module("agent.llm", model=object())
    module("agent.prompts", main_agent_content={"system_prompt": "unchanged"})
    module("langgraph")
    module("langgraph.checkpoint")
    module(
        "langgraph.checkpoint.memory",
        InMemorySaver=lambda: object(),
    )

    source_path = (
        Path(__file__).resolve().parents[1] / "agent" / "main_agent.py"
    )
    spec = importlib.util.spec_from_file_location(
        "main_agent_trace_lifecycle_under_test",
        source_path,
    )
    assert spec is not None and spec.loader is not None
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded, fake_graph


def test_run_lifecycle_completed_uses_one_root_entity(monkeypatch) -> None:
    async def scenario() -> None:
        await trace_store.clear_all()
        loaded, _ = load_main_agent_module(monkeypatch)
        with tempfile.TemporaryDirectory(
            prefix=".trace-test-",
            dir=Path.cwd(),
        ) as temporary_directory:
            loaded.project_root_path = Path(temporary_directory)
            previous_manager = monitor.websocket_manager
            monitor.websocket_manager = None
            try:
                await loaded.run_deep_agent(
                    "query",
                    "thread-1",
                    "run-1",
                )
            finally:
                monitor.websocket_manager = previous_manager

        events = await trace_store.list_events("run-1")
        assert [event.event for event in events] == [
            TraceEventType.RUN_STARTED,
            TraceEventType.SESSION_CREATED,
            TraceEventType.RUN_COMPLETED,
        ]
        assert events[0].entity_id == events[-1].entity_id == "run-1"
        assert events[1].status == TraceStatus.COMPLETED
        assert events[1].input == {}
        assert events[-1].status == TraceStatus.COMPLETED
        assert events[-1].input == {"query": "query"}
        assert events[-1].output == "final answer"
        assert events[-1].started_at == events[0].started_at
        assert events[-1].ended_at is not None
        assert events[-1].duration_ms is not None
        assert get_thread_context() is None
        assert get_run_context() is None

    asyncio.run(scenario())


def test_subagent_task_response_completes_the_matching_agent(monkeypatch) -> None:
    async def scenario() -> None:
        await trace_store.clear_all()
        loaded, fake_graph = load_main_agent_module(monkeypatch)
        fake_graph.chunks = [
            {"model": {"messages": [TaskCallMessage()]}},
            {"tools": {"messages": [TaskResultMessage()]}},
            {"model": {"messages": [FakeMessage()]}},
        ]
        with tempfile.TemporaryDirectory(
            prefix=".trace-test-",
            dir=Path.cwd(),
        ) as temporary_directory:
            loaded.project_root_path = Path(temporary_directory)
            previous_manager = monitor.websocket_manager
            monitor.websocket_manager = None
            try:
                await loaded.run_deep_agent(
                    "query",
                    "thread-1",
                    "run-subagent",
                )
            finally:
                monitor.websocket_manager = previous_manager

        events = await trace_store.list_events("run-subagent")
        agent_events = [
            event for event in events if event.node_type.value == "agent"
        ]
        assert [event.event for event in agent_events] == [
            TraceEventType.AGENT_STARTED,
            TraceEventType.AGENT_COMPLETED,
        ]
        assert agent_events[0].entity_id == agent_events[1].entity_id
        assert agent_events[0].name == agent_events[1].name == "数据库查询助手"
        assert agent_events[1].status == TraceStatus.COMPLETED
        assert agent_events[1].input == {
            "subagent_type": "数据库查询助手",
            "description": "查询产品库存",
        }
        assert agent_events[1].output == "库存查询完成"
        assert agent_events[1].duration_ms is not None

    asyncio.run(scenario())


def test_run_lifecycle_failure_emits_one_failed_terminal(monkeypatch) -> None:
    async def scenario() -> None:
        await trace_store.clear_all()
        loaded, fake_graph = load_main_agent_module(monkeypatch)
        with tempfile.TemporaryDirectory(
            prefix=".trace-test-",
            dir=Path.cwd(),
        ) as temporary_directory:
            loaded.project_root_path = Path(temporary_directory)
            fake_graph.fail = True
            previous_manager = monitor.websocket_manager
            monitor.websocket_manager = None
            try:
                await loaded.run_deep_agent(
                    "query",
                    "thread-1",
                    "run-failed",
                )
            finally:
                monitor.websocket_manager = previous_manager

        events = await trace_store.list_events("run-failed")
        terminal = [
            event
            for event in events
            if event.event
            in {TraceEventType.RUN_COMPLETED, TraceEventType.RUN_FAILED}
        ]
        assert len(terminal) == 1
        assert terminal[0].event == TraceEventType.RUN_FAILED
        assert terminal[0].status == TraceStatus.FAILED
        assert terminal[0].input == {"query": "query"}
        assert terminal[0].error.type == "RuntimeError"
        assert "model failure" in terminal[0].error.message

    asyncio.run(scenario())
