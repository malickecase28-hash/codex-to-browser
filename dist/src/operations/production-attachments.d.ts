import type { LocatorLike, PageLike } from "../types.js";
import type { BrowserObservationDigest } from "./browser-observation.js";
import { type OperationFileIdentity, type OperationFileManifestEntryV1 } from "./file-identity.js";
import type { SubmissionAttachmentObservation, SubmissionAttachmentRequest, SubmissionHandoffRequest, SubmissionHandoffResult } from "./submission.js";
import type { OperationTargetBindingV1 } from "./types.js";
/**
 * Provider capability for activating the one proven attachment/upload
 * control. Most providers return a visible locator. A browser integration may
 * instead return one bounded activation callback when its native upload input
 * is intentionally hidden and the provider can prove the exact active-composer
 * target through a narrower browser capability.
 */
export type ProductionAttachmentActivation = Readonly<{
    /** Provider-side candidate count before this primitive is allowed to click. */
    candidateCount: number;
    /** Stable provider capability key, never a localized display string. */
    capabilityKey: string;
} & ({
    locator: LocatorLike;
    activate?: never;
} | {
    locator?: never;
    /** One provider-owned gesture. The primitive starts the chooser waiter first. */
    activate: (options: Readonly<{
        timeoutMs: number;
    }>) => Promise<void> | void;
})>;
/**
 * Optional bounded preparation for providers whose composer exposes a plus
 * menu before the final localized Upload row. The durable file-handoff intent
 * must already exist before this callback is invoked. This is a mutation and
 * therefore the callback receives the provider timeout and is awaited to
 * settlement; the primitive never retries it.
 */
export type ProductionAttachmentPreparationResult = Readonly<{
    status: "prepared";
    providerEvidenceDigest: string;
} | {
    status: "not_satisfied";
    blockerCode: "selector_drift" | "ambiguous_file_handoff" | "operation_timeout";
} | {
    status: "uncertain";
    quarantine: "provider" | "caller";
}>;
/**
 * A provider attachment observer must return identity evidence from the live
 * surface itself. A filename, aria-label, or display name is not a content
 * identity and must never be converted into a manifest SHA or identity digest.
 */
export type ProductionAttachmentSurfaceRead = Readonly<{
    status: "absent";
    source: "live_surface";
    count: 0;
    identityDigests: readonly [];
    providerEvidenceDigest: string;
} | {
    status: "exact";
    source: "live_surface";
    count: number;
    identityDigests: readonly string[];
    providerEvidenceDigest: string;
} | {
    status: "mismatch" | "delayed" | "ambiguous" | "unavailable";
    source: "live_surface";
    providerEvidenceDigest?: string;
}>;
export type ProductionAttachmentPrimitiveOptions = Readonly<{
    /** Journal-keyed HMAC evidence. Bare hashes are rejected. */
    evidenceDigest: BrowserObservationDigest;
    /** Request-local immutable inputs. Paths remain inside this module closure. */
    files: readonly OperationFileIdentity[];
    /** Computes the operation identity digest for one immutable file manifest. */
    identityDigest: (ordinal: number, manifest: OperationFileManifestEntryV1) => string;
    /** Provider proof that a path still has its established identity. */
    revalidateFile: (identity: OperationFileIdentity) => Promise<void>;
    /** One bounded read of the provider's live attachment surface. Never polls. */
    observeSurface: (request: SubmissionAttachmentRequest, page: Readonly<PageLike>, target: OperationTargetBindingV1) => Promise<ProductionAttachmentSurfaceRead>;
    /** One bounded discovery of the unique visible localized activation control. */
    resolveActivation: (request: SubmissionHandoffRequest, page: Readonly<PageLike>, target: OperationTargetBindingV1) => Promise<ProductionAttachmentActivation | undefined>;
    /**
     * Optional one-shot plus-menu preparation. When present, this is the only
     * supported route for a two-step composer; callers must not hide a second
     * activation inside resolveActivation.
     */
    prepareActivation?: (request: SubmissionHandoffRequest, page: Readonly<PageLike>, target: OperationTargetBindingV1, options: Readonly<{
        timeoutMs: number;
    }>) => Promise<ProductionAttachmentPreparationResult>;
    /** Maximum chooser/callback budget. No polling interval is used. */
    timeoutMs?: number;
    /** Maximum accepted provider candidate count. */
    maxCandidates?: number;
}>;
/** Direct API plus the adapter-shaped bridge used by OperationBrowserAdapter. */
export type ProductionAttachmentPrimitive = Readonly<{
    observeAttachments: (request: SubmissionAttachmentRequest, page: Readonly<PageLike>, target: OperationTargetBindingV1) => Promise<SubmissionAttachmentObservation>;
    handoffFiles: (request: SubmissionHandoffRequest, page: Readonly<PageLike>, target: OperationTargetBindingV1) => Promise<SubmissionHandoffResult>;
    /**
     * Adapter-compatible wrapper. The supplied identities are checked against
     * the request-local immutable list, then discarded; raw paths never enter a
     * provider result or evidence payload.
     */
    handoffFilesForAdapter: (request: SubmissionHandoffRequest, files: readonly OperationFileIdentity[], page: Readonly<PageLike>, target: OperationTargetBindingV1) => Promise<SubmissionHandoffResult>;
}>;
export declare const PRODUCTION_ATTACHMENT_SCHEMA_VERSION: "chatgpt.browser_control.production_attachments.v1";
/**
 * Build one request-scoped, non-repeatable attachment capability.
 *
 * The factory validates and freezes the entire identity graph before any
 * provider callback can run. Handoff has one state machine: revalidate -> arm
 * one chooser waiter -> resolve one visible control -> click at most once ->
 * setFiles at most once. If either browser mutation can have happened and its
 * outcome is not exact, the result is quarantined as uncertain.
 */
export declare function createProductionAttachmentPrimitive(options: ProductionAttachmentPrimitiveOptions): ProductionAttachmentPrimitive;
/** Alias retained for integrations that name the layer after its provider. */
export declare const createOperationProductionAttachments: typeof createProductionAttachmentPrimitive;
