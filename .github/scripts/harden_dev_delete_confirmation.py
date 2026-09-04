from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected one patch site in {path}, found {count}")
    file.write_text(text.replace(old, new, 1), encoding="utf-8")


types = "packages/node/src/dev/types.ts"
replace_once(
    types,
    'delete(ref: DevProjectRef, options?: Readonly<{ idempotencyKey?: string }>): Promise<CommandResult<DevMutationResult<DevProjectRecord>>>;',
    'delete(ref: DevProjectRef, options?: Readonly<{ idempotencyKey?: string; confirmMutation?: boolean }>): Promise<CommandResult<DevMutationResult<DevProjectRecord>>>;'
)
replace_once(
    types,
    'delete(ref: DevPlannerTaskRef, options?: Readonly<{ idempotencyKey?: string }>): Promise<CommandResult<DevMutationResult<DevPlannerTaskRecord>>>;',
    'delete(ref: DevPlannerTaskRef, options?: Readonly<{ idempotencyKey?: string; confirmMutation?: boolean }>): Promise<CommandResult<DevMutationResult<DevPlannerTaskRecord>>>;'
)
replace_once(
    types,
    '      | "invalid_spec"\n      | "ui_unsupported"',
    '      | "invalid_spec"\n      | "confirmation_required"\n      | "ui_unsupported"'
)

orchestrator = "packages/node/src/dev/orchestrator.ts"
replace_once(
    orchestrator,
    '''  const status: CommandResult["status"] = devError.code === "not_found"
    ? "not_found"
    : devError.code === "ui_unsupported"
      ? "unsupported"''',
    '''  const status: CommandResult["status"] = devError.code === "not_found"
    ? "not_found"
    : devError.code === "confirmation_required"
      ? "needs_confirmation"
      : devError.code === "ui_unsupported"
        ? "unsupported"'''
)
replace_once(
    orchestrator,
    '''      kind: devError.code === "not_found"
        ? "not_found"
        : devError.code === "route_drift" || devError.code === "ui_unsupported"
          ? "selector_drift"
          : "unknown",''',
    '''      kind: devError.code === "not_found"
        ? "not_found"
        : devError.code === "confirmation_required"
          ? "confirmation"
          : devError.code === "route_drift" || devError.code === "ui_unsupported"
            ? "selector_drift"
            : "unknown",'''
)
replace_once(
    orchestrator,
    '''async function safe<T>(now: () => Date, callback: () => Promise<T>): Promise<CommandResult<T>> {
  try {
    return ok(await callback(), now);
  } catch (error) {
    return errorResult<T>(error, now);
  }
}
''',
    '''async function safe<T>(now: () => Date, callback: () => Promise<T>): Promise<CommandResult<T>> {
  try {
    return ok(await callback(), now);
  } catch (error) {
    return errorResult<T>(error, now);
  }
}

function requireMutationConfirmation(confirmed: boolean | undefined, label: string): void {
  if (confirmed !== true) {
    throw new DevOrchestratorError(
      "confirmation_required",
      `Explicit caller confirmation is required before ${label}.`
    );
  }
}
'''
)
replace_once(
    orchestrator,
    '''  const deleteProjectMutation = async (ref: DevProjectRef, explicitKey?: string): Promise<DevMutationResult<DevProjectRecord>> => {
    const key = operationKey("project.delete", ref, explicitKey);''',
    '''  const deleteProjectMutation = async (
    ref: DevProjectRef,
    options?: Readonly<{ idempotencyKey?: string; confirmMutation?: boolean }>
  ): Promise<DevMutationResult<DevProjectRecord>> => {
    requireMutationConfirmation(options?.confirmMutation, "deleting a ChatGPT Project");
    const key = operationKey("project.delete", ref, options?.idempotencyKey);'''
)
replace_once(
    orchestrator,
    '''  const deletePlannerMutation = async (ref: DevPlannerTaskRef, explicitKey?: string): Promise<DevMutationResult<DevPlannerTaskRecord>> => {
    const key = operationKey("planner.delete", ref, explicitKey);''',
    '''  const deletePlannerMutation = async (
    ref: DevPlannerTaskRef,
    options?: Readonly<{ idempotencyKey?: string; confirmMutation?: boolean }>
  ): Promise<DevMutationResult<DevPlannerTaskRecord>> => {
    requireMutationConfirmation(options?.confirmMutation, "deleting a ChatGPT Planner task");
    const key = operationKey("planner.delete", ref, options?.idempotencyKey);'''
)
replace_once(
    orchestrator,
    '    delete: (ref: DevProjectRef, options?: Readonly<{ idempotencyKey?: string }>) => safe(now, () => deleteProjectMutation(ref, options?.idempotencyKey)),',
    '    delete: (ref: DevProjectRef, options?: Readonly<{ idempotencyKey?: string; confirmMutation?: boolean }>) => safe(now, () => deleteProjectMutation(ref, options)),'
)
replace_once(
    orchestrator,
    '    delete: (ref: DevPlannerTaskRef, options?: Readonly<{ idempotencyKey?: string }>) => safe(now, () => deletePlannerMutation(ref, options?.idempotencyKey)),',
    '    delete: (ref: DevPlannerTaskRef, options?: Readonly<{ idempotencyKey?: string; confirmMutation?: boolean }>) => safe(now, () => deletePlannerMutation(ref, options)),'
)

tests = "packages/node/tests/unit/dev-orchestrator.test.ts"
marker = '  it("sets planner enabled state once and reuses its durable receipt", async () => {'
addition = '''  it("requires explicit caller confirmation before deleting a Project", async () => {
    const root = await stateRoot();
    const fake = fakeAdapter();
    fake.projects.push({ projectId: "g-p-one", name: "Build", url: "https://chatgpt.com/g/g-p-one/project" });
    const dev = createDevOrchestrator(runtimeFromEnvironment({}), { stateRoot: root, adapter: fake.adapter });

    const blocked = await dev.projects.delete("g-p-one", { idempotencyKey: "delete-build" });

    expect(blocked.ok).toBe(false);
    expect(blocked.status).toBe("needs_confirmation");
    expect(blocked.blocker?.kind).toBe("confirmation");
    expect(blocked.blocker?.code).toBe("dev_confirmation_required");
    expect(fake.counts.deleteProject ?? 0).toBe(0);
    expect(fake.projects).toHaveLength(1);

    const confirmed = await dev.projects.delete("g-p-one", {
      idempotencyKey: "delete-build",
      confirmMutation: true
    });
    expect(confirmed.ok).toBe(true);
    expect(fake.counts.deleteProject).toBe(1);
    expect(fake.projects).toHaveLength(0);
  });

  it("requires explicit caller confirmation before a Planner delete reaches a custom adapter", async () => {
    const root = await stateRoot();
    const fake = fakeAdapter();
    fake.tasks.push({ taskId: "task-1", name: "Nightly", enabled: true });
    const dev = createDevOrchestrator(runtimeFromEnvironment({}), { stateRoot: root, adapter: fake.adapter });

    const blocked = await dev.planner.delete("task-1");

    expect(blocked.ok).toBe(false);
    expect(blocked.status).toBe("needs_confirmation");
    expect(fake.counts.deletePlannerTask ?? 0).toBe(0);
    expect(fake.tasks).toHaveLength(1);
  });

'''
file = Path(tests)
text = file.read_text(encoding="utf-8")
if text.count(marker) != 1:
    raise SystemExit("unexpected dev orchestrator test insertion point")
file.write_text(text.replace(marker, addition + marker, 1), encoding="utf-8")
