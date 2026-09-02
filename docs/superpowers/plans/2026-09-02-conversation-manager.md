# Conversation Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Node-only durable logical-conversation registry and manager without changing the existing `chatgpt.ask()` default behavior.

**Architecture:** Store conversation metadata in one atomically replaced JSON file per logical key under the platform state directory. Resolve `reuse`, `new`, `current`, and history-search targets through a manager that delegates all browser work to the existing `ChatGPTClient` thread machinery and persists only successful result context.

**Tech Stack:** Node 20 standard-library filesystem/crypto/os/path APIs, strict TypeScript, Vitest, existing `tsx` CLI convention.

**Spec:** `C:\Users\malic\Downloads\Im making some changes and upgrades.md`

## Global Constraints

- Preserve the visible-session safety boundary; no private endpoints, scraping, background browser automation, or live-smoke execution.
- Keep `chatgpt.ask()` unchanged; add `createConversationManager()` as a higher-level Node surface.
- Persist conversation metadata only, never prompts or responses.
- Use existing `WorkflowThread`, `ChatGPTClient`, `CommandResult`, and search/open behavior; add no dependency.
- Keep Python parity and backend contracts unchanged because this surface is Node-local and does not alter the backend protocol.
- Keep the existing repository changes untouched; `.serena/` is pre-existing untracked user state.

---

### Task 1: Conversation registry

**Files:**
- Create: `packages/node/src/conversations/registry.ts`
- Test: `packages/node/tests/unit/conversation-registry.test.ts`

**Interfaces:**
- Produces `ConversationRegistry`, `ConversationRecord`, `RememberConversationArgs`, `ConversationRegistryOptions`, `ConversationSurface`, and `defaultConversationStateRoot()`.
- Registry records use `schemaVersion: 1`, canonical `key`, optional `conversationId`/`url`/`title`, `surface`, aliases, and ISO timestamps.

- [ ] **Step 1: Write failing tests** for remember/get, alias lookup, update preservation, last-use ordering, forget, missing identity rejection, and state-root persistence.
- [ ] **Step 2: Run `npx vitest run tests/unit/conversation-registry.test.ts`** and confirm failure because the registry module does not exist.
- [ ] **Step 3: Implement the registry** with SHA-256 filenames, platform defaults, strict record validation, `mkdir` mode `0700`, file mode `0600`, temp-write-plus-rename, and metadata-only persistence.
- [ ] **Step 4: Run the focused test again** and confirm all registry behavior passes.

### Task 2: Conversation manager

**Files:**
- Create: `packages/node/src/conversations/manager.ts`
- Test: `packages/node/tests/unit/conversation-manager.test.ts`

**Interfaces:**
- Consumes `ChatGPTClient.ask`, `runMessages`, `openThread`, and `readLatest`.
- Produces `ConversationManager`, `ConversationNotFoundError`, `createConversationManager()`, `ConversationUse`, resolution/result types, and forwarding methods `open`, `readLatest`, `ask`, and `runMessages`.

- [ ] **Step 1: Write failing tests** for new/current/reuse/search/create/block resolution, forwarding without the `conversation` field, successful context capture, read/open behavior, multi-message forwarding, operation-ID preservation, and alias writes remaining canonical.
- [ ] **Step 2: Run `npx vitest run tests/unit/conversation-manager.test.ts`** and confirm failure because the manager module does not exist.
- [ ] **Step 3: Implement the manager** by resolving to existing `WorkflowThread` values, forwarding the existing workflow arguments unchanged apart from replacing `conversation` with `thread`, and persisting valid ChatGPT context after successful calls.
- [ ] **Step 4: Run the focused manager and registry tests** and confirm all pass.

### Task 3: Public export and registry CLI

**Files:**
- Modify: `packages/node/src/index.ts`
- Create: `packages/node/src/scripts/conversations.ts`
- Modify: `packages/node/package.json`

**Interfaces:**
- Public package exports include both conversation modules.
- `npm run conversations -- list|get|remember|forget` operates on `CHATGPT_CONVERSATION_STATE_ROOT` when supplied.

- [ ] **Step 1: Add exports and the `conversations` script** using the existing `tsx` convention; keep CLI output JSON and reject missing required values.
- [ ] **Step 1b: Document the public manager and CLI** in `packages/node/README.md` without adding private session details.
- [ ] **Step 2: Run `npm run build`** to validate public types and the script.
- [ ] **Step 3: Run the CLI with a temporary state root** for remember, alias get, list, and forget, checking exit codes and JSON output.

### Task 4: Full verification

**Files:**
- No additional files.

- [ ] **Step 1: Run `npm test` in `packages/node`.**
- [ ] **Step 2: Run `npm run bundle`, `npm run contract:validate`, `npm run docs:drift`, `npm run parity:fixtures`, and `npm run parity:suite` in `packages/node`.
- [ ] **Step 3: Inspect `git diff` and `git status --short`** to confirm only the requested feature plus the required plan exists and no private/live-session data was added.
