# Autonomous Codex ↔ ChatGPT Development Orchestrator
## Full Takeover Roadmap and Current State

### 1. Objective

Build an autonomous development orchestration system where local Codex agents use the visible ChatGPT web application through the connected Browser extension.

The target workflow is:

1. A local Codex orchestrator opens or reuses a specific ChatGPT conversation.
2. ChatGPT acts as planner, reviewer, or task worker.
3. Local Codex owns repository edits, implementation, testing, commits, and pushes.
4. A separate independent local testing agent verifies every implementation milestone.
5. Commit SHAs are returned to the same ChatGPT worker conversation for review.
6. ChatGPT reviews the pushed code on GitHub.
7. The implementation/review loop continues until accepted.
8. Phase 2 adds a ChatGPT Project, a master planner conversation, one worker conversation per task, multiple concurrent local implementers, response wakeup routing, testing agents, and final integration review.

ChatGPT must not modify the repository unless explicitly instructed. Local Codex owns implementation.

---

# 2. Repository

Repository:

`malickecase28-hash/codex-to-browser`

Current accepted/pushed chain:

```text
cca7692cec93ba266a47bf853e7d1ce34b403c8f
Bind physical tab ownership to authoritative browser identity

parent:
2e990622313f41e957ce58fd9983f2b44b859586
Preserve exact tab identity through conversation reads

parent:
91ff44e63159dd174a7b51e7bbd692534a73c9bf
Handle cross-realm Node errno errors in registries

parent:
8a86daae3ab53a2f55b13e6c668943da24c24ffc
Persist exact ChatGPT tab affinity across clients

parent:
2f3260c9d0839414284999a465c10092406dcd01
Normalize managed browsers for receiver-safe coordination

parent:
b8660f8f6713da316233a0181b744d1ff22c51be
Use connected Browser extension for ChatGPT workflows

parent:
8edf6adc14c852eef5cce2bc292de99251fae04c
Add terminal browser transports and live smoke test

parent:
2ec19c9f3463759bbd683987ef358ae4bb55066b
feat: add persistent conversation manager
```

`.serena/` must remain untouched and untracked.

---

# 3. Hard Constraints

These are mandatory.

## Browser boundary

Use the visible connected Browser extension only.

Allowed:

```text
@Browser extension bridge
Edge / Chrome extension transport
visible ChatGPT web UI
browser.user.openTabs()
browser.user.claimTab()
browser.tabs APIs where supported
```

Not allowed:

```text
Browser Harness as normal workflow
CDP
Chrome DevTools Protocol
remote debugging
hidden ChatGPT APIs
private ChatGPT endpoints
cookie/token extraction
credential scraping
```

## Browser safety

Never:

```text
kill or close Edge for recovery
close unrelated user tabs
steal browser focus
assume selectedTabId means foreground tab
assume document.visibilityState means foreground
silently select the first duplicate semantic tab
retry an uncertain mutation
sign out to manufacture login blockers
solve or bypass CAPTCHA
```

Foreground state is not reliably observable.

The accepted ownership rule is:

```text
exact owned tab identity = authoritative

browser foreground state = unknown

user switching tabs/windows/apps
does not revoke automation ownership

selectedTabId
does not prove visible foreground

document.visibilityState
does not prove visible foreground

document.hasFocus
is unavailable and must not be required
```

## Chat mode only

Do not work on ChatGPT Work mode.

All active orchestration is normal Chat mode.

Work-related code may exist in the repository but is deferred and must not be part of current live testing or completion gates.

Preferred Chat model when visibly selectable and verifiable:

```text
GPT-5.6 Sol
High effort
```

Do not assume the model or effort state without visible verification.

## Mutation safety

Read-only browser probes are preferred until ownership is verified.

Never automatically retry:

```text
stop_generation_unverified
attachment_outcome_indeterminate
any submission with uncertain activation outcome
```

## Proof discipline

Never fabricate live evidence.

Every implementation milestone needs:

```text
implementation agent
separate independent tester
focused tests
build
bundle checks
git diff --check
commit
push
GitHub inspection
then live validation
```

