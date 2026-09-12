<p align="center">
  <h1 align="center">🤖 Deep Search Pro</h1>
  <p align="center"><b>A lightweight multi-agent collaboration system -- a hands-on AI agent learning project</b></p>
  <p align="center"><a href="README.md">Chinese README</a></p>
  <p align="center">
    <img src="https://img.shields.io/badge/Python-3.10+-blue.svg" alt="Python">
    <img src="https://img.shields.io/badge/FastAPI-0.129.2-green.svg" alt="FastAPI">
    <img src="https://img.shields.io/badge/LangChain-1.2.10-orange.svg" alt="LangChain">
    <img src="https://img.shields.io/badge/deepagents-0.4.3-purple.svg" alt="deepagents">
    <img src="https://img.shields.io/badge/Learning-project-brightgreen.svg" alt="learning project">
  </p>
</p>

---

## 🎯 What Is This Project?

Deep Search Pro is a hands-on AI agent project built for learning. With as
little engineering noise as possible, it demonstrates how to build a
**multi-agent collaboration system** with LangChain and DeepAgents: a main
agent acts like a team lead and coordinates three specialist agents for web
search, database queries, and knowledge-base retrieval.

The project also includes a ready-to-use web console:

- `/`: a light chat workspace with file attachments, session history, Markdown
  answers, and generated-file downloads.
- `/trace`: a run-tracing and diagnostics page with a topology view, role
  status, call records, final reports, raw data, and a node-details drawer.
- Run-level tracing: every task has its own `run_id`, and its event stream can
  be recovered through HTTP or WebSocket.

**This project is a good fit if you are 👇**

- Learning LangChain or LangGraph and looking for a complete project that runs.
- Interested in multi-agent orchestration without starting from a complex
  AutoGPT or CrewAI codebase.
- Trying to understand how **FastAPI + WebSocket + agents + a browser console**
  combine into a real application.
- Preparing an AI-agent project for a portfolio or interview and want to be
  able to explain its design decisions.

---

## 🧠 What You Can Learn From This Project

| Topic | Where It Appears |
| --- | --- |
| **Orchestrator multi-agent pattern** | `agent/main_agent.py` -- how the main agent coordinates three specialists. |
| **Prompt engineering in practice** | `prompt/prompts.yml` -- how system prompts guide agent behavior. |
| **LangChain `@tool` functions** | `tools/` -- complete examples of callable agent tools. |
| **FastAPI async background tasks** | `api/server.py` -- non-blocking execution with `asyncio.create_task`. |
| **WebSocket live delivery** | `api/monitor.py` -- real-time run-event delivery to the browser. |
| **Run-level trace protocol** | `api/trace_router.py` and `api/trace_store.py` -- querying, replay, pagination, and recovery. |
| **Coroutine-local context with ContextVar** | `api/context.py` -- isolates concurrent task state. |
| **Frontend state and session recovery** | `web/session.js` and `web/run-client.js` -- local sessions, reconnecting, and deduplication. |
| **Chat interaction details** | `web/chat-interactions.js` -- Enter to send, IME protection, and scroll behavior. |
| **Trace visualization** | `web/visualizer.js` -- nodes, edges, zooming, and status emphasis. |
| **Safe agent file paths** | `utils/path_utils.py` -- guards against unsafe path handling. |
| **RAG knowledge-base integration** | `tools/ragflow_tools.py` -- RAGFlow SDK usage. |
| **Natural-language database queries** | `tools/db_tools.py` -- tables, previews, and SQL execution. |

---

## ✨ Included Features

### Agent capabilities

- The main agent decides which information sources are relevant to a task.
- Network Search specialist uses Tavily for public web research.
- Database Query specialist inspects MySQL tables, previews data, and executes
  SQL queries.
- Knowledge Base specialist uses RAGFlow chat assistants to retrieve internal
  knowledge.
- Markdown report generation and Markdown-to-PDF conversion tools.
- Uploaded-file reading so a task can use user-provided reference material.

### Web chat workspace

- Minimal light interface with a sidebar, session list, top status area, and
  bottom composer.
- Multiple files can be uploaded before a task is submitted under the same
  `thread_id`.
- Press `Enter` to send and `Shift+Enter` for a newline.
- IME composition protection, including WebKit `keyCode=229` compatibility.
- Submission and upload controls are disabled while a task is running.
- The view follows new output unless the user is reading earlier content.
- A button appears when new content is available below the current scroll
  position.
- Markdown answers support tables, code blocks, links, and generated-file
  downloads.
