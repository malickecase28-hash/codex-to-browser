from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected one local action patch site in {path}, found {count}")
    file.write_text(text.replace(old, new, 1), encoding="utf-8")


def replace_between(path: str, start: str, end: str, replacement: str) -> None:
    file = Path(path)
    text = file.read_text(encoding="utf-8")
    if text.count(start) != 1:
        raise SystemExit(f"expected one start marker {start!r} in {path}")
    start_index = text.index(start)
    end_index = text.find(end, start_index + len(start))
    if end_index < 0:
        raise SystemExit(f"missing end marker {end!r} in {path}")
    file.write_text(text[:start_index] + replacement + text[end_index:], encoding="utf-8")


# The generic action store is JSON-only; make its canonical comparison total
# for primitive values under strict TypeScript typing.
replace_once(
    "packages/node/src/dev/autonomous-local-action-store.ts",
    "  return JSON.stringify(value);\n",
    '  return JSON.stringify(value) ?? "null";\n',
)

replace_once(
    "packages/node/src/dev/codex-cli-local-port.ts",
    'import { dirname, isAbsolute, join, relative, resolve } from "node:path";\n',
    'import { dirname, isAbsolute, join, relative, resolve } from "node:path";\n'
    'import { nodeErrorCode } from "../errors.js";\n',
)
replace_once(
    "packages/node/src/dev/codex-cli-local-port.ts",
    '} from "./autonomous-workflow.js";\n\nconst DEFAULT_TIMEOUT_MS',
    '} from "./autonomous-workflow.js";\n'
    'import {\n'
    '  FileDevAutonomousLocalActionStore,\n'
    '  type DevAutonomousLocalActionRecord\n'
    '} from "./autonomous-local-action-store.js";\n\n'
    'const DEFAULT_TIMEOUT_MS',
)
replace_once(
    "packages/node/src/dev/codex-cli-local-port.ts",
    '  /** Test seam. Production callers normally leave this unset. */\n  processRunner?: CodexCliLocalProcessRunner;\n}>;',
    '  /** Optional durable action journal override. */\n'
    '  actionStore?: FileDevAutonomousLocalActionStore;\n'
    '  /** Test seam. Production callers normally leave this unset. */\n'
    '  processRunner?: CodexCliLocalProcessRunner;\n}>;',
)
replace_once(
    "packages/node/src/dev/codex-cli-local-port.ts",
    '  private readonly runProcess: CodexCliLocalProcessRunner;\n',
    '  private readonly runProcess: CodexCliLocalProcessRunner;\n'
    '  readonly actions: FileDevAutonomousLocalActionStore;\n',
)
replace_once(
    "packages/node/src/dev/codex-cli-local-port.ts",
    '    this.runProcess = options.processRunner ?? defaultProcessRunner;\n  }',
    '    this.runProcess = options.processRunner ?? defaultProcessRunner;\n'
    '    this.actions = options.actionStore ?? new FileDevAutonomousLocalActionStore({\n'
    '      stateRoot: join(this.stateRoot, "actions")\n'
    '    });\n'
    '  }',
)

replace_between(
    "packages/node/src/dev/codex-cli-local-port.ts",
    "  async implement(",
    "  async test(",
    '''  async implement(input: Readonly<{
    workflow: DevAutonomousWorkflow;
    task: DevTaskRecord;
    guidance: string;
  }>): Promise<DevImplementationCandidate> {
    const repositoryRoot = await this.verifiedRepositoryRoot();
    const branch = await this.taskBranch(input.workflow, input.task);
    const scopeId = `task:${input.workflow.workflowId}:${input.task.taskId}`;
    const prompt = implementationPrompt(input.workflow, input.task, input.guidance);
    const inputDigest = localInputDigest({
      workflowId: input.workflow.workflowId,
      taskId: input.task.taskId,
      attempt: input.task.attempt,
      branch,
      promptDigest: digestText(prompt)
    });
    const actionId = localActionId("implement", inputDigest);
    return this.actions.withScope(scopeId, async () => {
      const worktree = await this.ensureWorktree(repositoryRoot, branch, scopeId);
      const previous = await this.actions.get(actionId);
      const baselineHead = previous?.baselineHead ?? await this.gitText(worktree, ["rev-parse", "HEAD"]);
      const record = await this.actions.prepare({
        actionId,
        kind: "implement",
        workflowId: input.workflow.workflowId,
        scopeId,
        inputDigest,
        branch,
        taskId: input.task.taskId,
        attempt: input.task.attempt,
        baselineHead
      });
      if (record.phase === "completed") {
        const evidence = implementationActionResult(record.result, branch);
        await this.assertImplementationRecovery(worktree, record, evidence);
        return evidence;
      }
      if (record.phase === "started") {
        if (!(await this.readCodexCompletion(actionId))) throw recoveryRequired("implementation");
      } else {
        await this.actions.start(actionId);
        await this.runCodexAction(worktree, prompt, "implementation", actionId);
      }
      const afterHead = await this.gitText(worktree, ["rev-parse", "HEAD"]);
      if (afterHead !== baselineHead) {
        throw blocked("codex_unexpected_commit", "Codex changed Git history during implementation; the port will not guess how to recover.");
      }
      const evidence = Object.freeze({
        implementerId: "codex-cli-implementer",
        branch,
        candidateDigest: await this.candidateDigest(worktree)
      });
      await this.actions.complete(actionId, evidence);
      return evidence;
    });
  }

'''
)

