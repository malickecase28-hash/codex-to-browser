from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected one patch site in {path}, found {count}")
    file.write_text(text.replace(old, new, 1), encoding="utf-8")


# First-run worktree creation must not invoke Git with a non-existent cwd.
replace_once(
    "packages/node/src/dev/codex-cli-local-port.ts",
    '''    const existing = await this.gitRaw(path, ["rev-parse", "--show-toplevel"]);\n    if (existing.exitCode === 0) {\n      const observed = resolve(existing.stdout.trim());\n      if (observed !== path) throw blocked("worktree_mismatch", "An existing autonomous worktree has an unexpected Git root.");\n      const currentBranch = await this.gitText(path, ["branch", "--show-current"]);\n      if (currentBranch !== branch) throw blocked("worktree_mismatch", "An existing autonomous worktree is bound to a different branch.");\n      return path;\n    }\n\n    try {\n      const stat = await lstat(path);\n      if (stat.isDirectory()) await rm(path, { recursive: true, force: true });\n      else throw blocked("worktree_mismatch", "The owned worktree path is occupied by a non-directory entry.");\n    } catch (error) {\n      if (error instanceof PortError) throw error;\n    }\n''',
    '''    let pathState: "missing" | "directory" | "occupied" = "missing";\n    try {\n      pathState = (await lstat(path)).isDirectory() ? "directory" : "occupied";\n    } catch {\n      pathState = "missing";\n    }\n    if (pathState === "occupied") {\n      throw blocked("worktree_mismatch", "The owned worktree path is occupied by a non-directory entry.");\n    }\n    if (pathState === "directory") {\n      const existing = await this.gitRaw(path, ["rev-parse", "--show-toplevel"]);\n      if (existing.exitCode === 0) {\n        const observed = resolve(existing.stdout.trim());\n        if (observed !== path) throw blocked("worktree_mismatch", "An existing autonomous worktree has an unexpected Git root.");\n        const currentBranch = await this.gitText(path, ["branch", "--show-current"]);\n        if (currentBranch !== branch) throw blocked("worktree_mismatch", "An existing autonomous worktree is bound to a different branch.");\n        return path;\n      }\n      await rm(path, { recursive: true, force: true });\n    }\n''',
)

# Make the concrete local port part of the public dev SDK.
replace_once(
    "packages/node/src/dev/index.ts",
    'export * from "./autonomous-api.js";\nexport * from "./plugin-bridge.js";\n',
    'export * from "./autonomous-api.js";\nexport * from "./codex-cli-local-port.js";\nexport * from "./plugin-bridge.js";\n',
)

# Explicit localCodex opt-in constructs the safe concrete local port.
replace_once(
    "packages/node/src/dev/client.ts",
    'import type { DevAutonomousLocalPort } from "./autonomous-engine.js";\n',
    'import type { DevAutonomousLocalPort } from "./autonomous-engine.js";\nimport {\n  createCodexCliAutonomousLocalPort,\n  type CodexCliAutonomousLocalPortOptions\n} from "./codex-cli-local-port.js";\n',
)
replace_once(
    "packages/node/src/dev/client.ts",
    '''export type DevAutonomousClientOptions = Readonly<{\n  stateRoot?: string;\n  maxParallelTasks?: number;\n  local?: DevAutonomousLocalPort;\n  chat?: Omit<ChatGPTAutonomousPortOptions, "stateRoot">;\n}>;''',
    '''export type DevAutonomousClientOptions = Readonly<{\n  stateRoot?: string;\n  maxParallelTasks?: number;\n  /** Fully custom local implementation/test/push port. */\n  local?: DevAutonomousLocalPort;\n  /** Opt into the packaged Codex CLI local port. Git push still requires allowPush: true. */\n  localCodex?: CodexCliAutonomousLocalPortOptions;\n  chat?: Omit<ChatGPTAutonomousPortOptions, "stateRoot">;\n}>;''',
)
replace_once(
    "packages/node/src/dev/client.ts",
    '''  const chat = new ChatGPTAutonomousPort(base, {\n    ...(autonomousOptions?.chat ?? {}),\n    stateRoot: join(autonomousRoot, "chat")\n  });\n  const store = new FileDevAutonomousWorkflowStore({\n    stateRoot: join(autonomousRoot, "workflows")\n  });\n  const autonomous = createDevAutonomousApi({\n    store,\n    chat,\n    ...(autonomousOptions?.local === undefined ? {} : { local: autonomousOptions.local }),\n    ...(autonomousOptions?.maxParallelTasks === undefined\n      ? {}\n      : { maxParallelTasks: autonomousOptions.maxParallelTasks })\n  });''',
    '''  const chat = new ChatGPTAutonomousPort(base, {\n    ...(autonomousOptions?.chat ?? {}),\n    stateRoot: join(autonomousRoot, "chat")\n  });\n  const store = new FileDevAutonomousWorkflowStore({\n    stateRoot: join(autonomousRoot, "workflows")\n  });\n  if (autonomousOptions?.local !== undefined && autonomousOptions.localCodex !== undefined) {\n    throw new TypeError("Configure either dev.autonomous.local or dev.autonomous.localCodex, not both.");\n  }\n  const local = autonomousOptions?.local ?? (autonomousOptions?.localCodex === undefined\n    ? undefined\n    : createCodexCliAutonomousLocalPort({\n        ...autonomousOptions.localCodex,\n        stateRoot: autonomousOptions.localCodex.stateRoot ?? join(autonomousRoot, "local")\n      }));\n  const autonomous = createDevAutonomousApi({\n    store,\n    chat,\n    ...(local === undefined ? {} : { local }),\n    ...(autonomousOptions?.maxParallelTasks === undefined\n      ? {}\n      : { maxParallelTasks: autonomousOptions.maxParallelTasks })\n  });''',
)

# Default runtime state/worktrees must never become repository candidates.
gitignore = Path(".gitignore")
text = gitignore.read_text(encoding="utf-8")
if ".chatgpt-dev/\n" not in text:
    if not text.endswith("\n"):
        text += "\n"
    text += ".chatgpt-dev/\n"
    gitignore.write_text(text, encoding="utf-8")
