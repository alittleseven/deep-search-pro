import threading
from pathlib import Path

from fastapi.testclient import TestClient

from api import server


PROJECT_ROOT = Path(__file__).resolve().parents[1]
WEB_ROOT = PROJECT_ROOT / "web"


def test_web_console_static_assets_and_swagger_remain_available() -> None:
    with TestClient(server.app) as client:
        root = client.get("/")
        css = client.get("/static/styles.css")
        javascript = client.get("/static/app.js")
        docs = client.get("/docs")

    assert root.status_code == 200
    assert "Deep Search Pro Console" in root.text
    assert 'type="module"' in root.text
    assert css.status_code == 200
    assert "text/css" in css.headers["content-type"]
    assert javascript.status_code == 200
    assert "javascript" in javascript.headers["content-type"]
    assert docs.status_code == 200
    assert "Swagger UI" in docs.text


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
