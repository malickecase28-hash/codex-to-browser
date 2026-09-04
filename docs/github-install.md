# Install the compiled SDK from GitHub

This repository publishes a compiled Node distribution after the full parity workflow succeeds on `main`. The distribution lives on the `npm-dist` branch and contains the same package files produced by `npm pack`, including compiled JavaScript, TypeScript declarations, the backend executable, contracts, references, and package metadata.

## Requirements

- Node.js 20 or newer.
- npm.
- Git credentials that can read this repository when the repository is private.
- A visible signed-in ChatGPT browser session plus a compatible browser bridge for browser-required operations.

Rust, Python, TypeScript, and the repository source tree are not required to install the compiled Node package.

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

The `npm-dist` branch is force-updated only from a successful `codex-chatgpt-control-parity` run on `main`. Its root `SOURCE_COMMIT` file records the exact source commit used to produce the compiled package.

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
  createDevAutonomousApi
} from "codex-chatgpt-control";
```

`createChatGPT` is the visible ChatGPT control surface. `createDevAutonomousApi` is the durable repository-development workflow engine. The autonomous API still requires explicit ChatGPT and local-executor ports; it does not fabricate shell, Git, browser, or tester evidence.

## GitHub Actions package artifact

Every package verification run produces an npm tarball plus SHA-256 checksum as a GitHub Actions artifact. The verification job installs that tarball into a clean npm project, imports the SDK, executes `chatgpt-thread --help`, and performs a backend health request before the tarball is eligible for distribution.

A downloaded tarball can be installed directly:

```bash
npm install ./codex-chatgpt-control-0.6.0-alpha.1.tgz
```

## Tagged GitHub releases

Version tags also build GitHub-hosted npm and Python distributions. Public npmjs and PyPI publication are optional and are not required for GitHub installation.

## Develop in Codespaces

Open **Code → Codespaces → Create codespace on main**. The repository dev container provides Node, Python, stable Rust/Cargo, and GitHub CLI. Rust remains optional: the main SDK runtime is Node, Python remains the parity protocol client, and the Rust workflow activates automatically only when a `Cargo.toml` exists.
