from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected one integration blocker patch site in {path}, found {count}")
    file.write_text(text.replace(old, new, 1), encoding="utf-8")


# Workflow state: preserve the exact integration phase that was blocked so a
# restart can resume deliberately instead of relying on an in-memory exception.
replace_once(
    "packages/node/src/dev/autonomous-workflow.ts",
    'export type DevWorkflowStatus =\n  | "running"\n  | "integration_ready"\n  | "integration_testing"\n  | "integration_push_pending"\n  | "planner_review_pending"\n  | "completed"\n  | "blocked";\n',
    'export type DevWorkflowStatus =\n  | "running"\n  | "integration_ready"\n  | "integration_testing"\n  | "integration_push_pending"\n  | "planner_review_pending"\n  | "completed"\n  | "blocked";\n\nexport type DevIntegrationPhase =\n  | "integration_ready"\n  | "integration_testing"\n  | "integration_push_pending"\n  | "planner_review_pending";\n',
)
replace_once(
    "packages/node/src/dev/autonomous-workflow.ts",
    '  plannerReview?: Readonly<{\n    plannerConversationKey: string;\n    reviewedSha: string;\n    status: "accepted" | "revision_required";\n    reviewDigest: string;\n    reviewWatcherId?: string | undefined;\n  }> | undefined;\n}>;',
    '  plannerReview?: Readonly<{\n    plannerConversationKey: string;\n    reviewedSha: string;\n    status: "accepted" | "revision_required";\n    reviewDigest: string;\n    reviewWatcherId?: string | undefined;\n  }> | undefined;\n  blockerCode?: string | undefined;\n  blockedFrom?: DevIntegrationPhase | undefined;\n}>;',
)
replace_once(
    "packages/node/src/dev/autonomous-workflow.ts",
    '  | Readonly<{ type: "integration_pushed"; evidence: DevPushEvidence }>\n  | Readonly<{\n      type: "planner_review";',
    '  | Readonly<{ type: "integration_pushed"; evidence: DevPushEvidence }>\n  | Readonly<{ type: "integration_blocked"; blockerCode: string }>\n  | Readonly<{ type: "integration_resumed" }>\n  | Readonly<{\n      type: "planner_review";',
)
replace_once(
    "packages/node/src/dev/autonomous-workflow.ts",
    '    case "integration_pushed":\n      next = integrationPushed(workflow, event.evidence);\n      break;\n    case "planner_review":',
    '    case "integration_pushed":\n      next = integrationPushed(workflow, event.evidence);\n      break;\n    case "integration_blocked":\n      next = blockIntegration(workflow, event.blockerCode);\n      break;\n    case "integration_resumed":\n      next = resumeIntegration(workflow);\n      break;\n    case "planner_review":',
)
replace_once(
    "packages/node/src/dev/autonomous-workflow.ts",
    'function plannerReview(\n  workflow: DevAutonomousWorkflow,',
    '''function blockIntegration(workflow: DevAutonomousWorkflow, blockerCode: string): DevAutonomousWorkflow {
  if (!isIntegrationPhase(workflow.status)) {
    invalidTransition("Only an active integration phase can be blocked.");
  }
  requireId(blockerCode, "integration blockerCode");
  return freezeWorkflow({
    ...workflow,
    revision: workflow.revision + 1,
    status: "blocked",
    integration: {
      ...workflow.integration,
      blockerCode,
      blockedFrom: workflow.status
    }
  });
}

function resumeIntegration(workflow: DevAutonomousWorkflow): DevAutonomousWorkflow {
  const blockedFrom = workflow.integration.blockedFrom;
  if (workflow.status !== "blocked" || blockedFrom === undefined) {
    invalidTransition("Only a durably blocked integration phase can be resumed.");
  }
  return freezeWorkflow({
    ...workflow,
    revision: workflow.revision + 1,
    status: blockedFrom,
    integration: {
      ...workflow.integration,
      blockerCode: undefined,
      blockedFrom: undefined
    }
  });
}

function isIntegrationPhase(status: DevWorkflowStatus): status is DevIntegrationPhase {
  return status === "integration_ready"
    || status === "integration_testing"
    || status === "integration_push_pending"
    || status === "planner_review_pending";
}

function plannerReview(
  workflow: DevAutonomousWorkflow,'''
)
replace_once(
    "packages/node/src/dev/autonomous-workflow.ts",
    '  let status = workflow.status;\n  if (status === "running" || status === "blocked" || status === "integration_ready") {',
    '  let status = workflow.status;\n  if (status === "blocked" && workflow.integration.blockedFrom !== undefined) {\n    return freezeWorkflow({ ...workflow, tasks, status });\n  }\n  if (status === "running" || status === "blocked" || status === "integration_ready") {',
)

