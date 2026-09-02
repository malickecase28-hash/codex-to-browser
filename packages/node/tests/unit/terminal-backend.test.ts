import { describe, expect, it } from "vitest";
import type { TerminalBrowserBackend, TerminalPageInfo } from "../../src/browser/transports/terminal-backend.js";
import { createTerminalBrowser } from "../../src/browser/transports/terminal-backend.js";

class MemoryBackend implements TerminalBrowserBackend {
  readonly name = "memory";
  readonly pages: TerminalPageInfo[] = [{ id: "tab-1", url: "https://chatgpt.com/c/one", title: "One" }];
  readonly evaluations: Array<{ pageId: string; expression: string }> = [];
  readonly activated: string[] = [];
  readonly closed: string[] = [];
  includeSecondPage = false;

  async listPages() { return this.includeSecondPage ? [...this.pages, { id: "tab-2", url: "https://example.com", title: "Two" }] : this.pages; }
  async selectedPageId() { return "tab-2"; }
  async createPage(url: string) {
    const page = { id: `tab-${this.pages.length + 1}`, url, title: "New" };
    this.pages.push(page);
    return page;
  }
  async activatePage(pageId: string) { this.activated.push(pageId); }
  async closePage(pageId: string) { this.closed.push(pageId); }
  async navigate(pageId: string, url: string) {
    const page = this.pages.find(candidate => candidate.id === pageId);
    if (page) page.url = url;
  }
  async evaluate<T>(pageId: string, expression: string) {
    this.evaluations.push({ pageId, expression });
    return "evaluated" as T;
  }
}

describe("terminal BrowserLike adapter", () => {
  it("maps daemon pages and claims the requested user tab", async () => {
    const backend = new MemoryBackend();
    const browser = createTerminalBrowser(backend);

    await expect(browser.user?.openTabs?.()).resolves.toEqual([
      { id: "tab-1", url: "https://chatgpt.com/c/one", title: "One" }
    ]);
    const page = await browser.user?.claimTab?.("tab-1");

    expect(page?.id).toBe("tab-1");
    expect(backend.activated).toEqual(["tab-1"]);
  });

  it("forwards page operations and leaves daemon-owned tabs open on finalize", async () => {
    const backend = new MemoryBackend();
    const browser = createTerminalBrowser(backend);
    const page = await browser.tabs?.new?.("about:blank");

    await page?.goto?.("https://chatgpt.com");
    await page?.locator?.("textarea")?.click?.();
    const value = await page?.evaluate?.((arg: { value: string }) => arg.value, { value: "ok" });
    await browser.tabs?.finalize?.({ keep: [] });

    expect(value).toBe("evaluated");
    expect(backend.pages[1]?.url).toBe("https://chatgpt.com");
    expect(backend.evaluations.map(entry => entry.expression)).toEqual([
      expect.stringContaining("element.click()"),
      expect.stringContaining('"value":"ok"')
    ]);
    expect(backend.evaluations[1]?.expression).toContain("const __name = value => value");
    expect(backend.closed).toEqual([]);
  });

  it("uses a backend-selected page when the daemon exposes one", async () => {
    const backend = new MemoryBackend();
    backend.includeSecondPage = true;
    const browser = createTerminalBrowser(backend);

    await expect(browser.tabs?.selected?.()).resolves.toMatchObject({ id: "tab-2" });
  });

  it("builds role, text, and nth locator operations in page expressions", async () => {
    const backend = new MemoryBackend();
    const browser = createTerminalBrowser(backend);
    const page = await browser.tabs?.get?.("tab-1");

    await page?.getByRole?.("button", { name: "Send" }).first?.().isVisible?.();
    await page?.locator?.("main")?.getByText?.(/hello/i)?.nth?.(-1)?.innerText?.();

    expect(backend.evaluations[0]?.expression).toContain("roleOf(element) === current.role");
    expect(backend.evaluations[0]?.expression).toContain('matcher.value');
    expect(backend.evaluations[1]?.expression).toContain('current.index');
    expect(backend.evaluations[1]?.expression).toContain("case 'filter'");
  });

  it("preserves exact role-name matching", async () => {
    const backend = new MemoryBackend();
    const browser = createTerminalBrowser(backend);
    const page = await browser.tabs?.get?.("tab-1");

    await page?.getByRole?.("button", { name: { value: "Send", exact: true } }).count?.();

    expect(backend.evaluations.at(-1)?.expression).toContain("matcher.exact");
  });
});
