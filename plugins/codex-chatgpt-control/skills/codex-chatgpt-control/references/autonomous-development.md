# Autonomous repository development

Use this reference when the user wants the plugin to plan, implement, test, push, review, or integrate repository changes autonomously. This is separate from the compatibility `dev.worker` / Scheduled Tasks surface.

## Ownership model

Keep the boundary explicit:

- ChatGPT visible Project conversations own master planning, task guidance, same-worker commit review, and final planner review.
- The local executor owns repository edits, deterministic tests, commits, pushes, and integration.
- Never let a ChatGPT response stand in for local Git/test evidence.
- Never use hidden ChatGPT endpoints, cookies, internal APIs, or guessed Project controls.
- Preserve the operator's existing ChatGPT tab. Autonomous conversations use separately owned browser tabs with authoritative provider tab identity.

## Start with `dev.autonomous.bootstrap()`

Prefer bootstrap unless the caller already owns a validated `DevWorkflowPlan`.

```ts
const workflow = await chatgpt.dev.autonomous.bootstrap({
  workflowId: "release-hardening",
  projectKey: "g-p-example-project-id",
  plannerConversationKey: "release-hardening:planner",
  objective: "Harden the release path and preserve Node/Python parity.",
  repositoryUrl: "https://github.com/example/repository",
  defaultBranch: "main",
  constraints: [
    "Use visible ChatGPT Project conversations only.",
    "Keep implementation and independent testing local."
  ]
});
```

`projectKey` is an identity boundary, not a display name. It must be an exact ChatGPT Project ID (`g-p-*`) or exact Project route (`https://chatgpt.com/g/g-p-*/project`) when the runtime needs to establish a new Project conversation. Do not search a title and guess.

Bootstrap durably claims the planning specification before the master-planner Send. Reusing the workflow ID with a different Project, planner key, objective, repository, branch, constraints, or task limit must fail rather than silently replan.

## Local Codex execution

For the packaged Codex CLI local executor:

```ts
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

`localCodex` is opt-in. `allowPush: true` is a separate explicit opt-in for Git network mutation. Without it, the workflow must block before push.

The packaged local port:

- creates owned Git worktrees under `.chatgpt-dev`;
- invokes executables directly without a shell;
- runs Codex with the `workspace-write` sandbox and no dangerous bypass flags;
- separates implementation and independent-test Codex sessions;
- detects tester mutation of the candidate;
- records prepared/started/completed local action receipts;
- reconciles action-tagged commits and exact remote SHAs after uncertain process/network results;
- never force-pushes.

## Task lifecycle

For each ready task:

1. establish or reuse exactly one worker conversation in the Project;
2. send task guidance once through the durable operation journal;
3. cache the exact worker response by watcher ID + digest;
4. let the local executor implement;
5. run an independent local tester;
6. push only the exact passed candidate;
7. send the exact pushed commit SHA back to the same worker conversation;
8. require strict review JSON;
9. if revision is required, rehydrate the exact review watcher/digest and continue in the same worker conversation.

A failed local tester also returns to the same worker, but only after the local port rehydrates the exact failed report and verifies its report digest. Pass the bounded tester summary as untrusted context. Do not blind-retry the implementation.

## Review responses

Accepted review:

```json
{"verdict":"accepted"}
```

Revision required:

```json
{"verdict":"revision_required","guidance":"specific bounded revision instructions"}
```

The runtime binds revision guidance to the durable watcher, response digest, review kind, and expected logical conversation key. A worker review from another task or a planner review cannot be substituted even if its JSON is otherwise valid.

## Integration lifecycle

After every task is worker-accepted:

1. integrate exact accepted task SHAs in the owned integration worktree;
2. run an independent integration tester;
3. push only the exact passed integration candidate;
4. send the exact integration commit SHA to the original master-planner conversation;
5. complete only after strict planner acceptance.

Physical integration action identity is semantic, not a workflow counter. Bookkeeping block/resume must reuse the same local action. A genuinely new integration attempt is authorized only by changed semantic evidence such as a failed tester candidate/report digest or planner-rejected SHA/review digest.

## Blockers and explicit resume

Port failures are durable state, not implicit retry signals.

- Task failures record `blockerCode` + exact `blockedFrom` phase. Resume only with `dev.autonomous.resumeTask(workflowId, taskId)` after the cause has been addressed.
- Integration failures record `blockerCode` + exact integration `blockedFrom` phase. Resume only with `dev.autonomous.resumeIntegration(workflowId)`.
- `run()` must not spin or silently retry a blocked mutation.
- A response still generating is `waiting`, not failure and not permission to submit again.
- Missing/corrupt durable evidence is a blocker. Do not manufacture replacement guidance, SHAs, tester reports, conversation identity, or completion receipts.

## Restart rules

After process restart, recover from durable state before doing anything physical:

- same logical ChatGPT turn => same operation ID + watcher ID;
- same local action => same semantic action ID;
- completed receipt => verify current local/remote state and reuse evidence;
- started action with exact completion evidence => reconcile, do not rerun;
- started action without sufficient completion evidence => block for recovery;
- remote already at the exact intended SHA => treat the push as reconciled, do not push again;
- route/tab/conversation mismatch => stop rather than adopt another tab or thread.

## Completion bar

Do not report the autonomous workflow complete merely because source code exists. Completion requires the repository's actual verification gates for the exact candidate SHA, including generated contract/plugin artifacts where applicable. Do not describe a bundle test as a live ChatGPT-browser qualification.
