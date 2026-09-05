# Autonomous development and cloud toolchains

`dev.autonomous` is the durable repository-development orchestrator. It is separate from the compatibility `dev.worker` namespace, which supervises Scheduled Tasks/planner runs and checkpoints rather than implementing repository changes.

The autonomous path keeps ownership explicit:

- visible ChatGPT Project conversations provide master planning, task guidance, worker review, and final integration review;
- the local executor owns repository edits, independent tests, commits, pushes, and integration;
- operation IDs, watcher IDs, conversation affinity, commit SHAs, and review evidence are persisted so restart recovery does not repeat a logical ChatGPT Send;
- local Codex/Git evidence is derived from exact candidates and SHAs rather than ChatGPT claims about repository work;
- a missing executor fails closed with `local_executor_unavailable` rather than claiming repository work occurred.

## Turnkey SDK shape

```ts
import { createChatGPT } from "codex-chatgpt-control";

const chatgpt = createChatGPT({
  agent: globalThis.agent,
  dev: {
    autonomous: {
      localCodex: {
        repositoryRoot: process.cwd(),
        allowPush: true
      },
      maxParallelTasks: 4
    }
  }
});

const workflow = await chatgpt.dev.autonomous.bootstrap({
  workflowId: "release-hardening-1",
  projectKey: "g-p-example-project-id",
  plannerConversationKey: "release-hardening-1:planner",
  objective: "Harden the release path while preserving Node/Python parity.",
  repositoryUrl: "https://github.com/example/repository",
  defaultBranch: "main",
  constraints: [
    "Use visible ChatGPT Project conversations only.",
    "Keep repository implementation and independent testing local."
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

`projectKey` is an identity boundary, not a display name. Automatic Project-scoped first-send creation requires either an exact ChatGPT Project ID such as `g-p-example-project-id` or the exact Project URL `https://chatgpt.com/g/g-p-example-project-id/project`. The runtime fails closed rather than searching Project titles and guessing ownership.

`bootstrap()` claims an immutable planning specification, starts or resumes the master-planner turn in the Project, parses a strict bounded task DAG, and creates the durable workflow. Reusing the same workflow ID with a different objective, Project, or planner identity is rejected instead of silently replanning an existing workflow.

Advanced callers can use `create(plan)` when they already own a validated `DevWorkflowPlan`. That deliberately bypasses master planning; it does not relax Project identity, conversation ownership, independent-test, push, or review requirements.

A planner or worker's first real prompt can establish its conversation directly from the exact ChatGPT Project route. The operation remains a transactional `new` target until ChatGPT exposes the real conversation ID; no synthetic conversation ID or setup message is inserted. Later review must use that same established conversation. Final planner review never creates a replacement planner conversation.

## Durable evidence and restart safety

The orchestration state under `.chatgpt-dev` keeps separate domains for workflow state, planning identity, ChatGPT turns, response watchers, conversation affinity, and local repository actions. These records are not interchangeable: a semantic conversation key cannot substitute for physical tab ownership, and a workflow phase cannot substitute for proof that a local mutation completed.

The packaged Codex CLI local port uses owned worktrees, direct executable invocation without a shell, the Codex `workspace-write` sandbox, bounded output, separate implementation and independent-test sessions, candidate digests, action-tagged Git commits, non-force pushes, and exact remote-SHA reconciliation. `allowPush: true` remains an explicit opt-in because Git push is a network mutation.

When an external action crosses a mutation boundary but completion cannot be proven, the port fails closed instead of blindly rerunning it. Completed actions are rehydrated from durable evidence, and ambiguous actions require recovery evidence before another physical mutation is allowed.

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

A repository executor may use a successful GitHub Actions run as independent tester evidence only when it records a stable tester identity, the exact candidate/commit identity, and a report digest derived from immutable run evidence. The autonomous state machine still requires the tested candidate digest to match the implementation candidate before a push or review can advance.

Do not treat a queued, unassigned, cancelled, or in-progress workflow as a passing test, and do not reuse a successful run from a different commit SHA.
