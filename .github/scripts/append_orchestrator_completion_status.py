from pathlib import Path

path = Path("Autonomous Codex ↔ ChatGPT Development Orchestrator.md")
text = path.read_text(encoding="utf-8")
marker = "# 39. Superseding Implementation Status — 2026-09-04"
if marker in text:
    raise SystemExit("status addendum already exists")

addendum = r'''

---

# 39. Superseding Implementation Status — 2026-09-04

This section supersedes the historical `Current Status Matrix`, `Immediate Handoff Instructions`, and old blocker SHA above. Those earlier sections remain in this document as an audit trail of the Phase 1 investigation; they are not the current implementation state.

## Current architecture

The repository now contains both lifecycle safety and the Phase 2 development orchestration surface.

```text
Phase 1 lifecycle foundation
  exact physical tab ownership from authoritative browser boundaries
  process-scoped browser coordination
  durable transactional operation journal
  no blind replay after uncertain mutation
  response watcher persistence/recovery
  semantic conversation registry kept separate from physical tab affinity
  login/captcha/rate-limit/permission/selector-drift fail-closed behavior

Phase 2 SDK
  dev.projects
  dev.planner
  dev.worker
  dev.autonomous

Autonomous workflow
  master planner conversation
  persistent worker conversation per task
  task DAG and bounded parallelism
  deterministic ChatGPT operation/watcher identities
  local implementation phase
  independent tester phase
  exact pushed SHA evidence
  same-worker GitHub review loop
  integration candidate
  independent integration test
  exact integration SHA
  final planner review
```

Node remains the authoritative runtime. Python is a protocol client and does not duplicate browser orchestration logic.

## Backend and Python parity

The Node backend exposes one bounded transport command:

```text
dev.dispatch
```

Its payload is restricted to the public namespaces/actions implemented by the Node SDK:

```text
projects
planner
worker
autonomous
```

Python exposes matching logical namespaces:

```text
chatgpt.dev.projects
chatgpt.dev.planner
chatgpt.dev.worker
chatgpt.dev.autonomous
```

The wire bridge delegates to the Node-authoritative implementation. It does not create Python-side browser selectors, lifecycle state, Git truth, or mutation reconciliation.

## Destructive confirmation

Project and Planner deletion now requires caller confirmation before the adapter may touch the destructive visible control.

Node:

```ts
await chatgpt.dev.projects.delete(projectRef, {
  idempotencyKey: "caller-owned-key",
  confirmMutation: true
});
```

Python uses the equivalent explicit `confirm_mutation=True` option.

Without confirmation:

```text
status = needs_confirmation
blocker.kind = confirmation
browser delete adapter invoked = false
```

A visible browser confirmation button is not treated as a substitute for caller consent.

## Planner capability boundary

The Planner API is public and typed, but the built-in visible-browser adapter exposes only behavior that can be positively verified against the live visible UI.

Where a Planner mutation/control has no verified selector and postcondition surface:

```text
ui_unsupported
```

is the required result.

The implementation must not invent hidden Planner APIs, private endpoints, guessed application state, or optimistic mutation success merely to claim feature coverage. A custom adapter may implement additional Planner controls only when it owns equivalent visible-UI verification and reconciliation guarantees.

## Packaged local Codex executor

The Node package now includes a concrete Codex CLI local port for the autonomous workflow.

Opt-in surface:

```ts
dev: {
  autonomous: {
    localCodex: {
      repositoryRoot: process.cwd(),
      allowPush: true
    }
  }
}
```

Safety model:

```text
localCodex is never enabled implicitly
Git network push requires separate allowPush: true opt-in
codex exec is invoked directly, never through a shell
Codex workspace-write sandbox is retained
no dangerous Codex approval/sandbox bypass flags
owned Git worktrees isolate task branches
one stable task branch survives revision attempts
implementation and independent testing use separate Codex sessions
tester mutation of the candidate is detected
candidate digests bind test evidence to implementation evidence
Git pushes are non-force
exact commit SHAs are returned for ChatGPT/GitHub review
integration worktree identity remains stable across persisted workflow revisions
```

Codex CLI itself is an external prerequisite only for this local implementation/test port. The compiled SDK can still be installed and used for browser/control workflows without a local Codex installation.

## Compiled GitHub distribution

Fork release identity is:

```text
codex-chatgpt-control 0.6.0-alpha.1
```

The source repository owns the distribution metadata.

After the full parity workflow succeeds on `main`, `github-installable-package`:

```text
builds the Node SDK
runs the source tests
validates npm pack contents
creates the npm tarball
installs that tarball in a clean npm project
imports the compiled public SDK
executes chatgpt-thread --help
health-checks the installed Node backend
publishes the exact verified tarball contents to branch npm-dist
writes SOURCE_COMMIT with the authoritative main SHA
performs an ordinary npm install directly from npm-dist
verifies the compiled SDK/CLI again
```

Private-repository installation:

```bash
gh auth login
gh auth setup-git
npm install "git+https://github.com/malickecase28-hash/codex-to-browser.git#npm-dist"
```

The compiled Node distribution does not require local TypeScript, Python, or Rust compilation.

Tagged GitHub releases attach the verified npm tarball plus Python wheel/source distribution. npmjs/PyPI publication is optional and not a prerequisite for GitHub installation.

## Permanent verification gates

The release candidate is governed by permanent repository workflows rather than one-off local assertions:

```text
codex-chatgpt-control-parity
  Node Ubuntu
  Node Windows
  Python Ubuntu
  Python Windows
  build
  deterministic tests
  bundles
  backend contract generation/validation
  docs drift
  parity fixtures/suite
  backend conformance

release-readiness
  npm package identity
  npm audit
  generated plugin runtime/layout
  Python wheel/sdist build and check
  clean source-install smoke

github-installable-package
  compiled npm tarball
  clean install/import/CLI/backend-health proof
  post-main npm-dist publication
  direct GitHub npm install proof

rust-cloud
  optional Rust readiness when Cargo manifests exist
```

Temporary write-capable patch workflows are development scaffolding only and must be removed before merge.

## Live-browser evidence boundary

Deterministic CI does not fabricate live ChatGPT evidence. Browser-dependent operations still require a signed-in visible ChatGPT session and compatible browser bridge at runtime.

The same hard stops remain authoritative:

```text
login required
captcha
rate limit
permission blocker
selector drift
ambiguous exact target
uncertain mutation outcome
unverifiable tab ownership
```

When any of these occurs, the SDK must stop or return a structured blocker. It must not switch to hidden endpoints or replay uncertain mutations.

---

# 40. Updated Definition of Done

This repository-level implementation is complete when one exact release-candidate SHA satisfies all of the following and is merged to `main`:

```text
Node deterministic suite green on Ubuntu and Windows
Python parity suite/compile/pyright green on Ubuntu and Windows
backend contract/parity/conformance green
plugin build/validate/check green
release-readiness green
compiled npm package install smoke green
Codex local-port focused integration test green
Rust-cloud readiness green or correctly no-op when no Cargo manifest exists
no temporary write-capable CI helpers remain
roadmap/status documentation is current
```

After merge, distribution completion additionally requires:

```text
main parity workflow green for the merged source SHA
npm-dist published from that successful main run
npm-dist/SOURCE_COMMIT equals the authoritative merged source SHA
ordinary npm install from private npm-dist succeeds
compiled SDK exports createChatGPT and the autonomous/local-Codex surfaces
installed chatgpt-thread CLI executes
installed backend health request succeeds
```

Only that post-merge GitHub proof should be reported as final completion.
'''

path.write_text(text.rstrip() + addendum + "\n", encoding="utf-8")
