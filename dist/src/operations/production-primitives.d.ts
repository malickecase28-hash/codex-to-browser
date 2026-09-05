import type { PageLike } from "../types.js";
import { type BrowserObservationDigest } from "./browser-observation.js";
import type { OperationRuntimeBrowserPrimitives } from "./runtime-adapter.js";
import type { OperationTargetBindingV1 } from "./types.js";
import type { SubmissionAttachmentObservation, SubmissionAttachmentRequest } from "./submission.js";
export type ProductionPrimitiveAttachmentObserver = (request: SubmissionAttachmentRequest, page: Readonly<PageLike>, target: OperationTargetBindingV1) => Promise<SubmissionAttachmentObservation>;
export type ProductionOperationPrimitiveOptions = Readonly<{
    /** Journal-keyed HMAC evidence. Bare hashes are not accepted. */
    evidenceDigest: BrowserObservationDigest;
    /** Request identity is required for the Send evidence domain. */
    operationId?: string;
    requestDigest?: string;
    /** Raw composer text is retained only in this request-scoped closure. */
    desiredComposerText?: string;
    /** Alias for callers that name the same private value `composerText`. */
    composerText?: string;
    /** Provider claim token, retained in the closure and never returned. */
    authoritativeTabClaim?: string;
    /** Optional target captured by a provider integration before Send. */
    target?: OperationTargetBindingV1;
    /** Optional provider-owned attachment identity observer. */
    observeAttachments?: ProductionPrimitiveAttachmentObserver;
}>;
export type ProductionPrimitiveCapability = "composer_set" | "empty_attachment_observation" | "send_activation" | "collector_snapshot" | "durable_baseline_projection" | "submission_witness_recovery" | "stop_control";
export type ProductionPrimitiveUnwiredCapability = "configuration_set" | "tool_selection" | "power_select" | "file_chooser_handoff" | "attachment_identity_for_nonempty_manifest" | "work_steer_activation";
export declare const PRODUCTION_PRIMITIVE_CAPABILITIES: readonly ProductionPrimitiveCapability[];
/**
 * These are not soft feature flags.  They are an inventory of deliberately
 * missing proof, so a caller cannot mistake an unavailable primitive for a
 * best-effort browser fallback.
 */
export declare const UNWIRED_PRODUCTION_PRIMITIVES: readonly ProductionPrimitiveUnwiredCapability[];
export declare const PRODUCTION_OPERATION_PRIMITIVE_INVENTORY: Readonly<{
    scope: "base_primitive_factory";
    wired: readonly ProductionPrimitiveCapability[];
    unwired: readonly ProductionPrimitiveUnwiredCapability[];
}>;
export declare class ProductionPrimitiveError extends Error {
    readonly code: string;
    constructor(code: string);
}
/**
 * Create one request-scoped set of production operation primitives.
 *
 * `operationId`, `requestDigest`, and the composer value should normally be
 * supplied by the lazy runtime capture after the journal has created the
 * operation.  If either identity is absent, Send fails closed rather than
 * fabricating an evidence domain.
 */
export declare function createProductionOperationPrimitives(options: ProductionOperationPrimitiveOptions): OperationRuntimeBrowserPrimitives;
/** Descriptive aliases for integrations that name the layer after the adapter. */
export declare const createOperationProductionPrimitives: typeof createProductionOperationPrimitives;
export declare const createProductionPrimitives: typeof createProductionOperationPrimitives;
