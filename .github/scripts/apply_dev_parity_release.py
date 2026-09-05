from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected one patch site in {path}, found {count}")
    file.write_text(text.replace(old, new, 1), encoding="utf-8")


# Backend protocol: one bounded command for the complete Node-authoritative dev surface.
replace_once(
    "packages/node/src/backend/protocol.ts",
    '  "response.copy",\n  "operations.submit",',
    '  "response.copy",\n  "dev.dispatch",\n  "operations.submit",',
)

# Backend session: construct the enhanced client once and delegate dev.dispatch to it.
replace_once(
    "packages/node/src/backend/session.ts",
    'import { createChatGPT, type ChatGPTClient, type ChatGPTClientOptions } from "../client.js";\n',
    'import {\n  createChatGPT,\n  type DevChatGPTClient as ChatGPTClient,\n  type DevChatGPTClientOptions as ChatGPTClientOptions\n} from "../dev/client.js";\nimport { dispatchDevBackend } from "../dev/backend-dispatch.js";\n',
)
replace_once(
    "packages/node/src/backend/session.ts",
    '    case "response.copy":\n      return client.response.copy(emptyToUndefined(payload));\n    case "operations.submit":',
    '    case "response.copy":\n      return client.response.copy(emptyToUndefined(payload));\n    case "dev.dispatch":\n      return dispatchDevBackend(client.dev, payload);\n    case "operations.submit":',
)

# Routing inventory: dev.dispatch uses the coordinated dev runtime facade, not a whole-command actor lock.
replace_once(
    "packages/node/src/runtime/command-routing.ts",
    '    "modes.get",\n    "tools.select"\n  ] as const),',
    '    "modes.get",\n    "tools.select",\n    "dev.dispatch"\n  ] as const),',
)
replace_once(
    "packages/node/src/runtime/command-routing.ts",
    '  "modes.get": "src/commands/modes.ts",\n  "tools.select": "src/commands/modes.ts"\n});',
    '  "modes.get": "src/commands/modes.ts",\n  "tools.select": "src/commands/modes.ts",\n  "dev.dispatch": "src/dev/backend-dispatch.ts -> src/dev/client.ts -> coordinated dev runtime"\n});',
)

# Async Python parity: reuse the existing bounded async backend execution path.
replace_once(
    "packages/python/src/codex_chatgpt_control/async_client.py",
    'from .commands import wire_kwargs\n',
    'from .commands import wire_kwargs\nfrom .dev import AsyncDevClient\n',
)
replace_once(
    "packages/python/src/codex_chatgpt_control/async_client.py",
    '        self.reports = AsyncReportsClient(transport, self._execution)\n        self.operations = _BoundAsyncOperationsClient(transport, self._execution)\n',
    '        self.reports = AsyncReportsClient(transport, self._execution)\n        self.operations = _BoundAsyncOperationsClient(transport, self._execution)\n\n        async def dev_request(command: str, payload: dict[str, Any]) -> Any:\n            return await async_request_backend(\n                transport,\n                command,\n                payload,\n                execution=self._execution,\n            )\n\n        self.dev = AsyncDevClient(dev_request)\n',
)

# Public Python exports for consumers that want explicit dev facade types.
replace_once(
    "packages/python/src/codex_chatgpt_control/__init__.py",
    'from .client import ChatGPT, ChatGPTAgent, ChatGPTRunner\n',
    'from .client import ChatGPT, ChatGPTAgent, ChatGPTRunner\nfrom .dev import AsyncDevClient, DevClient\n',
)
replace_once(
    "packages/python/src/codex_chatgpt_control/__init__.py",
    '    "AsyncCommandClient",\n',
    '    "AsyncCommandClient",\n    "AsyncDevClient",\n',
)
replace_once(
    "packages/python/src/codex_chatgpt_control/__init__.py",
    '    "DetectExperienceData",\n',
    '    "DetectExperienceData",\n    "DevClient",\n',
)