# Engine: integration port failures are journaled as workflow events and only an
# explicit resume restores the exact prior integration phase.
replace_once(
    "packages/node/src/dev/autonomous-engine.ts",
    '  async resumeTask(workflowId: string, taskId: string): Promise<DevAutonomousWorkflow> {\n    return this.store.apply(workflowId, { type: "task_resumed", taskId });\n  }\n\n  async advance(',
    '  async resumeTask(workflowId: string, taskId: string): Promise<DevAutonomousWorkflow> {\n    return this.store.apply(workflowId, { type: "task_resumed", taskId });\n  }\n\n  async resumeIntegration(workflowId: string): Promise<DevAutonomousWorkflow> {\n    return this.store.apply(workflowId, { type: "integration_resumed" });\n  }\n\n  async advance(',
)
replace_once(
    "packages/node/src/dev/autonomous-engine.ts",
    '  private async advanceIntegration(\n    workflow: DevAutonomousWorkflow,\n    options: DevAutonomousAdvanceOptions\n  ): Promise<boolean> {\n    switch (workflow.status) {',
    '  private async advanceIntegration(\n    workflow: DevAutonomousWorkflow,\n    options: DevAutonomousAdvanceOptions\n  ): Promise<boolean> {\n    try {\n      switch (workflow.status) {',
)
replace_once(
    "packages/node/src/dev/autonomous-engine.ts",
    '      case "running":\n      case "blocked":\n      case "completed":\n        return false;\n    }\n  }\n}',
    '        case "running":\n        case "blocked":\n        case "completed":\n          return false;\n      }\n    } catch (error) {\n      if (error instanceof DevAutonomousPortError) {\n        await this.store.apply(workflow.workflowId, {\n          type: "integration_blocked",\n          blockerCode: safeBlockerCode(error.blockerCode)\n        });\n        return true;\n      }\n      throw error;\n    }\n  }\n}',
)

# Public Node SDK and bounded backend action.
replace_once(
    "packages/node/src/dev/autonomous-api.ts",
    '  run(workflowId: string, options?: DevAutonomousRunOptions): Promise<DevAutonomousRunResult>;\n  resumeTask(workflowId: string, taskId: string): Promise<DevAutonomousWorkflow>;\n}>;',
    '  run(workflowId: string, options?: DevAutonomousRunOptions): Promise<DevAutonomousRunResult>;\n  resumeTask(workflowId: string, taskId: string): Promise<DevAutonomousWorkflow>;\n  resumeIntegration(workflowId: string): Promise<DevAutonomousWorkflow>;\n}>;',
)
replace_once(
    "packages/node/src/dev/autonomous-api.ts",
    '    resumeTask: (workflowId, taskId) => engine.resumeTask(workflowId, taskId),\n    run: async',
    '    resumeTask: (workflowId, taskId) => engine.resumeTask(workflowId, taskId),\n    resumeIntegration: workflowId => engine.resumeIntegration(workflowId),\n    run: async',
)
replace_once(
    "packages/node/src/dev/backend-dispatch.ts",
    '    case "resumeTask":\n      return dev.autonomous.resumeTask(\n        requiredString(args, "workflowId"),\n        requiredString(args, "taskId")\n      );\n    default:',
    '    case "resumeTask":\n      return dev.autonomous.resumeTask(\n        requiredString(args, "workflowId"),\n        requiredString(args, "taskId")\n      );\n    case "resumeIntegration":\n      return dev.autonomous.resumeIntegration(requiredString(args, "workflowId"));\n    default:',
)

