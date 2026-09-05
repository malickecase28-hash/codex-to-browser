from __future__ import annotations

import asyncio
import unittest
from typing import Any

from codex_chatgpt_control.dev import AsyncDevAutonomousClient, DevAutonomousClient


class DevIntegrationResumeParityTests(unittest.TestCase):
    def test_sync_resume_integration_uses_dev_dispatch(self) -> None:
        calls: list[tuple[str, dict[str, Any]]] = []

        def request(command: str, payload: dict[str, Any]) -> Any:
            calls.append((command, payload))
            return {"workflowId": "workflow-python-resume", "status": "integration_ready"}

        client = DevAutonomousClient(request)
        result = client.resume_integration("workflow-python-resume")

        self.assertEqual(result["status"], "integration_ready")
        self.assertEqual(
            calls,
            [
                (
                    "dev.dispatch",
                    {
                        "namespace": "autonomous",
                        "action": "resumeIntegration",
                        "args": {"workflowId": "workflow-python-resume"},
                    },
                )
            ],
        )

    def test_async_resume_integration_uses_same_wire_shape(self) -> None:
        calls: list[tuple[str, dict[str, Any]]] = []

        async def request(command: str, payload: dict[str, Any]) -> Any:
            calls.append((command, payload))
            return {"workflowId": "workflow-python-resume", "status": "integration_ready"}

        async def run() -> dict[str, Any]:
            client = AsyncDevAutonomousClient(request)
            return await client.resume_integration("workflow-python-resume")

        result = asyncio.run(run())
        self.assertEqual(result["status"], "integration_ready")
        self.assertEqual(
            calls,
            [
                (
                    "dev.dispatch",
                    {
                        "namespace": "autonomous",
                        "action": "resumeIntegration",
                        "args": {"workflowId": "workflow-python-resume"},
                    },
                )
            ],
        )


if __name__ == "__main__":
    unittest.main()
