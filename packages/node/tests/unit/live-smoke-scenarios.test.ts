import { describe, expect, it } from "vitest";
import { optionalScenarios } from "../../src/scripts/live-smoke/scenarios.js";
import type { LiveSmokeContext } from "../../src/scripts/live-smoke/types.js";

describe("initial-affinity-persistence live smoke scenario", () => {
  it("is opt-in and skips without conversation identity", async () => {
    const scenario = optionalScenarios.find(item => item.name === "initial-affinity-persistence");
    expect(scenario).toBeDefined();
    const context: LiveSmokeContext = { agent: {}, env: { CHATGPT_E2E_INITIAL_AFFINITY: "1" }, reportDir: "unused" };

    expect(scenario!.enabled(context)).toBe(true);
    const result = await scenario!.run(context);

    expect(result.status).toBe("skip");
    expect(result.details).toEqual({ reason: "blocked: missing conversation identity input" });
  });

  it("skips when the exact tab inventory is unavailable", async () => {
    const scenario = optionalScenarios.find(item => item.name === "initial-affinity-persistence")!;
    const result = await scenario.run({
      agent: {},
      env: { CHATGPT_E2E_INITIAL_AFFINITY: "1" },
      knownConversationId: "redacted-conversation",
      reportDir: "unused"
    });

    expect(result.status).toBe("skip");
    expect(result.details).toEqual({ reason: "blocked: exact tab inventory unavailable" });
  });
});

describe("affinity duplicate/stale-owner recovery live smoke scenario", () => {
  it("is disabled unless tab mutations are explicitly authorized", async () => {
    const scenario = optionalScenarios.find(item => item.name === "affinity-duplicate-stale-owner-recovery");
    expect(scenario).toBeDefined();
    const context: LiveSmokeContext = {
      agent: {},
      env: { CHATGPT_E2E_AFFINITY_RECOVERY: "1" },
      knownConversationId: "redacted-conversation",
      reportDir: "unused"
    };

    expect(scenario!.enabled(context)).toBe(false);
    const result = await scenario!.run(context);

    expect(result.status).toBe("skip");
    expect(result.details).toEqual({ reason: "blocked: explicit tab mutation authorization is required" });
  });

  it("skips when the authorized exact owner tab fixture is missing", async () => {
    const scenario = optionalScenarios.find(item => item.name === "affinity-duplicate-stale-owner-recovery")!;
    const result = await scenario.run({
      agent: {},
      env: {
        CHATGPT_E2E_AFFINITY_RECOVERY: "1",
        CHATGPT_E2E_AFFINITY_RECOVERY_ALLOW_MUTATIONS: "1"
      },
      knownConversationId: "redacted-conversation",
      reportDir: "unused"
    });

    expect(result.status).toBe("skip");
    expect(result.details).toEqual({ reason: "blocked: exact owner tab fixture is required" });
  });
});
