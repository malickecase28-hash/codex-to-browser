---
name: autonomous-development
description: Use when Codex should autonomously plan, implement, test, push, review, and integrate repository work through visible ChatGPT Project planner and worker conversations plus the packaged local Codex executor.
---

# Autonomous Development

Use this skill for durable repository-development workflows built on `chatgpt.dev.autonomous`.

The ChatGPT side is visible-browser only. The repository side is local Codex/Git work. Do not call hidden ChatGPT endpoints, do not substitute a Scheduled Task for the autonomous state machine, and do not blind-retry uncertain browser or Git mutations.

## Source Setup

```bash
cd packages/node
npm ci
npm test
npm run build
npm run bundle
npm run bundle:backend
```

Create the enhanced SDK from a bridge-enabled runtime and explicitly enable the packaged Codex local port when repository mutation is intended:

```js
import { createChatGPT } from "./dist/src/index.js";

const chatgpt = createChatGPT({
  agent: globalThis.agent,
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

`allowPush: true` is a separate network-mutation opt-in. Never infer it from a planning or read-only request.

## Bootstrap

Prefer one durable master planner and one worker conversation per task:

```js
const workflow = await chatgpt.dev.autonomous.bootstrap({
  workflowId: "release-hardening",
  projectKey: "g-p-example-project-id",
  plannerConversationKey: "release-hardening:planner",
  objective: "Finish the release candidate without weakening safety or parity.",
  repositoryUrl: "https://github.com/owner/repository",
  defaultBranch: "main"
});

await chatgpt.dev.autonomous.run(workflow.workflowId, {
  waitForChatGPT: true,
  maxSteps: 128
});
```

`projectKey` must be an exact `g-p-*` Project ID or exact Project URL. Friendly titles are not identity evidence.

## Recovery

- Inspect the durable workflow before recovery.
- Resolve the actual external blocker first.
- Use `resumeTask(workflowId, taskId)` only for that task's exact blocked phase.
- Use `resumeIntegration(workflowId)` only for the exact blocked integration phase.
- Block/resume bookkeeping must never authorize duplicate local implementation, test, integration, commit, push, or visible Send.
- Failed tester reports and revision guidance are digest-bound durable evidence; if exact evidence cannot be recovered, stop.

## Completion

Completion requires: every task accepted by its original worker after independent testing and exact-SHA push, integration independently tested and pushed, final review by the original planner against that exact integration SHA, and all repository release/package/parity/plugin gates green on the exact candidate SHA.

See `packages/node/references/autonomous-development.md` for the full SDK contract.