replace_between(
    "packages/node/src/dev/codex-cli-local-port.ts",
    "  async test(",
    "  async push(",
    '''  async test(input: Readonly<{
    workflow: DevAutonomousWorkflow;
    task: DevTaskRecord;
    implementation: DevImplementationCandidate;
  }>): Promise<DevTesterEvidence> {
    const repositoryRoot = await this.verifiedRepositoryRoot();
    const scopeId = `task:${input.workflow.workflowId}:${input.task.taskId}`;
    const prompt = independentTestPrompt(input.workflow, input.task);
    const inputDigest = localInputDigest({
      workflowId: input.workflow.workflowId,
      taskId: input.task.taskId,
      attempt: input.task.attempt,
      branch: input.implementation.branch,
      candidateDigest: input.implementation.candidateDigest,
      promptDigest: digestText(prompt)
    });
    const actionId = localActionId("test", inputDigest);
    return this.actions.withScope(scopeId, async () => {
      const worktree = await this.ensureWorktree(repositoryRoot, input.implementation.branch, scopeId);
      const previous = await this.actions.get(actionId);
      const baselineHead = previous?.baselineHead ?? await this.gitText(worktree, ["rev-parse", "HEAD"]);
      const record = await this.actions.prepare({
        actionId,
        kind: "test",
        workflowId: input.workflow.workflowId,
        scopeId,
        inputDigest,
        branch: input.implementation.branch,
        taskId: input.task.taskId,
        attempt: input.task.attempt,
        baselineHead
      });
      await this.assertCandidate(worktree, input.implementation.candidateDigest);
      if (record.phase === "completed") {
        const evidence = testerActionResult(record.result, input.implementation.candidateDigest, "codex-cli-independent-tester");
        await this.assertCandidate(worktree, input.implementation.candidateDigest, "tester_modified_candidate");
        return evidence;
      }
      let report: Readonly<{ status: "passed" | "failed"; raw: string }> | undefined;
      if (record.phase === "started") {
        report = await this.readIndependentTestReport(actionId);
        if (report === undefined) throw recoveryRequired("independent test");
      } else {
        await this.actions.start(actionId);
        report = await this.runIndependentTest(worktree, prompt, actionId);
      }
      await this.assertCandidate(worktree, input.implementation.candidateDigest, "tester_modified_candidate");
      const evidence = Object.freeze({
        testerId: "codex-cli-independent-tester",
        candidateDigest: input.implementation.candidateDigest,
        status: report.status,
        reportDigest: digestText(report.raw)
      });
      await this.actions.complete(actionId, evidence);
      return evidence;
    });
  }

'''
)

