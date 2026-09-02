# Terminal Browser Transports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Node SDK usable from an ordinary terminal through Browser Harness or Chrome DevTools CLI transports, without requiring `globalThis.agent`.

**Architecture:** Add one shared `TerminalBrowserBackend` compatibility layer that adapts daemon page operations to the repository's `BrowserLike`, `PageLike`, and `LocatorLike` types. Implement Browser Harness and Chrome DevTools as separate process-backed backends, then expose provider selection through a small factory and a no-send terminal smoke script.

**Tech Stack:** Node.js 20+, TypeScript ESM, `node:child_process`, Vitest, Browser Harness, Chrome DevTools MCP CLI.

**Spec:** `C:\Users\malic\Downloads\Im making some changes and upgrades.md`

## Global Constraints

- Preserve the visible-session-only safety boundary; do not read cookies, tokens, hidden ChatGPT APIs, or private browser state.
- Do not close the user's Chrome from `tabs.finalize()`.
- Keep `globalThis.agent` optional for terminal transports; the host bridge remains supported.
- Use no new npm dependency; external daemons are user-installed tools.
- Browser-required live checks are opt-in and must not send a message in the smoke script.

---

### Task 1: Shared terminal BrowserLike adapter

**Files:**
- Create: `packages/node/src/browser/transports/terminal-backend.ts`
- Test: `packages/node/tests/unit/terminal-backend.test.ts`

**Interfaces:**
- Consumes: `TerminalBrowserBackend` page operations from provider implementations.
- Produces: `createTerminalBrowser(backend): BrowserLike` with page, locator, keyboard, evaluation, content, and upload behavior.

- [ ] Write tests for page listing/selection, locator operations, evaluate serialization, and no-op finalization using an in-memory backend.
- [ ] Run the focused test and confirm it fails because the adapter does not exist.
- [ ] Implement the shared adapter with CSS/role/text/placeholder/child/nth/filter resolution inside the page expression.
- [ ] Run the focused test and confirm it passes.
- [ ] Add explicit errors for missing pages, missing targets, unsupported non-CSS uploads, and unavailable upload backends.

### Task 2: Chrome DevTools process backend

**Files:**
- Create: `packages/node/src/browser/transports/chrome-devtools.ts`
- Test: `packages/node/tests/unit/chrome-devtools.test.ts`

**Interfaces:**
- Consumes: Chrome DevTools CLI commands `list_pages`, `new_page`, `select_page`, `close_page`, `navigate_page`, `evaluate_script`, and `press_key`.
- Produces: `createChromeDevToolsBrowser(options): BrowserLike` and `ChromeDevToolsBackend`.

- [ ] Write fake executable tests for JSON page parsing, page creation, navigation, selection, keyboard, evaluation envelope decoding, timeout, and non-zero exit errors.
- [ ] Run the focused test and confirm the missing backend fails.
- [ ] Implement one-shot child processes against the persistent CLI daemon with defensive JSON extraction and bounded timeouts.
- [ ] Keep uploads explicitly blocked until UID resolution is implemented; never guess at a file target.
- [ ] Run the focused test and confirm it passes.

### Task 3: Browser Harness process backend

**Files:**
- Create: `packages/node/src/browser/transports/browser-harness.ts`
- Test: `packages/node/tests/unit/browser-harness.test.ts`

**Interfaces:**
- Consumes: Browser Harness Python snippets using `list_tabs`, `current_tab`, `switch_tab`, `new_tab`, `close_tab`, `goto_url`, `wait_for_load`, `js`, `press_key`, and `upload_file`.
- Produces: `createBrowserHarnessBrowser(options): BrowserLike` and `BrowserHarnessBackend`.

- [ ] Write fake executable tests for Python script input, JSON page decoding, page operations, evaluated values, uploads, browser selection env, timeout, and process errors.
- [ ] Run the focused test and confirm the missing backend fails.
- [ ] Implement stdin script execution with the configured command, timeout, browser-name environment, and last-JSON-line parsing.
- [ ] Normalize function expressions before passing them to Browser Harness `js()`.
- [ ] Run the focused test and confirm it passes.

### Task 4: Provider factory, smoke command, and public docs

**Files:**
- Create: `packages/node/src/browser/transports/terminal.ts`
- Create: `packages/node/src/scripts/terminal-browser-smoke.ts`
- Modify: `packages/node/src/index.ts`
- Modify: `packages/node/package.json`
- Modify: `packages/node/README.md`
- Modify: `docs/browser-bridge.md`
- Test: `packages/node/tests/unit/terminal-factory.test.ts`

**Interfaces:**
- Consumes: both provider constructors.
- Produces: `createTerminalBrowserTransport(options)`, `createTerminalBrowserFromEnv()`, and `npm run smoke:terminal-browser`.

- [ ] Write factory tests for explicit providers, default Browser Harness selection, browser name forwarding, and unknown-provider rejection.
- [ ] Run the focused test and confirm it fails before the factory exists.
- [ ] Implement exports and the no-send bootstrap/read-latest smoke script.
- [ ] Document installation, Chrome remote-debugging opt-in, provider environment variables, and ordinary-shell behavior.
- [ ] Run focused tests, TypeScript build, bundle, contract/parity gates, and the full Node suite.
- [ ] Run the terminal smoke command only as an opt-in environment check; report daemon/Chrome blockers separately from code verification.

### Self-review checklist

- [ ] Every spec section 1–12 maps to an implementation or documented deliberate limitation.
- [ ] No private credentials, cookies, transcripts, or local account data enter source or reports.
- [ ] `tabs.finalize()` does not close user-owned pages.
- [ ] Upload behavior is direct for Browser Harness and fail-closed for Chrome DevTools.
- [ ] No live message is sent by the smoke script.
