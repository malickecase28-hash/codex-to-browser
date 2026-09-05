import type { BootstrapArgs, BrowserLike, PageLike, RuntimeEnv } from "../types.js";
import { type CoordinatedBrowserOptions } from "../runtime/coordinated-browser.js";
export type AttachedPageSelection = {
    page: PageLike;
    tabId?: string;
};
export type AttachedBrowser = {
    browser: BrowserLike;
    page: PageLike;
    browserName: string;
    tabId?: string;
};
export declare function attachChatGPTBrowser(env: RuntimeEnv, args?: BootstrapArgs, coordination?: CoordinatedBrowserOptions): Promise<AttachedBrowser>;
/** Resolve the configured provider browser without selecting, claiming, or creating a tab. */
export declare function resolveChatGPTBrowser(env: RuntimeEnv, coordination?: CoordinatedBrowserOptions): Promise<BrowserLike>;
export { isChatGPTUrl } from "./chatgpt-url.js";
export declare function tabIdFromPage(page: PageLike): string | undefined;
export declare function bindPageTabId(page: PageLike, tabId: string | undefined): void;
