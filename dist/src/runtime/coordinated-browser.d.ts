import type { BrowserLike, PageLike, RuntimeEnv } from "../types.js";
import { type BrowserResourceKey, type CoordinatorOwner, type ProcessTabCoordinator } from "./tab-coordinator.js";
export declare const MAX_BROWSER_TAB_CANDIDATES = 256;
export type CoordinatedBrowserOptions = Readonly<{
    coordinator?: ProcessTabCoordinator;
    owner?: CoordinatorOwner;
}>;
export declare class CoordinatedBrowserError extends Error {
    readonly code = "coordinated_browser_invalid";
    constructor(message: string, options?: {
        cause?: unknown;
    });
}
export declare function coordinatedBrowserResource(browser?: BrowserLike): Readonly<{
    kind: "browser";
    key: BrowserResourceKey;
}>;
/** Wrap a browser using one browser-wide actor; no per-tab capability is inferred. */
export declare function createCoordinatedBrowser(browser: BrowserLike, options?: CoordinatedBrowserOptions): BrowserLike;
/** Wrap one initial/captured page with the browser-wide legacy actor. */
export declare function createCoordinatedPageForBrowser(page: PageLike, browser?: BrowserLike, options?: CoordinatedBrowserOptions): PageLike;
/** Make a fresh RuntimeEnv snapshot with only browser/page values coordinated. */
export declare function coordinateRuntimeEnv(env: RuntimeEnv, options?: CoordinatedBrowserOptions): RuntimeEnv;
export declare function unwrapCoordinatedBrowser(browser: BrowserLike): BrowserLike;
