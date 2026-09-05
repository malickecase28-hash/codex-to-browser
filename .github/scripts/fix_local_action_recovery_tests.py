from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected one local recovery test patch site in {path}, found {count}")
    file.write_text(text.replace(old, new, 1), encoding="utf-8")


def replace_count(path: str, old: str, new: str, count: int) -> None:
    file = Path(path)
    text = file.read_text(encoding="utf-8")
    observed = text.count(old)
    if observed != count:
        raise SystemExit(f"expected {count} local recovery patch sites in {path}, found {observed}")
    file.write_text(text.replace(old, new), encoding="utf-8")


# Integration owns one physical branch/worktree for the entire workflow. A
# workflow-state revision is not a branch-identity boundary.
replace_once(
    "packages/node/src/dev/codex-cli-local-port.ts",
    'function integrationBranch(workflow: DevAutonomousWorkflow): string {\n'
    '  return `codex/${safeRefPart(workflow.workflowId)}-integration-r${workflow.revision}`;\n'
    '}\n',
    'function integrationBranch(workflow: DevAutonomousWorkflow): string {\n'
    '  return `codex/${safeRefPart(workflow.workflowId)}-integration`;\n'
    '}\n',
)

# Store-specific lock/corruption failures must travel through the same
# structured blocker boundary as every other local autonomous failure.
replace_once(
    "packages/node/src/dev/codex-cli-local-port.ts",
    '  FileDevAutonomousLocalActionStore,\n'
    '  type DevAutonomousLocalActionRecord\n',
    '  DevAutonomousLocalActionStoreError,\n'
    '  FileDevAutonomousLocalActionStore,\n'
    '  type DevAutonomousLocalActionRecord\n',
)
replace_count(
    "packages/node/src/dev/codex-cli-local-port.ts",
    'return this.actions.withScope(scopeId, async () => {',
    'return this.withActionScope(scopeId, async () => {',
    6,
)
replace_once(
    "packages/node/src/dev/codex-cli-local-port.ts",
    '  private async verifiedRepositoryRoot(): Promise<string> {\n',
    '''  private async withActionScope<T>(scopeId: string, action: () => Promise<T>): Promise<T> {
    try {
      return await this.actions.withScope(scopeId, action);
    } catch (error) {
      if (error instanceof DevAutonomousLocalActionStoreError) {
        if (error.code === "lock_timeout") {
          throw blocked("local_action_busy", "Another autonomous process currently owns this exact local worktree scope. Retry only after that owner finishes or its stale lock is safely reclaimed.");
        }
        if (error.code === "write_failed") {
          throw blocked("local_action_state_unavailable", "Durable local action evidence could not be committed safely; no uncertain mutation will be retried.");
        }
        throw new PortError(
          "local_action_state_invalid",
          false,
          "Durable local action identity or evidence is corrupt or conflicts with the requested operation."
        );
      }
      throw error;
    }
  }

  private async verifiedRepositoryRoot(): Promise<string> {
''',
)

# Remove an accidental placeholder assertion from the recovery test. The actual
# proof is the durable action record plus zero second Codex invocations.
replace_once(
    "packages/node/tests/unit/dev-codex-cli-local-recovery.test.ts",
    '    const worktrees = join(fixture.stateRoot, "worktrees");\n'
    '    expect(await readFile(join(worktrees, (await import("node:fs/promises")).then ? "" : ""), "utf8").catch(() => "ignored")).toBe("ignored");\n',
    '',
)
replace_once(
    "packages/node/tests/unit/dev-codex-cli-local-recovery.test.ts",
    'import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";\n',
    'import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";\n',
)

# Re-run integration at a later workflow revision and prove accepted task SHAs
# are not cherry-picked a second time. The second pass is a new integration
# action and therefore invokes only the integrator once more.
replace_once(
    "packages/node/tests/unit/dev-codex-cli-local-port.test.ts",
    '    expect(integrationTester.testerId).not.toBe(integration.implementerId);\n'
    '    expect(await git(remote, "rev-parse", `refs/heads/${integration.branch}`)).toBe(integrationPush.commitSha);\n\n'
    '    expect(codexCalls.length).toBe(5);\n',
    '    expect(integrationTester.testerId).not.toBe(integration.implementerId);\n'
    '    expect(await git(remote, "rev-parse", `refs/heads/${integration.branch}`)).toBe(integrationPush.commitSha);\n\n'
    '    const reintegration = await port.integrate({\n'
    '      workflow: workflow(acceptedTask, 10),\n'
    '      acceptedTasks: [acceptedTask]\n'
    '    });\n'
    '    expect(reintegration.branch).toBe(integration.branch);\n\n'
    '    expect(codexCalls.length).toBe(6);\n',
)
