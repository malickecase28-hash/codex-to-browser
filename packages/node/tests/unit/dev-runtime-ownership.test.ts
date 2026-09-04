import { describe, expect, it } from "vitest";
import type { PageLike } from "../../src/types.js";
import { createDevChatGPT } from "../../src/dev/client.js";

describe("development runtime ownership", () => {
  it("does not treat generic PageLike id fields as physical tab ownership", async () => {
    const page: PageLike = {
      id: "operator-visible-id",
      tabId: "operator-visible-id",
      url: async () => "https://chatgpt.com/",
      content: async () => "<html><body></body></html>"
    };

    const chatgpt = createDevChatGPT({ page });
    const result = await chatgpt.dev.projects.list();

    expect(result.ok).toBe(false);
    expect(result.status).toBe("blocked");
    expect(result.blocker?.code).toBe("dev_tab_ownership_unavailable");
  });
});