# Python sync/async parity follows the same single dev.dispatch wire command.
replace_once(
    "packages/python/src/codex_chatgpt_control/dev.py",
    '    def resume_task(self, workflow_id: str, task_id: str) -> dict[str, Any]:\n        return _record(\n            self._namespace.raw("resumeTask", workflowId=workflow_id, taskId=task_id),\n            label="autonomous.resumeTask",\n        )\n\n\nclass DevClient:',
    '    def resume_task(self, workflow_id: str, task_id: str) -> dict[str, Any]:\n        return _record(\n            self._namespace.raw("resumeTask", workflowId=workflow_id, taskId=task_id),\n            label="autonomous.resumeTask",\n        )\n\n    def resume_integration(self, workflow_id: str) -> dict[str, Any]:\n        return _record(\n            self._namespace.raw("resumeIntegration", workflowId=workflow_id),\n            label="autonomous.resumeIntegration",\n        )\n\n\nclass DevClient:',
)
replace_once(
    "packages/python/src/codex_chatgpt_control/dev.py",
    '    async def resume_task(self, workflow_id: str, task_id: str) -> dict[str, Any]:\n        return _record(\n            await self._namespace.raw("resumeTask", workflowId=workflow_id, taskId=task_id),\n            label="autonomous.resumeTask",\n        )\n\n\nclass AsyncDevClient:',
    '    async def resume_task(self, workflow_id: str, task_id: str) -> dict[str, Any]:\n        return _record(\n            await self._namespace.raw("resumeTask", workflowId=workflow_id, taskId=task_id),\n            label="autonomous.resumeTask",\n        )\n\n    async def resume_integration(self, workflow_id: str) -> dict[str, Any]:\n        return _record(\n            await self._namespace.raw("resumeIntegration", workflowId=workflow_id),\n            label="autonomous.resumeIntegration",\n        )\n\n\nclass AsyncDevClient:',
)

# State-machine proof: exact phase survives block/resume and normalization does
# not accidentally release an integration blocker just because all tasks are accepted.
replace_once(
    "packages/node/tests/unit/dev-autonomous-workflow.test.ts",
    '  it("rejects dependency cycles before any work can be dispatched", () => {',
    '''  it("persists and resumes the exact blocked integration phase", () => {
    const acceptedA = acceptTask(workflow(), "task-a", "worker-task-a", D1, SHA_A);
    const acceptedAll = acceptTask(acceptedA, "task-b", "worker-task-b", D2, SHA_B);
    const integration = applyAutonomousWorkflowEvent(acceptedAll, {
      type: "integration_candidate",
      evidence: { implementerId: "integrator", branch: "integration", candidateDigest: D3 }
    });
    expect(integration.status).toBe("integration_testing");

    const blocked = applyAutonomousWorkflowEvent(integration, {
      type: "integration_blocked",
      blockerCode: "local_action_busy"
    });
    expect(blocked.status).toBe("blocked");
    expect(blocked.integration).toMatchObject({
      blockerCode: "local_action_busy",
      blockedFrom: "integration_testing"
    });

    const resumed = applyAutonomousWorkflowEvent(blocked, { type: "integration_resumed" });
    expect(resumed.status).toBe("integration_testing");
    expect(resumed.integration.blockerCode).toBeUndefined();
    expect(resumed.integration.blockedFrom).toBeUndefined();
  });

  it("rejects dependency cycles before any work can be dispatched", () => {'''
)

# Engine proof: a port error becomes durable state, repeated advance does not
# retry it, and explicit resume restores exactly the failed integration phase.
replace_once(
    "packages/node/tests/unit/dev-autonomous-engine.test.ts",
    '  it("persists a structured task blocker instead of retrying a failed external port", async () => {',
    '''  it("persists integration blockers and requires explicit phase-safe resume", async () => {
    const stateRoot = await root();
    const store = new FileDevAutonomousWorkflowStore({ stateRoot });
    const { chat, local } = ports();
    const integrate = local.integrate as ReturnType<typeof vi.fn>;
    integrate.mockRejectedValueOnce(new DevAutonomousPortError("local_action_busy", true));
    const engine = new DevAutonomousEngine(store, chat, local, { maxParallelTasks: 2 });
    await engine.create(plan());

    for (let index = 0; index < 6; index += 1) await engine.advance("workflow-engine");
    const blocked = await engine.advance("workflow-engine");
    expect(blocked.workflow.status).toBe("blocked");
    expect(blocked.workflow.integration).toMatchObject({
      blockerCode: "local_action_busy",
      blockedFrom: "integration_ready"
    });
    expect(integrate).toHaveBeenCalledTimes(1);

    const noRetry = await engine.advance("workflow-engine");
    expect(noRetry.workflow.status).toBe("blocked");
    expect(integrate).toHaveBeenCalledTimes(1);

    const resumed = await engine.resumeIntegration("workflow-engine");
    expect(resumed.status).toBe("integration_ready");
    expect(resumed.integration.blockerCode).toBeUndefined();
    await engine.advance("workflow-engine");
    expect(integrate).toHaveBeenCalledTimes(2);
  });

  it("persists a structured task blocker instead of retrying a failed external port", async () => {'''
)

