# Install the compiled SDK from GitHub

This repository publishes a compiled Node distribution after the full parity workflow succeeds on `main`. The distribution lives on the `npm-dist` branch and contains the same package files produced by `npm pack`, including compiled JavaScript, TypeScript declarations, the backend executable, contracts, references, and package metadata.

## Requirements

For the compiled Node SDK itself:

- Node.js 20 or newer.
- npm.
- Git credentials that can read this repository when the repository is private.
- A visible signed-in ChatGPT browser session plus a compatible browser bridge for browser-required operations.

Rust, Python, TypeScript, and the repository source tree are not required to install the compiled Node package.

For autonomous **local implementation/testing**, install Codex CLI separately and sign in to it. The supported local port invokes the official non-interactive `codex exec` surface and never enables Codex's dangerous sandbox/approval bypass flags.

```bash
npm install -g @openai/codex
codex
```

The first interactive `codex` run can be used to sign in with ChatGPT. Codex CLI is not needed for read-only SDK use or for workflows that inject a different local executor.

## Authenticate to a private GitHub repository

If GitHub CLI is installed:

```bash
gh auth login
gh auth setup-git
```

Any Git credential helper that can authenticate HTTPS GitHub repository reads is also sufficient.

## Install directly from the compiled GitHub branch

Project-local installation:

```bash
npm install "git+https://github.com/malickecase28-hash/codex-to-browser.git#npm-dist"
```

Global installation:

```bash
npm install -g "git+https://github.com/malickecase28-hash/codex-to-browser.git#npm-dist"
```

The `npm-dist` branch is force-updated only from a successful `codex-chatgpt-control-parity` run on `main`. Its root `SOURCE_COMMIT` file records the exact source commit used to produce the compiled package. The distribution workflow performs an ordinary clean `npm install` from that exact private Git branch before the branch is considered verified.

## Run the installed commands

Show the visible-thread CLI help:

```bash
npx chatgpt-thread --help
```

For a global install:

```bash
chatgpt-thread --help
```

Run the Node backend protocol process:

```bash
npx codex-chatgpt-control-backend
```

The backend reads newline-delimited protocol requests from standard input. Browser-required requests still need a compatible visible browser bridge; installation alone does not bypass login, permissions, captcha, rate limits, or visible UI safety checks.

## Import the compiled SDK

```js
import {
  createChatGPT,
  createCodexCliAutonomousLocalPort,
  createDevAutonomousApi
} from "codex-chatgpt-control";
```

`createChatGPT` is the visible ChatGPT control surface. `createDevAutonomousApi` is the durable repository-development workflow engine. `createCodexCliAutonomousLocalPort` is the packaged local implementation/test/Git adapter. Python exposes the same logical `dev.projects`, `dev.planner`, `dev.worker`, and `dev.autonomous` namespaces through the Node-authoritative backend protocol rather than duplicating browser logic.

## Enable autonomous local Codex work

The enhanced `createChatGPT` client can construct the packaged Codex CLI port when you explicitly opt in with `dev.autonomous.localCodex`:

```js
import { createChatGPT } from "codex-chatgpt-control";

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

`localCodex` is never enabled implicitly. `allowPush: true` is a separate explicit opt-in because pushing a Git branch is a network mutation. Without it, implementation and independent testing can proceed, but the workflow blocks before push with `git_push_confirmation_required` rather than guessing consent.

The local port uses owned Git worktrees, direct executable invocation without a shell, Codex's `workspace-write` sandbox, bounded process output, separate implementation and independent-test Codex sessions, candidate-digest checks, non-force Git pushes, and exact commit-SHA evidence. Runtime state and owned worktrees live under `.chatgpt-dev` by default and are ignored by the source repository.

A minimal workflow plan is explicit and durable:

```js
const workflow = await chatgpt.dev.autonomous.create({
  workflowId: "release-hardening",
  projectKey: "codex-to-browser",
  plannerConversationKey: "planner-main",
  tasks: [
    {
      taskId: "task-001",
      title: "Harden release path",
      summary: "Implement the planned release hardening work.",
      acceptanceCriteria: [
        "relevant unit tests pass",
        "package verification passes"
      ]
    }
  ]
});

const result = await chatgpt.dev.autonomous.run(workflow.workflowId, {
  waitForChatGPT: true,
  maxSteps: 128
});
```

ChatGPT worker/planner turns remain visible-browser operations. The local Codex port never substitutes hidden ChatGPT endpoints and never treats an unverified browser mutation as successful.

## Destructive UI mutations

Project and Planner deletion requires explicit caller confirmation all the way across Node and Python parity surfaces. For example, a Node Project deletion must include `confirmMutation: true`; an unconfirmed request returns `needs_confirmation` before the browser adapter can touch the destructive control.

Planner controls that the live visible UI cannot be positively verified remain fail-closed with `ui_unsupported`. The SDK does not invent hidden Planner APIs or guessed selectors merely to claim feature coverage.

## GitHub Actions package artifact

Every package verification run produces an npm tarball plus SHA-256 checksum as a GitHub Actions artifact. The verification job installs that tarball into a clean npm project, imports the SDK, verifies the packaged Codex local-port export, executes `chatgpt-thread --help`, and performs a backend health request before the tarball is eligible for distribution.

A downloaded tarball can be installed directly:

```bash
npm install ./codex-chatgpt-control-0.6.0-alpha.1.tgz
```

## Tagged GitHub releases

Version tags also build GitHub-hosted npm and Python distributions. Public npmjs and PyPI publication are optional and are not required for GitHub installation.

## Develop in Codespaces

Open **Code → Codespaces → Create codespace on main**. The repository dev container provides Node, Python, stable Rust/Cargo, and GitHub CLI. Rust remains optional: the main SDK runtime is Node, Python remains the parity protocol client, and the Rust workflow activates automatically only when a `Cargo.toml` exists.