---

# 4. Architecture Domains

Keep these state domains separate.

## A. Semantic conversation registry

Purpose:

```text
logical task/conversation key
conversation ID
conversation URL
title
surface metadata
```

This answers:

```text
Which ChatGPT conversation belongs to task X?
```

It must not answer:

```text
Which physical browser tab do we own?
```

## B. Browser affinity registry

Purpose:

```text
logical conversation key
exact physical tab ID
conversation ID
conversation URL
surface
timestamps
```

This answers:

```text
Which physical browser tab is owned for task X?
```

## C. Operation journal

Purpose:

```text
submission identity
mutation boundaries
send-once semantics
restart/recovery evidence
attachment mutation state
response collection state
```

This answers:

```text
Was this exact user operation already submitted?
```

## D. Response watcher registry

Still pending.

Purpose:

```text
pending response watcher ID
logical conversation key
conversation ID
exact tab ID
operation ID
baseline assistant turn identity/count
watch state
registration timestamp
```

This answers:

```text
Which local task should wake when this ChatGPT response finishes?
```

Do not overload any of these domains into another.

---

# 5. Phase 1 Goal

Phase 1 must establish a robust visible-browser Chat lifecycle before Phase 2 begins.

Required Phase 1 capabilities:

```text
managed browser bootstrap
receiver-safe browser coordination
exact-tab bootstrap
persistent exact-tab ownership
background-owned Chat reliability
background mutation safety
attachments
downloads
login blocker
captcha blocker
bridge interruption/reconnection
recovery without duplicate Chat submissions
event-driven response completion/wakeup
restart/resume
multi-chat watcher routing
independent verification
```

Work mode is not part of the Phase 1 gate.

---

# 6. Completed Phase 1 Milestones

## 6.1 Persistent semantic conversation manager

Implemented.

Supports durable mapping between logical keys and ChatGPT conversation IDs/URLs.

Old behavior remains:

```text
chatgpt.ask({ prompt })
```

can still create a new conversation by default.

Explicit conversation manager supports reuse across terminal restarts.

---

## 6.2 Connected Browser extension workflow

Implemented.

The SDK uses the connected Browser extension instead of hidden browser transports.

Terminal environment bootstrap uses Browser plugin discovery.

Relevant environment behavior:

```ts
createChatGPTFromEnvironment()
```

loads a Browser extension provider using the Browser plugin runtime.

No direct Chrome fallback should silently replace a failed extension bootstrap.

---

## 6.3 Managed browser normalization

Commit:

```text
2f3260c9d0839414284999a465c10092406dcd01
```

Solved receiver/private-field incompatibilities with Browser provider proxies.

Important method-discovery invariant:

```text
bounded descriptor/prototype walk

never invoke accessor descriptors while inspecting capability

own data methods are callable

for inherited data-function descriptors:
use receiver-safe Reflect.get(value, key, value)

getterReads must remain 0
```

This fixed prior private-field failures such as:

```text
Cannot read private member #r
```

---

## 6.4 Exact-tab bootstrap

Live verified before later persistence work.

Exact target example:

```ts
await chatgpt.session.bootstrap({
  existingTab: {
    target: {
      type: "tabId",
      tabId: "517469202"
    },
    ifMissing: "block",
    ifMultiple: "block",
    requireChatGPT: true
  },
  preferExistingTab: true
});
```

Observed:

```text
exact requested tab remained selected by automation
no new tab
no duplicate
correct conversation URL
logged in
```

Exact-ID bootstrap capability is considered PASS.

---

## 6.5 Background read ownership

Live read-only testing established:

```text
owned page stays usable while user switches tabs
owned page stays usable while user switches windows
owned page stays usable while browser is backgrounded
automation does not need foreground focus
```

But:

```text
selectedTabId is not foreground truth
visibilityState is not foreground truth
hasFocus unavailable
```

Foreground observability remains unsupported/unknown.

---

## 6.6 Cross-realm filesystem errno handling

Commit:

```text
91ff44e63159dd174a7b51e7bbd692534a73c9bf
```

