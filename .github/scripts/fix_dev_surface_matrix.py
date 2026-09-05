from __future__ import annotations

import json
from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected one dev surface patch site in {path}, found {count}")
    file.write_text(text.replace(old, new, 1), encoding="utf-8")


# dev.dispatch is a public bounded backend command. Give it a descriptor rather
# than exempting it from surface-drift checks. Risk defaults to high because
# the envelope can route destructive actions that independently require their
# own explicit confirmation flags.
replace_once(
    "packages/node/src/commands/registry.ts",
    '  primitive("tools.select", "Select a visible ChatGPT tool when unambiguous.", 30000)\n];',
    '  primitive("tools.select", "Select a visible ChatGPT tool when unambiguous.", 30000),\n'
    '  primitive("dev.dispatch", "Dispatch one bounded development-orchestrator namespace/action through the authoritative Node backend while preserving confirmation and visible-browser safety contracts.", 120000)\n'
    '];',
)
replace_once(
    "packages/node/src/commands/registry.ts",
    'function primitiveArgs(name: string): Record<string, string> {\n',
    'function primitiveArgs(name: string): Record<string, string> {\n'
    '  if (name === "dev.dispatch") return {\n'
    '    namespace: "projects, planner, worker, or autonomous",\n'
    '    action: "allowlisted action inside the selected namespace",\n'
    '    args: "bounded JSON arguments for that action; destructive actions retain explicit confirmation fields"\n'
    '  };\n',
)
replace_once(
    "packages/node/src/commands/registry.ts",
    'function primitiveExamples(name: string): string[] {\n',
    'function primitiveExamples(name: string): string[] {\n'
    '  if (name === "dev.dispatch") {\n'
    '    return [`await backend.request("dev.dispatch", { namespace: "autonomous", action: "get", args: { workflowId: "workflow-1" } });`];\n'
    '  }\n',
)

# Make the Python facade's backend command discoverable by the static parity
# scanner and use the same marker for sync/async routing.
replace_once(
    "packages/python/src/codex_chatgpt_control/dev.py",
    'AsyncRequester = Callable[[str, dict[str, Any]], Awaitable[Any]]\n\n\n',
    'AsyncRequester = Callable[[str, dict[str, Any]], Awaitable[Any]]\n\n'
    'DEV_BACKEND_COMMANDS = {"dispatch": "dev.dispatch"}\n\n\n',
)
replace_once(
    "packages/python/src/codex_chatgpt_control/dev.py",
    '        return _command_result(self._request("dev.dispatch", _payload(self._namespace, action, args)))\n\n'
    '    def raw(self, action: str, **args: Any) -> Any:\n'
    '        return self._request("dev.dispatch", _payload(self._namespace, action, args))',
    '        return _command_result(self._request(DEV_BACKEND_COMMANDS["dispatch"], _payload(self._namespace, action, args)))\n\n'
    '    def raw(self, action: str, **args: Any) -> Any:\n'
    '        return self._request(DEV_BACKEND_COMMANDS["dispatch"], _payload(self._namespace, action, args))',
)
replace_once(
    "packages/python/src/codex_chatgpt_control/dev.py",
    '        return _command_result(await self._request("dev.dispatch", _payload(self._namespace, action, args)))\n\n'
    '    async def raw(self, action: str, **args: Any) -> Any:\n'
    '        return await self._request("dev.dispatch", _payload(self._namespace, action, args))',
    '        return _command_result(await self._request(DEV_BACKEND_COMMANDS["dispatch"], _payload(self._namespace, action, args)))\n\n'
    '    async def raw(self, action: str, **args: Any) -> Any:\n'
    '        return await self._request(DEV_BACKEND_COMMANDS["dispatch"], _payload(self._namespace, action, args))',
)

# Tie the backend command to concrete implementation, test, Python and docs
# evidence. This file is authored coverage metadata, not a generated fixture.
path = Path("packages/node/contracts/v1/parity-suite.json")
matrix = json.loads(path.read_text(encoding="utf-8"))
commands = matrix.get("backendCommands")
if not isinstance(commands, dict):
    raise SystemExit("parity-suite backendCommands is not an object")
expected = {
    "surface": "backend-protocol",
    "sourceFiles": [
        "src/dev/backend-dispatch.ts",
        "src/dev/client.ts",
        "src/dev/autonomous-api.ts",
    ],
    "nodeTests": [
        "tests/unit/dev-backend-dispatch.test.ts",
        "tests/unit/dev-autonomous-api.test.ts",
        "tests/unit/backend-dispatch.test.ts",
    ],
    "pythonTests": ["tests/test_dev_client.py"],
    "docs": [
        "README.md",
        "../../docs/github-install.md",
    ],
}
existing = commands.get("dev.dispatch")
if existing is not None and existing != expected:
    raise SystemExit("existing dev.dispatch parity coverage does not match the intended public contract")
commands["dev.dispatch"] = expected
path.write_text(json.dumps(matrix, indent=2) + "\n", encoding="utf-8")