- Recent sessions are stored locally and can be searched or switched.
- Expired in-memory traces are handled gracefully instead of repeatedly showing
  stale-run errors.

### Trace run diagnostics

- Dedicated `/trace` page for the full lifecycle of one agent run.
- Submit a query, upload files, and run a new investigation from the page.
- Six run metrics: duration, call records, active roles, tool calls, generated
  files, and connection state.
- Five role summaries: Main Agent, Network Search, Database Query, Knowledge
  Base, and Report / Files.
- Eight topology nodes and eleven curved edges, with emphasized active states.
- Zoom, fit-to-window, node selection, and status highlighting.
- Inspector drawer for an event or node overview, input, output, raw event, and
  error details.
- Four record tabs: call records, final report, generated files, and raw data.
- Search and status filters for call records.
- WebSocket replay using `after_sequence`, with frontend deduplication by
  `event_id`.

---

## 🏗️ Architecture Overview

The core execution path is deliberately direct, making the project easy to
read module by module:

```text
User request
  ├── Browser chat page /
  └── Trace diagnostics page /trace
        │
        ▼
api/server.py
  ├── POST /api/upload       Upload reference files
  ├── POST /api/task         Start a task; return thread_id + run_id
  ├── GET /api/threads/...   List runs for a thread
  ├── GET /api/runs/...      Read trace events for a run
  └── WS /ws/{thread_id}     Stream live run events
        │
        ▼
agent/main_agent.py
  ├── Specialist 1: Network Search    tools/tavily_tool.py
  ├── Specialist 2: Database Query    tools/db_tools.py
  ├── Specialist 3: RAGFlow Knowledge tools/ragflow_tools.py
  └── Main-agent tools: Markdown / PDF / uploaded-file reader
        │
        ▼
api/monitor.py + api/trace_store.py
  └── Store events, broadcast WebSocket messages, support replay and recovery
```

### Data flow

1. A user submits a natural-language request from the chat or trace page.
2. The frontend uploads any attachments, then calls `POST /api/task`.
3. The backend creates a unique `run_id` and reserves an in-memory trace record.
4. The main agent analyzes the request and chooses specialist agents as needed.
5. Specialists search the web, query MySQL, retrieve RAGFlow knowledge, or read
   uploaded files.
6. The main agent combines the results, returns a response, and can generate a
   Markdown or PDF file when requested.
7. Lifecycle events are stored in memory and pushed to the browser by WebSocket.
8. After a refresh or reconnect, the frontend recovers missing events with
   `run_id + after_sequence`.

---

## 🚀 Get Running in 5 Minutes

### Requirements

- Python 3.10 or later.
- An OpenAI-compatible LLM API key. Alibaba Cloud DashScope, DeepSeek, and
  OpenAI-compatible endpoints can be used.
