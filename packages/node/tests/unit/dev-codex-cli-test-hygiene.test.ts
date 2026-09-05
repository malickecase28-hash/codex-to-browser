import { describe, expect, it, vi } from "vitest";
import {
  createCodexCliHygienicProcessRunner
} from "../../src/dev/codex-cli-safe-local-port.js";
import type {
  CodexCliLocalProcessResult,
  CodexCliLocalProcessRunner
} from "../../src/dev/codex-cli-local-port.js";

const runOptions = Object.freeze({
  cwd: "/tmp/owned-worktree",
  timeoutMs: 300_000,
  maxOutputBytes: 4 * 1024 * 1024,
  env: Object.freeze({ PATH: process.env.PATH })
});

function ok(): CodexCliLocalProcessResult {
  return Object.freeze({ exitCode: 0, stdout: "", stderr: "" });
}

describe("public Codex independent-test hygiene", () => {
  it("does not clean around implementation sessions", async () => {
    const delegate = vi.fn<CodexCliLocalProcessRunner>(async () => ok());
    const runner = createCodexCliHygienicProcessRunner({
      gitExecutable: "git-custom",
      processRunner: delegate
    });

    await runner("codex", [
      "exec",
      "--cd",
      runOptions.cwd,
      "You are the local implementation agent in an autonomous development workflow."
    ], runOptions);

    expect(delegate).toHaveBeenCalledTimes(1);
    expect(delegate.mock.calls[0]?.[0]).toBe("codex");
  });

  it("removes ignored artifacts before and after an independent task tester", async () => {
    const calls: Array<readonly [string, readonly string[]]> = [];
    const delegate: CodexCliLocalProcessRunner = async (executable, args) => {
      calls.push([executable, [...args]]);
      return ok();
    };
    const runner = createCodexCliHygienicProcessRunner({
      gitExecutable: "git-custom",
      processRunner: delegate
    });

    await runner("codex", [
      "exec",
      "--cd",
      runOptions.cwd,
      "You are the independent testing agent. You did not implement this candidate."
    ], runOptions);

    expect(calls).toEqual([
      ["git-custom", ["clean", "-fdX", "--"]],
      ["codex", [
        "exec",
        "--cd",
        runOptions.cwd,
        "You are the independent testing agent. You did not implement this candidate."
      ]],
      ["git-custom", ["clean", "-fdX", "--"]]
    ]);
  });

  it("applies the same hygiene to integration testing", async () => {
    const executables: string[] = [];
    const delegate: CodexCliLocalProcessRunner = async (executable) => {
      executables.push(executable);
      return ok();
    };
    const runner = createCodexCliHygienicProcessRunner({
      processRunner: delegate
    });

    await runner("codex", [
      "exec",
      "You are the independent integration tester. You did not implement the task candidates or integration candidate."
    ], runOptions);

    expect(executables).toEqual(["git", "codex", "git"]);
  });

  it("still cleans ignored artifacts when the independent tester process throws", async () => {
    const calls: string[] = [];
    const delegate: CodexCliLocalProcessRunner = async (executable, args) => {
      calls.push(`${executable}:${args[0] ?? ""}`);
      if (executable === "codex") throw new Error("tester process failed");
      return ok();
    };
    const runner = createCodexCliHygienicProcessRunner({ processRunner: delegate });

    await expect(runner("codex", [
      "exec",
      "You are the independent testing agent. You did not implement this candidate."
    ], runOptions)).rejects.toThrow("tester process failed");

    expect(calls).toEqual(["git:clean", "codex:exec", "git:clean"]);
  });
});