replace_between(
    "packages/node/src/dev/codex-cli-local-port.ts",
    "  async push(",
    "  async integrate(",
    '''  async push(input: Readonly<{
    workflow: DevAutonomousWorkflow;
    task: DevTaskRecord;
    implementation: DevImplementationCandidate;
    tester: DevTesterEvidence;
  }>): Promise<Readonly<{ branch: string; commitSha: string; candidateDigest: string }>> {
    this.requirePushOptIn();
    if (input.tester.status !== "passed" || input.tester.candidateDigest !== input.implementation.candidateDigest) {
      throw blocked("untested_candidate", "Only the independently tested candidate may be committed and pushed.");
    }
    const repositoryRoot = await this.verifiedRepositoryRoot();
    const scopeId = `task:${input.workflow.workflowId}:${input.task.taskId}`;
    const inputDigest = localInputDigest({
      workflowId: input.workflow.workflowId,
      taskId: input.task.taskId,
      attempt: input.task.attempt,
      branch: input.implementation.branch,
      candidateDigest: input.implementation.candidateDigest,
      testerReportDigest: input.tester.reportDigest
    });
    const actionId = localActionId("push", inputDigest);
    return this.actions.withScope(scopeId, async () => {
      const worktree = await this.ensureWorktree(repositoryRoot, input.implementation.branch, scopeId);
      const previous = await this.actions.get(actionId);
      const baselineHead = previous?.baselineHead ?? await this.gitText(worktree, ["rev-parse", "HEAD"]);
      const record = await this.actions.prepare({
        actionId,
        kind: "push",
        workflowId: input.workflow.workflowId,
        scopeId,
        inputDigest,
        branch: input.implementation.branch,
        taskId: input.task.taskId,
        attempt: input.task.attempt,
        baselineHead
      });
      if (record.phase === "completed") {
        const evidence = pushActionResult(record.result, input.implementation.branch, input.implementation.candidateDigest);
        await this.assertPushedResult(worktree, evidence);
        return evidence;
      }
      if (record.phase === "prepared") await this.actions.start(actionId);
      const evidence = await this.reconcileTaskPush(worktree, record, actionId, input);
      await this.actions.complete(actionId, evidence);
      return evidence;
    });
  }

'''
)

replace_between(
    "packages/node/src/dev/codex-cli-local-port.ts",
    "  async integrate(",
    "  async testIntegration(",
    '''  async integrate(input: Readonly<{
    workflow: DevAutonomousWorkflow;
    acceptedTasks: readonly DevTaskRecord[];
  }>): Promise<DevImplementationCandidate> {
    if (input.acceptedTasks.length === 0 || input.acceptedTasks.some(task => task.push === undefined)) {
      throw blocked("integration_evidence_missing", "Integration requires exact pushed SHAs for every accepted task.");
    }
    const repositoryRoot = await this.verifiedRepositoryRoot();
    const branch = integrationBranch(input.workflow);
    const scopeId = `integration:${input.workflow.workflowId}:${branch}`;
    const acceptedShas = input.acceptedTasks.map(task => task.push!.commitSha);
    for (const sha of acceptedShas) requireCommitSha(sha);
    const prompt = integrationPrompt(input.workflow, input.acceptedTasks);
    const inputDigest = localInputDigest({
      workflowId: input.workflow.workflowId,
      revision: input.workflow.revision,
      branch,
      acceptedShas,
      promptDigest: digestText(prompt)
    });
    const actionId = localActionId("integrate", inputDigest);
    return this.actions.withScope(scopeId, async () => {
      const worktree = await this.ensureWorktree(repositoryRoot, branch, scopeId);
      const previous = await this.actions.get(actionId);
      const baselineHead = previous?.baselineHead ?? await this.gitText(worktree, ["rev-parse", "HEAD"]);
      const record = await this.actions.prepare({
        actionId,
        kind: "integrate",
        workflowId: input.workflow.workflowId,
        scopeId,
        inputDigest,
        branch,
        baselineHead
      });
      if (record.phase === "completed") {
        const evidence = implementationActionResult(record.result, branch, "codex-cli-integrator");
        await this.assertCommittedCandidate(worktree, evidence.candidateDigest);
        return evidence;
      }
      if (record.phase === "started") {
        if (!(await this.readCodexCompletion(actionId))) throw recoveryRequired("integration");
      } else {
        const status = await this.gitText(worktree, ["status", "--porcelain=v1", "--untracked-files=normal"]);
        if (status !== "") throw blocked("integration_not_clean", "A fresh integration action requires a clean owned worktree.");
        await this.actions.start(actionId);
        for (const sha of acceptedShas) {
          if (await this.hasIntegratedSource(worktree, sha)) continue;
          const result = await this.gitRaw(worktree, ["cherry-pick", "-x", sha]);
          if (result.exitCode !== 0) {
            await this.gitRaw(worktree, ["cherry-pick", "--abort"]);
            throw blocked("integration_conflict", "Accepted task commits could not be integrated without a Git conflict.");
          }
        }
        const beforeCodex = await this.gitText(worktree, ["rev-parse", "HEAD"]);
        await this.runCodexAction(worktree, prompt, "integration", actionId);
        const afterCodex = await this.gitText(worktree, ["rev-parse", "HEAD"]);
        if (afterCodex !== beforeCodex) {
          throw blocked("codex_unexpected_commit", "Codex changed Git history during integration; the port will not guess how to recover.");
        }
      }
      await this.gitChecked(worktree, ["add", "--all"]);
      const staged = await this.gitRaw(worktree, ["diff", "--cached", "--quiet"]);
      if (staged.exitCode !== 0 && staged.exitCode !== 1) throw gitFailed();
      if (staged.exitCode === 1) {
        await this.gitChecked(worktree, [
          "commit",
          "-m",
          `chore(dev): integrate ${safeLabel(input.workflow.workflowId)}`,
          "-m",
          actionTrailer(actionId)
        ]);
      }
      await this.assertIntegrationHistory(worktree, baselineHead, actionId, acceptedShas);
      const evidence = Object.freeze({
        implementerId: "codex-cli-integrator",
        branch,
        candidateDigest: await this.committedCandidateDigest(worktree)
      });
      await this.actions.complete(actionId, evidence);
      return evidence;
    });
  }

'''
)

