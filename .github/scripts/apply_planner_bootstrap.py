from pathlib import Path


def replace_exact(path: str, old: str, new: str, expected: int = 1) -> None:
    file = Path(path)
    text = file.read_text(encoding="utf-8")
    count = text.count(old)
    if count != expected:
        raise SystemExit(f"expected {expected} planner patch site(s) in {path}, found {count}")
    file.write_text(text.replace(old, new), encoding="utf-8")


def replace_once(path: str, old: str, new: str) -> None:
    replace_exact(path, old, new, 1)


# Project keys and planner conversation keys are bounded text, not necessarily ID_PATTERN values.
replace_once(
    "packages/node/src/dev/autonomous-planner.ts",
    '''  boundedId(spec.workflowId, "workflowId");\n  boundedId(spec.projectKey, "projectKey");\n  boundedId(spec.plannerConversationKey, "plannerConversationKey");''',
    '''  boundedId(spec.workflowId, "workflowId");\n  boundedText(spec.projectKey, "projectKey", 512);\n  boundedText(spec.plannerConversationKey, "plannerConversationKey", 512);''',
)

# Planner turns are first-class durable autonomous turns.
replace_once(
    "packages/node/src/dev/autonomous-turn-store.ts",
    'export type DevAutonomousTurnKind = "guidance" | "worker_review" | "planner_review";',
    'export type DevAutonomousTurnKind = "planner_plan" | "guidance" | "worker_review" | "planner_review";',
)
replace_exact(
    "packages/node/src/dev/autonomous-turn-store.ts",
    'record.kind !== "guidance" && record.kind !== "worker_review" && record.kind !== "planner_review"',
    'record.kind !== "planner_plan" && record.kind !== "guidance" && record.kind !== "worker_review" && record.kind !== "planner_review"',
    1,
)
replace_once(
    "packages/node/src/dev/autonomous-turn-store.ts",
    'input.kind !== "guidance" && input.kind !== "worker_review" && input.kind !== "planner_review"',
    'input.kind !== "planner_plan" && input.kind !== "guidance" && input.kind !== "worker_review" && input.kind !== "planner_review"',
)

# Visible-ChatGPT planner port: same transactional operation/watch store used by guidance and reviews.
replace_once(
    "packages/node/src/dev/autonomous-chatgpt-port.ts",
    '''import {\n  DevAutonomousPortError,\n  type DevAutonomousChatPort,''',
    '''import {\n  DevAutonomousPortError,\n  deterministicDevOperationId,\n  deterministicDevWatcherId,\n  type DevAutonomousChatPort,''',
)
replace_once(
    "packages/node/src/dev/autonomous-chatgpt-port.ts",
    '''} from "./autonomous-engine.js";\nimport type {\n  DevAutonomousWorkflow,''',
    '''} from "./autonomous-engine.js";\nimport {\n  devAutonomousPlannerPrompt,\n  devAutonomousPlanningDigest,\n  parseDevAutonomousPlannerResponse,\n  validateDevAutonomousPlanningSpec,\n  type DevAutonomousPlannerPort,\n  type DevAutonomousPlanningOptions,\n  type DevAutonomousPlanningSpec\n} from "./autonomous-planner.js";\nimport {\n  DEV_AUTONOMOUS_WORKFLOW_SCHEMA_VERSION,\n  type DevAutonomousWorkflow,''',
)
replace_once(
    "packages/node/src/dev/autonomous-chatgpt-port.ts",
    '''export class ChatGPTAutonomousPort implements DevAutonomousChatPort {''',
    '''export class ChatGPTAutonomousPort implements DevAutonomousChatPort, DevAutonomousPlannerPort {''',
)
replace_once(
    "packages/node/src/dev/autonomous-chatgpt-port.ts",
    '''    this.provisioner = options.provisioner;\n  }\n\n  async ensureWorkerConversation''',
    '''    this.provisioner = options.provisioner;\n  }\n\n  async planWorkflow(\n    spec: DevAutonomousPlanningSpec,\n    options: DevAutonomousPlanningOptions = {}\n  ): Promise<import("./autonomous-workflow.js").DevWorkflowPlan> {\n    validateDevAutonomousPlanningSpec(spec);\n    const digest = devAutonomousPlanningDigest(spec);\n    const material = `planner-plan:${spec.workflowId}:${digest}`;\n    const workflow = planningWorkflow(spec);\n    const conversation = await this.resolvePlannerConversation(workflow, spec.plannerConversationKey);\n    const operationId = deterministicDevOperationId(material);\n    const watcherId = deterministicDevWatcherId(material);\n    await this.beginTurn({\n      workflow,\n      conversation,\n      logicalConversationKey: spec.plannerConversationKey,\n      kind: "planner_plan",\n      operationId,\n      watcherId,\n      prompt: devAutonomousPlannerPrompt(spec)\n    });\n    const response = await this.collectTurn(watcherId, {\n      wait: true,\n      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs })\n    });\n    if (response === undefined) {\n      throw new DevAutonomousPortError(\n        "planner_response_pending",\n        true,\n        "The master planner response is still pending; retrying will resume the same durable planner turn."\n      );\n    }\n    return parseDevAutonomousPlannerResponse(response.text, spec);\n  }\n\n  async ensureWorkerConversation''',
)
replace_once(
    "packages/node/src/dev/autonomous-chatgpt-port.ts",
    '''  private async resolveGuidanceConversation(\n    workflow: DevAutonomousWorkflow,''',
    '''  private async resolvePlannerConversation(\n    workflow: DevAutonomousWorkflow,\n    key: string\n  ): Promise<ConversationRecord | undefined> {\n    const existing = await this.existingConversation(key);\n    if (existing !== undefined) return existing;\n    if (this.provisioner === undefined) return undefined;\n    const identity = await this.provisioner.ensure({\n      workflow,\n      logicalConversationKey: key,\n      role: "planner"\n    });\n    validateConversationIdentity(identity);\n    const record = await this.conversations.remember({\n      key,\n      conversationId: identity.conversationId,\n      url: identity.url,\n      ...(identity.title === undefined ? {} : { title: identity.title }),\n      surface: "chat"\n    });\n    await this.conversations.affinity.remember({\n      key,\n      tabId: identity.tabId,\n      conversationId: identity.conversationId,\n      url: identity.url,\n      surface: "chat"\n    });\n    return record;\n  }\n\n  private async resolveGuidanceConversation(\n    workflow: DevAutonomousWorkflow,''',
)
replace_once(
    "packages/node/src/dev/autonomous-chatgpt-port.ts",
    '''export function createChatGPTAutonomousPort(\n  chatgpt: ChatGPTClient,''',
    '''function planningWorkflow(spec: DevAutonomousPlanningSpec): DevAutonomousWorkflow {\n  return Object.freeze({\n    schemaVersion: DEV_AUTONOMOUS_WORKFLOW_SCHEMA_VERSION,\n    workflowId: spec.workflowId,\n    projectKey: spec.projectKey,\n    plannerConversationKey: spec.plannerConversationKey,\n    revision: 0,\n    status: "running",\n    tasks: Object.freeze([]),\n    integration: Object.freeze({})\n  });\n}\n\nexport function createChatGPTAutonomousPort(\n  chatgpt: ChatGPTClient,''',
)

