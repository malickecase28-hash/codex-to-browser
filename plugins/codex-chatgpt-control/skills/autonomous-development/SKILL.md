---
name: autonomous-development
description: Use when Codex should autonomously plan, implement, test, push, review, and integrate repository work through visible ChatGPT Project planner and worker conversations plus the packaged local Codex executor.
---

# Autonomous Development

Use this skill for repository-development workflows that should be driven by one durable ChatGPT Project planner conversation, dedicated worker conversations, local Codex implementation/testing, exact Git evidence, and explicit recovery.

This workflow is visible-browser only for ChatGPT. It does not call hidden ChatGPT endpoints, does not bypass login/captcha/permissions, and does not treat an unverified browser mutation as successful.

## Runtime

Resolve the plugin runtime relative to this skill:

```js
const loaderUrl = new URL(
  "../../runtime/import-chatgpt-control.mjs",
  "file:///absolute/path/to/plugins/codex-chatgpt-control/skills/autonomous-development/SKILL.md"
);
const { importChatGPTControl } = await import(`${loaderUrl.href}?t=${Date.now()}`);
const { createChatGPTFromEnvironment } = await importChatGPTControl();
const chatgpt = await createChatGPTFromEnvironment({
  dev: {
    autonomous: {
      localCodex: {
        repositoryRoot: process.cwd(),
        allowPush: true
      }
    }
  }
});
```

`localCodex` is explicit. `allowPush: true` is a separate Git network-write opt-in. Never infer either from the user merely asking for analysis or planning.

## Start Or Resume

Prefer `bootstrap()` unless the caller already owns a validated `DevWorkflowPlan`:

```js
const workflow = await chatgpt.dev.autonomous.bootstrap({
  workflowId: "release-hardening",
  projectKey: "g-p-example-project-id",
  plannerConversationKey: "release-hardening:planner",
  objective: "Finish the release candidate without weakening safety or parity.",
  repositoryUrl: "https://github.com/owner/repository",
  defaultBranch: "main",
  constraints: [
    "Use visible ChatGPT Project conversations only.",
    "Keep repository editing and testing local to Codex.",
    "Require independent testing before every push."
  ]
});

const run = await chatgpt.dev.autonomous.run(workflow.workflowId, {
  waitForChatGPT: true,
  maxSteps: 128
});
```

`projectKey` must be the exact ChatGPT Project ID (`g-p-*`) or exact Project URL. A friendly Project title is not identity evidence.

## Ownership Model

- One master planner conversation owns the task DAG and final integrated-SHA review.
- One worker conversation owns each task across all implementation/revision attempts.
- The local executor owns repository edits, deterministic testing, commit creation, and Git push.
- The independent tester must be a different actor from the implementation actor and must evaluate the exact candidate digest.
- Worker review must name the exact pushed task SHA and return to the same worker conversation.
- Final planner review must name the exact pushed integration SHA and return to the original planner conversation.

Do not substitute Scheduled Tasks (`dev.worker`) for the autonomous engine (`dev.autonomous`). `dev.worker` is a compatibility supervisor surface, not the repository-development state machine.

## Recovery

State is durable under `.chatgpt-dev` by default. Retry by semantic identity, not by repeating physical mutation calls.

For task blockers:

```js
const current = await chatgpt.dev.autonomous.get(workflow.workflowId);
// Resolve the external cause first.
await chatgpt.dev.autonomous.resumeTask(workflow.workflowId, "TASK-001");
```

For integration blockers:

```js
const current = await chatgpt.dev.autonomous.get(workflow.workflowId);
// Resolve the external cause first.
await chatgpt.dev.autonomous.resumeIntegration(workflow.workflowId);
```

Never call resume merely to make progress. Inspect `blockerCode`, fix the cause, then resume the exact blocked phase. A block/resume bookkeeping revision must not authorize duplicate local implementation, testing, integration, or push work.

Failed task/integration tester feedback and worker/planner revision guidance are digest-bound durable evidence. If that evidence cannot be rehydrated exactly, stop instead of opening a new ChatGPT turn or rerunning local work blindly.

## Completion Gate

Do not claim completion until all of the following are true:

1. Every task is accepted by its original worker after an independent tester pass and exact-SHA push.
2. Integration is independently tested and pushed at an exact SHA.
3. The original master planner accepts that exact integration SHA.
4. Repository release gates pass for the exact candidate SHA, including Node tests/build/bundles/contracts/docs/parity/backend conformance/audit, Python tests/type checks/smoke, plugin runtime/layout checks, and install-package smoke.
5. Any optional language gate such as Rust either passes or reports that no workspace exists; absence of Rust source is not a reason to invent a Rust rewrite.

For the full operating contract, read `../codex-chatgpt-control/references/autonomous-development.md`.
