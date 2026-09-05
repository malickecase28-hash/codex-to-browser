import type { BrowserLike } from "../../types.js";
import { type BrowserHarnessOptions } from "./browser-harness.js";
import { type ChromeDevToolsOptions } from "./chrome-devtools.js";
export type TerminalBrowserProvider = "chrome-devtools" | "browser-harness";
export type TerminalBrowserOptions = {
    provider: "chrome-devtools";
    chromeDevTools?: ChromeDevToolsOptions;
} | {
    provider: "browser-harness";
    browserHarness?: BrowserHarnessOptions;
};
export declare function createTerminalBrowserTransport(options: TerminalBrowserOptions): BrowserLike;
export declare function createTerminalBrowserFromEnv(env?: Record<string, string | undefined>): BrowserLike;
