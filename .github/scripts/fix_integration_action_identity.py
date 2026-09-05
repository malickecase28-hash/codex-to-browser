from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected one integration action identity patch site in {path}, found {count}")
    file.write_text(text.replace(old, new, 1), encoding="utf-8")


# Workflow revision is bookkeeping and changes when a blocker is persisted or
# resumed. It must not create a new physical integration action. A genuinely
# new planner-directed integration attempt is instead keyed by the exact prior
# reviewed SHA/digest plus the accepted source SHAs and prompt digest.
replace_once(
    "packages/node/src/dev/codex-cli-local-port.ts",
    '''    const inputDigest = localInputDigest({
      workflowId: input.workflow.workflowId,
      revision: input.workflow.revision,
      branch,
      acceptedShas,
      promptDigest: digestText(prompt)
    });''',
    '''    const inputDigest = localInputDigest({
      workflowId: input.workflow.workflowId,
      branch,
      acceptedShas,
      plannerReviewedSha: input.workflow.integration.plannerReview?.reviewedSha ?? null,
      plannerReviewDigest: input.workflow.integration.plannerReview?.reviewDigest ?? null,
      promptDigest: digestText(prompt)
    });''',
)

# Simulate an integration Codex process that writes its durable completion
# evidence and then loses the process result. Retrying the same logical
# integration after workflow bookkeeping revision changes must rehydrate the
# started action and never invoke Codex again.
replace_once(
    "packages/node/tests/unit/dev-codex-cli-local-recovery.test.ts",
    '''  it("serializes concurrent implementers on the same owned task worktree", async () => {''',
    '''  it("keeps one integration action across blocker/resume revision changes", async () => {
    const fixture = await repositoryFixture();
    const base = await git(fixture.repository, "rev-parse", "HEAD");
    await writeFile(join(fixture.repository, "accepted.txt"), "accepted\\n", "utf8");
    await git(fixture.repository, "add", "accepted.txt");
    await git(fixture.repository, "commit", "-m", "accepted source");
    const sourceSha = await git(fixture.repository, "rev-parse", "HEAD");
    await git(fixture.repository, "branch", "accepted-source", sourceSha);
    await git(fixture.repository, "reset", "--hard", base);

    const digest = `sha256:${"7".repeat(64)}`;
    const accepted: DevTaskRecord = {
      ...task(),
      phase: "accepted",
      implementation: {
        implementerId: "implementer-recovery",
        branch: "accepted-source",
        candidateDigest: digest
      },
      tester: {
        testerId: "tester-recovery",
        candidateDigest: digest,
        status: "passed",
        reportDigest: `sha256:${"8".repeat(64)}`
      },
      push: {
        branch: "accepted-source",
        commitSha: sourceSha,
        candidateDigest: digest
      }
    };

    let firstCodexCall = true;
    const first = new CodexCliAutonomousLocalPort({
      repositoryRoot: fixture.repository,
      stateRoot: fixture.stateRoot,
      codexExecutable: "fake-codex",
      processRunner: async (executable, args, options) => {
        if (executable !== "fake-codex") return runReal(executable, args, options);
        const output = outputPath(args);
        if (output !== undefined) {
          await writeFile(output, JSON.stringify({ status: "completed" }), "utf8");
        }
        if (firstCodexCall) {
          firstCodexCall = false;
          throw new Error("simulated lost integration process result");
        }
        throw new Error("integration Codex must not be invoked twice");
      }
    });

    await expect(first.integrate({
      workflow: workflow(accepted, 7),
      acceptedTasks: [accepted]
    })).rejects.toMatchObject({ blockerCode: "local_process_unavailable" });

    const calls = { codex: 0, pushes: 0 };
    const restarted = new CodexCliAutonomousLocalPort({
      repositoryRoot: fixture.repository,
      stateRoot: fixture.stateRoot,
      codexExecutable: "fake-codex",
      processRunner: successfulCodexRunner(calls)
    });
    const evidence = await restarted.integrate({
      workflow: workflow(accepted, 9),
      acceptedTasks: [accepted]
    });

    expect(calls.codex).toBe(0);
    expect(evidence.branch).toBe("codex/workflow-recovery-integration");
    expect(evidence.candidateDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("serializes concurrent implementers on the same owned task worktree", async () => {''',
)
