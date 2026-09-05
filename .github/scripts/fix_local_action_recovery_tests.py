from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected one local recovery test patch site in {path}, found {count}")
    file.write_text(text.replace(old, new, 1), encoding="utf-8")


# Remove an accidental placeholder assertion from the recovery test. The actual
# proof is the durable action record plus zero second Codex invocations.
replace_once(
    "packages/node/tests/unit/dev-codex-cli-local-recovery.test.ts",
    '    const worktrees = join(fixture.stateRoot, "worktrees");\n'
    '    expect(await readFile(join(worktrees, (await import("node:fs/promises")).then ? "" : ""), "utf8").catch(() => "ignored")).toBe("ignored");\n',
    '',
)
replace_once(
    "packages/node/tests/unit/dev-codex-cli-local-recovery.test.ts",
    'import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";\n',
    'import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";\n',
)

# Re-run integration at a later workflow revision and prove accepted task SHAs
# are not cherry-picked a second time. The second pass is a new integration
# action and therefore invokes only the integrator once more.
replace_once(
    "packages/node/tests/unit/dev-codex-cli-local-port.test.ts",
    '    expect(integrationTester.testerId).not.toBe(integration.implementerId);\n'
    '    expect(await git(remote, "rev-parse", `refs/heads/${integration.branch}`)).toBe(integrationPush.commitSha);\n\n'
    '    expect(codexCalls.length).toBe(5);\n',
    '    expect(integrationTester.testerId).not.toBe(integration.implementerId);\n'
    '    expect(await git(remote, "rev-parse", `refs/heads/${integration.branch}`)).toBe(integrationPush.commitSha);\n\n'
    '    const reintegration = await port.integrate({\n'
    '      workflow: workflow(acceptedTask, 10),\n'
    '      acceptedTasks: [acceptedTask]\n'
    '    });\n'
    '    expect(reintegration.branch).toBe(integration.branch);\n\n'
    '    expect(codexCalls.length).toBe(6);\n',
)
