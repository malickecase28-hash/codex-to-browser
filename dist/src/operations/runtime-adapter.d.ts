import type { PageLike } from "../types.js";
import type { CoordinatorOwner, ProcessTabCoordinator } from "../runtime/tab-coordinator.js";
import { OperationRuntimeContext, type OperationRuntimeCapabilities } from "../runtime/operation-context.js";
import { type ComposedOperationBrowserAdapter, type OperationBrowserAdapterOptions, type OperationBrowserCollectorPrimitive, type OperationBrowserControlPrimitive, type OperationBrowserArtifactPrimitive, type OperationBrowserCurrentTargetResult, type OperationBrowserStagingPrimitive, type OperationBrowserSubmissionPrimitive, type OperationBrowserTargetProbe, type OperationBrowserTargetProbeRequest } from "./browser-adapter.js";
import type { BrowserTargetClaim, BrowserTargetEvidenceDigest } from "./browser-target.js";
import type { OwnershipTargetEvidence } from "./turn-ownership.js";
import type { OperationFileIdentity } from "./file-identity.js";
import type { OperationSurface, OperationTargetBindingV1, OperationTargetRequestV1 } from "./types.js";
/**
 * Browser primitives that are safe to pass into an operation adapter.
 *
 * The callbacks receive the captured page explicitly.  They must perform one
 * bounded DOM transaction and return an already-redacted observation.  In
 * particular, a callback must not poll for generation, wait for attachment
 * processing, read a mutable RuntimeEnv, or retry a non-repeatable browser
 * action.  Those waits belong to the operation collector and are deliberately
 * outside the tab actor.
 */
export type OperationRuntimeBrowserPrimitives = Readonly<{
    submission?: OperationBrowserSubmissionPrimitive;
    staging?: OperationBrowserStagingPrimitive;
    collector?: OperationBrowserCollectorPrimitive;
    control?: OperationBrowserControlPrimitive;
    artifacts?: OperationBrowserArtifactPrimitive;
}>;
/**
 * One request-scoped capture.  The capture factory is invoked lazily from
 * `resolveTarget`, after OperationService has created the durable operation
 * record.  It is the only place that may attach/claim/create a browser page.
 *
 * `targetEvidence` is required when no resolver is supplied.  A resolver is
 * useful for an explicit target policy (for example a selected tab versus a
 * caller-provided tab id), but it must remain read-only and return the same
 * captured page object.
 */
export type OperationRuntimeBrowserCapture = Readonly<{
    page: Readonly<PageLike>;
    /** Optional immutable context captured by the provider bridge. */
    runtimeContext?: OperationRuntimeContext<PageLike>;
    targetEvidence?: OwnershipTargetEvidence;
    authoritativeClaim?: BrowserTargetClaim;
    capabilities?: Partial<OperationRuntimeCapabilities>;
    /** Provider-proofed anchor evidence for a target whose ID is allocated by Send. */
    newTargetAnchorDigest?: string;
    blankTaskEvidenceDigest?: string;
    resolveTargetEvidence?: (request: OperationBrowserTargetProbeRequest) => Promise<OperationBrowserTargetProbe> | OperationBrowserTargetProbe;
    observeCurrentTarget?: (request: Parameters<NonNullable<OperationBrowserAdapterOptions["observeCurrentTarget"]>>[0]) => Promise<OperationBrowserCurrentTargetResult> | OperationBrowserCurrentTargetResult;
    /** Request-local output destination; intentionally absent on recovery. */
    outputDirectory?: string;
    primitives?: OperationRuntimeBrowserPrimitives;
}>;
export type OperationRuntimeBrowserCaptureRequest = Readonly<{
    operationId: string;
    requestDigest: string;
    surface: OperationSurface;
    target: OperationTargetRequestV1;
    signal: AbortSignal;
}>;
/**
 * Frozen locator and complete durable target supplied by an authenticated
 * post-restart handle factory.  `targetRequest` is explicit because a durable
 * binding must never be reconstructed by guessing a selected/replacement tab.
 */
export type OperationRuntimeBrowserRecoveryContext = Readonly<{
    operationId: string;
    requestDigest: string;
    surface: OperationSurface;
    target: OperationTargetBindingV1;
    targetRequest: OperationTargetRequestV1;
}>;
export type OperationRuntimeAdapterOptions = Readonly<{
    /** Backend process owner used by the process/tab coordinator. */
    owner: CoordinatorOwner;
    /** Journal-keyed evidence digest. It must never be a bare public hash. */
    evidenceDigest: BrowserTargetEvidenceDigest;
    /** Lazy, request-scoped page/context capture. */
    capture: (request: OperationRuntimeBrowserCaptureRequest) => Promise<OperationRuntimeBrowserCapture> | OperationRuntimeBrowserCapture;
    /** Static operation closures may safely retain request-local private input. */
    primitives?: OperationRuntimeBrowserPrimitives;
    /** Set when the lazy capture will return the corresponding optional port.
     * Leaving this false keeps OperationService on its read-only submission
     * precondition path; exposing an absent staging port would otherwise turn a
     * safe pre-populated composer into an artificial mutation blocker. */
    exposeStaging?: boolean;
    /** Set when callers want structured unavailable control results. */
    exposeControl?: boolean;
    /** Set only for a request-local submit capture with an absolute destination. */
    exposeArtifacts?: boolean;
    coordinator?: ProcessTabCoordinator;
    transactionTimeoutMs?: number;
    files?: readonly OperationFileIdentity[];
    fileManifestDigest?: OperationBrowserAdapterOptions["fileManifestDigest"];
    /** Explicit lazy recovery path; submit adapters do not use this option. */
    recovery?: OperationRuntimeBrowserRecoveryContext;
}>;
export type OperationRuntimeAdapterErrorCode = "adapter_incomplete" | "capture_failed" | "capture_incomplete" | "target_evidence_unavailable" | "target_binding_mismatch" | "page_affinity_mismatch" | "unsupported_browser_primitive" | "not_initialized" | "backend_unavailable" | "browser_bridge_unavailable" | "login_required" | "captcha" | "rate_limited" | "permission_required" | "needs_confirmation" | "runtime_incompatible";
/** Stable, redacted error boundary for a request-scoped runtime adapter. */
export declare class OperationRuntimeAdapterError extends Error {
    readonly code: OperationRuntimeAdapterErrorCode;
    constructor(code: OperationRuntimeAdapterErrorCode);
}
/**
 * This is the generic adapter's injection inventory, retained for compatibility
 * with integrations that assemble their own provider runtime. It does not
 * describe the default ChatGPT composite: `chatgpt-runtime.ts` injects the
 * proven production modules for these seams. The generic adapter itself never
 * guesses selectors or routes legacy polling helpers through a tab actor.
 */
export declare const UNWIRED_OPERATION_RUNTIME_PRIMITIVES: readonly ["new_thread_creation", "configuration_set", "tool_selection", "composer_population", "file_chooser_handoff", "send_activation", "stop_activation", "work_steer_activation"];
/**
 * Compose one lazy runtime capture over the existing operation browser
 * adapter.  The returned object is intentionally request-scoped: a caller
 * should construct it in `OperationClient.adapterFactory` and retain it only
 * for the resulting operation handle.
 */
export declare function createRuntimeOperationBrowserAdapter(options: OperationRuntimeAdapterOptions): ComposedOperationBrowserAdapter;
/** Alias for callers that put the runtime qualifier first. */
export declare const createOperationRuntimeAdapter: typeof createRuntimeOperationBrowserAdapter;
