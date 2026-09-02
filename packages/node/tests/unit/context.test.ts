import { describe, expect, it } from "vitest";
import { contextFromPage } from "../../src/commands/context.js";

describe("contextFromPage", () => {
  it("copies a data-valued page id", async () => {
    await expect(contextFromPage({ id: "tab-a" })).resolves.toMatchObject({ tabId: "tab-a" });
  });

  it("does not execute an accessor-backed page id", async () => {
    let executed = false;
    const page = Object.defineProperty({}, "id", { get: () => { executed = true; return "tab-a"; } });

    await expect(contextFromPage(page)).resolves.not.toHaveProperty("tabId");
    expect(executed).toBe(false);
  });
});