- A Tavily API key for the default web-research workflow. Register for its free
  tier at [Tavily](https://tavily.com).

> 📌 MySQL and RAGFlow are optional. They only affect the corresponding
> specialist agents, while the rest of the application can still run.

### Step 1: Clone and install dependencies

```bash
git clone <your-fork-or-repository-url>
cd deep-search-pro
python -m pip install -r requirements.txt
```

Optional but recommended: install dependencies in a virtual environment.

```bash
python -m venv .venv
```

```bash
# macOS or Linux
source .venv/bin/activate
```

```powershell
# Windows PowerShell
.\.venv\Scripts\Activate.ps1
```

### Step 2: Configure environment variables

```bash
# macOS or Linux
cp .env.example .env
```

```powershell
# Windows PowerShell
Copy-Item .env.example .env
```

Edit `.env`. At minimum, set the following values:

```dotenv
# Required: OpenAI-compatible LLM service
OPENAI_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
OPENAI_API_KEY=sk-xxxxxxxxxxxxxxxx

# The current agent/llm.py reads this exact variable name.
LLM_QWEN3.8=qwen-max

# Required for the default network-search specialist
TAVILY_API_KEY=tvly-xxxxxxxxxxxxxxxx

# Optional: configure only when those sources are available
# RAGFLOW_API_URL=http://127.0.0.1:9380
# RAGFLOW_API_KEY=your-ragflow-api-key
# MYSQL_HOST=127.0.0.1
# MYSQL_USER=your-db-user
# MYSQL_PASSWORD=your-db-password
# MYSQL_DATABASE=your-database-name
```

> ⚠️ The current `agent/llm.py` reads `LLM_QWEN3.8`, while the checked-in
> `.env.example` still contains older `LLM_QWEN*` placeholders. Add the exact
> key above to `.env`, or change both files together if you want a different
> configuration name.

### Step 3: Start the application

```bash
python api/server.py
```

By default, visit:

- `http://localhost:8000/`: Deep Search chat workspace.
- `http://localhost:8000/trace`: run tracing and diagnostics.
- `http://localhost:8000/docs`: Swagger API documentation.

To use a different local port, for example `8002`:

```bash
uvicorn api.server:app --host 127.0.0.1 --port 8002
```

Then visit `http://127.0.0.1:8002/` and
`http://127.0.0.1:8002/trace`.

### Step 4: Try a task

```bash
curl -X POST http://localhost:8000/api/task \
  -H "Content-Type: application/json" \
  -d '{"query":"Summarize the latest developments in AI agents"}'
```

The response contains a `thread_id` and `run_id`:

```json
{
  "status": "started",
  "thread_id": "conversation-id",
  "run_id": "unique-run-id"
}
```

Open `/trace?thread_id=conversation-id&run_id=unique-run-id` in the browser to
see the live run trace.

### Optional integrations

#### MySQL

The Database Query specialist requires these variables:

```dotenv
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=deep_search_user
MYSQL_PASSWORD=replace-with-a-secret
MYSQL_DATABASE=deep_search
MYSQL_CHARSET=utf8mb4
MYSQL_COLLATION=utf8mb4_unicode_ci
```

It can list tables, preview the first 100 rows of a table, and run custom SQL
queries. Use a dedicated, least-privileged, read-only account. Do not connect
this tool to a privileged production database account.

`database/init_demo_data.sql` creates a deterministic demo dataset:

- `warehouses`: 5 rows.
- `products`: 4 rows.
- `inventory`: 20 rows.
- `sales_records`: 200 rows.

The helper below imports it into a running Docker MySQL container named
`deep-search-mysql` by default. It reads MySQL credentials from `.env`.

```powershell
.\database\run_init_demo_data.ps1
```

#### RAGFlow

The Knowledge Base specialist requires:

```dotenv
RAGFLOW_API_URL=http://127.0.0.1:9380
RAGFLOW_API_KEY=your-ragflow-api-key
```

It first lists the RAGFlow chat assistants, then creates a temporary assistant
session to ask a selected assistant. Datasets, assistants, and credentials are
managed by your RAGFlow deployment; this repository does not create them.

#### Trace storage limits

The trace store is in memory and can be configured with:

```dotenv
TRACE_MAX_EVENTS_PER_RUN=5000
TRACE_MAX_RUNS=100
```

> ⚠️ PDF conversion is Windows-specific in the current implementation. It uses
> Microsoft Word through `pywin32`, so Microsoft Word must be installed when
> the PDF tool is used.

---

## 📖 Suggested Reading Order

If this is your first AI-agent project, read the code in this order:

| Order | File | What to Focus On |
| --- | --- | --- |
| 1️⃣ | `agent/llm.py` | How an OpenAI-compatible model is initialized. |
| 2️⃣ | `prompt/prompts.yml` | System prompts and agent constraints. |
| 3️⃣ | `agent/subagents/network_search_agent.py` | The smallest specialist-agent definition. |
| 4️⃣ | `tools/tavily_tool.py` | A complete `@tool` implementation and its tracing hook. |
| 5️⃣ | `agent/main_agent.py` | **Core**: main-agent creation, orchestration, and async streaming. |
| 6️⃣ | `api/server.py` | FastAPI integration and background task startup. |
| 7️⃣ | `api/monitor.py` | WebSocket delivery and lifecycle-event emission. |
| 8️⃣ | `api/trace_store.py` | Run-level trace storage, pagination, and eviction. |
| 9️⃣ | `api/context.py` | Why `ContextVar` is safer than a global variable for async work. |
| 🔟 | `web/run-client.js` | Upload, task startup, trace recovery, reconnecting, and deduplication. |
| 1️⃣1️⃣ | `web/chat.js` and `web/app.js` | How the chat and trace pages consume the same run state. |
| 1️⃣2️⃣ | `utils/path_utils.py` | File-path safety boundaries for agent tools. |

---

## 📁 Project Files at a Glance

```text
deep-search-pro/
│
├── agent/                          # 🤖 Agent layer (core)
│   ├── llm.py                      # Model initialization
│   ├── prompts.py                  # YAML prompt loader
│   ├── main_agent.py               # ★ Main agent and async execution engine
│   └── subagents/                  # Specialist-agent definitions
│       ├── network_search_agent.py
│       ├── database_query_agent.py
│       └── knowledge_base_agent.py
│
├── api/                            # 🌐 Web/API layer
│   ├── server.py                   # FastAPI entry point, uploads, tasks, WebSocket
│   ├── context.py                  # ContextVar isolation for async runs
│   ├── monitor.py                  # Trace emission and WebSocket manager
│   ├── trace_models.py             # Trace events, statuses, and response models
│   ├── trace_router.py             # Trace HTTP endpoints
│   ├── trace_serializer.py         # Trace payload normalization
│   └── trace_store.py              # Process-local run-level trace storage
│
├── web/                            # 🖥 Native frontend, no build step
│   ├── index.html                  # Chat page
│   ├── trace.html                  # Trace diagnostics page
│   ├── styles.css                  # Shared light visual system
│   ├── trace.css                   # Trace page styles
│   ├── api.js                      # HTTP and WebSocket API helpers
│   ├── run-client.js               # Upload, startup, recovery, and reconnect lifecycle
│   ├── session.js                  # Local sessions and URL construction
│   ├── state.js                    # Frontend run state and role derivation
│   ├── chat.js                     # Chat-page rendering and interaction
│   ├── chat-interactions.js        # Input, scroll, and render-batching logic
│   ├── visualizer.js               # Trace topology nodes and edges
│   └── markdown.js                 # Safe Markdown rendering
│
├── tools/                          # 🔧 Agent tools (`@tool`)
│   ├── tavily_tool.py              # Network search
│   ├── db_tools.py                 # MySQL tools
│   ├── ragflow_tools.py            # RAGFlow retrieval
│   ├── markdown_tools.py           # Markdown generation
│   ├── pdf_tools.py                # Markdown to PDF
│   └── upload_file_read_tool.py    # Uploaded-file reader
│
├── tests/                          # 🧪 Python and Node frontend tests
│   ├── test_trace_*.py             # Trace API, store, and monitor tests
│   ├── test_web_frontend.py        # Web-page and static-asset contract tests
│   └── frontend_*.test.mjs         # Native ES-module frontend tests
│
├── utils/                          # 🛠 Shared helpers
│   ├── path_utils.py               # Safe path resolution
│   └── word_converter.py           # Microsoft Word COM PDF converter
│
├── database/                       # 🗄 MySQL demo data and import helper
├── rawflow/                        # 📚 RAGFlow SDK examples
├── prompt/prompts.yml              # Prompt configuration
├── requirements.txt                # Pinned dependencies
└── .env.example                    # Environment-variable template
```

---

## 📡 Trace API

`POST /api/task` creates a distinct `run_id` for every call:

```json
{
  "status": "started",
  "thread_id": "conversation-id",
  "run_id": "unique-run-id"
}
```

`thread_id` identifies a reusable conversation, while `run_id` identifies one
execution inside that conversation. Even when you reuse `thread_id`, every new
request gets a new `run_id`.

Historical queries:

```text
GET /api/runs/{run_id}/trace?after_sequence=12&limit=100
GET /api/threads/{thread_id}/runs
```

`after_sequence` is exclusive: it returns only events with a larger sequence
number. A WebSocket connection uses the same recovery semantics:

```text
ws://localhost:8000/ws/{thread_id}?run_id={run_id}&after_sequence=12
```

Trace events include `event_id`, `sequence`, `thread_id`, `run_id`, `event`,
`node_type`, `status`, `input`, `output`, and `error`. The frontend
deduplicates events by `event_id` and uses `sequence` as its recovery cursor.

Additional file endpoints:

```text
GET /api/files?path=<absolute-output-directory>
GET /api/download?path=<absolute-output-file>
```

Both endpoints allow paths only inside the project `output/` directory.

Important limitations:

- The trace store is process-local and in memory. Restarting the server clears
  trace data, and multiple workers or instances do not share it.
- The browser stores `thread_id` locally but cannot guarantee that an expired
  `run_id` is still available after a server restart or eviction.
- Compatibility fields `type="monitor_event"` and `data` remain in the 1.x
  trace schema. New integrations should consume the typed fields.

---

## 🧪 Testing

Python tests:

```bash
python -m pytest -q
```

Frontend ES-module tests:

```bash
node --test tests/frontend_*.test.mjs
```

Useful focused tests:

```bash
python -m pytest tests/test_web_frontend.py tests/test_trace_api.py -q
node --test tests/frontend_session.test.mjs tests/frontend_chat_interactions.test.mjs
```

If globally installed pytest plugins cause unrelated dependency errors, disable
automatic plugin discovery temporarily:

```bash
PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python -m pytest -q
```

Windows PowerShell:

```powershell
$env:PYTEST_DISABLE_PLUGIN_AUTOLOAD = "1"
python -m pytest -q
```

---

## 🧪 Practice Ideas: Ways to Extend It

The project intentionally stays compact, leaving room to explore. Here are
some possible improvements, from easier to more advanced:

### Beginner level

- [ ] **Switch the model**: use DeepSeek, OpenAI, or another compatible model
  by changing the model identifier in `.env`.
- [ ] **Add a specialist agent**: for example, a weather agent or a code
  execution agent.
- [ ] **Change the system prompt**: adapt the product-company scenario to your
  own domain and observe the behavior change.
- [ ] **Add a trace event type**: follow one event from the backend model to a
  frontend tab.

### Intermediate level

- [ ] **Replace `InMemorySaver` with `SqliteSaver`** so agent conversation
  history survives a restart.
- [ ] **Persist the trace store** in SQLite, PostgreSQL, or Redis.
- [ ] **Export a run trace** as a JSON or Markdown debugging report.
- [ ] **Add reflection to specialist agents** so they validate their work.
- [ ] **Add JWT authentication** to `/api/task`, `/api/upload`, and `/trace`.

### Challenge level

- [ ] **Replace Word COM with a cross-platform converter** so PDF generation
  can run on Linux.
- [ ] **Use a LangGraph checkpointer for human approval nodes** before sensitive
  operations.
- [ ] **Let specialist agents exchange information** instead of reporting only
  to the main agent.
- [ ] **Containerize the application** with a Dockerfile and Compose setup.
- [ ] **Make it multi-user** by externalizing in-memory state, uploads,
  WebSocket delivery, and trace storage.

---

## 🔧 Technology Stack

| Layer | Technology | Purpose |
| --- | --- | --- |
| Agent framework | **DeepAgents** | Multi-agent orchestration. |
| LLM integration | LangChain + OpenAI-compatible API | One integration path for multiple model providers. |
| Web framework | FastAPI + Uvicorn | Async HTTP endpoints and native WebSocket support. |
| Frontend | HTML, CSS, and native ES modules | No build step; easy to read and debug. |
| Trace | Process-local run-level event store | Pagination, recovery cursor, and frontend deduplication. |
| Search | Tavily API | Web research for agents. |
| Knowledge base | RAGFlow | Self-hostable RAG service. |
| Database | MySQL | Product, inventory, and sales data queries. |
| Document generation | Markdown + pywin32 | Markdown generation and Word COM PDF conversion. |
| Testing | pytest + Node test runner | Python backend and frontend pure-function tests. |

---

## ❓ FAQ

### Q: Why use DeepAgents instead of writing the orchestration manually?

**A:** A custom orchestrator must handle state, tool-call routing, streaming,
and error recovery. DeepAgents provides those building blocks so this project
can focus on agent definitions, tools, trace events, and the application
workflow. It is a useful starting point before reading framework internals.

### Q: Can the project run without RAGFlow and MySQL?

**A:** Yes. The default LLM and Tavily workflow can still be used, while RAGFlow
and MySQL only power their respective specialist agents. Configure an
integration before asking the agent to use it.

### Q: Why use `ContextVar` instead of global variables?

**A:** FastAPI handles concurrent requests as coroutines, often on the same
thread. Global state can leak one user's run context into another user's run.
`ContextVar` provides coroutine-local state so session, thread, run, and
working-directory values remain scoped to the active request chain.

### Q: Why do traces disappear?

**A:** The current trace store lives only in process memory. It is useful for
learning, debugging, and a single-machine demo, but data disappears after a
restart and can be evicted when its configured limits are reached. Use SQLite,
PostgreSQL, or Redis for persistent production traces.

### Q: Why does the frontend not use React or Vue?

**A:** The project focuses on agents, the trace protocol, and async execution.
Native HTML, CSS, and ES modules have no build step, make the data flow easy to
inspect, and allow pure frontend logic to be tested directly with Node.

### Q: Is this safe to expose directly to the public internet?

**A:** No. The current application allows permissive CORS and has no
authentication or authorization layer. Keep it on a trusted network or put it
behind an authenticated reverse proxy. Use least-privileged database accounts
and never place secrets in source control.

### Q: Why is the project intentionally lightweight?

**A:** It is designed as a learning project, not a complete production platform.
Each module has a focused responsibility, keeping the core multi-agent concepts
small enough to understand and modify.

---

## 📄 License

MIT License. You may use, modify, and fork the project under the terms in
[LICENSE](LICENSE).