Problem:

Browser-hosted filesystem errors could be created in another JS realm.

This failed:

```ts
error instanceof Error
```

even when the object was a genuine Node `ENOENT`.

Correct shared helper:

```ts
nodeErrorCode(error)
```

uses safe descriptor reads and no realm-sensitive `instanceof`.

Verified:

```text
foreign realm ENOENT recognized
accessor-backed code property not executed
missing ConversationRegistry root:
  get => undefined
  list => []

missing BrowserAffinityRegistry root:
  get => undefined
  list => []
```

---

# 7. Exact Tab Persistence Work

## 7.1 Initial affinity implementation

Commit:

```text
8a86daae3ab53a2f55b13e6c668943da24c24ffc
```

Browser affinity was correctly separated from semantic conversation state.

Required recovery invariant:

```text
owned A exists + semantic duplicate B exists
→ reclaim exact A

owned A missing + duplicate B exists
→ BLOCK
→ never adopt B

no affinity record + two semantic duplicates
→ existing_tab_ambiguous
```

Unit tests passed at the time.

Live testing later exposed deeper physical identity issues.

---

## 7.2 Result tab propagation repair

Commit:

```text
2e990622313f41e957ce58fd9983f2b44b859586
```

Problem:

A successful read could omit:

```text
context.tabId
```

so browser affinity was never persisted.

Manager was repaired to:

```text
retain verified preflight A

verified A + downstream tabId omitted
→ return A
→ persist A

verified A + downstream B
→ tab_affinity_lost
→ never persist B
```

This passed independent tests.

Live testing then exposed a deeper defect:

```text
the tab ID being propagated was the wrong physical ID
```

---

# 8. Physical Tab Identity Defect

Live proof found:

```text
actual disposable browser tab A:
517469367

claimed page URL:
correct disposable conversation

claimed page.id:
517469202
```

`517469202` was another ChatGPT tab.

Therefore:

```text
PageLike.id is NOT guaranteed to be the physical browser tab ID
```

This invalidated any architecture that treated:

```ts
page.id
page.tabId
```

as authoritative physical ownership.

Correct principle:

```text
the mechanism that selects or claims a physical browser tab owns the tab identity

the returned page object does not get to rename the tab
```

---

# 9. Current Physical Binding Repair

Current pushed HEAD:

```text
cca7692cec93ba266a47bf853e7d1ce34b403c8f
Bind physical tab ownership to authoritative browser identity
```

Changed exactly seven files:

```text
packages/node/src/browser/attach.ts
packages/node/src/commands/context.ts
packages/node/src/commands/session.ts
packages/node/src/operations/chatgpt-runtime.ts
packages/node/tests/unit/attach-coordination.test.ts
packages/node/tests/unit/client.test.ts
packages/node/tests/unit/context.test.ts
```

## Implemented design

A trusted runtime binding now maps:

```text
provider page object → authoritative physical tab ID
```

using a WeakMap.

Conceptual behavior:

```ts
bindPageTabId(page, "A");

tabIdFromPage(page);
// A
```

Ordinary property mutation:

```ts
page.id = "B";
```

must not change the binding.

Authoritative rebinding:

```ts
bindPageTabId(page, "B");
```

must update the physical identity.

## Authoritative identity sources

Current architecture intends these boundaries to be trusted:

```text
browser.user.openTabs() entry.id
browser.user.claimTab(selectedEntry)
explicit exact tabs.get(A)
controlled browser tab inventory where the API itself guarantees exact identity
```

Generic:

```text
PageLike.id
PageLike.tabId
```

must not establish ownership.

## Direct primitive liveness

Verified implementation behavior:

```text
expected A
trusted page binding B
→ tab_affinity_lost

expected A
unbound page
→ tab_affinity_unverifiable

expected/bound A
browser user inventory no longer contains A
→ fail closed

page.id changes
→ ignored as ownership signal
```

Independent focused verifier passed before commit.

Integrator focused result after commit:

```text
115/115 PASS
build PASS
bundle:live-smoke PASS
git diff --check PASS
```