# Public package export and enhanced client wiring.
replace_once(
    "packages/node/src/dev/index.ts",
    'export * from "./autonomous-api.js";\n',
    'export * from "./autonomous-api.js";\nexport * from "./autonomous-planner.js";\n',
)
replace_once(
    "packages/node/src/dev/client.ts",
    '''  const autonomous = createDevAutonomousApi({\n    store,\n    chat,\n    ...(local === undefined ? {} : { local }),''',
    '''  const autonomous = createDevAutonomousApi({\n    store,\n    chat,\n    planner: chat,\n    ...(local === undefined ? {} : { local }),''',
)

# Backend parity: planner bootstrap stays inside the one bounded dev.dispatch command.
replace_once(
    "packages/node/src/dev/backend-dispatch.ts",
    '''  switch (action) {\n    case "create":\n      return dev.autonomous.create(requiredRecord(args, "plan") as DevWorkflowPlan);''',
    '''  switch (action) {\n    case "plan":\n      return dev.autonomous.plan(\n        requiredRecord(args, "spec") as Parameters<DevChatGPTSdk["autonomous"]["plan"]>[0],\n        optionalRecordOrUndefined(args.options) as Parameters<DevChatGPTSdk["autonomous"]["plan"]>[1]\n      );\n    case "bootstrap":\n      return dev.autonomous.bootstrap(\n        requiredRecord(args, "spec") as Parameters<DevChatGPTSdk["autonomous"]["bootstrap"]>[0],\n        optionalRecordOrUndefined(args.options) as Parameters<DevChatGPTSdk["autonomous"]["bootstrap"]>[1]\n      );\n    case "create":\n      return dev.autonomous.create(requiredRecord(args, "plan") as DevWorkflowPlan);''',
)

