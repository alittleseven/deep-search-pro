from agent.subagents.knowledge_base_agent import knowledge_base_agent
from agent.subagents.database_query_agent import database_query_agent
from agent.subagents.network_search_agent import network_search_agent
from langgraph.checkpoint.memory import InMemorySaver

# main_agent tool导入
from tools.markdown_tools import generate_markdown
from tools.pdf_tools import convert_md_to_pdf
from tools.upload_file_read_tool import read_file_content

from deepagents import create_deep_agent

from agent.llm import model
from agent.prompts import main_agent_content

from api.monitor import monitor
import asyncio
import uuid
import shutil
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional

from api.context import (
    reset_current_agent_context,
    reset_current_entity_context,
    reset_run_context,
    reset_session_context,
    reset_thread_context,
    set_current_agent_context,
    set_current_entity_context,
    set_run_context,
    set_session_context,
    set_thread_context,
)
from api.trace_models import TraceEventType, TraceNodeType, TraceStatus

main_agent = create_deep_agent(
   model = model,
   system_prompt=main_agent_content['system_prompt'],
   tools= [generate_markdown,convert_md_to_pdf,read_file_content],
   checkpointer=InMemorySaver(),
   subagents=[
       database_query_agent,
       network_search_agent,
       knowledge_base_agent
   ]
)

# 执行
"""
  1. 执行主智能体 一定选异步，原因：对应多个客户端
  2. 什么时候触发我们智能体的调用或者执行？？？
  3. 客户端 -》 api/task -> fastapi 接口 -》 异步执行 -》 main_agent的运行 （异步方法）
  4. main_agent执行stream流式处理 -》 调用工具 -》 已经埋好了点  
                                   调用子智能体 -》 结果解析 -》 name = task -> monitor -> 发送子智能体
                                   调用最终结果 -》 结果 -》 monitor -> 发送结果的方法
                                   开启调用以后 -》 当前会话 -》 文件夹地址 -》 推送到前端
"""