---

# 10. CURRENT BLOCKER

Do not run the live persistence proof yet.

The full Node suite after commit reported:

```text
1650 passed
3 failed
2 skipped
```

At least one failure is directly related to the physical-binding change.

## Live-smoke cleanup regression

File:

```text
packages/node/src/scripts/live-smoke/harness.ts
```

Current code uses:

```ts
const pages = await browser.tabs.list();

for (const page of pages) {
  const id = tabIdFromPage(page);
}
```

But:

```text
tabIdFromPage()
```

now intentionally accepts only a previously trusted page binding.

Fresh inventory entries returned by:

```text
browser.tabs.list()
```

may contain authoritative exact IDs but are not automatically WeakMap-bound.

Therefore live-smoke cleanup can produce:

```text
browser.tabs.list returned a tab without an exact id
```

and lose the ability to safely diff:

```text
baseline tabs
versus
scenario-created tabs
```

This is a direct regression caused by the provenance repair.

---

# 11. IMMEDIATE NEXT TASK

Fix the authoritative inventory handling without making generic `page.id` trusted again.

## Correct rule

These API boundaries may assign authority:

```text
browser.user.openTabs() item.id
browser.tabs.list() inventory entry identity
browser.tabs.get(A) exact lookup target A
claimTab(A)
```

The important distinction is:

```text
id is trusted because of which browser API produced it

not merely because an arbitrary object happens to contain property "id"
```

## Live-smoke repair

When reading:

```ts
await browser.tabs.list()
```

extract the ID using a bounded data-descriptor read appropriate for browser inventory.

Do not execute accessors.

Conceptual helper:

```ts
function safeInventoryTabId(
  value: unknown
): string | undefined {
  // own data descriptor only
  // no getter execution
  // validate stable non-empty ID
}
```

Then:

```ts
const entries = await tabs.list();

for (const entry of entries) {
  const id = safeInventoryTabId(entry);

  if (id === undefined) {
    return inventoryUnverifiable;
  }

  bindPageTabId(entry, id);
  baselineIds.add(id);
}
```

For exact lookup:

```ts
const page = await tabs.get(id);

// id is authoritative because exact get(id) succeeded
bindPageTabId(page, id);
```

Then validate/close that exact tab.

Do not use:

```ts
page.id
```

as post-lookup proof.

The requested exact ID itself is the authority for successful `tabs.get(id)`.

---

# 12. Required Regression Tests for Current Blocker

At minimum:

```text
1.
tabs.list returns own data-valued id A
→ A accepted as authoritative inventory
→ A can be bound

2.
tabs.list returns accessor-backed id
→ getterReads = 0
→ inventory unverifiable

3.
baseline contains A
scenario adds B
→ cleanup closes only B

4.
tabs.get(B) returns page whose page.id = MASTER
→ requested exact B remains authoritative
→ B is closed
→ MASTER is never targeted

5.
claimed BrowserUserTabInfo A returns misleading page.id
→ A remains authoritative

6.
generic unbound page.id
→ tabIdFromPage remains undefined

7.
page bound A then ordinary page.id becomes B
→ tabIdFromPage still A

8.
authoritative rebind A → B
→ tabIdFromPage becomes B
```

---

# 13. Current Gate Before Live Browser Testing

Run:

```text
focused physical binding suites
live-smoke-harness.test.ts
attach coordination
session/client/context/runtime relevant suites
conversation manager affinity tests
```

Then:

```text
npm run build
npm run bundle:live-smoke
git diff --check
npm test
```

Acceptance:

```text
focused suites PASS
live-smoke harness PASS
build PASS
bundle PASS
diff check PASS
full Node suite:
0 unexpected failures
```

If Work-only deferred tests fail, report exact names and output.

Do not broadly label failures as unrelated.

After independent tester PASS:

```text
separate commit
push
return SHA
wait for ChatGPT GitHub inspection
```

Only after GitHub inspection may live persistence testing resume.

---

# 14. Live Exact-Affinity Proof After Current Blocker Is Fixed

