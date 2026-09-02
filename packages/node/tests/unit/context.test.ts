import { describe, expect, it } from "vitest";
import { contextFromPage } from "../../src/commands/context.js";

describe("contextFromPage", () => {
  it("does not infer identity from a page id", async () => {
    await expect(contextFromPage({ id: "tab-a" })).resolves.not.toHaveProperty("tabId");
  });

  it("preserves an explicitly supplied identity", async () => {
    await expect(contextFromPage({ id: "misleading" }, { tabId: "tab-a" })).resolves.toMatchObject({ tabId: "tab-a" });
  });

  it("does not execute an accessor-backed page id", async () => {
    let executed = false;
    const page = Object.defineProperty({}, "id", { get: () => { executed = true; return "tab-a"; } });

    await expect(contextFromPage(page)).resolves.not.toHaveProperty("tabId");
    expect(executed).toBe(false);
  });
});