replace_between(
    "packages/node/src/dev/codex-cli-local-port.ts",
    "  async testIntegration(",
    "  async pushIntegration(",
    '''  async testIntegration(input: Readonly<{
    workflow: DevAutonomousWorkflow;
    implementation: DevImplementationCandidate;
  }>): Promise<DevTesterEvidence> {
    const repositoryRoot = await this.verifiedRepositoryRoot();
    const scopeId = `integration:${input.workflow.workflowId}:${input.implementation.branch}`;
    const prompt = integrationTestPrompt(input.workflow);
    const inputDigest = localInputDigest({
      workflowId: input.workflow.workflowId,
      branch: input.implementation.branch,
      candidateDigest: input.implementation.candidateDigest,
      promptDigest: digestText(prompt)
    });
    const actionId = localActionId("integration_test", inputDigest);
    return this.actions.withScope(scopeId, async () => {
      const worktree = await this.ensureWorktree(repositoryRoot, input.implementation.branch, scopeId);
      const previous = await this.actions.get(actionId);
      const baselineHead = previous?.baselineHead ?? await this.gitText(worktree, ["rev-parse", "HEAD"]);
      const record = await this.actions.prepare({
        actionId,
        kind: "integration_test",
        workflowId: input.workflow.workflowId,
        scopeId,
        inputDigest,
        branch: input.implementation.branch,
        baselineHead
      });
      await this.assertCommittedCandidate(worktree, input.implementation.candidateDigest);
      if (record.phase === "completed") {
        const evidence = testerActionResult(record.result, input.implementation.candidateDigest, "codex-cli-integration-tester");
        await this.assertCommittedCandidate(worktree, input.implementation.candidateDigest, "tester_modified_candidate");
        return evidence;
      }
      let report: Readonly<{ status: "passed" | "failed"; raw: string }> | undefined;
      if (record.phase === "started") {
        report = await this.readIndependentTestReport(actionId);
        if (report === undefined) throw recoveryRequired("integration test");
      } else {
        await this.actions.start(actionId);
        report = await this.runIndependentTest(worktree, prompt, actionId);
      }
      await this.assertCommittedCandidate(worktree, input.implementation.candidateDigest, "tester_modified_candidate");
      const evidence = Object.freeze({
        testerId: "codex-cli-integration-tester",
        candidateDigest: input.implementation.candidateDigest,
        status: report.status,
        reportDigest: digestText(report.raw)
      });
      await this.actions.complete(actionId, evidence);
      return evidence;
    });
  }

'''
)

