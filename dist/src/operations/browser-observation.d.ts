import type { PageLike } from "../types.js";
import { type OwnershipBaseline, type OwnershipSnapshot } from "./turn-ownership.js";
import { type CollectorTerminalObservation } from "./collector.js";
import type { OperationResponseFormatV1 } from "./types.js";
/**
 * A read-only browser observation has deliberately fewer powers than the
 * legacy page helpers.  The page is passed by value to this boundary and is
 * never obtained from (or written back to) RuntimeEnv.
 */
export type BrowserObservationDigest = (domain: string, material: unknown) => string;
export type BrowserObservationTarget = Readonly<{
    providerId: string;
    browserId: string;
    tabId: string;
    coordinationScope: "process" | "provider";
    authoritativeTabClaim?: string;
    /**
     * A new target is allowed to have no provider conversation identity before
     * Send.  The read-only page probe still has to prove a blank/new-task
     * surface; this flag never permits a missing identity for a fixed target.
     */
    targetLifecycle?: "fixed" | "new_pending" | "new_established";
    expectedConversationId?: string;
    expectedThreadId?: string;
}>;
export type BrowserObservationOptions = Readonly<{
    operationId: string;
    target: BrowserObservationTarget;
    evidenceDigest: BrowserObservationDigest;
    /** Metadata is the default; raw content requires an exact assistant ID. */
    responseContent?: "include" | "metadata";
    /** Immutable transactional response format; only semantic Markdown/text are supported. */
    responseFormat?: OperationResponseFormatV1;
    /** Exact terminal assistant turn to normalize for collector metadata. */
    terminalAssistantTurnId?: string;
    rawAssistantTurnId?: string;
    /** A complete baseline enables exact post-Send delta evidence. */
    baseline?: OwnershipBaseline;
    maxTurns?: number;
    maxTextChars?: number;
    maxArtifactsPerTurn?: number;
}>;
export type BrowserObservationResult = Readonly<{
    snapshot: OwnershipSnapshot;
    terminal?: CollectorTerminalObservation;
    /** Present only for a verified blank/new-task pre-Send observation. */
    newTargetAnchor?: Readonly<{
        anchorDigest: string;
        blankTaskEvidenceDigest: string;
    }>;
}>;
export type BrowserObservationErrorCode = "page_evaluation_unavailable" | "page_evaluation_failed" | "provider_shape_drift" | "missing_identity" | "duplicate_identity" | "unstable_identity" | "incomplete_dom" | "navigation_ambiguous" | "branch_ambiguous" | "bounded_limit_exceeded" | "evidence_digest_failed" | "raw_content_unavailable";
export declare class BrowserObservationError extends Error {
    readonly code: BrowserObservationErrorCode;
    constructor(code: BrowserObservationErrorCode);
}
type RawArtifact = Readonly<{
    kind: "file" | "image" | "other";
    identity: string;
    contentDigest?: string;
    bytes?: number;
    mimeType?: string;
}>;
type RawTurn = Readonly<{
    role: "user" | "assistant";
    stableId: string;
    parentStableId?: string;
    branchStableId?: string;
    ordinal: number;
    text: string;
    /** Bounded, transient innerHTML for the one exact requested assistant turn. */
    contentHtml?: string;
    structure: Readonly<{
        tag: string;
        childCount: number;
        artifactCount: number;
    }>;
    state?: "generating" | "terminal";
    finishReason?: string;
    artifacts: readonly RawArtifact[];
}>;
type RawPageObservation = Readonly<{
    canonicalUrl: string;
    conversationId?: string;
    threadId?: string;
    turns: readonly RawTurn[];
    completeness: "complete" | "truncated" | "incomplete" | "out_of_order";
    terminalState: "idle" | "generating" | "terminal" | "unknown";
}>;
type RawEvaluateArguments = Readonly<{
    maxTurns: number;
    maxTextChars: number;
    maxArtifactsPerTurn: number;
    captureAssistantTurnId?: string;
    allowBlankTask?: boolean;
}>;
/**
 * Perform one bounded read-only page transaction and normalize its result.
 * `page.evaluate` is the only browser call made by this adapter.
 */
export declare function observeBrowserPage(page: Readonly<PageLike>, options: BrowserObservationOptions): Promise<BrowserObservationResult>;
/**
 * This function is intentionally self-contained because it is serialized into
 * the browser evaluation boundary. It returns bounded, transient raw material;
 * the outer adapter converts ownership material to HMAC evidence and never
 * stores prompt/response text in the normalized snapshot. Exact response text
 * is exposed only in the request-scoped terminal result when explicitly asked.
 */
export declare function readPageObservation(args: RawEvaluateArguments): RawPageObservation;
export {};