Use a dedicated disposable normal Chat conversation.

No prompt is needed if the conversation already has harmless assistant content.

Use fresh temporary state roots.

## Step 1 — Initial persistence

Preconditions:

```text
exactly one disposable tab A for that conversation
fresh local runtime
fresh manager
fresh semantic registry root
fresh affinity root
client supplied page = false
client supplied expectedTabId = false
```

Use the normal manager read-only path.

Required:

```text
readLatest.ok = true
readLatest.status = ok

readLatest.context.tabId = A

manager.affinity.get(key):
  exists
  tabId = A
  conversationId/url = expected
```

Hard stop if affinity is absent or does not equal A.

Do not create a duplicate if Step 1 fails.

## Step 2 — Duplicate recovery

Manually create duplicate B with the exact same ChatGPT conversation URL.

Record:

```text
A ID
B ID
URLs
user tab count
controlled tab count
```

Destroy the first client/runtime.

Create a genuinely fresh runtime:

```text
supplied page = false
supplied expectedTabId = false
same state roots
```

Call only readLatest.

Required:

```text
ok = true
context.tabId = A
conversation unchanged
persisted affinity remains A
A reclaimed
B untouched
tab count unchanged
no new ChatGPT tab
```

## Step 3 — Stale owner

Close A manually.

Leave B open.

Fresh client/runtime.

Same roots.

Same read-only manager call.

Required:

```text
A absent
B present

result:
  ok = false
  status = blocked

persisted affinity still A

B adopted = false
B URL unchanged
new ChatGPT tab created = false
prompt submitted = false
```

Stop after this result.

No retries.

If B is adopted at any point, the gate fails.

---

# 15. Background Mutation Safety

Only start after exact-tab live persistence/recovery is fully green.

Use a disposable conversation and one harmless prompt.

Test while the user actively works in another browser tab/window/app.

Acceptance:

```text
submission occurs only on exact owned tab A
assistant response appears only on A
context.tabId = A
conversation unchanged
unrelated foreground tab unchanged
no focus theft observed
no unrelated tab mutation
```

Never infer foreground from:

```text
selectedTabId
visibilityState
```

Independent tester required.

---

# 16. Response Watcher / Wakeup

This is a first-class Phase 1 requirement.

Do not implement polling-first orchestration.

Required observable lifecycle:

```text
local agent submits Chat prompt

→ persist:
   logical conversation key
   conversation ID
   exact owned tab ID
   operation ID
   baseline assistant-turn state

→ submitting agent yields

→ independent watcher waits

→ ChatGPT finishes response

→ watcher emits local completion event

→ relevant local orchestrator/task wakes

→ completed response read once
```

Preferred detection order:

```text
A. Browser bridge/page event signalling DOM/page change

B. retained-page completion observer

C. MutationObserver or equivalent visible DOM completion signal

D. bounded low-frequency metadata polling only as fallback/recovery
```

Do not keep an implementation agent burning an active slot while waiting for ChatGPT generation.

## Suggested APIs

```ts
watchers.register()
watchers.await()
watchers.resumePending()
watchers.cancel()
```

## Durable watcher metadata

```text
watcher ID
logical conversation key
conversation ID
exact owned tab ID
operation ID
baseline assistant turn identity/count
state
registeredAt
```

No transcript persistence.

## Completion event

Conceptually:

```json
{
  "type": "chat_response_ready",
  "conversationKey": "project/task-002",
  "operationId": "redacted",
  "assistantTurnCount": 4
}
```

## Restart behavior

On process restart:

```text
reload pending watchers
reconnect exact owned tab
verify conversation
read completion status
never resend prompt
```

Bridge outage must not count as response completion.

## Multi-chat routing

At least two pending chats must be independently routable:

```text
Chat A completion wakes task A
Chat B completion wakes task B
```

No cross-routing.

Independent Response Wake Tester required.

---

# 17. Attachments

After watcher foundation and ownership safety are stable.

Use a harmless file such as:

```text
attachment-live-test.txt
```

Required behavior:

