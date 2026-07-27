import asyncio

from api.context import (
    get_current_agent_context,
    get_current_entity_context,
    get_current_parent_context,
    get_run_context,
    get_thread_context,
    reset_current_agent_context,
    reset_current_entity_context,
    reset_current_parent_context,
    reset_run_context,
    reset_thread_context,
    set_current_agent_context,
    set_current_entity_context,
    set_current_parent_context,
    set_run_context,
    set_thread_context,
)
from api.trace_models import TraceEvent, TraceEventType
from api.trace_store import InMemoryTraceStore


def test_trace_contexts_are_isolated_across_concurrent_tasks() -> None:
    async def scenario() -> None:
        store = InMemoryTraceStore()

        async def worker(index: int) -> tuple:
            thread_id = f"thread-{index}"
            run_id = f"run-{index}"
            entity_id = f"entity-{index}"
            parent_id = f"parent-{index}"
            agent_id = f"agent-{index}"
            thread_token = set_thread_context(thread_id)
            run_token = set_run_context(run_id)
            entity_token = set_current_entity_context(entity_id)
            parent_token = set_current_parent_context(parent_id)
            agent_token = set_current_agent_context(agent_id)
            try:
                await asyncio.sleep(0)
                event = await store.append(
                    TraceEvent(
                        thread_id=get_thread_context(),
                        run_id=get_run_context(),
                        entity_id=get_current_entity_context(),
                        parent_id=get_current_parent_context(),
                        name=get_current_agent_context(),
                        event=TraceEventType.MESSAGE_SENT,
                    )
                )
                return (
                    event.thread_id,
                    event.run_id,
                    event.entity_id,
                    event.parent_id,
                    event.name,
                    event.sequence,
                )
            finally:
                reset_current_agent_context(agent_token)
                reset_current_parent_context(parent_token)
                reset_current_entity_context(entity_token)
                reset_run_context(run_token)
                reset_thread_context(thread_token)

        results = await asyncio.gather(worker(1), worker(2))
        assert results == [
            ("thread-1", "run-1", "entity-1", "parent-1", "agent-1", 1),
            ("thread-2", "run-2", "entity-2", "parent-2", "agent-2", 1),
        ]
        assert get_thread_context() is None
        assert get_run_context() is None
        assert get_current_entity_context() is None

    asyncio.run(scenario())