# Python sync/async parity for plan/bootstrap.
replace_once(
    "packages/python/src/codex_chatgpt_control/dev.py",
    '''class DevAutonomousClient:\n    def __init__(self, request: SyncRequester) -> None:\n        self._namespace = _SyncDevNamespace(request, "autonomous")\n\n    def create(self, plan: dict[str, Any]) -> dict[str, Any]:''',
    '''class DevAutonomousClient:\n    def __init__(self, request: SyncRequester) -> None:\n        self._namespace = _SyncDevNamespace(request, "autonomous")\n\n    def plan(self, spec: dict[str, Any], *, options: dict[str, Any] | None = None) -> dict[str, Any]:\n        args: dict[str, Any] = {"spec": spec}\n        if options is not None:\n            args["options"] = options\n        return _record(self._namespace.raw("plan", **args), label="autonomous.plan")\n\n    def bootstrap(self, spec: dict[str, Any], *, options: dict[str, Any] | None = None) -> dict[str, Any]:\n        args: dict[str, Any] = {"spec": spec}\n        if options is not None:\n            args["options"] = options\n        return _record(self._namespace.raw("bootstrap", **args), label="autonomous.bootstrap")\n\n    def create(self, plan: dict[str, Any]) -> dict[str, Any]:''',
)
replace_once(
    "packages/python/src/codex_chatgpt_control/dev.py",
    '''class AsyncDevAutonomousClient:\n    def __init__(self, request: AsyncRequester) -> None:\n        self._namespace = _AsyncDevNamespace(request, "autonomous")\n\n    async def create(self, plan: dict[str, Any]) -> dict[str, Any]:''',
    '''class AsyncDevAutonomousClient:\n    def __init__(self, request: AsyncRequester) -> None:\n        self._namespace = _AsyncDevNamespace(request, "autonomous")\n\n    async def plan(self, spec: dict[str, Any], *, options: dict[str, Any] | None = None) -> dict[str, Any]:\n        args: dict[str, Any] = {"spec": spec}\n        if options is not None:\n            args["options"] = options\n        return _record(await self._namespace.raw("plan", **args), label="autonomous.plan")\n\n    async def bootstrap(self, spec: dict[str, Any], *, options: dict[str, Any] | None = None) -> dict[str, Any]:\n        args: dict[str, Any] = {"spec": spec}\n        if options is not None:\n            args["options"] = options\n        return _record(await self._namespace.raw("bootstrap", **args), label="autonomous.bootstrap")\n\n    async def create(self, plan: dict[str, Any]) -> dict[str, Any]:''',
)

# Extend the ChatGPT port fixture so planner JSON can be collected through the same operation seam.
replace_once(
    "packages/node/tests/unit/dev-autonomous-chatgpt-port.test.ts",
    '''function fakeClient(operationState: OperationStateV1 = state()) {''',
    '''function fakeClient(\n  operationState: OperationStateV1 = state(),\n  responseText = "Use the existing lifecycle seam and add a focused test."\n) {''',
)
replace_once(
    "packages/node/tests/unit/dev-autonomous-chatgpt-port.test.ts",
    '''      rawText: "Use the existing lifecycle seam and add a focused test.",''',
    '''      rawText: responseText,''',
)
replace_once(
    "packages/node/tests/unit/dev-autonomous-chatgpt-port.test.ts",
    '''describe("transactional autonomous ChatGPT port", () => {\n  it("provisions a Project chat,''',
    '''describe("transactional autonomous ChatGPT port", () => {\n  it("creates a bounded master-planner turn in the exact Project chat and parses its task DAG", async () => {\n    const stateRoot = await root();\n    const response = JSON.stringify({\n      workflowId: "workflow-plan",\n      projectKey: "g-p-project1",\n      plannerConversationKey: "planner-main",\n      tasks: [{\n        taskId: "TASK-001",\n        title: "Implement the release gate",\n        summary: "Add deterministic release verification.",\n        dependencies: [],\n        acceptanceCriteria: ["release verification passes"]\n      }]\n    });\n    const { client, submit } = fakeClient(state(), response);\n    const port = new ChatGPTAutonomousPort(client, { stateRoot, provisioner: provisioner() });\n\n    const plan = await port.planWorkflow({\n      workflowId: "workflow-plan",\n      projectKey: "g-p-project1",\n      plannerConversationKey: "planner-main",\n      objective: "Plan the release work.",\n      repositoryUrl: "https://github.com/malickecase28-hash/codex-to-browser"\n    });\n\n    expect(plan.tasks[0]?.taskId).toBe("TASK-001");\n    expect(submit).toHaveBeenCalledTimes(1);\n    expect(submit.mock.calls[0]?.[0]).toMatchObject({\n      surface: "chat",\n      target: { type: "tab_id", tabId: "tab-project-1" }\n    });\n    expect(submit.mock.calls[0]?.[0].prompt).toContain("Do not implement code");\n  });\n\n  it("provisions a Project chat,''',
)

# Python parity tests include planner bootstrap wire shape.
replace_once(
    "packages/python/tests/test_dev_client.py",
    '''    def test_public_sync_chatgpt_exposes_dev_namespace(self) -> None:\n        backend = RecordingBackend()''',
    '''    def test_sync_autonomous_bootstrap_uses_dev_dispatch(self) -> None:\n        backend = RecordingBackend()\n        dev = DevClient(backend)\n        spec = {\n            "workflowId": "workflow-one",\n            "projectKey": "g-p-project1",\n            "plannerConversationKey": "planner-main",\n            "objective": "Plan the work.",\n        }\n\n        dev.autonomous.bootstrap(spec, options={"timeoutMs": 5000})\n\n        self.assertEqual(\n            backend.calls[-1],\n            ("dev.dispatch", {\n                "namespace": "autonomous",\n                "action": "bootstrap",\n                "args": {"spec": spec, "options": {"timeoutMs": 5000}},\n            }),\n        )\n\n    def test_public_sync_chatgpt_exposes_dev_namespace(self) -> None:\n        backend = RecordingBackend()''',
)
