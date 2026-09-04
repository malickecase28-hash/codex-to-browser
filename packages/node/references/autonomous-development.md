# Autonomous development and cloud toolchains

`dev.autonomous` is the durable repository-development orchestrator. It is separate from the compatibility `dev.worker` namespace, which supervises scheduled/planner runs and checkpoints rather than implementing repository changes.

The autonomous path keeps ownership explicit:

- visible ChatGPT Project conversations provide task guidance and review;
- the injected local executor owns repository edits, independent tests, pushes, and integration;
- operation IDs, watcher IDs, conversation affinity, commit SHAs, and review evidence are persisted so restart recovery does not repeat a logical Send;
- a missing executor fails closed with `local_executor_unavailable` rather than claiming repository work occurred.

## SDK shape

```ts
import { createDevChatGPT } from "codex-chatgpt-control";

const chatgpt = createDevChatGPT({
  agent: globalThis.agent,
  dev: {
    autonomous: {
      local: repositoryExecutor,
      maxParallelTasks: 4
    }
  }
});

const workflow = await chatgpt.dev.autonomous.create({
  workflowId: "release-hardening-1",
  projectKey: "g-p-project-id",
  plannerConversationKey: "release-hardening-1:planner",
  tasks: [
    {
      taskId: "node",
      title: "Harden Node runtime",
      summary: "Implement the reviewed Node changes.",
      acceptanceCriteria: ["Node tests pass", "TypeScript build passes"]
    },
    {
      taskId: "python",
      title: "Preserve Python parity",
      summary: "Mirror the approved request shape in Python.",
      dependencies: ["node"],
      acceptanceCriteria: ["Python tests pass", "pyright passes"]
    }
  ]
});

const result = await chatgpt.dev.autonomous.run(workflow.workflowId, {
  waitForChatGPT: false,
  maxSteps: 128
});

if (result.waiting) {
  // Persist the workflow ID and resume later. The engine does not spin while
  // a visible ChatGPT response is still pending.
}
```

A worker's first real guidance prompt may establish its conversation directly from the exact ChatGPT Project route. The operation remains a transactional `new` target until ChatGPT exposes the real conversation ID; no synthetic conversation ID or setup message is inserted. Later review must use the same established worker conversation.

The final planner review requires the planner conversation identified by `plannerConversationKey` to already exist with exact tab affinity. Register that semantic conversation and its affinity in a shared `ConversationManager`, then pass the manager as `dev.autonomous.chat.conversations`. The engine never creates a replacement planner at final review time.

## GitHub Codespaces

The repository includes `.devcontainer/devcontainer.json` so a Codespace has the project toolchains without depending on the developer workstation:

```bash
node --version
python --version
rustc --version
cargo --version
```

Open the repository in GitHub, choose **Code → Codespaces → Create codespace**, then use the browser-hosted VS Code terminal normally. Node, Python, stable Rust, Cargo, and GitHub CLI are provisioned in the cloud environment.

Rust is an optional toolchain, not a rewrite requirement. If a Rust crate or workspace is later added, it can be built interactively in Codespaces with:

```bash
cargo build
cargo run
cargo test
```

## GitHub Actions Rust gate

`.github/workflows/rust-cloud.yml` discovers `Cargo.toml` files automatically. When no Rust crate exists, the job succeeds and reports that the cloud toolchain is ready. When Rust code is present it runs, for every discovered manifest:

```bash
cargo fmt --all -- --check
cargo build --release
cargo test
```

If the crate directory contains `Cargo.lock`, build and test run with `--locked` so CI validates the committed dependency graph.

This cloud gate complements the permanent Node/Python parity workflow. It does not replace local executor evidence or allow ChatGPT browser conversations to claim that repository commands ran.

## Evidence from cloud CI

A repository executor may use a successful GitHub Actions run as independent tester evidence by recording a stable tester identity, the exact candidate digest, and a report digest derived from the immutable run/commit evidence. The autonomous state machine still requires the tested candidate digest to match the implementation candidate before a push or review can advance.

Do not treat a queued or in-progress workflow as a passing test, and do not reuse a successful run from a different commit SHA.