```text
preflight exact ownership
verify Chat composer
perform approved attachment
wait for upload readiness
submit once
assistant recognizes file content
```

Permission blocker must stop cleanly.

If attachment outcome becomes indeterminate:

```text
do not reattach
do not resubmit
do not automatically retry
```

Required blocker includes:

```text
attachment_outcome_indeterminate
```

Independent tester required.

---

# 18. Downloads

Use a harmless generated artifact such as:

```text
codex-browser-live-proof.csv
```

Required:

```text
ask ChatGPT to generate exact artifact
wait for visible artifact
match exact filename regex
download to approved temporary destination
verify file content/digest
reject wrong artifact
do not overwrite unrelated file
```

Permission blockers must be structured.

Independent tester required.

---

# 19. Login and CAPTCHA

Do not sign out intentionally.

Do not provoke or bypass CAPTCHA.

Required fixture behavior:

```text
login_required
→ no mutation

captcha
→ no mutation

retry after blocker
→ must not duplicate prior prompt
```

Live doctor may verify:

```text
signed in
no CAPTCHA currently present
```

If a CAPTCHA naturally appears:

```text
stop
return structured blocker
```

---

# 20. Bridge Interruption / Recovery

Do not kill Edge.

Simulate interruption at SDK/bridge-client boundaries where possible.

Required scenarios:

## A. Client recreation

```text
recreate SDK/client
reuse remembered conversation
read existing thread
no duplicate chat
```

## B. Response pending during local restart

```text
prompt already submitted
operation persisted
watcher persisted
local process restarts
reconnect same exact tab
collect response
no resend
```

## C. Bridge unavailable before send

```text
structured blocker
no mutation
explicit later retry allowed
one message only
```

## D. Bridge disappears after send acknowledgement

```text
reconnect
collect existing response
no duplicate prompt
```

## E. Bridge disappears during attachment

```text
attachment outcome indeterminate
no replay
```

## F. Owned A + duplicate B

```text
fresh client reclaims A
```

## G. A missing + B remains

```text
fail closed
never adopt B
```

## H. No affinity + duplicate semantic tabs

```text
existing_tab_ambiguous
```

## I. User focus/tab changes

```text
do not alter ownership
```

## J. Unexpected navigation on A

```text
ownership interruption
block
```

## K. Tab ID reused for another semantic page

```text
block
```

Independent Recovery Tester required.

---

# 21. Same-Tab Navigation Policy

Allowed:

```text
same physical tab ID
+
expected SDK navigation
+
semantic identity updated consistently
```

Blocked:

```text
same ID
+
unexpected different conversation

same ID
+
non-ChatGPT origin

different ID
+
same conversation URL

owned ID gone
+
identical duplicate exists
```

Exact tab ID is necessary but not sufficient.

---

# 22. Phase 1 Completion Gate

Phase 1 is complete only when all of these are green:

```text
receiver/accessor safety
managed browser normalization
extension bootstrap compatibility
exact-tab bootstrap
exact-tab durable persistence
duplicate recovery
stale-owner fail closed
background owned reads
background mutation safety
foreground state treated as unknown
response watcher/wakeup
watcher restart/resume
multi-chat routing
attachments
downloads
login blocker
captcha blocker
bridge interruption
duplicate-send recovery
attachment indeterminate recovery
unexpected navigation protection
independent testing agents
build
bundles
contracts/parity
full relevant Node suite
Python suite where applicable
GitHub proof commits
verification report
```

Work mode:

```text
DEFERRED / OUT OF SCOPE
```

Suggested verification report:

```text
docs/verification/phase-1-lifecycle.md
```

Do not include private ChatGPT transcripts in verification artifacts.

---

# 23. Phase 2 — DO NOT START UNTIL PHASE 1 IS GREEN

Phase 2 builds the actual autonomous development orchestrator.

Normal Chat mode only.

---

# 24. ChatGPT Project Architecture

Create one ChatGPT Project for the target software project.

Inside it:

```text
one master planner chat
one worker chat per task
```

Persist durable project metadata locally.

Potential registry:

