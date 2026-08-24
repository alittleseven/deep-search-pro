import re
import threading
from pathlib import Path

from fastapi.testclient import TestClient

from api import server


PROJECT_ROOT = Path(__file__).resolve().parents[1]
WEB_ROOT = PROJECT_ROOT / "web"


def test_chat_and_trace_pages_and_static_assets_are_available() -> None:
    with TestClient(server.app) as client:
        chat = client.get("/")
        trace = client.get("/trace")
        assets = {
            path: client.get(path)
            for path in (
                "/static/styles.css",
                "/static/trace.css",
                "/static/chat.js",
                "/static/chat-interactions.js",
                "/static/app.js",
                "/static/session.js",
                "/static/markdown.js",
                "/static/run-client.js",
            )
        }
        docs = client.get("/docs")

    assert chat.status_code == 200
    assert "Deep Search" in chat.text
    assert 'href="/static/styles.css?v=' in chat.text
    assert 'src="/static/chat.js?v=' in chat.text
    assert trace.status_code == 200
    assert "运行详情" in trace.text
    assert 'href="/static/styles.css?v=' in trace.text
    assert 'href="/static/trace.css?v=' in trace.text
    assert 'src="/static/app.js?v=' in trace.text
    assert all(response.status_code == 200 for response in assets.values())
    assert "text/css" in assets["/static/styles.css"].headers["content-type"]
    assert "text/css" in assets["/static/trace.css"].headers["content-type"]
    assert all(
        "javascript" in response.headers["content-type"]
        for path, response in assets.items()
        if path.endswith(".js")
    )
    assert docs.status_code == 200
    assert "Swagger UI" in docs.text


def test_web_console_favicon_is_available() -> None:
    with TestClient(server.app) as client:
        favicon = client.get("/favicon.ico")

    assert favicon.status_code == 200
    assert "image/" in favicon.headers["content-type"]


def test_frontend_uses_no_external_runtime_or_html_injection_sink() -> None:
    sources = "\n".join(
        path.read_text(encoding="utf-8")
        for path in WEB_ROOT.glob("*")
        if path.suffix in {".html", ".js"}
    )

    assert "https://" not in (WEB_ROOT / "index.html").read_text(encoding="utf-8")
    assert ".innerHTML" not in sources
    assert "outerHTML" not in sources
    assert "insertAdjacentHTML" not in sources
    assert "document.write" not in sources
    assert "eval(" not in sources
    assert "javascript:" not in sources
    assert "textContent" in sources

    markdown = (WEB_ROOT / "markdown.js").read_text(encoding="utf-8")
    run_client = (WEB_ROOT / "run-client.js").read_text(encoding="utf-8")
    assert "export function renderMarkdown" in markdown
    assert "export function stringifyValue" in markdown
    assert "export class RunClient" in run_client
    assert "await uploadFiles" in run_client
    assert "await startTask" in run_client
    assert run_client.index("await uploadFiles") < run_client.index("await startTask")


def test_frontend_static_module_imports_are_cache_busted() -> None:
    for name in ("app.js", "chat.js", "run-client.js"):
        source = (WEB_ROOT / name).read_text(encoding="utf-8")
        imports = [line for line in source.splitlines() if 'from "./' in line]
        assert imports
        assert all(".js?v=" in line for line in imports)


def test_chat_page_exposes_complete_question_workflow() -> None:
    html = (WEB_ROOT / "index.html").read_text(encoding="utf-8")
    script = (WEB_ROOT / "chat.js").read_text(encoding="utf-8")

    for element_id in (
        "session-list",
        "new-session",
        "session-search",
        "messages",
        "scroll-to-latest",
        "empty-state",
        "task-input",
        "file-input",
        "queued-files",
        "send-button",
        "trace-link",
        "connection-label",
        "notice",
    ):
        assert f'id="{element_id}"' in html

    for symbol in (
        "RunClient",
        "SessionRepository",
        "renderMarkdown",
        "downloadUrl",
        "traceUrl",
        "shouldSubmitOnEnter",
        "isNearBottom",
        "aria-busy",
    ):
        assert symbol in script


def test_trace_page_preserves_diagnostics_in_vertical_layout() -> None:
    html = (WEB_ROOT / "trace.html").read_text(encoding="utf-8")
    css = (WEB_ROOT / "trace.css").read_text(encoding="utf-8")

    for element_id in (
        "run-title",
        "chat-link",
        "task-input",
        "run-button",
        "role-summary",
        "execution-graph",
        "graph-edges",
        "graph-empty",
        "inspector-drawer",
        "inspector-body",
        "records-collapse",
        "events-list",
        "final-report",
        "files-list",
        "raw-events",
    ):
        assert f'id="{element_id}"' in html

    assert "overflow-y: auto" in css
    assert 'data-bottom-tab="events"' in html
    assert 'data-bottom-tab="report"' in html
    assert 'data-bottom-tab="files"' in html
    assert 'data-bottom-tab="raw"' in html


def test_frontend_has_accessible_controls_and_responsive_guards() -> None:
    pages = "\n".join(
        (WEB_ROOT / name).read_text(encoding="utf-8")
        for name in ("index.html", "trace.html")
    )
    styles = "\n".join(
        (WEB_ROOT / name).read_text(encoding="utf-8")
        for name in ("styles.css", "trace.css")
    )

    assert 'aria-live="polite"' in pages
    assert 'aria-label="关闭节点详情"' in pages
    assert 'role="dialog"' in pages
    assert 'aria-modal="true"' in pages
    assert ":focus-visible" in styles
    assert "prefers-reduced-motion" in styles
    assert "@media (max-width: 900px)" in styles
    assert "font-size: 8px" not in styles
    assert "font-size: 9px" not in styles
    assert "font-size: 10px" not in styles
    assert not re.search(
        r"\.trace-topbar\s+\.trace-button\s*\{[^}]*display:\s*none",
        styles,
        re.DOTALL,
    )

    trace_script = (WEB_ROOT / "app.js").read_text(encoding="utf-8")
    assert "chatUrl" in trace_script
    assert "restoredQuery" in trace_script
    assert 'elements["close-inspector"].focus()' in trace_script


def test_upload_completes_before_task_submission(monkeypatch, tmp_path) -> None:
    executed = threading.Event()
    observation = {}
    thread_id = "web-upload-order"

    async def inspect_uploaded_file(query: str, received_thread: str, run_id: str) -> None:
        uploaded = tmp_path / f"session_{received_thread}" / "reference.txt"
        observation.update({
            "query": query,
            "thread_id": received_thread,
            "run_id": run_id,
            "exists": uploaded.exists(),
            "content": uploaded.read_text(encoding="utf-8") if uploaded.exists() else None,
        })
        executed.set()

    monkeypatch.setattr(server, "updated_dir", tmp_path)
    monkeypatch.setattr(server, "execute_deep_agent", inspect_uploaded_file)

    with TestClient(server.app) as client:
        uploaded = client.post(
            "/api/upload",
            data={"thread_id": thread_id},
            files={"files": ("reference.txt", b"grounded source", "text/plain")},
        )
        started = client.post(
            "/api/task",
            json={"query": "Use the attached source", "thread_id": thread_id},
        )
        assert executed.wait(timeout=2)

    assert uploaded.status_code == 200
    assert uploaded.json() == {
        "status": "uploaded",
        "files": ["reference.txt"],
    }
    assert started.status_code == 200
    assert started.json()["thread_id"] == thread_id
    assert observation == {
        "query": "Use the attached source",
        "thread_id": thread_id,
        "run_id": started.json()["run_id"],
        "exists": True,
        "content": "grounded source",
    }
