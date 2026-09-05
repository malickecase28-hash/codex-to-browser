import { describe, expect, it } from "vitest";
import {
  DevBackendDispatchError,
  dispatchDevBackend
} from "../../src/dev/backend-dispatch.js";
import type { DevChatGPTSdk } from "../../src/dev/client.js";

function fakeDev(calls: Array<readonly [string, unknown]>): DevChatGPTSdk {
  return {
    projects: {
      list: async (filters: unknown) => {
        calls.push(["projects.list", filters]);
        return { ok: true, status: "ok", data: [], warnings: [], context: { timestamp: "2026-09-05T00:00:00.000Z" } };
      },
      delete: async (_ref: unknown, options: unknown) => {
        calls.push(["projects.delete", options]);
        return { ok: true, status: "ok", warnings: [], context: { timestamp: "2026-09-05T00:00:00.000Z" } } as never;
      }
    },
    planner: {
      delete: async (_ref: unknown, options: unknown) => {
        calls.push(["planner.delete", options]);
        return { ok: true, status: "ok", warnings: [], context: { timestamp: "2026-09-05T00:00:00.000Z" } } as never;
      }
    },
    worker: {},
    autonomous: {
      run: async (_workflowId: unknown, options: unknown) => {
        calls.push(["autonomous.run", options]);
        return { workflow: {}, steps: 1, complete: false, waiting: true } as never;
      }
    }
  } as unknown as DevChatGPTSdk;
}

describe("development backend dispatch", () => {
  it("routes Project list through the bounded namespace/action contract", async () => {
    const calls: Array<readonly [string, unknown]> = [];
    const result = await dispatchDevBackend(fakeDev(calls), {
      namespace: "projects",
      action: "list",
      args: { filters: { name: "Compiler" } }
    });

    expect(result).toMatchObject({ ok: true, status: "ok" });
    expect(calls).toEqual([["projects.list", { name: "Compiler" }]]);
  });

  it("preserves explicit destructive confirmation across the backend boundary", async () => {
    const calls: Array<readonly [string, unknown]> = [];
    await dispatchDevBackend(fakeDev(calls), {
      namespace: "projects",
      action: "delete",
      args: {
        ref: "g-p-one",
        options: { idempotencyKey: "delete-one", confirmMutation: true }
      }
    });
    await dispatchDevBackend(fakeDev(calls), {
      namespace: "planner",
      action: "delete",
      args: {
        ref: "task-one",
        options: { idempotencyKey: "delete-task", confirmMutation: true }
      }
    });

    expect(calls).toEqual([
      ["projects.delete", { idempotencyKey: "delete-one", confirmMutation: true }],
      ["planner.delete", { idempotencyKey: "delete-task", confirmMutation: true }]
    ]);
  });

  it("routes autonomous run options without widening the public wire command set", async () => {
    const calls: Array<readonly [string, unknown]> = [];
    const result = await dispatchDevBackend(fakeDev(calls), {
      namespace: "autonomous",
      action: "run",
      args: {
        workflowId: "workflow-one",
        options: { waitForChatGPT: true, timeoutMs: 5000, maxSteps: 4 }
      }
    });

    expect(result).toMatchObject({ steps: 1, waiting: true });
    expect(calls).toEqual([["autonomous.run", { waitForChatGPT: true, timeoutMs: 5000, maxSteps: 4 }]]);
  });

  it("fails closed for unknown namespaces and actions", async () => {
    const dev = fakeDev([]);
    await expect(dispatchDevBackend(dev, { namespace: "hidden", action: "list", args: {} }))
      .rejects.toBeInstanceOf(DevBackendDispatchError);
    await expect(dispatchDevBackend(dev, { namespace: "projects", action: "private", args: {} }))
      .rejects.toBeInstanceOf(DevBackendDispatchError);
  });
});
