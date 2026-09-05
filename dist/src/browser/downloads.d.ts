import type { DownloadedFile, PageLike } from "../types.js";
export type DownloadLike = {
    suggestedFilename?: () => string;
    /** Capability-based stream exposed by Playwright's Download implementation. */
    createReadStream?: () => Promise<AsyncIterable<Uint8Array>>;
    saveAs?: (path: string) => Promise<void>;
    path?: () => Promise<string | null>;
};
export declare function waitForDownloadFromClick(page: PageLike, click: () => Promise<void>, destDir: string, timeoutMs: number, filenameHint?: string): Promise<DownloadedFile>;
