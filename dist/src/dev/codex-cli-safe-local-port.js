import { spawn } from "node:child_process";
import { CodexCliAutonomousLocalPort as CoreCodexCliAutonomousLocalPort } from "./codex-cli-local-port.js";
const HYGIENE_TIMEOUT_MS = 120_000;
const HYGIENE_OUTPUT_BYTES = 1024 * 1024;
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
export class CodexCliAutonomousLocalPort extends CoreCodexCliAutonomousLocalPort {
    constructor(options = {}) {
        super({
            ...options,
            processRunner: createCodexCliHygienicProcessRunner(options)
        });
    }
}
export function createCodexCliAutonomousLocalPort(options = {}) {
    return new CodexCliAutonomousLocalPort(options);
}
/** Testable composition seam used by the public hardened constructor. */
export function createCodexCliHygienicProcessRunner(options = {}) {
    const delegate = options.processRunner ?? defaultProcessRunner;
    const gitExecutable = options.gitExecutable ?? "git";
    return async (executable, args, runOptions) => {
        if (!isIndependentTesterInvocation(args)) {
            return delegate(executable, args, runOptions);
        }
        await cleanIgnoredArtifacts(delegate, gitExecutable, runOptions);
        try {
            return await delegate(executable, args, runOptions);
        }
        finally {
            await cleanIgnoredArtifacts(delegate, gitExecutable, runOptions);
        }
    };
}
function isIndependentTesterInvocation(args) {
    if (args[0] !== "exec")
        return false;
    const prompt = args.at(-1);
    return typeof prompt === "string" && (prompt.startsWith("You are the independent testing agent.")
        || prompt.startsWith("You are the independent integration tester."));
}
async function cleanIgnoredArtifacts(runner, gitExecutable, runOptions) {
    const result = await runner(gitExecutable, ["clean", "-fdX", "--"], {
        cwd: runOptions.cwd,
        timeoutMs: Math.min(runOptions.timeoutMs, HYGIENE_TIMEOUT_MS),
        maxOutputBytes: Math.min(runOptions.maxOutputBytes, HYGIENE_OUTPUT_BYTES),
        env: runOptions.env
    });
    if (result.exitCode !== 0) {
        throw new Error("independent-test ignored-artifact cleanup failed");
    }
}
async function defaultProcessRunner(executable, args, options) {
    return new Promise((resolveResult, reject) => {
        const child = spawn(executable, [...args], {
            cwd: options.cwd,
            env: options.env,
            shell: false,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"]
        });
        const stdout = [];
        const stderr = [];
        let outputBytes = 0;
        let settled = false;
        const timer = setTimeout(() => {
            child.kill();
            if (!settled) {
                settled = true;
                reject(new Error("local process timed out"));
            }
        }, options.timeoutMs);
        timer.unref?.();
        const append = (target, chunk) => {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            outputBytes += buffer.byteLength;
            if (outputBytes > options.maxOutputBytes) {
                child.kill();
                if (!settled) {
                    settled = true;
                    clearTimeout(timer);
                    reject(new Error("local process output exceeded limit"));
                }
                return;
            }
            target.push(buffer);
        };
        child.stdout?.on("data", chunk => append(stdout, chunk));
        child.stderr?.on("data", chunk => append(stderr, chunk));
        child.once("error", error => {
            clearTimeout(timer);
            if (!settled) {
                settled = true;
                reject(error);
            }
        });
        child.once("close", code => {
            clearTimeout(timer);
            if (settled)
                return;
            settled = true;
            resolveResult(Object.freeze({
                exitCode: typeof code === "number" ? code : 1,
                stdout: Buffer.concat(stdout).toString("utf8"),
                stderr: Buffer.concat(stderr).toString("utf8")
            }));
        });
    });
}
