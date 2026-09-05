import type { DownloadLike } from "../browser/downloads.js";
import type { PageLike } from "../types.js";
import type { BrowserObservationDigest } from "./browser-observation.js";
import type { ArtifactTransferSourceRequest } from "./artifact-transfer.js";
/**
 * The source side of an artifact transfer is deliberately kept separate from
 * the transfer/output coordinator.  This provider only proves and reads the
 * one artifact owned by the request; it never chooses a latest message or
 * writes a durable output.
 */
export type ProductionChatGPTArtifactsOptions = Readonly<{
    /** An already-owned same-tab page. A per-call page may be supplied instead. */
    page?: Readonly<PageLike>;
    /** The keyed evidence function used by browser-observation.ts. */
    evidenceDigest: BrowserObservationDigest;
    /** Optional existing parent for request-temporary download directories. */
    tempDirectory?: string;
    /** Maximum time spent on bounded reads and event observation. */
    timeoutMs?: number;
    /** Maximum downloaded artifact size accepted by this source. */
    maxBytes?: number;
    /** Maximum DOM artifact candidates examined in one exact turn. */
    maxArtifacts?: number;
    /** Optional request cancellation signal. It never cancels an in-flight mutation. */
    signal?: AbortSignal;
}>;
export type ProductionChatGPTArtifactOpenSource = (request: ArtifactTransferSourceRequest, page?: Readonly<PageLike>) => Promise<AsyncIterable<Uint8Array>>;
/**
 * The browser phase returns only the causal download capability. It performs
 * no saveAs(), path(), filesystem read, or temporary-directory work.
 */
export type ProductionChatGPTArtifactAcquireDownload = (request: ArtifactTransferSourceRequest, page?: Readonly<PageLike>) => Promise<DownloadLike>;
/**
 * The local phase consumes one download capability exactly once and returns
 * only a defensive byte stream. It never calls back into the browser.
 */
export type ProductionChatGPTArtifactMaterializeDownload = (download: DownloadLike) => Promise<AsyncIterable<Uint8Array>>;
export type ProductionChatGPTArtifacts = Readonly<{
    /**
     * Browser phase: prove, arm one waiter, click once, and return the exact
     * causal DownloadLike. Run this only while the same-tab transaction is held.
     */
    acquireDownload: ProductionChatGPTArtifactAcquireDownload;
    /**
     * Local phase: after releasing the browser transaction, materialize the
     * provider capability into a defensive bounded byte stream. No caller path
     * is recursively removed by this phase.
     */
    materializeDownload: ProductionChatGPTArtifactMaterializeDownload;
    /** Convenience composition of acquireDownload followed by materializeDownload. */
    openSource: ProductionChatGPTArtifactOpenSource;
}>;
export type ProductionChatGPTArtifactSourceProviderOptions = ProductionChatGPTArtifactsOptions;
export type ProductionChatGPTArtifactSourceProvider = ProductionChatGPTArtifacts;
export declare const PRODUCTION_CHATGPT_ARTIFACTS_SCHEMA_VERSION: "chatgpt.browser_control.production_artifacts.v1";
/**
 * Create a request-local ChatGPT artifact source adapter.
 *
 * The adapter performs two exact DOM reads around the one browser mutation:
 * the first proves the request's HMAC identity, while the second proves that
 * the same turn/kind/ordinal facts are still present immediately before the
 * click.  A download event is armed once, before the click, and a click that
 * rejects after acting is reconciled against only that one waiter.
 *
 * `acquireDownload` is the short browser-actor phase. Callers should release
 * the same-tab transaction as soon as it resolves, then call
 * `materializeDownload`; `openSource` is retained for non-actor callers that
 * explicitly want the two phases composed.
 */
export declare function createProductionChatGPTArtifacts(options: ProductionChatGPTArtifactsOptions): ProductionChatGPTArtifacts;
/** Explicit aliases used by callers that name the provider after its role. */
export declare const createChatGPTArtifactSourceProvider: typeof createProductionChatGPTArtifacts;
export declare const createProductionChatGPTArtifactSource: typeof createProductionChatGPTArtifacts;
export declare const createProductionChatGPTArtifactSourceProvider: typeof createProductionChatGPTArtifacts;
