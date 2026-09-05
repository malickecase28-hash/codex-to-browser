import type { GeneratedArtifact, ListArtifactsArgs, PageLike } from "../types.js";
export declare function listPageArtifacts(page: PageLike, args?: ListArtifactsArgs): Promise<GeneratedArtifact[]>;
export declare function countPageArtifacts(page: PageLike, args?: ListArtifactsArgs): Promise<number>;
export declare function readLatestImageDataUrl(page: PageLike, timeoutMs: number | undefined): Promise<{
    dataUrl: string;
    alt?: string;
} | undefined>;
