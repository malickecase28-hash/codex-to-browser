import { describe, expect, it, vi } from "vitest";
import { dispatchDevBackend } from "../../src/dev/backend-dispatch.js";
import type { DevChatGPTSdk } from "../../src/dev/client.js";

describe("autonomous integration resume surface", () => {
  it("dispatches only the caller-owned workflow ID to resumeIntegration", async () => {
    const resumeIntegration = vi.fn(async (workflowId: string) => ({
      workflowId,
      status: "integration_ready"
    }));
    const dev = {
      autonomous: { resumeIntegration }
    } as unknown as DevChatGPTSdk;

    const result = await dispatchDevBackend(dev, {
      namespace: "autonomous",
      action: "resumeIntegration",
      args: { workflowId: "workflow-resume-surface" }
    });

    expect(resumeIntegration).toHaveBeenCalledOnce();
    expect(resumeIntegration).toHaveBeenCalledWith("workflow-resume-surface");
    expect(result).toEqual({
      workflowId: "workflow-resume-surface",
      status: "integration_ready"
    });
  });

  it("rejects a missing workflow identity before calling the SDK", async () => {
    const resumeIntegration = vi.fn();
    const dev = {
      autonomous: { resumeIntegration }
    } as unknown as DevChatGPTSdk;

    await expect(dispatchDevBackend(dev, {
      namespace: "autonomous",
      action: "resumeIntegration",
      args: {}
    })).rejects.toMatchObject({ name: "DevBackendDispatchError" });
    expect(resumeIntegration).not.toHaveBeenCalled();
  });
});