# Public API and backend dispatch expose only explicit integration resume; no
# hidden auto-retry is added to run().
replace_once(
    "packages/node/tests/unit/dev-autonomous-api.test.ts",
    '  it("bounds host-driven run loops", async () => {',
    '''  it("exposes explicit integration resume without auto-retrying a blocker", async () => {
    const planning = planner();
    const failingLocal = local();
    (failingLocal.integrate as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new DevAutonomousPortError("local_action_busy", true)
    );
    const value = await api({ planner: planning, local: failingLocal });
    await value.create(plan());
    for (let index = 0; index < 6; index += 1) await value.advance("workflow-api");

    const blocked = await value.advance("workflow-api");
    expect(blocked.workflow.status).toBe("blocked");
    const resumed = await value.resumeIntegration("workflow-api");
    expect(resumed.status).toBe("integration_ready");
  });

  it("bounds host-driven run loops", async () => {'''
)
replace_once(
    "packages/node/tests/unit/dev-backend-dispatch.test.ts",
    '    autonomous: {\n      run: async (_workflowId: unknown, options: unknown) => {\n        calls.push(["autonomous.run", options]);\n        return { workflow: {}, steps: 1, complete: false, waiting: true } as never;\n      }\n    }',
    '    autonomous: {\n      run: async (_workflowId: unknown, options: unknown) => {\n        calls.push(["autonomous.run", options]);\n        return { workflow: {}, steps: 1, complete: false, waiting: true } as never;\n      },\n      resumeIntegration: async (workflowId: unknown) => {\n        calls.push(["autonomous.resumeIntegration", workflowId]);\n        return { workflowId, status: "integration_ready" } as never;\n      }\n    }',
)
replace_once(
    "packages/node/tests/unit/dev-backend-dispatch.test.ts",
    '  it("fails closed for unknown namespaces and actions", async () => {',
    '''  it("routes explicit integration resume over the bounded dev dispatch action", async () => {
    const calls: Array<readonly [string, unknown]> = [];
    const result = await dispatchDevBackend(fakeDev(calls), {
      namespace: "autonomous",
      action: "resumeIntegration",
      args: { workflowId: "workflow-one" }
    });

    expect(result).toMatchObject({ workflowId: "workflow-one", status: "integration_ready" });
    expect(calls).toEqual([["autonomous.resumeIntegration", "workflow-one"]]);
  });

  it("fails closed for unknown namespaces and actions", async () => {'''
)

# Python parity tests both sync and async wire shapes.
replace_once(
    "packages/python/tests/test_dev_client.py",
    '    def test_public_sync_chatgpt_exposes_dev_namespace(self) -> None:',
    '''    def test_sync_autonomous_resume_integration_uses_dev_dispatch(self) -> None:
        backend = RecordingBackend()
        dev = DevClient(backend)

        dev.autonomous.resume_integration("workflow-one")

        self.assertEqual(
            backend.calls[-1],
            ("dev.dispatch", {
                "namespace": "autonomous",
                "action": "resumeIntegration",
                "args": {"workflowId": "workflow-one"},
            }),
        )

    def test_public_sync_chatgpt_exposes_dev_namespace(self) -> None:'''
)
replace_once(
    "packages/python/tests/test_dev_client.py",
    '    async def test_public_async_chatgpt_exposes_dev_namespace(self) -> None:',
    '''    async def test_async_autonomous_resume_integration_uses_dev_dispatch(self) -> None:
        backend = AsyncRecordingBackend()

        async def request(command: str, payload: dict[str, Any]) -> Any:
            return await backend.request(command, payload)

        dev = AsyncDevClient(request)
        await dev.autonomous.resume_integration("workflow-one")

        self.assertEqual(
            backend.calls[-1],
            ("dev.dispatch", {
                "namespace": "autonomous",
                "action": "resumeIntegration",
                "args": {"workflowId": "workflow-one"},
            }),
        )

    async def test_public_async_chatgpt_exposes_dev_namespace(self) -> None:'''
)
