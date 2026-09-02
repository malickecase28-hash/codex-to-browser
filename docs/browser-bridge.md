---
title: Browser Bridge
date: 2026-06-06
type: reference
status: draft
---

# Browser Bridge

Browser-required operations need a compatible bridge that exposes a visible ChatGPT tab to the SDK runtime.

Ordinary shell runs validate the backend protocol and produce structured
`browser_bridge_unavailable` blockers for browser-required commands unless a
terminal transport is explicitly supplied.

When using a Codex-hosted browser bridge, initialize the bridge in the host runtime, then pass that agent object to `createChatGPT({ agent })`. Keep bridge-hosted backend processes alive while Python clients call through relays; if the host call exits, browser operations can lose their execution context.

## Runtime Requirements

Deterministic tests and protocol checks need only local language runtimes:

- Node.js 20 or newer
- npm
- Python 3.10 or newer for the Python client

Real ChatGPT control additionally needs:

- Chrome with a signed-in visible ChatGPT web session
- a compatible Codex/browser bridge exposing `globalThis.agent`
- permission to operate or open a visible ChatGPT tab
- explicit user approval for prompts, files, downloads, and account-affecting actions

`globalThis.agent` is host-provided. The SDK does not create or fake a browser bridge from an ordinary shell.

## Terminal transports

The Node package also accepts a terminal-owned `BrowserLike` transport. This
avoids the Codex Desktop bridge while retaining the visible-session boundary:

```ts
import { createChatGPT, createTerminalBrowserFromEnv } from "codex-chatgpt-control";

const chatgpt = createChatGPT({ browser: createTerminalBrowserFromEnv() });
await chatgpt.session.bootstrap({ preferExistingTab: true });
```

Set `CODEX_BROWSER_PROVIDER=browser-harness` (the default) or
`CODEX_BROWSER_PROVIDER=chrome-devtools`. Browser Harness uses its persistent
daemon and supports visible tab listing, navigation, JavaScript, keyboard
input, and file upload. Chrome DevTools supports the same core page controls;
its file upload adapter remains deliberately blocked until UID resolution is
implemented.

Install and verify Browser Harness:

```bash
uv tool install --python 3.12 --upgrade --force browser-harness
browser-harness <<'PY'
import json
print(json.dumps(list_tabs(), indent=2))
PY
```

For Chrome 144+, enable remote debugging at
`chrome://inspect/#remote-debugging` before attaching to an existing Chrome
profile. The no-send `npm run smoke:terminal-browser` command performs the
first bootstrap/read check.

Install and verify the alternate Chrome DevTools provider:

```bash
npm install -g chrome-devtools-mcp@latest
chrome-devtools list_pages --output-format=json
```

With Chrome remote debugging enabled, an existing Chrome profile can be
attached through the persistent daemon:

```bash
chrome-devtools stop
chrome-devtools start --autoConnect
chrome-devtools list_pages
```

## Host-Local Attachment Paths

Attachment paths must be absolute on the machine running the Node backend. On Linux/WSL backends, use paths such as `/home/you/file.pdf` or `/mnt/c/work/file.pdf`. On Windows backends, use fully qualified paths such as `C:\Users\you\file.pdf` or UNC paths such as `\\server\share\file.pdf`. The backend rejects ambiguous Windows forms and rejects Windows-looking paths when the backend host is POSIX.

## File Upload Permissions

File attachments require both permission gates:

1. Chrome extension gate: open `chrome://extensions`, select the Codex/browser bridge extension, open **Details**, and enable **Allow access to file URLs**.
2. Codex app gate: in Codex settings, allow Google Chrome uploads under **Computer Use > Google Chrome > Permissions > Uploads**.

If either gate is missing, upload workflows should return a structured permission blocker instead of retrying.