```text
project key
ChatGPT project identifier/locator
planner conversation key
task IDs
worker conversation keys
branch mapping
task status
integration status
```

Need reliable visible-UI operations for:

```text
find/create/open project
find/create/open worker chat
verify chat belongs to expected project
durably reconnect later
```

Do not silently substitute a similarly named project/chat.

---

# 25. Master Planner

The master planner should:

```text
inspect GitHub repository
inspect roadmap
inspect task manifest
define architecture
define task graph
define dependencies
define acceptance criteria
review final integration
```

The master planner should not implement code.

Planner output should include a machine-readable task manifest.

Example task record:

```json
{
  "taskId": "TASK-002",
  "title": "Calendar persistence",
  "dependencies": ["TASK-001"],
  "parallelSafe": true,
  "acceptance": [
    "unit tests pass",
    "integration test passes"
  ]
}
```

---

# 26. Per-Task Worker Chats

Each task receives one persistent ChatGPT worker conversation.

Permanent mapping:

```text
task ID ↔ worker conversation key
```

Worker responsibilities:

```text
inspect GitHub
understand task
guide local implementation
review pushed commits
identify defects
accept or request revision
```

Worker does not directly edit the local repository.

---

# 27. Local Codex Implementation Agents

For every task:

```text
worker gives implementation direction

→ local Codex implementation agent edits repository

→ separate local testing agent verifies task

→ implementation commits/pushes branch

→ SHA returned to same ChatGPT worker

→ worker reviews GitHub commit

→ if rejected:
     local agent repairs
     tester reruns
     new SHA pushed
     same worker reviews again
```

Each task must preserve:

```text
task ID
worker conversation key
branch
implementation SHA
tester result
worker review result
integration SHA
```

---

# 28. Mandatory Independent Testing Agent

Every implementation phase needs a different local testing agent.

Testing agent must independently inspect behavior rather than trusting implementation-agent claims.

No task can be accepted based solely on:

```text
implementation agent says tests passed
```

Required:

```text
separate tester
test output
proof
```

---

# 29. Parallel Execution

Independent tasks may run concurrently.

Example:

```text
TASK-001 UI shell
TASK-002 calendar data model
TASK-003 productivity data model
```

may be parallel if planner marks them independent.

Integration-sensitive tasks serialize.

The orchestrator must respect the task DAG.

Do not merge branches opportunistically if dependencies are unresolved.

---

# 30. Watcher-Driven Worker Orchestration

Phase 2 must use the Phase 1 watcher system.

Expected worker lifecycle:

```text
send task/review message to worker chat
persist operation/watch state
yield local execution slot

worker ChatGPT completes
watcher emits event
orchestrator wakes correct task
response read once
task proceeds
```

Do not poll each worker continuously from an implementation agent.

---

# 31. GitHub Proof Loop

Every milestone must be inspectable on GitHub.

For SDK work:

```text
repo
SHA
parent SHA
changed files
focused test counts
full suite status
build status
bundle status
live evidence
remaining failures
```

For application tasks:

```text
task ID
worker conversation key
branch
implementation SHA
independent tester result
worker review result
integration SHA
```

Never include:

```text
cookies
tokens
credentials
private transcripts
```

---

# 32. Example Phase 2 Application

Planned future test repository:

```text
malickecase28-hash/test-setup
```

Target product:

```text
calculator
calendar
productivity tracker
```

Logical project key:

```text
productivity-suite
```

Master planner:

```text
roadmap
task DAG
machine-readable task manifest
acceptance criteria
```

Then one worker chat per task.

Local Codex owns Git operations.

---

# 33. Final Integration

After all workers accept their tasks:

```text
integration agent assembles branches
independent integration tester runs full product tests
master planner reviews final GitHub state
```

Master planner either:

```text
accepts integration
```

or returns precise repair tasks.

No final completion until:

```text
all task workers accepted
integration tester passed
master planner accepted
main branch pushed
```

---

# 34. Current Status Matrix

