import type { DevAutonomousLocalPort } from "./autonomous-engine.js";
import type { DevAutonomousWorkflow, DevImplementationCandidate, DevTaskRecord, DevTesterEvidence } from "./autonomous-workflow.js";
import { FileDevAutonomousLocalActionStore } from "./autonomous-local-action-store.js";
export type CodexCliLocalProcessResult = Readonly<{
    exitCode: number;
    stdout: string;
    stderr: string;
}>;
export type CodexCliLocalProcessRunner = (executable: string, args: readonly string[], options: Readonly<{
    cwd: string;
    timeoutMs: number;
    maxOutputBytes: number;
    env: NodeJS.ProcessEnv;
}>) => Promise<CodexCliLocalProcessResult>;
export type CodexCliAutonomousLocalPortOptions = Readonly<{
    /** Repository that Codex is allowed to edit. Defaults to process.cwd(). */
    repositoryRoot?: string;
    /** Durable local orchestration files and owned Git worktrees. */
    stateRoot?: string;
    /** Codex CLI executable name/path. */
    codexExecutable?: string;
    /** Git executable name/path. */
    gitExecutable?: string;
    /** Git ref used when creating a fresh task/integration branch. */
    baseRef?: string;
    /** Remote used by push operations. Defaults to origin. */
    remote?: string;
    /** Explicit opt-in required before this port performs any Git network push. */
    allowPush?: boolean;
    /** Optional Codex model selection passed as --model. */
    model?: string;
    /** Optional Codex configuration profile passed as --profile. */
    profile?: string;
    timeoutMs?: number;
    maxOutputBytes?: number;
    /** Optional durable action journal override. */
    actionStore?: FileDevAutonomousLocalActionStore;
    /** Test seam. Production callers normally leave this unset. */
    processRunner?: CodexCliLocalProcessRunner;
}>;
/**
 * Local Codex/Git implementation port for the autonomous engine.
 *
 * Safety properties:
 * - invokes executables directly with shell=false semantics;
 * - confines Codex to an owned Git worktree using the workspace-write sandbox;
 * - never enables Codex approval/sandbox bypass flags;
 * - keeps implementation and independent testing in separate Codex sessions;
 * - detects candidate mutation by the tester;
 * - never force-pushes and requires explicit allowPush=true for Git network writes.
 */
export declare class CodexCliAutonomousLocalPort implements DevAutonomousLocalPort {
    private readonly repositoryRoot;
    private readonly stateRoot;
    private readonly codexExecutable;
    private readonly gitExecutable;
    private readonly baseRef;
    private readonly remote;
    private readonly allowPush;
    private readonly model;
    private readonly profile;
    private readonly timeoutMs;
    private readonly maxOutputBytes;
    private readonly runProcess;
    readonly actions: FileDevAutonomousLocalActionStore;
    constructor(options?: CodexCliAutonomousLocalPortOptions);
    readTaskTestFailure(input: Readonly<{
        workflow: DevAutonomousWorkflow;
        task: DevTaskRecord;
    }>): Promise<Readonly<{
        summary: string;
    }>>;
    implement(input: Readonly<{
        workflow: DevAutonomousWorkflow;
        task: DevTaskRecord;
        guidance: string;
    }>): Promise<DevImplementationCandidate>;
    test(input: Readonly<{
        workflow: DevAutonomousWorkflow;
        task: DevTaskRecord;
        implementation: DevImplementationCandidate;
    }>): Promise<DevTesterEvidence>;
    push(input: Readonly<{
        workflow: DevAutonomousWorkflow;
        task: DevTaskRecord;
        implementation: DevImplementationCandidate;
        tester: DevTesterEvidence;
    }>): Promise<Readonly<{
        branch: string;
        commitSha: string;
        candidateDigest: string;
    }>>;
    integrate(input: Readonly<{
        workflow: DevAutonomousWorkflow;
        acceptedTasks: readonly DevTaskRecord[];
        revisionGuidance?: string;
    }>): Promise<DevImplementationCandidate>;
    testIntegration(input: Readonly<{
        workflow: DevAutonomousWorkflow;
        implementation: DevImplementationCandidate;
    }>): Promise<DevTesterEvidence>;
    pushIntegration(input: Readonly<{
        workflow: DevAutonomousWorkflow;
        implementation: DevImplementationCandidate;
        tester: DevTesterEvidence;
    }>): Promise<Readonly<{
        branch: string;
        commitSha: string;
        candidateDigest: string;
    }>>;
    private integrationTestFailureFeedback;
    private assertImplementationRecovery;
    private reconcileTaskPush;
    private isActionCommit;
    private ensureRemoteCommit;
    private remoteBranchSha;
    private assertPushedResult;
    private hasIntegratedSource;
    private assertIntegrationHistory;
    private withActionScope;
    private verifiedRepositoryRoot;
    private taskBranch;
    private ensureWorktree;
    private runCodexAction;
    private readCodexCompletion;
    private runIndependentTest;
    private readIndependentTestReport;
    private actionResultPath;
    private candidateDigest;
    private committedCandidateDigest;
    private assertCandidate;
    private assertCommittedCandidate;
    private requirePushOptIn;
    private gitChecked;
    private gitText;
    private gitRaw;
    private safeRun;
}
export declare function createCodexCliAutonomousLocalPort(options?: CodexCliAutonomousLocalPortOptions): CodexCliAutonomousLocalPort;