# Destructive Project/Planner deletes require explicit caller confirmation before adapter access.
replace_once(
    "packages/node/src/dev/types.ts",
    'delete(ref: DevProjectRef, options?: Readonly<{ idempotencyKey?: string }>): Promise<CommandResult<DevMutationResult<DevProjectRecord>>>;',
    'delete(ref: DevProjectRef, options?: Readonly<{ idempotencyKey?: string; confirmMutation?: boolean }>): Promise<CommandResult<DevMutationResult<DevProjectRecord>>>;',
)
replace_once(
    "packages/node/src/dev/types.ts",
    'delete(ref: DevPlannerTaskRef, options?: Readonly<{ idempotencyKey?: string }>): Promise<CommandResult<DevMutationResult<DevPlannerTaskRecord>>>;',
    'delete(ref: DevPlannerTaskRef, options?: Readonly<{ idempotencyKey?: string; confirmMutation?: boolean }>): Promise<CommandResult<DevMutationResult<DevPlannerTaskRecord>>>;',
)
replace_once(
    "packages/node/src/dev/types.ts",
    '      | "invalid_spec"\n      | "ui_unsupported"',
    '      | "invalid_spec"\n      | "confirmation_required"\n      | "ui_unsupported"',
)

replace_once(
    "packages/node/src/dev/orchestrator.ts",
    '''  const status: CommandResult["status"] = devError.code === "not_found"\n    ? "not_found"\n    : devError.code === "ui_unsupported"\n      ? "unsupported"''',
    '''  const status: CommandResult["status"] = devError.code === "not_found"\n    ? "not_found"\n    : devError.code === "confirmation_required"\n      ? "needs_confirmation"\n      : devError.code === "ui_unsupported"\n        ? "unsupported"''',
)
replace_once(
    "packages/node/src/dev/orchestrator.ts",
    '''      kind: devError.code === "not_found"\n        ? "not_found"\n        : devError.code === "route_drift" || devError.code === "ui_unsupported"\n          ? "selector_drift"\n          : "unknown",''',
    '''      kind: devError.code === "not_found"\n        ? "not_found"\n        : devError.code === "confirmation_required"\n          ? "confirmation"\n          : devError.code === "route_drift" || devError.code === "ui_unsupported"\n            ? "selector_drift"\n            : "unknown",''',
)
replace_once(
    "packages/node/src/dev/orchestrator.ts",
    '''async function safe<T>(now: () => Date, callback: () => Promise<T>): Promise<CommandResult<T>> {\n  try {\n    return ok(await callback(), now);\n  } catch (error) {\n    return errorResult<T>(error, now);\n  }\n}\n''',
    '''async function safe<T>(now: () => Date, callback: () => Promise<T>): Promise<CommandResult<T>> {\n  try {\n    return ok(await callback(), now);\n  } catch (error) {\n    return errorResult<T>(error, now);\n  }\n}\n\nfunction requireMutationConfirmation(confirmed: boolean | undefined, label: string): void {\n  if (confirmed !== true) {\n    throw new DevOrchestratorError(\n      "confirmation_required",\n      `Explicit caller confirmation is required before ${label}.`\n    );\n  }\n}\n''',
)
replace_once(
    "packages/node/src/dev/orchestrator.ts",
    '''  const deleteProjectMutation = async (ref: DevProjectRef, explicitKey?: string): Promise<DevMutationResult<DevProjectRecord>> => {\n    const key = operationKey("project.delete", ref, explicitKey);''',
    '''  const deleteProjectMutation = async (\n    ref: DevProjectRef,\n    options?: Readonly<{ idempotencyKey?: string; confirmMutation?: boolean }>\n  ): Promise<DevMutationResult<DevProjectRecord>> => {\n    requireMutationConfirmation(options?.confirmMutation, "deleting a ChatGPT Project");\n    const key = operationKey("project.delete", ref, options?.idempotencyKey);''',
)
replace_once(
    "packages/node/src/dev/orchestrator.ts",
    '''  const deletePlannerMutation = async (ref: DevPlannerTaskRef, explicitKey?: string): Promise<DevMutationResult<DevPlannerTaskRecord>> => {\n    const key = operationKey("planner.delete", ref, explicitKey);''',
    '''  const deletePlannerMutation = async (\n    ref: DevPlannerTaskRef,\n    options?: Readonly<{ idempotencyKey?: string; confirmMutation?: boolean }>\n  ): Promise<DevMutationResult<DevPlannerTaskRecord>> => {\n    requireMutationConfirmation(options?.confirmMutation, "deleting a ChatGPT Planner task");\n    const key = operationKey("planner.delete", ref, options?.idempotencyKey);''',
)
replace_once(
    "packages/node/src/dev/orchestrator.ts",
    '    delete: (ref: DevProjectRef, options?: Readonly<{ idempotencyKey?: string }>) => safe(now, () => deleteProjectMutation(ref, options?.idempotencyKey)),',
    '    delete: (ref: DevProjectRef, options?: Readonly<{ idempotencyKey?: string; confirmMutation?: boolean }>) => safe(now, () => deleteProjectMutation(ref, options)),',
)
replace_once(
    "packages/node/src/dev/orchestrator.ts",
    '    delete: (ref: DevPlannerTaskRef, options?: Readonly<{ idempotencyKey?: string }>) => safe(now, () => deletePlannerMutation(ref, options?.idempotencyKey)),',
    '    delete: (ref: DevPlannerTaskRef, options?: Readonly<{ idempotencyKey?: string; confirmMutation?: boolean }>) => safe(now, () => deletePlannerMutation(ref, options)),',
)