project_root_path = Path(__file__).parents[1].resolve() # 绝对 解析路径标识以及软连接
# project_root_path = Path(__file__).parents[1].absolute() # 绝对
# main_agent.invoke()
# main_agent.stream()
# main_agent.astream() [选他]
async def run_deep_agent(
    task_query: str,
    session_id: Optional[str] = None,
    run_id: Optional[str] = None,
) -> None:
    """
    定义流式+异步执行主智能体！！
    执行过程中，返回  会话文件化返回  调用子智能体  调用最终结果 （monitor）
    task_query: 前端提问的问题
    session_id: 每个前端会话对应的标识 （1.存储session_id ContextVars 2.session_id 给他创建对应的output输出地址）
    """
    session_id = session_id or str(uuid.uuid4())
    run_id = run_id or str(uuid.uuid4())
    root_entity_id = run_id
    started_at = datetime.now(timezone.utc)
    started_monotonic = time.perf_counter()
    final_output = None
    pending_agents: Dict[str, Dict[str, Any]] = {}

    session_id_token = set_thread_context(session_id)
    run_id_token = set_run_context(run_id)
    entity_id_token = set_current_entity_context(root_entity_id)
    agent_id_token = set_current_agent_context(root_entity_id)
    session_dir_token = None

    async def settle_agent(
        task_call_id: str,
        *,
        output: Any = None,
        error: Any = None,
        cancelled: bool = False,
    ) -> None:
        pending = pending_agents.pop(task_call_id, None)
        if pending is None:
            return

        ended_at = datetime.now(timezone.utc)
        duration_ms = int(
            (time.perf_counter() - pending["started_monotonic"]) * 1_000
        )
        if error is None:
            await monitor.emit_event(
                event=TraceEventType.AGENT_COMPLETED,
                node_type=TraceNodeType.AGENT,
                status=TraceStatus.COMPLETED,
                entity_id=pending["entity_id"],
                parent_id=root_entity_id,
                tool_call_id=task_call_id,
                name=pending["name"],
                message=f"助手执行完成: {pending['name']}",
                started_at=pending["started_at"],
                ended_at=ended_at,
                duration_ms=duration_ms,
                input=pending["input"],
                output=output,
                data={"assistant_name": pending["name"]},
                thread_id=session_id,
                run_id=run_id,
            )
            return

        await monitor.emit_event(
            event=TraceEventType.AGENT_FAILED,
            node_type=TraceNodeType.AGENT,
            status=TraceStatus.CANCELLED if cancelled else TraceStatus.FAILED,
            entity_id=pending["entity_id"],
            parent_id=root_entity_id,
            tool_call_id=task_call_id,
            name=pending["name"],
            message=f"助手执行失败: {pending['name']}",
            started_at=pending["started_at"],
            ended_at=ended_at,
            duration_ms=duration_ms,
            input=pending["input"],
            error=error,
            data={"assistant_name": pending["name"]},
            thread_id=session_id,
            run_id=run_id,
        )

    async def settle_all_agents(
        *,
        output: Any = None,
        error: Any = None,
        cancelled: bool = False,
    ) -> None:
        for task_call_id in list(pending_agents):
            await settle_agent(
                task_call_id,
                output=output,
                error=error,
                cancelled=cancelled,
            )

    print(
        "当前会话的main_agent开始执行了！ "
        f"会话id:{session_id} run_id:{run_id}"
    )
    try:
        await monitor.emit_event(
            event=TraceEventType.RUN_STARTED,
            node_type=TraceNodeType.RUN,
            status=TraceStatus.RUNNING,
            entity_id=root_entity_id,
            name="deep_search",
            message="智能体任务已开始",
            started_at=started_at,
            input={"query": task_query},
            thread_id=session_id,
            run_id=run_id,
        )

        # 准备会话目录、上传文件和智能体工作目录提示词。
        session_dir = project_root_path / "output" / f"session_{session_id}"
        session_dir.mkdir(parents=True, exist_ok=True)
        session_dir_str = str(session_dir).replace("\\", "/")
        relative_session_dir_str = str(
            session_dir.relative_to(project_root_path)
        ).replace("\\", "/")

        updated_dir_path = project_root_path / "updated" / f"session_{session_id}"
        updated_info_prompt = ""
        if updated_dir_path.exists():
            files = [
                file.name
                for file in updated_dir_path.iterdir()
                if file.is_file()
            ]
            if files:
                for filename in files:
                    shutil.copy2(
                        updated_dir_path / filename,
                        session_dir / filename,
                    )
                updated_info_prompt = (
                    "\n    [已上传文件] 已加载到工作目录:\n"
                    + "\n".join([f"    - {filename}" for filename in files])
                    + "\n    请优先使用工具（read_file_content）读取并参考这些文件。"
                )

        session_dir_token = set_session_context(session_dir_str)
        session_created_at = datetime.now(timezone.utc)
        await monitor.emit_event(
            event=TraceEventType.SESSION_CREATED,
            node_type=TraceNodeType.RUN,
            status=TraceStatus.COMPLETED,
            entity_id=root_entity_id,
            message=f"工作目录已创建: {session_dir_str}",
            started_at=session_created_at,
            ended_at=session_created_at,
            duration_ms=0,
            input={},
            output={"path": session_dir_str},
            data={"path": session_dir_str},
            thread_id=session_id,
            run_id=run_id,
        )

        config = {
            "configurable": {
                "thread_id": session_id,
            }
        }
        path_instruction = f"""
    【工作环境指令】
    工作目录: {relative_session_dir_str}
    {updated_info_prompt}

    规则：
    1. 新生成文件必须保存到工作目录：'{relative_session_dir_str}/filename'
    2. 读取已上传的文件时，请直接将文件名（例如：'开篇.txt'）作为 filename 参数传入（read_file_content）读取工具，不要带上任何目录前缀。
    3. 使用相对路径，禁止使用绝对路径
    4. 若存在上传文件，请先分析内容
    """

        async for chunk in main_agent.astream({
            "messages":[
                {
                    "role":"user","content":task_query+path_instruction
                }
            ]
        },config=config):
            # {"model [大模型决定调用工具 子智能体  最终结果] / tools" : {messages:[xxx...]}}
            for node_name,state in chunk.items():
                if not state or "messages" not in state: continue
                messages = state["messages"]
                if messages and isinstance(messages,list):
                    last_msg = messages[-1]
                    if node_name == 'model':
                        if last_msg.tool_calls:
                            # 工具和子智能体
                            for tool_call in last_msg.tool_calls:
                                """
                                  tool_call = {
                                      name: task
                                      args:{
                                          subagent_type:子智能体的名字
                                          description:子智能体的描述
                                      }
                                  }                                
                                """
                                if tool_call['name'] == 'task':
                                    # ``task`` returns a ToolMessage with the same ID.
                                    # Keep that ID to close this agent span when it returns.
                                    task_call_id = str(
                                        tool_call.get("id") or uuid.uuid4()
                                    )
                                    agent_args = tool_call['args']
                                    agent_name = agent_args['subagent_type']
                                    agent_started_at = datetime.now(timezone.utc)
                                    agent_entity_id = str(uuid.uuid4())
                                    pending_agents[task_call_id] = {
                                        "entity_id": agent_entity_id,
                                        "name": agent_name,
                                        "input": agent_args,
                                        "started_at": agent_started_at,
                                        "started_monotonic": time.perf_counter(),
                                    }
                                    await monitor.emit_event(
                                        event=TraceEventType.AGENT_STARTED,
                                        node_type=TraceNodeType.AGENT,
                                        status=TraceStatus.RUNNING,
                                        entity_id=agent_entity_id,
                                        parent_id=root_entity_id,
                                        tool_call_id=task_call_id,
                                        name=agent_name,
                                        message=f"正在调用助手: {agent_name}",
                                        started_at=agent_started_at,
                                        input=agent_args,
                                        metadata={"legacy_event": "assistant_call"},
                                        data={"assistant_name": agent_name},
                                        thread_id=session_id,
                                        run_id=run_id,
                                    )
                        elif last_msg.content:
                            print("主智能体已生成最终结果")
                            final_output = last_msg.content
                    elif node_name == 'tools':
                        for tool_message in messages:
                            task_call_id = getattr(
                                tool_message,
                                "tool_call_id",
                                None,
                            )
                            if isinstance(tool_message, dict):
                                task_call_id = tool_message.get(
                                    "tool_call_id",
                                    task_call_id,
                                )
                            if not task_call_id:
                                continue

                            result = getattr(tool_message, "content", None)
                            status = getattr(tool_message, "status", None)
                            if isinstance(tool_message, dict):
                                result = tool_message.get("content", result)
                                status = tool_message.get("status", status)
                            if status == "error":
                                await settle_agent(
                                    str(task_call_id),
                                    error=result or "子智能体任务失败",
                                )
                            else:
                                await settle_agent(
                                    str(task_call_id),
                                    output=result,
                                )

        await settle_all_agents()

        ended_at = datetime.now(timezone.utc)
        duration_ms = int((time.perf_counter() - started_monotonic) * 1_000)
        await monitor.emit_event(
            event=TraceEventType.RUN_COMPLETED,
            node_type=TraceNodeType.RUN,
            status=TraceStatus.COMPLETED,
            entity_id=root_entity_id,
            name="deep_search",
            message="智能体任务执行完成",
            started_at=started_at,
            ended_at=ended_at,
            duration_ms=duration_ms,
            input={"query": task_query},
            output=final_output,
            data={},
            thread_id=session_id,
            run_id=run_id,
        )
    except asyncio.CancelledError as exc:
        ended_at = datetime.now(timezone.utc)
        try:
            await settle_all_agents(error=exc, cancelled=True)
            await monitor.emit_event(
                event=TraceEventType.RUN_FAILED,
                node_type=TraceNodeType.RUN,
                status=TraceStatus.CANCELLED,
                entity_id=root_entity_id,
                name="deep_search",
                message="智能体任务已取消",
                started_at=started_at,
                ended_at=ended_at,
                duration_ms=int(
                    (time.perf_counter() - started_monotonic) * 1_000
                ),
                input={"query": task_query},
                error=exc,
                thread_id=session_id,
                run_id=run_id,
            )
        except Exception as trace_error:
            print(
                "[Agent] Failed to record cancelled run: "
                f"{type(trace_error).__name__}"
            )
        raise
    except Exception as exc:
        ended_at = datetime.now(timezone.utc)
        try:
            await settle_all_agents(error=exc)
            await monitor.emit_event(
                event=TraceEventType.RUN_FAILED,
                node_type=TraceNodeType.RUN,
                status=TraceStatus.FAILED,
                entity_id=root_entity_id,
                name="deep_search",
                message="执行主智能体时发生异常",
                started_at=started_at,
                ended_at=ended_at,
                duration_ms=int(
                    (time.perf_counter() - started_monotonic) * 1_000
                ),
                input={"query": task_query},
                error=exc,
                thread_id=session_id,
                run_id=run_id,
            )
        except Exception as trace_error:
            print(
                "[Agent] Failed to record failed run: "
                f"{type(trace_error).__name__}"
            )
        # 保留原实现的异常处理语义：记录失败后结束后台任务。
    finally:
        if session_dir_token is not None:
            reset_session_context(session_dir_token)
        reset_current_agent_context(agent_id_token)
        reset_current_entity_context(entity_id_token)
        reset_run_context(run_id_token)
        reset_thread_context(session_id_token)
