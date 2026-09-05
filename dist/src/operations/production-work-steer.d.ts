import type { LocatorLike, PageLike } from "../types.js";
import { type OperationBlockerCode, type OperationTargetBindingV1 } from "./types.js";
import { type OwnershipBaseline } from "./turn-ownership.js";
import { type BrowserObservationDigest, type BrowserObservationResult } from "./browser-observation.js";
/**
 * Work-steer is a deliberately small browser capability.  Durable action
 * intent and the complete prepared baseline belong to the caller.  Keeping
 * those writes outside this module means a tab actor is never held across a
 * journal transaction.
 */
export declare const PRODUCTION_WORK_STEER_SCHEMA_VERSION: "chatgpt.browser_control.production_work_steer.v1";
export type ProductionWorkSteerComposer = Readonly<{
    locator: LocatorLike;
    capabilityKey: string;
    candidateCount: number;
}>;
export type ProductionWorkSteerSendActivation = Readonly<{
    locator: LocatorLike;
    capabilityKey: string;
    localeKey: string;
    candidateCount: number;
}>;
export type ProductionWorkSteerObservationPhase = "prepare" | "final_recheck" | "verify" | "recovery";
/** No target or prompt crosses this callback boundary. */
export type ProductionWorkSteerObservationRequest = Readonly<{
    schemaVersion: typeof PRODUCTION_WORK_STEER_SCHEMA_VERSION;
    phase: ProductionWorkSteerObservationPhase;
    operationId: string;
    parentRequestDigest: string;
    targetBindingDigest: string;
    controlActionId: string;
    expectedAssistantTurnId: string;
    assistantBranchId?: string;
    assistantParentTurnId?: string;
    baselineSnapshotDigest?: string;
    preparedDigest?: string;
    page: Readonly<PageLike>;
    signal: AbortSignal;
    deadlineAt: number;
    /** Always a redacted, complete baseline when present. */
    baseline?: OwnershipBaseline;
}>;
/** No target, URL, label, or prompt crosses this callback boundary. */
export type ProductionWorkSteerResolverRequest = Readonly<{
    schemaVersion: typeof PRODUCTION_WORK_STEER_SCHEMA_VERSION;
    operationId: string;
    parentRequestDigest: string;
    targetBindingDigest: string;
    controlActionId: string;
    expectedAssistantTurnId: string;
    assistantBranchId: string;
    assistantParentTurnId: string;
    preparedDigest: string;
    page: Readonly<PageLike>;
    signal: AbortSignal;
    deadlineAt: number;
}>;
export type ProductionWorkSteerOptions = Readonly<{
    evidenceDigest: BrowserObservationDigest;
    operationId: string;
    parentRequestDigest: string;
    targetBindingDigest: string;
    controlActionId: string;
    expectedAssistantTurnId: string;
    /** Captured privately and used only to validate observations. */
    target: OperationTargetBindingV1;
    /** Retained only in this closure and passed only to the composer locator. */
    prompt: string;
    observe: (request: ProductionWorkSteerObservationRequest) => Promise<BrowserObservationResult>;
    resolveComposer: (request: ProductionWorkSteerResolverRequest) => Promise<ProductionWorkSteerComposer | undefined>;
    resolveSendControl: (request: ProductionWorkSteerResolverRequest) => Promise<ProductionWorkSteerSendActivation | undefined>;
    timeoutMs?: number;
    now?: () => number;
}>;
export type ProductionWorkSteerPrepared = Readonly<{
    schemaVersion: typeof PRODUCTION_WORK_STEER_SCHEMA_VERSION;
    operationId: string;
    parentRequestDigest: string;
    targetBindingDigest: string;
    controlActionId: string;
    action: "work_steer";
    expectedAssistantTurnId: string;
    /** Derived from the exact observed assistant turn. */
    assistantBranchId: string;
    /** Derived from the exact observed assistant turn. */
    assistantParentTurnId: string;
    baselineSnapshotDigest: string;
    preparedDigest: string;
    /** Complete and redacted; safe for the caller's durable journal. */
    baseline: OwnershipBaseline;
}>;
export type ProductionWorkSteerVerificationReceipt = Readonly<{
    schemaVersion: typeof PRODUCTION_WORK_STEER_SCHEMA_VERSION;
    baselineSnapshotDigest: string;
    preparedDigest: string;
    assistantTurnId: string;
    assistantBranchId: string;
    assistantParentTurnId: string;
    userTurnId: string;
    userTurnEvidenceDigest: string;
    postSendDeltaDigest: string;
    evidenceDigest: string;
}>;
export type ProductionWorkSteerPrepareRequest = Readonly<{
    page: Readonly<PageLike>;
    signal: AbortSignal;
    deadlineAt?: number;
}>;
export type ProductionWorkSteerExecutePreparedRequest = Readonly<{
    page: Readonly<PageLike>;
    prepared: ProductionWorkSteerPrepared;
    signal: AbortSignal;
    deadlineAt?: number;
}>;
export type ProductionWorkSteerVerifyRequest = Readonly<{
    page: Readonly<PageLike>;
    prepared: ProductionWorkSteerPrepared;
    signal: AbortSignal;
    deadlineAt?: number;
}>;
export type ProductionWorkSteerRecoveryRequest = Readonly<{
    page: Readonly<PageLike>;
    prepared: ProductionWorkSteerPrepared;
    /** Authenticated complete baseline loaded from the caller's journal. */
    baseline: OwnershipBaseline;
    signal: AbortSignal;
    deadlineAt?: number;
}>;
type Phase = "prepare" | "execute_prepared" | "verify" | "recovery";
export type ProductionWorkSteerResultBase = Readonly<{
    schemaVersion: typeof PRODUCTION_WORK_STEER_SCHEMA_VERSION;
    operationId: string;
    parentRequestDigest: string;
    targetBindingDigest: string;
    controlActionId: string;
    action: "work_steer";
    phase: Phase;
    expectedAssistantTurnId: string;
    assistantBranchId?: string;
    assistantParentTurnId?: string;
    baselineSnapshotDigest?: string;
    preparedDigest?: string;
}>;
type BlockedResult = ProductionWorkSteerResultBase & Readonly<{
    status: "blocked";
    blockerCode: OperationBlockerCode;
    observationRequired: boolean;
    mutationBoundary: "none" | "control_may_have_occurred";
    evidenceDigest?: string;
}>;
type UncertainResult = ProductionWorkSteerResultBase & Readonly<{
    status: "uncertain";
    blockerCode: OperationBlockerCode;
    observationRequired: true;
    mutationBoundary: "control_may_have_occurred";
    quarantine: "caller" | "provider";
    evidenceDigest?: string;
}>;
export type ProductionWorkSteerResult = (ProductionWorkSteerResultBase & Readonly<{
    phase: "prepare";
    status: "prepared";
    observationRequired: false;
    mutationBoundary: "none";
    prepared: ProductionWorkSteerPrepared;
}>) | (ProductionWorkSteerResultBase & Readonly<{
    phase: "execute_prepared";
    status: "executed";
    observationRequired: true;
    mutationBoundary: "control_may_have_occurred";
}>) | (ProductionWorkSteerResultBase & Readonly<{
    phase: "verify" | "recovery";
    status: "satisfied";
    observationRequired: false;
    mutationBoundary: "control_may_have_occurred";
    receipt: ProductionWorkSteerVerificationReceipt;
    baselineSnapshotDigest: string;
    preparedDigest: string;
    assistantBranchId: string;
    assistantParentTurnId: string;
    userTurnId: string;
    userTurnEvidenceDigest: string;
    postSendDeltaDigest: string;
    evidenceDigest: string;
}>) | BlockedResult | UncertainResult;
export declare class ProductionWorkSteerPrimitiveError extends Error {
    readonly code: string;
    constructor(code: string);
}
/**
 * Construct one request-scoped primitive.  The public phase boundary is:
 *
 *   prepare (read) -> caller persists intent + prepared.baseline
 *   -> executePrepared (one-shot mutation) -> verify/recover (read only).
 */
export declare function createProductionWorkSteerPrimitive(options: ProductionWorkSteerOptions): Readonly<{
    prepare(request: ProductionWorkSteerPrepareRequest): Promise<ProductionWorkSteerResult>;
    executePrepared(request: ProductionWorkSteerExecutePreparedRequest): Promise<ProductionWorkSteerResult>;
    verify(request: ProductionWorkSteerVerifyRequest): Promise<ProductionWorkSteerResult>;
    recover(request: ProductionWorkSteerRecoveryRequest): Promise<ProductionWorkSteerResult>;
}>;
export declare const createOperationProductionWorkSteer: typeof createProductionWorkSteerPrimitive;
export declare const createProductionWorkSteer: typeof createProductionWorkSteerPrimitive;
export {};
