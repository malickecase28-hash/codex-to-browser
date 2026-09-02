import type { BrowserLike } from "../../types.js";
import { createBrowserHarnessBrowser, type BrowserHarnessOptions } from "./browser-harness.js";
import { createChromeDevToolsBrowser, type ChromeDevToolsOptions } from "./chrome-devtools.js";

export type TerminalBrowserProvider = "chrome-devtools" | "browser-harness";

export type TerminalBrowserOptions =
  | { provider: "chrome-devtools"; chromeDevTools?: ChromeDevToolsOptions }
  | { provider: "browser-harness"; browserHarness?: BrowserHarnessOptions };

export function createTerminalBrowserTransport(options: TerminalBrowserOptions): BrowserLike {
  switch (options.provider) {
    case "chrome-devtools":
      return createChromeDevToolsBrowser(options.chromeDevTools);
    case "browser-harness":
      return createBrowserHarnessBrowser(options.browserHarness);
  }
}

export function createTerminalBrowserFromEnv(): BrowserLike {
  const provider = process.env.CODEX_BROWSER_PROVIDER ?? "browser-harness";
  if (provider === "chrome-devtools") return createChromeDevToolsBrowser();
  if (provider === "browser-harness") {
    const browserName = process.env.CODEX_BROWSER_NAME;
    return createBrowserHarnessBrowser(browserName === undefined ? {} : { browserName });
  }
  throw new Error(`Unknown CODEX_BROWSER_PROVIDER: ${provider}`);
}
