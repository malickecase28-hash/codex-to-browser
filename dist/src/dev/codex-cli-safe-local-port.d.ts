import { CodexCliAutonomousLocalPort as CoreCodexCliAutonomousLocalPort, type CodexCliAutonomousLocalPortOptions, type CodexCliLocalProcessRunner } from "./codex-cli-local-port.js";
/**
 * Public Codex local port with reproducible independent-test boundaries.
 *
 * The core port deliberately excludes ignored files from candidate digests.
 * Before and after every independent task/integration tester session, this
 * wrapper removes only ignored, untracked files (`git clean -fdX --`) from the
 * owned worktree. Tracked files and non-ignored candidate files are preserved.
 * This prevents implementation-generated caches, dependency trees, build
 * output, or local secret files from becoming invisible acceptance evidence.
 */
export declare class CodexCliAutonomousLocalPort extends CoreCodexCliAutonomousLocalPort {
    constructor(options?: CodexCliAutonomousLocalPortOptions);
}
export declare function createCodexCliAutonomousLocalPort(options?: CodexCliAutonomousLocalPortOptions): CodexCliAutonomousLocalPort;
/** Testable composition seam used by the public hardened constructor. */
export declare function createCodexCliHygienicProcessRunner(options?: Pick<CodexCliAutonomousLocalPortOptions, "gitExecutable" | "processRunner">): CodexCliLocalProcessRunner;
