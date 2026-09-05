import { type CoordinatorOwner, type ProcessTabCoordinator } from "../runtime/tab-coordinator.js";
import { OperationRuntimeContext, type OperationRuntimeCapabilities } from "../runtime/operation-context.js";
import type { PageLike } from "../types.js";
import { type BrowserTargetCapabilities, type BrowserTargetClaim, type BrowserTargetEvidenceDigest } from "./browser-target.js";
import { type OperationStagingCallbackRequest, type OperationStagingMutationResult, type OperationStagingObservation } from "./staging.js";
import { type SendOnceObservers } from "./send-once.js";
import { type OperationFileIdentity } from "./file-identity.js";
import type { CollectorObservation, CollectorObservationRequest } from "./collector.js";
import type { ControlSteerExecutePreparedRequest, ControlSteerPhaseResult, ControlSteerPrepareRequest, ControlSteerRecoverRequest, ControlSteerVerifyRequest, ControlExecutionRequest, ControlExecutionResult, ControlPostconditionObservation, ControlPostconditionRequest, ControlTurnObservation, ControlTurnObservationRequest } from "./control.js";
import type { OperationCollectorContext, OperationCollectorContextRequest, OperationBrowserAdapter } from "./service.js";
import { type ArtifactTransferSourceRequest } from "./artifact-transfer.js";
import type { DownloadLike } from "../browser/downloads.js";
import type { OperationTargetBindingV1, OperationTargetRequestV1, OperationSurface } from "./types.js";
import type { OwnershipTargetEvidence } from "./turn-ownership.js";
import type { SubmissionAttachmentObservation, SubmissionAttachmentRequest, SubmissionHandoffRequest, SubmissionHandoffResult, SubmissionStageObservation, SubmissionStageRequest } from "./submission.js";
/**
 * Browser-bound adapter errors intentionally contain only a stable code.  The
 * visible browser layer may produce provider/bridge errors containing URLs,
 * paths, prompt text, or claim tokens; none of those values are allowed to
 * cross this boundary.
 */
export type OperationBrowserAdapterErrorCode = "adapter_incomplete" | "target_evidence_unavailable" | "target_binding_mismatch" | "page_affinity_mismatch" | "browser_bridge_unavailable" | "unsupported_browser_primitive" | "input_file_changed";
export declare class OperationBrowserAdapterError extends Error {
    readonly code: OperationBrowserAdapterErrorCode;
    constructor(code: OperationBrowserAdapterErrorCode);
}
/** A target probe is read-only and returns no caller-controlled diagnostics. */
export type OperationBrowserTargetProbe = Readonly<{
    page?: Readonly<PageLike>;
    evidence: OwnershipTargetEvidence;
    authoritativeClaim?: BrowserTargetClaim;
    capabilities?: Partial<BrowserTargetCapabilities>;
    /** New targets must carry provider-proofed blank-task anchor evidence. */
    targetLifecycle?: "fixed" | "new_pending" | "new_established";
    newTargetAnchorDigest?: string;
    blankTaskEvidenceDigest?: string;
}>;
export type OperationBrowserTargetProbeRequest = Readonly<{
    page: Readonly<PageLike>;
    operationId: string;
    requestDigest: string;
    surface: OperationSurface;
    target: OperationTargetRequestV1;
    signal: AbortSignal;
}>;
export type OperationBrowserCurrentTargetRequest = Readonly<{
    page: Readonly<PageLike>;
    operationId: string;
    target: OperationTargetBindingV1;
    signal: AbortSignal;
    deadlineAt?: number;
}>;
export type OperationBrowserCurrentTargetResult = Readonly<{
    evidence: OwnershipTargetEvidence;
    authoritativeClaim?: BrowserTargetClaim;
}>;
/**
 * Authenticated, read-only context used when a process-restarted handle is
 * reconstructed.  The durable target is the complete journal-owned binding;
 * it is never rebuilt from the currently selected tab or from a guessed
 * replacement.
 */
export type OperationBrowserRecoveryContext = Readonly<{
    operationId: string;
    requestDigest: string;
    surface: OperationSurface;
    target: OperationTargetBindingV1;
    signal: AbortSignal;
}>;
/** The page and target are supplied by the adapter, not recovered from RuntimeEnv. */
export type OperationBrowserStagingPrimitive = Readonly<{
    readCurrent?: (request: OperationStagingCallbackRequest & {
        page: Readonly<PageLike>;
        target: OperationTargetBindingV1;
    }) => Promise<OperationStagingObservation>;
    mutateOnce?: (request: OperationStagingCallbackRequest & {
        page: Readonly<PageLike>;
        target: OperationTargetBindingV1;
    }) => Promise<OperationStagingMutationResult>;
    observe?: (request: OperationStagingCallbackRequest & {
        page: Readonly<PageLike>;
        target: OperationTargetBindingV1;
    }) => Promise<OperationStagingObservation>;
}>;
export type OperationBrowserSubmissionPrimitive = Readonly<{
    observeStaging?: (request: SubmissionStageRequest, page: Readonly<PageLike>, target: OperationTargetBindingV1) => Promise<SubmissionStageObservation>;
    handoffFiles?: (request: SubmissionHandoffRequest, files: readonly OperationFileIdentity[], page: Readonly<PageLike>, target: OperationTargetBindingV1) => Promise<SubmissionHandoffResult>;
    observeAttachments?: (request: SubmissionAttachmentRequest, page: Readonly<PageLike>, target: OperationTargetBindingV1) => Promise<SubmissionAttachmentObservation>;
    /** One-shot redacted probes; SendOnce owns bounded polling outside the actor. */
    sendObservers?: SendOnceObservers;
}>;
export type OperationBrowserCollectorPrimitive = Readonly<{
    readContext?: (request: OperationCollectorContextRequest, page: Readonly<PageLike>, target: OperationTargetBindingV1) => Promise<OperationCollectorContext>;
    observe?: (request: CollectorObservationRequest, page: Readonly<PageLike>, target: OperationTargetBindingV1, context: OperationCollectorContext) => Promise<CollectorObservation>;
    sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}>;