```text
semantic conversation persistence      PASS

receiver/accessor browser safety        PASS

managed-browser normalization           PASS

Browser extension bootstrap             PASS

exact-tab bootstrap capability          PASS

background read ownership               PASS

foreground observability                UNSUPPORTED / UNKNOWN

cross-realm registry errno handling     PASS

tab-ID result propagation               PASS in focused tests

authoritative physical claim identity   PASS in focused tests

trusted A→B rebinding                   PASS in focused tests

direct primitive fail-closed            PASS in focused tests

manager exact-A persistence             PASS in focused tests

live-smoke exact cleanup                FAIL / REGRESSION

full Node suite                         FAIL: 3 tests

live initial affinity persistence       BLOCKED

live duplicate recovery                 NOT RUN after current repair

live stale-owner recovery               NOT RUN after current repair

background mutation safety              PENDING

response watcher/wakeup                 PENDING

attachments                             PENDING

downloads                               PENDING

login/captcha fixtures                  PENDING

bridge recovery                         PENDING

Phase 1 completion                      NOT READY

Phase 2 Project orchestration           NOT STARTED

Work mode                               DEFERRED / OUT OF SCOPE
```

---

# 35. Immediate Handoff Instructions

The next engineer should begin here:

```text
HEAD:
cca7692cec93ba266a47bf853e7d1ce34b403c8f
```

Do not run live browser persistence yet.

First:

```text
repair live-smoke harness exact tab inventory handling
```

without weakening the provenance model.

Then:

```text
independent tester
focused suites
live-smoke harness tests
build
bundle
git diff check
full Node suite
```

Require zero unexpected failures.

Then:

```text
commit separately
push
send SHA to supervising ChatGPT
wait for GitHub inspection
```

Once supervising ChatGPT accepts the pushed repair:

```text
rerun fresh initial-persistence live step only
```

If initial persistence passes:

```text
run duplicate A+B recovery
```

If duplicate recovery passes:

```text
run stale-A fail-closed
```

Then proceed in order:

```text
background mutation safety
response watcher/wakeup
watcher restart/resume
multi-chat routing
attachments
downloads
login/captcha
bridge recovery
Phase 1 final verification
```

Only after the full Phase 1 gate is green:

```text
start Phase 2
```

---

# 36. What to Send Back to Supervising ChatGPT

For any new implementation commit, provide:

```text
commit SHA
parent SHA
changed files
exact test command
test count
build result
bundle result
git diff check result
full suite result
independent tester verdict
live actions performed or none
.serena status
known remaining failures
```

The supervising ChatGPT should inspect the pushed GitHub code before authorizing the next live step.

For live evidence, provide exact facts only:

```text
tab IDs
conversation IDs
tab counts
controlled tab counts
result status
blocker code
whether any prompt was submitted
whether any tab changed
whether any new tab was created
```

Do not summarize a failed proof as a pass.

---

# 37. Core Invariants That Must Never Be Lost

```text
semantic conversation identity
is not physical browser ownership

physical browser ownership
must come from an authoritative browser API boundary

PageLike.id
must not establish physical ownership

duplicate semantic tab
must never substitute for missing owned tab

owned A missing + semantic B
must fail closed

uncertain send outcome
must never be resent automatically

attachment uncertainty
must never replay automatically

watcher restart
must never resend prompt

user foreground switching
must not revoke ownership

browser selected tab
must not be treated as foreground truth

browser automation
must not steal focus

unrelated user tabs
must never be closed

all implementation work
needs independent testing
```

---

# 38. Definition of Done

The roadmap is complete when:

```text
Phase 1 browser lifecycle is fully green

and

Phase 2 can autonomously:

create/reuse planner and worker conversations
route tasks to workers
wake local agents on ChatGPT completion
implement tasks locally
test independently
commit/push GitHub proof
return SHAs to workers
receive worker review
iterate without duplicate sends
parallelize independent tasks
recover after restart/bridge interruption
integrate all accepted work
receive final master planner approval
```

At that point the system should support long-running autonomous Codex ↔ ChatGPT software development using normal visible ChatGPT conversations, with GitHub as the proof and review boundary.