# Add safety regression tests once.
tests = Path("packages/node/tests/unit/dev-orchestrator.test.ts")
text = tests.read_text(encoding="utf-8")
marker = '  it("sets planner enabled state once and reuses its durable receipt", async () => {'
addition = '''  it("requires explicit caller confirmation before deleting a Project", async () => {\n    const root = await stateRoot();\n    const fake = fakeAdapter();\n    fake.projects.push({ projectId: "g-p-one", name: "Build", url: "https://chatgpt.com/g/g-p-one/project" });\n    const dev = createDevOrchestrator(runtimeFromEnvironment({}), { stateRoot: root, adapter: fake.adapter });\n\n    const blocked = await dev.projects.delete("g-p-one", { idempotencyKey: "delete-build" });\n\n    expect(blocked.ok).toBe(false);\n    expect(blocked.status).toBe("needs_confirmation");\n    expect(blocked.blocker?.kind).toBe("confirmation");\n    expect(blocked.blocker?.code).toBe("dev_confirmation_required");\n    expect(fake.counts.deleteProject ?? 0).toBe(0);\n    expect(fake.projects).toHaveLength(1);\n\n    const confirmed = await dev.projects.delete("g-p-one", {\n      idempotencyKey: "delete-build",\n      confirmMutation: true\n    });\n    expect(confirmed.ok).toBe(true);\n    expect(fake.counts.deleteProject).toBe(1);\n    expect(fake.projects).toHaveLength(0);\n  });\n\n  it("requires explicit caller confirmation before a Planner delete reaches a custom adapter", async () => {\n    const root = await stateRoot();\n    const fake = fakeAdapter();\n    fake.tasks.push({ taskId: "task-1", name: "Nightly", enabled: true });\n    const dev = createDevOrchestrator(runtimeFromEnvironment({}), { stateRoot: root, adapter: fake.adapter });\n\n    const blocked = await dev.planner.delete("task-1");\n\n    expect(blocked.ok).toBe(false);\n    expect(blocked.status).toBe("needs_confirmation");\n    expect(fake.counts.deletePlannerTask ?? 0).toBe(0);\n    expect(fake.tasks).toHaveLength(1);\n  });\n\n'''
if addition not in text:
    if text.count(marker) != 1:
        raise SystemExit("unexpected dev orchestrator test insertion point")
    tests.write_text(text.replace(marker, addition + marker, 1), encoding="utf-8")
