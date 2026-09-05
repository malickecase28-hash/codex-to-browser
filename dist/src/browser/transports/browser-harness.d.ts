import { type TerminalBrowserBackend, type TerminalPageInfo } from "./terminal-backend.js";
import type { BrowserLike } from "../../types.js";
export type BrowserHarnessOptions = {
    command?: string;
    args?: string[];
    cwd?: string;
    browserName?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
};
export declare function createBrowserHarnessBrowser(options?: BrowserHarnessOptions): BrowserLike;
export declare class BrowserHarnessBackend implements TerminalBrowserBackend {
    readonly name = "browser-harness";
    private readonly command;
    private readonly args;
    private readonly cwd;
    private readonly env;
    private readonly timeoutMs;
    constructor(options?: BrowserHarnessOptions);
    listPages(): Promise<TerminalPageInfo[]>;
    createPage(url: string): Promise<TerminalPageInfo>;
    activatePage(pageId: string): Promise<void>;
    closePage(pageId: string): Promise<void>;
    selectedPageId(): Promise<string | undefined>;
    navigate(pageId: string, url: string): Promise<void>;
    evaluate<T>(pageId: string, expression: string): Promise<T>;
    pressKey(pageId: string, key: string): Promise<void>;
    uploadFiles(pageId: string, selector: string, paths: string[]): Promise<void>;
    waitForEvent(pageId: string, event: string): Promise<unknown>;
    private execJson;
    private exec;
    private queue;
    private execOnce;
}
