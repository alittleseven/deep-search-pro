from ragflow_sdk import RAGFlow


class _PaginatedChatsResponse:
    def json(self):
        return {
            "code": 0,
            "data": {
                "chats": [{"id": "chat-1", "name": "Knowledge Assistant"}],
                "total": 1,
            },
            "message": "success",
        }


def test_list_chats_supports_paginated_ragflow_response(monkeypatch):
    client = RAGFlow(api_key="test-key", base_url="http://ragflow.example")
    monkeypatch.setattr(client, "get", lambda *args, **kwargs: _PaginatedChatsResponse())

    chats = client.list_chats()

    assert len(chats) == 1
    assert chats[0].id == "chat-1"
