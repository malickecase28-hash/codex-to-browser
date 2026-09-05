import type { BrowserLike } from "../../types.js";
export type TerminalPageInfo = {
    id: string;
    url: string;
    title: string;
};
export interface TerminalBrowserBackend {
    readonly name: string;
    listPages(): Promise<TerminalPageInfo[]>;
    createPage(url: string): Promise<TerminalPageInfo>;
    activatePage(pageId: string): Promise<void>;
    closePage(pageId: string): Promise<void>;
    navigate(pageId: string, url: string): Promise<void>;
    evaluate<T>(pageId: string, expression: string): Promise<T>;
    pressKey?(pageId: string, key: string): Promise<void>;
    uploadFiles?(pageId: string, selector: string, paths: string[]): Promise<void>;
    waitForEvent?(pageId: string, event: string, options?: unknown): Promise<unknown>;
    selectedPageId?(): Promise<string | undefined>;
}
export declare function createTerminalBrowser(backend: TerminalBrowserBackend): BrowserLike;