replace_between(
    "packages/node/src/dev/codex-cli-local-port.ts",
    "  async pushIntegration(",
    "  private async verifiedRepositoryRoot",
    '''  async pushIntegration(input: Readonly<{
    workflow: DevAutonomousWorkflow;
    implementation: DevImplementationCandidate;
    tester: DevTesterEvidence;
  }>): Promise<Readonly<{ branch: string; commitSha: string; candidateDigest: string }>> {
    this.requirePushOptIn();
    if (input.tester.status !== "passed" || input.tester.candidateDigest !== input.implementation.candidateDigest) {
      throw blocked("untested_candidate", "Only the independently tested integration candidate may be pushed.");
    }
    const repositoryRoot = await this.verifiedRepositoryRoot();
    const scopeId = `integration:${input.workflow.workflowId}:${input.implementation.branch}`;
    const inputDigest = localInputDigest({
      workflowId: input.workflow.workflowId,
      branch: input.implementation.branch,
      candidateDigest: input.implementation.candidateDigest,
      testerReportDigest: input.tester.reportDigest
    });
    const actionId = localActionId("integration_push", inputDigest);
    return this.actions.withScope(scopeId, async () => {
      const worktree = await this.ensureWorktree(repositoryRoot, input.implementation.branch, scopeId);
      const previous = await this.actions.get(actionId);
      const baselineHead = previous?.baselineHead ?? await this.gitText(worktree, ["rev-parse", "HEAD"]);
      const record = await this.actions.prepare({
        actionId,
        kind: "integration_push",
        workflowId: input.workflow.workflowId,
        scopeId,
        inputDigest,
        branch: input.implementation.branch,
        baselineHead
      });
      if (record.phase === "completed") {
        const evidence = pushActionResult(record.result, input.implementation.branch, input.implementation.candidateDigest);
        await this.assertPushedResult(worktree, evidence);
        return evidence;
      }
      if (record.phase === "prepared") await this.actions.start(actionId);
      await this.assertCommittedCandidate(worktree, input.implementation.candidateDigest);
      const commitSha = await this.gitText(worktree, ["rev-parse", "HEAD"]);
      if (commitSha !== baselineHead) throw recoveryRequired("integration push");
      requireCommitSha(commitSha);
      await this.ensureRemoteCommit(worktree, input.implementation.branch, commitSha);
      const evidence = Object.freeze({
        branch: input.implementation.branch,
        commitSha,
        candidateDigest: input.implementation.candidateDigest
      });
      await this.actions.complete(actionId, evidence);
      return evidence;
    });
  }

  private async assertImplementationRecovery(
    worktree: string,
    record: DevAutonomousLocalActionRecord,
    evidence: DevImplementationCandidate
  ): Promise<void> {
    const currentHead = await this.gitText(worktree, ["rev-parse", "HEAD"]);
    if (record.baselineHead === undefined || currentHead !== record.baselineHead) throw recoveryRequired("implementation receipt");
    await this.assertCandidate(worktree, evidence.candidateDigest);
  }

  private async reconcileTaskPush(
    worktree: string,
    record: DevAutonomousLocalActionRecord,
    actionId: string,
    input: Readonly<{
      workflow: DevAutonomousWorkflow;
      task: DevTaskRecord;
      implementation: DevImplementationCandidate;
      tester: DevTesterEvidence;
    }>
  ): Promise<Readonly<{ branch: string; commitSha: string; candidateDigest: string }>> {
    const baselineHead = record.baselineHead;
    if (baselineHead === undefined) throw recoveryRequired("task push");
    let currentHead = await this.gitText(worktree, ["rev-parse", "HEAD"]);
    if (currentHead === baselineHead) {
      await this.assertCandidate(worktree, input.implementation.candidateDigest);
      await this.gitChecked(worktree, ["add", "--all"]);
      const staged = await this.gitRaw(worktree, ["diff", "--cached", "--quiet"]);
      if (staged.exitCode !== 0 && staged.exitCode !== 1) throw gitFailed();
      if (staged.exitCode === 1) {
        await this.gitChecked(worktree, [
          "commit",
          "-m",
          commitMessage(input.task.taskId, input.task.title),
          "-m",
          actionTrailer(actionId)
        ]);
        currentHead = await this.gitText(worktree, ["rev-parse", "HEAD"]);
      }
    } else if (!(await this.isActionCommit(worktree, currentHead, baselineHead, actionId))) {
      throw recoveryRequired("task push");
    }
    requireCommitSha(currentHead);
    const status = await this.gitText(worktree, ["status", "--porcelain=v1", "--untracked-files=normal"]);
    if (status !== "") throw recoveryRequired("task push");
    await this.ensureRemoteCommit(worktree, input.implementation.branch, currentHead);
    return Object.freeze({
      branch: input.implementation.branch,
      commitSha: currentHead,
      candidateDigest: input.implementation.candidateDigest
    });
  }

  private async isActionCommit(worktree: string, head: string, parent: string, actionId: string): Promise<boolean> {
    const actualParent = await this.gitText(worktree, ["rev-parse", `${head}^`]);
    if (actualParent !== parent) return false;
    const body = await this.gitText(worktree, ["show", "-s", "--format=%B", head], false);
    return body.split(/\\r?\\n/u).includes(actionTrailer(actionId));
  }

  private async ensureRemoteCommit(worktree: string, branch: string, commitSha: string): Promise<void> {
    const remote = await this.remoteBranchSha(worktree, branch);
    if (remote === commitSha) return;
    if (remote !== undefined) {
      const ancestor = await this.gitRaw(worktree, ["merge-base", "--is-ancestor", remote, commitSha]);
      if (ancestor.exitCode === 1) throw blocked("remote_branch_diverged", "The remote autonomous branch no longer points to an ancestor of the exact tested commit.");
      if (ancestor.exitCode !== 0) throw blocked("remote_branch_unverifiable", "The remote autonomous branch could not be verified as a safe fast-forward base.");
    }
    await this.gitChecked(worktree, ["push", "--set-upstream", this.remote, `${commitSha}:refs/heads/${branch}`]);
    const verified = await this.remoteBranchSha(worktree, branch);
    if (verified !== commitSha) throw blocked("git_push_unverified", "The remote autonomous branch did not verify at the exact pushed commit SHA.");
  }

  private async remoteBranchSha(worktree: string, branch: string): Promise<string | undefined> {
    const result = await this.gitChecked(worktree, ["ls-remote", "--heads", this.remote, `refs/heads/${branch}`]);
    const lines = result.stdout.trim().split(/\\r?\\n/u).filter(Boolean);
    if (lines.length === 0) return undefined;
    if (lines.length !== 1) throw blocked("remote_branch_unverifiable", "The remote returned ambiguous branch identity.");
    const sha = lines[0]!.split(/\\s+/u)[0];
    if (sha === undefined) throw blocked("remote_branch_unverifiable", "The remote branch SHA is unavailable.");
    requireCommitSha(sha);
    return sha;
  }

  private async assertPushedResult(
    worktree: string,
    evidence: Readonly<{ branch: string; commitSha: string; candidateDigest: string }>
  ): Promise<void> {
    const currentHead = await this.gitText(worktree, ["rev-parse", "HEAD"]);
    if (currentHead !== evidence.commitSha) throw recoveryRequired("push receipt");
    const remote = await this.remoteBranchSha(worktree, evidence.branch);
    if (remote !== evidence.commitSha) throw recoveryRequired("push receipt");
  }

  private async hasIntegratedSource(worktree: string, sha: string): Promise<boolean> {
    const ancestor = await this.gitRaw(worktree, ["merge-base", "--is-ancestor", sha, "HEAD"]);
    if (ancestor.exitCode === 0) return true;
    if (ancestor.exitCode !== 1) throw gitFailed();
    const needle = `(cherry picked from commit ${sha})`;
    const log = await this.gitText(worktree, ["log", "-1", "--format=%H", "--fixed-strings", `--grep=${needle}`, "HEAD"]);
    return log !== "";
  }

  private async assertIntegrationHistory(
    worktree: string,
    baselineHead: string,
    actionId: string,
    acceptedShas: readonly string[]
  ): Promise<void> {
    const log = await this.gitText(worktree, ["log", "--format=%B%x00", `${baselineHead}..HEAD`], false);
    const commits = log.split("\\0").map(value => value.trim()).filter(Boolean);
    const action = actionTrailer(actionId);
    for (const body of commits) {
      const source = acceptedShas.some(sha => body.includes(`(cherry picked from commit ${sha})`));
      const owned = body.split(/\\r?\\n/u).includes(action);
      if (!source && !owned) throw recoveryRequired("integration history");
    }
    for (const sha of acceptedShas) {
      if (!(await this.hasIntegratedSource(worktree, sha))) throw recoveryRequired("integration history");
    }
  }

'''
)

