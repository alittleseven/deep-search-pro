import asyncio
import concurrent.futures
import functools
import inspect
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Dict, List, Optional, Union
from uuid import uuid4

from fastapi import WebSocket

from api.context import (
    get_current_agent_context,
    get_current_entity_context,
    get_current_parent_context,
    get_run_context,
    get_thread_context,
)
from api.trace_models import (
    TraceError,
    TraceEvent,
    TraceEventType,
    TraceNodeType,
    TraceStatus,
)
from api.trace_serializer import normalize_trace_error, sanitize_for_trace
from api.trace_store import trace_store

try:
    import builtins
except ImportError:
    builtins = None


SEND_TIMEOUT_SECONDS = 5.0
EmissionResult = Union[
    TraceEvent,
    "asyncio.Task[TraceEvent]",
    "concurrent.futures.Future[TraceEvent]",
]


@dataclass(eq=False)
class ConnectionState:
    websocket: WebSocket
    thread_id: str
    run_id: Optional[str]
    replaying: bool = True
    pending: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    send_lock: asyncio.Lock = field(default_factory=asyncio.Lock)


class ConnectionManager:
    """Broadcast WebSocket connections grouped by run, with thread fallback."""

    def __init__(self) -> None:
        self.active_connections: Dict[
            Optional[str],
            Dict[int, ConnectionState],
        ] = {}
        self.loop: Optional[asyncio.AbstractEventLoop] = None
        self._lock = asyncio.Lock()

    def set_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self.loop = loop
        monitor.set_websocket_manager(self)
        print(f"[Monitor] ConnectionManager bound to loop: {id(loop)}")

    async def connect(
        self,
        websocket: WebSocket,
        thread_id: str,
        run_id: Optional[str] = None,
    ) -> ConnectionState:
        await websocket.accept()
        state = ConnectionState(
            websocket=websocket,
            thread_id=thread_id,
            run_id=run_id,
        )
        async with self._lock:
            self.active_connections.setdefault(run_id, {})[id(websocket)] = state
        return state

    async def complete_replay(
        self,
        state: ConnectionState,
        historical_events: List[TraceEvent],
    ) -> None:
        """Finish catch-up without a history/live gap.

        The connection is registered as ``replaying`` before history is read.
        Broadcasts that race with that read are buffered in ``state.pending``.
        A per-connection send lock serializes the sorted catch-up batch ahead of
        subsequent live sends. An event may be observed in both history and the
        pending buffer, so event_id is used to de-duplicate it.
        """

        failed = False
        async with state.send_lock:
            async with self._lock:
                if not self._contains_state_locked(state):
                    return
                payloads = {
                    event.event_id: event.model_dump(mode="json")
                    for event in historical_events
                }
                payloads.update(state.pending)
                state.pending.clear()
                state.replaying = False

            ordered = sorted(
                payloads.values(),
                key=lambda payload: int(payload.get("sequence", 0)),
            )
            for payload in ordered:
                try:
                    await asyncio.wait_for(
                        state.websocket.send_json(payload),
                        timeout=SEND_TIMEOUT_SECONDS,
                    )
                except asyncio.CancelledError:
                    raise
                except Exception:
                    failed = True
                    break
        if failed:
            await self.disconnect(state.websocket, state.run_id)

    async def disconnect(
        self,
        websocket: WebSocket,
        run_id: Optional[str] = None,
    ) -> None:
        async with self._lock:
            if run_id in self.active_connections:
                self.active_connections[run_id].pop(id(websocket), None)
                if not self.active_connections[run_id]:
                    self.active_connections.pop(run_id, None)
                return
            for key, connections in list(self.active_connections.items()):
                if id(websocket) in connections:
                    connections.pop(id(websocket), None)
                    if not connections:
                        self.active_connections.pop(key, None)
                    return

    async def broadcast_event(self, event: TraceEvent) -> None:
        payload = event.model_dump(mode="json")
        live_states: List[ConnectionState] = []
        async with self._lock:
            candidates = list(
                self.active_connections.get(event.run_id, {}).values()
            ) + list(self.active_connections.get(None, {}).values())
            for state in candidates:
                if state.thread_id != event.thread_id:
                    continue
                if state.replaying:
                    state.pending[event.event_id] = payload
                else:
                    live_states.append(state)

        if live_states:
            await asyncio.gather(
                *(self._send_to_state(state, payload) for state in live_states),
                return_exceptions=True,
            )

    async def send_personal_message(
        self,
        message: str,
        websocket: WebSocket,
    ) -> None:
        await websocket.send_text(message)

    async def send_to_connection(
        self,
        state: ConnectionState,
        payload: Dict[str, Any],
    ) -> None:
        await self._send_to_state(state, sanitize_for_trace(payload))

    async def send_to_thread(
        self,
        message: Dict[str, Any],
        thread_id: str,
    ) -> None:
        """Compatibility broadcaster for non-trace messages."""

        payload = sanitize_for_trace(message)
        states: List[ConnectionState] = []
        async with self._lock:
            for connections in self.active_connections.values():
                states.extend(
                    state
                    for state in connections.values()
                    if state.thread_id == thread_id and not state.replaying
                )
        await asyncio.gather(
            *(self._send_to_state(state, payload) for state in states),
            return_exceptions=True,
        )

    async def connection_count(self, run_id: Optional[str] = None) -> int:
        async with self._lock:
            if run_id is not None:
                return len(self.active_connections.get(run_id, {}))
            return sum(
                len(connections)
                for connections in self.active_connections.values()
            )

    async def _send_to_state(
        self,
        state: ConnectionState,
        payload: Dict[str, Any],
    ) -> None:
        failed = False
        async with state.send_lock:
            try:
                await asyncio.wait_for(
                    state.websocket.send_json(payload),
                    timeout=SEND_TIMEOUT_SECONDS,
                )
            except asyncio.CancelledError:
                raise
            except Exception:
                failed = True
        if failed:
            await self.disconnect(state.websocket, state.run_id)

    def _contains_state_locked(self, state: ConnectionState) -> bool:
        return (
            self.active_connections.get(state.run_id, {}).get(
                id(state.websocket)
            )
            is state
        )