export type OperationBrowserControlPrimitive = Readonly<{
    observeTurn?: (request: ControlTurnObservationRequest, page: Readonly<PageLike>, target: OperationTargetBindingV1) => Promise<ControlTurnObservation>;
    executeOnce?: (request: ControlExecutionRequest, page: Readonly<PageLike>, target: OperationTargetBindingV1) => Promise<ControlExecutionResult>;
    observePostcondition?: (request: ControlPostconditionRequest, page: Readonly<PageLike>, target: OperationTargetBindingV1) => Promise<ControlPostconditionObservation>;
    /** Read-only Work-steer preparation; prompt text never crosses this boundary. */
    prepareSteer?: (request: ControlSteerPrepareRequest, page: Readonly<PageLike>, target: OperationTargetBindingV1) => Promise<ControlSteerPhaseResult>;
    /** Sole short Work-steer control transaction; provider must await mutation settlement. */
    executeSteerPrepared?: (request: ControlSteerExecutePreparedRequest, page: Readonly<PageLike>, target: OperationTargetBindingV1) => Promise<ControlSteerPhaseResult>;
    /** Read-only Work-steer postcondition observation. */
    verifySteer?: (request: ControlSteerVerifyRequest, page: Readonly<PageLike>, target: OperationTargetBindingV1) => Promise<ControlSteerPhaseResult>;
    /** Read-only Work-steer restart/quarantine recovery. */
    recoverSteer?: (request: ControlSteerRecoverRequest, page: Readonly<PageLike>, target: OperationTargetBindingV1) => Promise<ControlSteerPhaseResult>;
}>;
/** Provider-facing artifact phases. Browser acquisition is short-lived; the
 * adapter releases the tab actor before materializing the local byte stream. */
export type OperationBrowserArtifactPrimitive = Readonly<{
    acquireDownload: (request: ArtifactTransferSourceRequest & Readonly<{
        signal: AbortSignal;
        deadlineAt: number;
    }>, page: Readonly<PageLike>, target: OperationTargetBindingV1) => Promise<DownloadLike>;
    materializeDownload: (download: DownloadLike) => Promise<AsyncIterable<Uint8Array>>;
}>;
export type OperationBrowserAdapterOptions = Readonly<{
    /** One immutable page captured by the caller before constructing the adapter. */
    page: Readonly<PageLike>;
    /** A context is optional, but if supplied it must bind the same page. */
    runtimeContext?: OperationRuntimeContext<PageLike>;
    owner: CoordinatorOwner;
    coordinator?: ProcessTabCoordinator;
    evidenceDigest: BrowserTargetEvidenceDigest;
    targetEvidence?: OwnershipTargetEvidence;
    /** Provider-proofed anchor evidence when the target is `new_pending`. */
    newTargetAnchorDigest?: string;
    blankTaskEvidenceDigest?: string;
    resolveTargetEvidence?: (request: OperationBrowserTargetProbeRequest) => Promise<OperationBrowserTargetProbe> | OperationBrowserTargetProbe;
    observeCurrentTarget?: (request: OperationBrowserCurrentTargetRequest) => Promise<OperationBrowserCurrentTargetResult> | OperationBrowserCurrentTargetResult;
    capabilities?: Partial<OperationRuntimeCapabilities>;
    authoritativeClaim?: BrowserTargetClaim;
    /** Hard upper bound for one queued/in-flight browser transaction. */
    transactionTimeoutMs?: number;
    files?: readonly OperationFileIdentity[];
    /** The callback is a keyed manifest identity function; it receives no path. */
    fileManifestDigest?: (ordinal: number, manifest: OperationFileIdentity["manifest"]) => string;
    submission?: OperationBrowserSubmissionPrimitive;
    staging?: OperationBrowserStagingPrimitive;
    collector?: OperationBrowserCollectorPrimitive;
    control?: OperationBrowserControlPrimitive;
    /** Optional request-local artifact source; omitted on restart adapters. */
    artifacts?: OperationBrowserArtifactPrimitive;
    /** Absolute request-local output directory, never passed to the service. */
    outputDirectory?: string;
    /** Optional lazy, read-only hydration of one authenticated durable target. */
    recovery?: OperationBrowserRecoveryContext;
}>;
export type ComposedOperationBrowserAdapter = OperationBrowserAdapter;
/**
 * Build the operation browser adapter over one captured page.
 *
 * The adapter is deliberately a composition layer: journal persistence stays
 * in OperationService, browser observations are supplied by narrow injected
 * primitives (or the conservative browser-observation default), and every
 * non-repeatable call is made at one explicit site.  No method reads
 * RuntimeEnv.page and no method retries a browser mutation.
 */
export declare function createOperationBrowserAdapter(options: OperationBrowserAdapterOptions): ComposedOperationBrowserAdapter;