# Replace Codex/test process helpers with structured, durable completion files.
replace_between(
    "packages/node/src/dev/codex-cli-local-port.ts",
    "  private async codex(",
    "  private async candidateDigest",
    '''  private async runCodexAction(worktree: string, prompt: string, role: string, actionId: string): Promise<void> {
    boundedPrompt(prompt);
    const schemaRoot = resolve(this.stateRoot, "schemas");
    const resultRoot = resolve(this.stateRoot, "action-results");
    await mkdir(schemaRoot, { recursive: true, mode: 0o700 });
    await mkdir(resultRoot, { recursive: true, mode: 0o700 });
    const schemaPath = resolve(schemaRoot, "codex-action-completion.json");
    const resultPath = this.actionResultPath(resultRoot, actionId, "codex");
    await writeFile(schemaPath, JSON.stringify(CODEX_ACTION_RESULT_SCHEMA), { encoding: "utf8", mode: 0o600 });
    await rm(resultPath, { force: true });
    const args = [
      "exec", "--cd", worktree, "--sandbox", "workspace-write", "--ephemeral", "--color", "never",
      "--output-schema", schemaPath,
      "--output-last-message", resultPath
    ];
    if (this.model !== undefined) args.push("--model", this.model);
    if (this.profile !== undefined) args.push("--profile", this.profile);
    args.push(prompt);
    const result = await this.safeRun(this.codexExecutable, args, worktree, codexEnvironment());
    if (result.exitCode !== 0) {
      await rm(resultPath, { force: true });
      throw blocked("codex_cli_failed", `The isolated Codex ${safeLabel(role)} session did not complete successfully.`);
    }
    if (!(await this.readCodexCompletion(actionId))) {
      throw blocked("codex_completion_unverified", "Codex exited successfully without its required structured completion evidence.");
    }
  }

  private async readCodexCompletion(actionId: string): Promise<boolean> {
    const resultRoot = resolve(this.stateRoot, "action-results");
    const resultPath = this.actionResultPath(resultRoot, actionId, "codex");
    let raw: string;
    try {
      const metadata = await lstat(resultPath);
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw recoveryRequired("Codex completion marker");
      raw = await readFile(resultPath, "utf8");
    } catch (error) {
      if (nodeErrorCode(error) === "ENOENT") return false;
      if (error instanceof PortError) throw error;
      throw recoveryRequired("Codex completion marker");
    }
    if (raw.length === 0 || raw.length > 16_384) throw recoveryRequired("Codex completion marker");
    let value: unknown;
    try { value = JSON.parse(raw); } catch { throw recoveryRequired("Codex completion marker"); }
    return isRecord(value) && Object.keys(value).length === 1 && value.status === "completed";
  }

  private async runIndependentTest(
    worktree: string,
    prompt: string,
    actionId: string
  ): Promise<Readonly<{ status: "passed" | "failed"; raw: string }>> {
    boundedPrompt(prompt);
    const schemaRoot = resolve(this.stateRoot, "schemas");
    const resultRoot = resolve(this.stateRoot, "action-results");
    await mkdir(schemaRoot, { recursive: true, mode: 0o700 });
    await mkdir(resultRoot, { recursive: true, mode: 0o700 });
    const schemaPath = resolve(schemaRoot, "independent-test-result.json");
    const reportPath = this.actionResultPath(resultRoot, actionId, "test");
    await writeFile(schemaPath, JSON.stringify(TEST_RESULT_SCHEMA), { encoding: "utf8", mode: 0o600 });
    await rm(reportPath, { force: true });
    const args = [
      "exec", "--cd", worktree, "--sandbox", "workspace-write", "--ephemeral", "--color", "never",
      "--output-schema", schemaPath,
      "--output-last-message", reportPath
    ];
    if (this.model !== undefined) args.push("--model", this.model);
    if (this.profile !== undefined) args.push("--profile", this.profile);
    args.push(prompt);
    const result = await this.safeRun(this.codexExecutable, args, worktree, codexEnvironment());
    if (result.exitCode !== 0) {
      await rm(reportPath, { force: true });
      throw blocked("codex_test_failed", "The independent Codex tester process did not complete successfully.");
    }
    const report = await this.readIndependentTestReport(actionId);
    if (report === undefined) throw blocked("tester_output_invalid", "The independent tester did not produce its required structured result.");
    return report;
  }

  private async readIndependentTestReport(
    actionId: string
  ): Promise<Readonly<{ status: "passed" | "failed"; raw: string }> | undefined> {
    const resultRoot = resolve(this.stateRoot, "action-results");
    const reportPath = this.actionResultPath(resultRoot, actionId, "test");
    let raw: string;
    try {
      const metadata = await lstat(reportPath);
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw recoveryRequired("independent test report");
      raw = await readFile(reportPath, "utf8");
    } catch (error) {
      if (nodeErrorCode(error) === "ENOENT") return undefined;
      if (error instanceof PortError) throw error;
      throw recoveryRequired("independent test report");
    }
    if (raw.length === 0 || raw.length > 65_536) throw recoveryRequired("independent test report");
    let value: unknown;
    try { value = JSON.parse(raw); } catch { throw recoveryRequired("independent test report"); }
    if (
      !isRecord(value)
      || Object.keys(value).sort().join(",") !== "status,summary"
      || (value.status !== "passed" && value.status !== "failed")
      || typeof value.summary !== "string"
      || value.summary.length === 0
      || value.summary.length > 32_768
    ) throw recoveryRequired("independent test report");
    return Object.freeze({ status: value.status, raw });
  }

  private actionResultPath(root: string, actionId: string, suffix: string): string {
    const path = resolve(root, `${createHash("sha256").update(`${actionId}:${suffix}`, "utf8").digest("hex")}.json`);
    if (!inside(root, path)) throw blocked("state_path_invalid", "Local action result path escaped the autonomous state root.");
    return path;
  }

'''
)

