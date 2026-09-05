import { type TerminalBrowserBackend, type TerminalPageInfo } from "./terminal-backend.js";
import type { BrowserLike } from "../../types.js";
export type ChromeDevToolsOptions = {
    command?: string;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
};
export declare function createChromeDevToolsBrowser(options?: ChromeDevToolsOptions): BrowserLike;
export declare class ChromeDevToolsBackend implements TerminalBrowserBackend {
    readonly name = "chrome-devtools";
    private readonly command;
    private readonly cwd;
    private readonly env;
    private readonly timeoutMs;
    constructor(options?: ChromeDevToolsOptions);
    listPages(): Promise<TerminalPageInfo[]>;
    createPage(url: string): Promise<TerminalPageInfo>;
    activatePage(pageId: string): Promise<void>;
    closePage(pageId: string): Promise<void>;
    navigate(pageId: string, url: string): Promise<void>;
    evaluate<T>(pageId: string, expression: string): Promise<T>;
    pressKey(pageId: string, key: string): Promise<void>;
    uploadFiles(_pageId: string, _selector: string, _paths: string[]): Promise<void>;
    private run;
}
