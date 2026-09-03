import { describe, expect, it } from "vitest";
import type { BrowserLike, PageLike } from "../../src/types.js";
import {
  MAX_BROWSER_TAB_CANDIDATES,
  coordinateRuntimeEnv,
  createCoordinatedBrowser,
  createCoordinatedPageForBrowser,
  unwrapCoordinatedBrowser
} from "../../src/runtime/coordinated-browser.js";
import { createCoordinatedPage, normalizePage, unwrapCoordinatedPage } from "../../src/runtime/coordinated-page.js";
import { ProcessTabCoordinator } from "../../src/runtime/tab-coordinator.js";

const waitForTurn = async (): Promise<void> => {
  await new Promise<void>(resolve => setImmediate(resolve));
};

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(next => { resolve = next; });
  return { promise, resolve };
};

const owner = (id: string) => ({ backendSessionId: "session", ownerId: id });

class PrivateTabsProvider {
  #tabId = "private-tab";

  list(): PageLike[] {
    return [{ id: this.#tabId }];
  }
}

class PrivateUserProvider {
  #tabId = "private-tab";

  openTabs(): Array<{ id: string }> {
    return [{ id: this.#tabId }];
  }
}

function boundPrivateProvider<T extends object>(provider: T): T {
  return new Proxy(provider, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

describe("coordinated browser runtime facade", () => {
  it("normalizes a raw extension Tab before the page coordinator inspects it", async () => {
    const rawTab = {
      id: "extension-tab",
      url: "https://chatgpt.com/c/raw-extension-tab",
      title: "ChatGPT",
      playwright: {
        content: async () => "<main>ChatGPT</main>",
        evaluate: async <T>() => "evaluated" as T
      }
    };
    const env = coordinateRuntimeEnv({ browser: {}, page: rawTab as unknown as PageLike }, {
      coordinator: new ProcessTabCoordinator(),
      owner: owner("raw-extension-tab")
    });

    expect(env.page?.url).toBeTypeOf("function");
    expect(env.page?.title).toBeTypeOf("function");
    expect(env.page?.content).toBeTypeOf("function");
    expect(env.page?.evaluate).toBeTypeOf("function");
    await expect(env.page?.url?.()).resolves.toBe("https://chatgpt.com/c/raw-extension-tab");
    await expect(env.page?.title?.()).resolves.toBe("ChatGPT");
    await expect(env.page?.content?.()).resolves.toBe("<main>ChatGPT</main>");
    await expect(env.page?.evaluate?.(() => "ignored")).resolves.toBe("evaluated");
  });

  it("does not execute accessor-backed raw Tab provider fields", () => {
    let getterReads = 0;
    const rawTab = { id: "accessor-tab" } as Record<string, unknown>;
    Object.defineProperty(rawTab, "playwright", {
      get: () => {
        getterReads += 1;
        throw new Error("playwright getter must not run");
      }
    });

    expect(() => coordinateRuntimeEnv({ browser: {}, page: rawTab as unknown as PageLike }, {
      coordinator: new ProcessTabCoordinator(),
      owner: owner("accessor-tab")
    })).toThrow(/accessor-backed provider members are not supported/);
    expect(getterReads).toBe(0);
  });

  it("normalizes a live-shaped Tab with a non-callable top-level content member", async () => {
    let evaluatorCalls = 0;
    const tabPrototype = {
      url: () => "https://chatgpt.com/c/stalled-tab",
      title: async () => "ChatGPT"
    };
    const playwrightPrototype = {
      evaluate: async () => {
        evaluatorCalls += 1;
        return "evaluated";
      }
    };
    const rawTab = Object.assign(Object.create(tabPrototype), {
      id: "stalled-tab",
      content: { stale: true },
      playwright: Object.create(playwrightPrototype)
    });

    const normalized = normalizePage(rawTab);

    expect(normalized).not.toBe(rawTab);
    expect(normalized.url).toBeTypeOf("function");
    expect(normalized.title).toBeTypeOf("function");
    expect(normalized.evaluate).toBeTypeOf("function");
    expect(normalized.content).toBeUndefined();
    await expect(normalized.evaluate?.(() => "ignored")).resolves.toBe("evaluated");
    expect(evaluatorCalls).toBe(1);
  });

  it("rejects accessor-backed tab methods without invoking getters", () => {
    let getterReads = 0;
    const tabs = {} as NonNullable<BrowserLike["tabs"]>;
    Object.defineProperty(tabs, "list", {
      get: () => {
        getterReads += 1;
        return async () => [];
      }
    });
    const user = {} as NonNullable<BrowserLike["user"]>;
    Object.defineProperty(user, "openTabs", {
      get: () => {
        getterReads += 1;
        return async () => [];
      }
    });

    expect(() => createCoordinatedBrowser({ name: "chrome", tabs }, {
      coordinator: new ProcessTabCoordinator(),
      owner: owner("accessor-tabs")
    })).toThrow(/accessor-backed provider members are not supported/);
    expect(() => createCoordinatedBrowser({ name: "chrome", user }, {
      coordinator: new ProcessTabCoordinator(),
      owner: owner("accessor-user")
    })).toThrow(/accessor-backed provider members are not supported/);
    expect(getterReads).toBe(0);
  });

  it("calls ordinary own data function providers", async () => {
    const browser: BrowserLike = {
      name: "chrome",
      tabs: { list: async () => [{ id: "own-tab" }] }
    };
    const coordinated = createCoordinatedBrowser(browser, {
      coordinator: new ProcessTabCoordinator(),
      owner: owner("own-function")
    });

    await expect(coordinated.tabs!.list!()).resolves.toEqual([{ id: "own-tab" }]);
  });

  it("preserves provider private brands through normal method access", async () => {
    const browser: BrowserLike = {
      name: "chrome",
      tabs: boundPrivateProvider(new PrivateTabsProvider()),
      user: boundPrivateProvider(new PrivateUserProvider())
    };
    const directTabs = browser.tabs!.list!();
    const directOpenTabs = browser.user!.openTabs!();
    const coordinated = createCoordinatedBrowser(browser, {
      coordinator: new ProcessTabCoordinator(),
      owner: owner("private-brand")
    });

    await expect(coordinated.tabs!.list!()).resolves.toEqual(directTabs);
    await expect(coordinated.user!.openTabs!()).resolves.toEqual(directOpenTabs);
  });

  it("serializes browser methods across separate clients sharing one browser", async () => {
    const gate = deferred();
    const events: string[] = [];
    const browser: BrowserLike = {
      name: "chrome",
      tabs: {
        selected: async () => {
          events.push("selected:start");
          await gate.promise;
          events.push("selected:end");
          return { id: "tab-a" };
        }
      }
    };
    const coordinator = new ProcessTabCoordinator();
    const first = createCoordinatedBrowser(browser, { coordinator, owner: owner("client-a") });
    const second = createCoordinatedBrowser(browser, { coordinator, owner: owner("client-b") });
    expect(unwrapCoordinatedBrowser(first)).toBe(browser);
    const firstCall = first.tabs!.selected!();
    await waitForTurn();
    const secondCall = second.tabs!.selected!();
    await waitForTurn();
    expect(events).toEqual(["selected:start"]);
    gate.resolve();
    await Promise.all([firstCall, secondCall]);
    expect(events).toEqual(["selected:start", "selected:end", "selected:start", "selected:end"]);
  });

  it("orders browser acquisition against page DOM calls on the same conservative resource", async () => {
    const browserGate = deferred();
    const pageGate = deferred();
    const events: string[] = [];
    const rawPage: PageLike = {
      url: async () => {
        events.push("page:url");
        return "https://chatgpt.com/";
      },
      evaluate: async <T>() => {
        events.push("page:evaluate:start");
        await pageGate.promise;
        events.push("page:evaluate:end");
        return "ok" as T;
      }
    };
    const browser: BrowserLike = {
      name: "chrome",
      tabs: { selected: async () => {
        events.push("browser:selected:start");
        await browserGate.promise;
        events.push("browser:selected:end");
        return rawPage;
      } }
    };
    const coordinator = new ProcessTabCoordinator();
    const coordinatedBrowser = createCoordinatedBrowser(browser, { coordinator, owner: owner("browser") });
    const page = createCoordinatedPageForBrowser(rawPage, coordinatedBrowser, {
      coordinator,
      owner: owner("page")
    });
    const browserCall = coordinatedBrowser.tabs!.selected!();
    await waitForTurn();
    const pageCall = page.evaluate!(() => "ok");
    await waitForTurn();
    expect(events).toEqual(["browser:selected:start"]);
    browserGate.resolve();
    await browserCall;
    await waitForTurn();
    expect(events).toEqual(["browser:selected:start", "browser:selected:end", "page:evaluate:start"]);
    pageGate.resolve();
    await pageCall;
    expect(events).toEqual(["browser:selected:start", "browser:selected:end", "page:evaluate:start", "page:evaluate:end"]);
  });

  it("does not claim different-tab concurrency when provider capabilities are unknown", async () => {
    const firstGate = deferred();
    const events: string[] = [];
    const browser: BrowserLike = { name: "codex-unknown" };
    const firstRaw: PageLike = {
      evaluate: async <T>() => {
        events.push("tab-a:start");
        await firstGate.promise;
        events.push("tab-a:end");
        return "a" as T;
      }
    };
    const secondRaw: PageLike = {
      evaluate: async <T>() => {
        events.push("tab-b");
        return "b" as T;
      }
    };
    const coordinator = new ProcessTabCoordinator();
    const first = createCoordinatedPageForBrowser(firstRaw, browser, { coordinator, owner: owner("a") });
    const second = createCoordinatedPageForBrowser(secondRaw, browser, { coordinator, owner: owner("b") });
    const firstCall = first.evaluate!(() => "a");
    await waitForTurn();
    const secondCall = second.evaluate!(() => "b");
    await waitForTurn();
    expect(events).toEqual(["tab-a:start"]);
    firstGate.resolve();
    await Promise.all([firstCall, secondCall]);
    expect(events).toEqual(["tab-a:start", "tab-a:end", "tab-b"]);
  });

  it("bounds owner-specific browser wrappers and keeps recent affinities hot", () => {
    const browser: BrowserLike = { name: "chrome", tabs: {} };
    const coordinator = new ProcessTabCoordinator();
    const first = createCoordinatedBrowser(browser, { coordinator, owner: owner("operation-0") });
    let latest: BrowserLike | undefined;
    for (let index = 1; index <= 300; index += 1) {
      latest = createCoordinatedBrowser(browser, {
        coordinator,
        owner: owner(`operation-${index}`)
      });
    }
    expect(latest).toBeDefined();
    expect(createCoordinatedBrowser(browser, {
      coordinator,
      owner: owner("operation-300")
    })).toBe(latest);
    // The first affinity is outside the bounded 256-entry LRU after the
    // stress loop, so it is rebuilt instead of retained forever.
    expect(createCoordinatedBrowser(browser, {
      coordinator,
      owner: owner("operation-0")
    })).not.toBe(first);
  });

  it("fails closed before mapping an oversized provider tab candidate list", async () => {
    const pages = Array.from(
      { length: MAX_BROWSER_TAB_CANDIDATES + 1 },
      (_, index): PageLike => ({ id: `tab-${index}` })
    );
    const browser: BrowserLike = {
      name: "chrome",
      user: {
        openTabs: async () => pages.map(page => ({ id: page.id! })),
        claimTab: async () => pages[0]!
      },
      tabs: { list: async () => pages }
    };
    const coordinated = createCoordinatedBrowser(browser, {
      coordinator: new ProcessTabCoordinator(),
      owner: owner("candidate-bound")
    });

    await expect(coordinated.tabs!.list!()).rejects.toMatchObject({
      code: "coordinated_browser_invalid"
    });
    await expect(coordinated.user!.openTabs!()).rejects.toMatchObject({
      code: "coordinated_browser_invalid"
    });
  });

  it("keeps timeout polling outside the browser actor and preserves runtime snapshots", async () => {
    const timeoutGate = deferred();
    let countCalls = 0;
    const rawPage: PageLike = {
      waitForTimeout: async () => timeoutGate.promise,
      locator: () => ({ count: async () => {
        countCalls += 1;
        return 1;
      } })
    };
    const browser: BrowserLike = { name: "chrome" };
    const coordinator = new ProcessTabCoordinator();
    const env = coordinateRuntimeEnv({ browser, page: rawPage }, { coordinator, owner: owner("runtime") });
    expect(env.browser).toBe(createCoordinatedBrowser(browser, { coordinator, owner: owner("runtime") }));
    expect(unwrapCoordinatedPage(env.page!)).toBe(rawPage);
    const sleep = env.page!.waitForTimeout!(0);
    await env.page!.locator!("button").count!();
    expect(countCalls).toBe(1);
    timeoutGate.resolve();
    await sleep;
  });
});