replace_once(
    "packages/node/src/dev/index.ts",
    'export * from "./autonomous-planning-store.js";\n',
    'export * from "./autonomous-planning-store.js";\nexport * from "./autonomous-local-action-store.js";\n',
)

# Add completion schema and stable helper functions without widening behavior.
replace_once(
    "packages/node/src/dev/codex-cli-local-port.ts",
    'const TEST_RESULT_SCHEMA = Object.freeze({\n',
    'const CODEX_ACTION_RESULT_SCHEMA = Object.freeze({\n'
    '  type: "object",\n'
    '  additionalProperties: false,\n'
    '  required: ["status"],\n'
    '  properties: { status: { type: "string", enum: ["completed"] } }\n'
    '});\n\n'
    'const TEST_RESULT_SCHEMA = Object.freeze({\n',
)
replace_once(
    "packages/node/src/dev/codex-cli-local-port.ts",
    'function implementationPrompt(workflow: DevAutonomousWorkflow, task: DevTaskRecord, guidance: string): string {\n',
    '''function localInputDigest(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > 1024 * 1024) {
    throw blocked("local_action_input_invalid", "Autonomous local action identity exceeded its bounded canonical input.");
  }
  return digestText(encoded);
}

function localActionId(kind: string, inputDigest: string): string {
  return `dev-local-${safeRefPart(kind)}-${createHash("sha256").update(inputDigest, "utf8").digest("hex").slice(0, 48)}`;
}

function actionTrailer(actionId: string): string {
  return `Dev-Autonomous-Action: ${actionId}`;
}

function recoveryRequired(label: string): PortError {
  return blocked(
    "local_action_recovery_required",
    `The ${safeLabel(label)} crossed a local mutation boundary without enough durable evidence to retry safely. Inspect the owned worktree/action journal before resuming.`
  );
}

function implementationActionResult(
  value: unknown,
  branch: string,
  implementerId = "codex-cli-implementer"
): DevImplementationCandidate {
  if (!isRecord(value) || value.implementerId !== implementerId || value.branch !== branch || !canonicalDigest(value.candidateDigest)) {
    throw recoveryRequired("implementation receipt");
  }
  return Object.freeze({ implementerId, branch, candidateDigest: value.candidateDigest });
}

function testerActionResult(value: unknown, candidateDigest: string, testerId: string): DevTesterEvidence {
  if (
    !isRecord(value)
    || value.testerId !== testerId
    || value.candidateDigest !== candidateDigest
    || (value.status !== "passed" && value.status !== "failed")
    || !canonicalDigest(value.reportDigest)
  ) throw recoveryRequired("tester receipt");
  return Object.freeze({ testerId, candidateDigest, status: value.status, reportDigest: value.reportDigest });
}

function pushActionResult(
  value: unknown,
  branch: string,
  candidateDigest: string
): Readonly<{ branch: string; commitSha: string; candidateDigest: string }> {
  if (!isRecord(value) || value.branch !== branch || value.candidateDigest !== candidateDigest || typeof value.commitSha !== "string") {
    throw recoveryRequired("push receipt");
  }
  requireCommitSha(value.commitSha);
  return Object.freeze({ branch, commitSha: value.commitSha, candidateDigest });
}

function canonicalDigest(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function implementationPrompt(workflow: DevAutonomousWorkflow, task: DevTaskRecord, guidance: string): string {
''',
)

# Existing fake Codex test runner must emit the schema matching each isolated
# role now that implementation/integration also use structured completion.
replace_once(
    "packages/node/tests/unit/dev-codex-cli-local-port.test.ts",
    '        await writeFile(output, JSON.stringify({ status: "passed", summary: "independently verified" }), "utf8");\n',
    '        const payload = prompt.includes("independent testing agent") || prompt.includes("independent integration tester")\n'
    '          ? { status: "passed", summary: "independently verified" }\n'
    '          : { status: "completed" };\n'
    '        await writeFile(output, JSON.stringify(payload), "utf8");\n',
)
