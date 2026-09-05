from __future__ import annotations

import unittest
from typing import Any

from codex_chatgpt_control import AsyncChatGPT, ChatGPT
from codex_chatgpt_control.dev import AsyncDevClient, DevClient


_OK_RESULT = {
    "ok": True,
    "status": "ok",
    "data": [],
    "warnings": [],
    "context": {"timestamp": "2026-09-05T00:00:00.000Z"},
}


class RecordingBackend:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def request(self, command: str, payload: dict[str, Any] | None = None) -> Any:
        body = payload or {}
        self.calls.append((command, body))
        namespace = body.get("namespace")
        action = body.get("action")
        if namespace == "autonomous" and action == "get":
            return {"workflowId": "workflow-one", "status": "running"}
        return dict(_OK_RESULT)


class AsyncRecordingBackend:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []

    async def request(self, command: str, payload: dict[str, Any] | None = None) -> Any:
        body = payload or {}
        self.calls.append((command, body))
        namespace = body.get("namespace")
        action = body.get("action")
        if namespace == "autonomous" and action == "get":
            return {"workflowId": "workflow-one", "status": "running"}
        return dict(_OK_RESULT)


class DevClientTests(unittest.TestCase):
    def test_sync_facade_uses_single_bounded_dev_dispatch_command(self) -> None:
        backend = RecordingBackend()
        dev = DevClient(backend)

        result = dev.projects.list(filters={"name": "Compiler"})

        self.assertTrue(result.ok)
        self.assertEqual(
            backend.calls,
            [("dev.dispatch", {
                "namespace": "projects",
                "action": "list",
                "args": {"filters": {"name": "Compiler"}},
            })],
        )

    def test_sync_delete_serializes_confirmation_explicitly(self) -> None:
        backend = RecordingBackend()
        dev = DevClient(backend)

        dev.projects.delete("g-p-one", idempotency_key="delete-one")
        dev.projects.delete("g-p-one", idempotency_key="delete-two", confirm_mutation=True)

        self.assertEqual(
            backend.calls[0][1]["args"]["options"],
            {"idempotencyKey": "delete-one", "confirmMutation": False},
        )
        self.assertEqual(
            backend.calls[1][1]["args"]["options"],
            {"idempotencyKey": "delete-two", "confirmMutation": True},
        )

    def test_sync_autonomous_bootstrap_uses_dev_dispatch(self) -> None:
        backend = RecordingBackend()
        dev = DevClient(backend)
        spec = {
            "workflowId": "workflow-one",
            "projectKey": "g-p-project1",
            "plannerConversationKey": "planner-main",
            "objective": "Plan the work.",
        }

        dev.autonomous.bootstrap(spec, options={"timeoutMs": 5000})

        self.assertEqual(
            backend.calls[-1],
            ("dev.dispatch", {
                "namespace": "autonomous",
                "action": "bootstrap",
                "args": {"spec": spec, "options": {"timeoutMs": 5000}},
            }),
        )

    def test_public_sync_chatgpt_exposes_dev_namespace(self) -> None:
        backend = RecordingBackend()
        chatgpt = ChatGPT(backend=backend)

        workflow = chatgpt.dev.autonomous.get("workflow-one")

        self.assertEqual(workflow["workflowId"], "workflow-one")
        self.assertEqual(backend.calls[0][0], "dev.dispatch")


class AsyncDevClientTests(unittest.IsolatedAsyncioTestCase):
    async def test_async_facade_matches_sync_wire_shape(self) -> None:
        backend = AsyncRecordingBackend()

        async def request(command: str, payload: dict[str, Any]) -> Any:
            return await backend.request(command, payload)

        dev = AsyncDevClient(request)
        result = await dev.planner.set_enabled("task-one", True, idempotency_key="enable-one")

        self.assertTrue(result.ok)
        self.assertEqual(
            backend.calls,
            [("dev.dispatch", {
                "namespace": "planner",
                "action": "setEnabled",
                "args": {
                    "ref": "task-one",
                    "enabled": True,
                    "options": {"idempotencyKey": "enable-one"},
                },
            })],
        )

    async def test_public_async_chatgpt_exposes_dev_namespace(self) -> None:
        backend = AsyncRecordingBackend()
        chatgpt = AsyncChatGPT(backend)
        try:
            workflow = await chatgpt.dev.autonomous.get("workflow-one")
            self.assertEqual(workflow["workflowId"], "workflow-one")
            self.assertEqual(backend.calls[0][0], "dev.dispatch")
        finally:
            await chatgpt.aclose()


if __name__ == "__main__":
    unittest.main()
