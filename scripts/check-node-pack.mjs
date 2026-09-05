#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import process from "node:process";

import { npmInvocation } from "./lib/npm-command.mjs";

const REQUIRED_FILES = [
  "package.json",
  "README.md",
  "LICENSE",
  "CHANGELOG.md",
  "dist/src/index.js",
  "dist/src/index.d.ts",
  "dist/src/environment.js",
  "dist/src/environment.d.ts",
  "dist/src/dev/autonomous-api.js",
  "dist/src/dev/autonomous-api.d.ts",
  "dist/src/dev/autonomous-chatgpt-port.js",
  "dist/src/dev/autonomous-chatgpt-port.d.ts",
  "dist/src/dev/autonomous-engine.js",
  "dist/src/dev/autonomous-engine.d.ts",
  "dist/src/dev/autonomous-local-identity.js",
  "dist/src/dev/autonomous-local-identity.d.ts",
  "dist/src/dev/autonomous-workflow.js",
  "dist/src/dev/autonomous-workflow.d.ts",
  "dist/src/dev/codex-cli-local-port.js",
  "dist/src/dev/codex-cli-local-port.d.ts",
  "dist/src/dev/client.js",
  "dist/src/dev/client.d.ts",
  "dist/src/scripts/backend-server.js",
  "dist/src/scripts/chatgpt-thread-bin.js",
  "dist/codex-chatgpt-control.bundle.mjs",
  "dist/codex-chatgpt-control-backend.mjs",
  "contracts/v1/manifest.json",
  "references/autonomous-development.md"
];

const FORBIDDEN_PATTERNS = [
  /^node_modules\//,
  /^reports\//,
  /^tests\//,
  /^src\/.*\.ts$/,
  /\.map$/,
  /\.env(?:\.|$)/,
  /live-smoke\/.*\.json$/,
  /__pycache__/
];

function main() {
  const npm = npmInvocation(["pack", "--dry-run", "--json"]);
  const output = execFileSync(npm.program, npm.args, {
    cwd: new URL("../packages/node", import.meta.url),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });

  const packs = JSON.parse(output);
  const pack = packs[0];
  if (!pack) throw new Error("npm pack did not return a package summary");

  const files = pack.files.map(file => file.path).sort();
  const missing = REQUIRED_FILES.filter(file => !files.includes(file));
  const forbidden = files.filter(file => FORBIDDEN_PATTERNS.some(pattern => pattern.test(file)));

  const summary = {
    name: pack.name,
    version: pack.version,
    filename: pack.filename,
    files: files.length,
    unpackedSize: pack.unpackedSize,
    required: REQUIRED_FILES.length,
    missing,
    forbidden
  };
  console.log(JSON.stringify(summary, null, 2));

  if (missing.length > 0 || forbidden.length > 0) {
    process.exit(1);
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
