from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected one final planner/parity patch site in {path}, found {count}")
    file.write_text(text.replace(old, new, 1), encoding="utf-8")


# Public Promise-returning APIs must reject through the Promise boundary even
# when a required port is missing; callers should never receive a synchronous
# throw from a method whose declared contract is Promise<T>.
replace_once(
    "packages/node/src/dev/autonomous-api.ts",
    '    plan: (spec, planningOptions) => requirePlanner().planWorkflow(spec, planningOptions),',
    '    plan: async (spec, planningOptions) => requirePlanner().planWorkflow(spec, planningOptions),',
)

# Async Python must expose the exact same dev namespace as the sync ChatGPT
# facade, routed through the owned async execution pool rather than blocking the
# event loop or creating a second backend implementation.
replace_once(
    "packages/python/src/codex_chatgpt_control/async_client.py",
    'from .commands import wire_kwargs\n',
    'from .commands import wire_kwargs\nfrom .dev import AsyncDevClient\n',
)
replace_once(
    "packages/python/src/codex_chatgpt_control/async_client.py",
    '        self.operations = _BoundAsyncOperationsClient(transport, self._execution)\n',
    '        self.operations = _BoundAsyncOperationsClient(transport, self._execution)\n        self.dev = AsyncDevClient(\n            lambda command, payload: async_request_backend(\n                transport,\n                command,\n                payload,\n                execution=self._execution,\n            )\n        )\n',
)