class ToolMonitor:
    """Compatibility monitor backed by the canonical trace infrastructure."""

    _instance: Optional["ToolMonitor"] = None
    websocket_manager: Optional[ConnectionManager]

    def __new__(cls) -> "ToolMonitor":
        if cls._instance is None:
            instance = super().__new__(cls)
            instance.websocket_manager = None
            cls._instance = instance
        return cls._instance

    def set_websocket_manager(self, websocket_manager: ConnectionManager) -> None:
        self.websocket_manager = websocket_manager

    def traced_tool(self, tool_name: str) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
        """Wrap a synchronous LangChain tool with paired trace events."""

        def decorator(function: Callable[..., Any]) -> Callable[..., Any]:
            signature = inspect.signature(function)

            @functools.wraps(function)
            def wrapped(*args: Any, **kwargs: Any) -> Any:
                try:
                    bound_arguments = signature.bind(*args, **kwargs)
                    bound_arguments.apply_defaults()
                    tool_input: Dict[str, Any] = dict(bound_arguments.arguments)
                except TypeError:
                    tool_input = dict(kwargs)

                tool_call_id = str(uuid4())
                started_at = datetime.now(timezone.utc)
                started_monotonic = time.perf_counter()
                thread_id = get_thread_context() or "legacy"
                run_id = get_run_context() or f"legacy-{uuid4()}"
                parent_id = (
                    get_current_agent_context()
                    or get_current_entity_context()
                )

                self._dispatch_trace_event(
                    event=TraceEventType.TOOL_STARTED,
                    node_type=TraceNodeType.TOOL,
                    status=TraceStatus.RUNNING,
                    entity_id=tool_call_id,
                    parent_id=parent_id,
                    tool_call_id=tool_call_id,
                    name=tool_name,
                    message=f"开始执行工具: {tool_name}",
                    started_at=started_at,
                    input=tool_input,
                    metadata={"legacy_event": "tool_start"},
                    data={"tool_name": tool_name},
                    thread_id=thread_id,
                    run_id=run_id,
                )

                try:
                    output = function(*args, **kwargs)
                except BaseException as exc:
                    self._dispatch_trace_event(
                        event=TraceEventType.TOOL_FAILED,
                        node_type=TraceNodeType.TOOL,
                        status=TraceStatus.FAILED,
                        entity_id=tool_call_id,
                        parent_id=parent_id,
                        tool_call_id=tool_call_id,
                        name=tool_name,
                        message=f"工具执行失败: {tool_name}",
                        started_at=started_at,
                        ended_at=datetime.now(timezone.utc),
                        duration_ms=int(
                            (time.perf_counter() - started_monotonic) * 1_000
                        ),
                        input=tool_input,
                        error=exc,
                        metadata={"legacy_event": "tool_error"},
                        data={"tool_name": tool_name},
                        thread_id=thread_id,
                        run_id=run_id,
                    )
                    raise

                self._dispatch_trace_event(
                    event=TraceEventType.TOOL_COMPLETED,
                    node_type=TraceNodeType.TOOL,
                    status=TraceStatus.COMPLETED,
                    entity_id=tool_call_id,
                    parent_id=parent_id,
                    tool_call_id=tool_call_id,
                    name=tool_name,
                    message=f"工具执行完成: {tool_name}",
                    started_at=started_at,
                    ended_at=datetime.now(timezone.utc),
                    duration_ms=int(
                        (time.perf_counter() - started_monotonic) * 1_000
                    ),
                    input=tool_input,
                    output=output,
                    metadata={"legacy_event": "tool_complete"},
                    data={"tool_name": tool_name},
                    thread_id=thread_id,
                    run_id=run_id,
                )
                return output

            return wrapped

        return decorator

    def _dispatch_trace_event(self, **kwargs: Any) -> None:
        """Schedule trace delivery without changing the wrapped tool outcome."""

        try:
            self._dispatch(self.emit_event(**kwargs))
        except Exception as exc:
            print(
                "[Monitor] Scheduled lifecycle trace emission failed: "
                f"{type(exc).__name__}"
            )

    async def emit_event(
        self,
        *,
        event: TraceEventType,
        node_type: Optional[TraceNodeType] = None,
        status: Optional[TraceStatus] = None,
        entity_id: Optional[str] = None,
        parent_id: Optional[str] = None,
        source_id: Optional[str] = None,
        target_id: Optional[str] = None,
        tool_call_id: Optional[str] = None,
        name: Optional[str] = None,
        message: Optional[str] = None,
        started_at: Optional[datetime] = None,
        ended_at: Optional[datetime] = None,
        duration_ms: Optional[int] = None,
        input: Any = None,
        output: Any = None,
        error: Union[TraceError, Dict[str, Any], str, BaseException, None] = None,
        metadata: Optional[Dict[str, Any]] = None,
        data: Optional[Dict[str, Any]] = None,
        thread_id: Optional[str] = None,
        run_id: Optional[str] = None,
    ) -> TraceEvent:
        resolved_thread_id = thread_id or get_thread_context() or "legacy"
        resolved_run_id = run_id or get_run_context() or f"legacy-{uuid4()}"
        safe_metadata = sanitize_for_trace(metadata or {})
        safe_data = sanitize_for_trace(data or {})
        safe_name = sanitize_for_trace(name)
        safe_message = sanitize_for_trace(message)
        trace_event = TraceEvent(
            thread_id=resolved_thread_id,
            run_id=resolved_run_id,
            event=event,
            node_type=node_type,
            status=status,
            entity_id=entity_id or get_current_entity_context(),
            parent_id=parent_id or get_current_parent_context(),
            source_id=source_id,
            target_id=target_id,
            tool_call_id=tool_call_id,
            name=safe_name if isinstance(safe_name, str) else None,
            message=safe_message if isinstance(safe_message, str) else None,
            started_at=started_at,
            ended_at=ended_at,
            duration_ms=duration_ms,
            input=sanitize_for_trace(input),
            output=sanitize_for_trace(output),
            error=normalize_trace_error(error),
            metadata=safe_metadata if isinstance(safe_metadata, dict) else {},
            data=safe_data if isinstance(safe_data, dict) else {},
        )

        # Persistence is the delivery boundary: never broadcast an event that
        # cannot subsequently be recovered from the trace store.
        stored_event = await trace_store.append(trace_event)
        if self.websocket_manager is not None:
            try:
                await self.websocket_manager.broadcast_event(stored_event)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                print(
                    "[Monitor] Trace broadcast failed "
                    f"for event_id={stored_event.event_id}: {type(exc).__name__}"
                )

        payload = stored_event.model_dump(mode="json")
        if (
            builtins is not None
            and hasattr(builtins, "runtime")
            and hasattr(builtins.runtime, "stream_writer")
        ):
            try:
                builtins.runtime.stream_writer(payload)
            except Exception as exc:
                print(
                    "[Monitor] Runtime stream writer failed "
                    f"for event_id={stored_event.event_id}: {type(exc).__name__}"
                )
        print(
            f"[Monitor:{stored_event.event.value}] "
            f"run_id={stored_event.run_id} sequence={stored_event.sequence}"
        )
        return stored_event

    def _emit(
        self,
        event_type: str,
        message: str,
        data: Optional[Dict[str, Any]] = None,
    ) -> EmissionResult:
        """Compatibility adapter for the original monitor event names."""

        legacy_data = data or {}
        common = {
            "message": message,
            "data": legacy_data,
            "metadata": {"legacy_event": event_type},
            # Resolve ContextVars before a cross-thread coroutine is scheduled.
            "thread_id": get_thread_context(),
            "run_id": get_run_context(),
        }
        if event_type == "tool_start":
            tool_call_id = str(uuid4())
            awaitable = self.emit_event(
                event=TraceEventType.TOOL_STARTED,
                node_type=TraceNodeType.TOOL,
                status=TraceStatus.RUNNING,
                entity_id=tool_call_id,
                parent_id=(
                    get_current_agent_context()
                    or get_current_entity_context()
                ),
                tool_call_id=tool_call_id,
                name=legacy_data.get("tool_name"),
                input=legacy_data.get("args"),
                **common,
            )
        elif event_type == "assistant_call":
            # The legacy signal denotes invocation, so it maps to agent_started.
            entity_id = str(uuid4())
            awaitable = self.emit_event(
                event=TraceEventType.AGENT_STARTED,
                node_type=TraceNodeType.AGENT,
                status=TraceStatus.RUNNING,
                entity_id=entity_id,
                parent_id=get_current_entity_context(),
                name=legacy_data.get("assistant_name"),
                input=legacy_data.get("args"),
                **common,
            )
        elif event_type == "task_result":
            awaitable = self.emit_event(
                event=TraceEventType.RUN_COMPLETED,
                node_type=TraceNodeType.RUN,
                status=TraceStatus.COMPLETED,
                entity_id=get_run_context(),
                output=legacy_data.get("result"),
                **common,
            )
        elif event_type == "session_created":
            awaitable = self.emit_event(
                event=TraceEventType.SESSION_CREATED,
                node_type=TraceNodeType.RUN,
                status=TraceStatus.RUNNING,
                entity_id=get_run_context(),
                output={"path": legacy_data.get("path")},
                **common,
            )
        elif event_type == "error":
            awaitable = self.emit_event(
                event=TraceEventType.RUN_FAILED,
                node_type=TraceNodeType.RUN,
                status=TraceStatus.FAILED,
                entity_id=get_run_context(),
                error=message,
                **common,
            )
        else:
            try:
                canonical_event = TraceEventType(event_type)
            except ValueError:
                canonical_event = TraceEventType.MESSAGE_SENT
            awaitable = self.emit_event(event=canonical_event, **common)
        return self._dispatch(awaitable)

    def report_tool(
        self,
        tool_name: str,
        args: Optional[Dict[str, Any]] = None,
    ) -> EmissionResult:
        return self._emit(
            "tool_start",
            f"开始执行工具: {tool_name}",
            {"tool_name": tool_name, "args": args},
        )

    def report_assistant(
        self,
        assistant_name: str,
        args: Optional[Dict[str, Any]] = None,
    ) -> EmissionResult:
        return self._emit(
            "assistant_call",
            f"正在调用助手: {assistant_name}",
            {"assistant_name": assistant_name, "args": args},
        )

    def report_task_result(self, result: str) -> EmissionResult:
        return self._emit(
            "task_result",
            "任务执行完成",
            {"result": result},
        )

    def report_session_dir(self, path: str) -> EmissionResult:
        return self._emit(
            "session_created",
            f"工作目录已创建: {path}",
            {"path": path},
        )

    @staticmethod
    def _dispatch(awaitable: Awaitable[TraceEvent]) -> EmissionResult:
        try:
            current_loop = asyncio.get_running_loop()
        except RuntimeError:
            current_loop = None

        if current_loop is not None:
            task = current_loop.create_task(awaitable)
            task.add_done_callback(ToolMonitor._log_task_failure)
            return task

        manager_loop = manager.loop
        if manager_loop is not None and manager_loop.is_running():
            future = asyncio.run_coroutine_threadsafe(awaitable, manager_loop)
            return future
        return asyncio.run(awaitable)

    @staticmethod
    def _log_task_failure(task: "asyncio.Task[TraceEvent]") -> None:
        if task.cancelled():
            return
        error = task.exception()
        if error is not None:
            print(
                "[Monitor] Scheduled trace emission failed: "
                f"{type(error).__name__}"
            )


monitor = ToolMonitor()
manager = ConnectionManager()
