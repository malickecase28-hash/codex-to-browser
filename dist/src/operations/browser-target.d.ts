import type { PageLike } from "../types.js";
import { type BrowserResourceKey, type CoordinatorAcquisitionContext, type CoordinatorOwner, type CoordinatorPriority, type CoordinatorResourceKind, type ProcessTabCoordinator, type TabResourceKey } from "../runtime/tab-coordinator.js";
import type { OperationRuntimeCapabilities } from "../runtime/operation-context.js";
import type { OperationTargetBindingV1, OperationTargetLifecycle } from "./types.js";
import type { OwnershipTargetEvidence } from "./turn-ownership.js";
/** A target HMAC implementation must be keyed by the journal/runtime secret. */
export type BrowserTargetEvidenceDigest = (domain: string, material: unknown) => string;
/**
 * Provider claims are intentionally separate from the browser-observation
 * target.  Observation exposes only the opaque token; the epoch is retained
 * here for fencing and is never written into user-visible diagnostics.
 */
export type BrowserTargetClaim = Readonly<{
    token: string;
    epoch: number;
}>;
/**
 * The capability matrix is conservative by construction.  Missing fields are
 * false, so an older provider can never accidentally advertise concurrent-tab
 * or cross-process safety.
 */
export type BrowserTargetCapabilities = Readonly<OperationRuntimeCapabilities>;
export type BrowserTargetBindingInput<Page extends PageLike = PageLike> = Readonly<{
    /** An explicit page captured by the caller; never read from RuntimeEnv. */
    page: Readonly<Page>;
    /** The normalized target from `observeBrowserPage(...).snapshot.target`. */
    evidence: OwnershipTargetEvidence;
    /** Fixed is the compatibility default; new_pending carries a blank-task anchor. */
    targetLifecycle?: OperationTargetLifecycle;
    /** Required keyed evidence for a pending new-task anchor. */
    newTargetAnchorDigest?: string;
    blankTaskEvidenceDigest?: string;
    /** Optional provider claim/fencing evidence.  Omission means process scope. */
    authoritativeClaim?: BrowserTargetClaim;
    capabilities?: Partial<BrowserTargetCapabilities>;
    evidenceDigest: BrowserTargetEvidenceDigest;
    owner: CoordinatorOwner;
    coordinator: ProcessTabCoordinator;
    userTurnBaselineDigest?: string;
    assistantTurnBaselineDigest?: string;
    configurationReceiptDigest?: string;
}>;
export type BrowserTargetResource = Readonly<{
    /** `provider` is reserved for validated provider claim + advertised overlap. */
    scope: OperationTargetBindingV1["coordinationScope"];
    resourceKind: CoordinatorResourceKind;
    resourceKey: BrowserResourceKey | TabResourceKey;
    /** True only when different tabs may use independent coordinator actors. */
    concurrentTabs: boolean;
    authoritativeClaimValidated: boolean;
}>;
export type BrowserTargetTransactionOptions = Readonly<{
    priority?: CoordinatorPriority;
    signal?: AbortSignal;
    deadlineAt?: number;
    timeoutMs?: number;
    label?: string;
}>;
export type BrowserTargetTransactionContext<Page extends PageLike = PageLike> = Readonly<{
    page: Readonly<Page>;
    target: OperationTargetBindingV1;
    acquisition: CoordinatorAcquisitionContext;
    /**
     * Validate a fresh read-only observation before any mutation.  The read and
     * mutation should remain one short transaction; polling/sleeping belongs
     * after the promise returned by `withTabTransaction` settles.
     */
    assertCurrent: (evidence: OwnershipTargetEvidence, claim?: BrowserTargetClaim, allowNewTargetEstablishment?: boolean) => void;
}>;
export type BrowserTargetBinding<Page extends PageLike = PageLike> = Readonly<{
    page: Readonly<Page>;
    target: OperationTargetBindingV1;
    /**
     * Evidence for this live observation only. This is deliberately distinct
     * from the journal's canonical targetBindingDigest, which is computed from
     * the complete durable OperationTargetBindingV1 by OperationJournal.
     */
    targetEvidenceDigest: string;
    evidence: OwnershipTargetEvidence;
    capabilities: BrowserTargetCapabilities;
    resource: BrowserTargetResource;
    owner: CoordinatorOwner;
    assertPage: (page: unknown) => void;
    assertCurrent: (evidence: OwnershipTargetEvidence, claim?: BrowserTargetClaim, allowNewTargetEstablishment?: boolean) => void;
    /** Internal one-way latch set after a post-Send identity proof. */
    markTargetEstablished?: (establishment: Readonly<{
        conversationId: string;
        canonicalThreadUrl: string;
    }>) => void;
    withTabTransaction: <T>(options: BrowserTargetTransactionOptions, callback: (context: BrowserTargetTransactionContext<Page>) => T | PromiseLike<T>) => Promise<T>;
}>;
export type BrowserTargetErrorCode = "invalid_target_evidence" | "invalid_capabilities" | "invalid_claim" | "invalid_owner" | "invalid_digest" | "navigation_mismatch" | "claim_mismatch" | "page_mismatch";
/** Errors intentionally contain no caller-controlled IDs, URLs, or digests. */
export declare class BrowserTargetError extends Error {
    readonly code: BrowserTargetErrorCode;
    constructor(code: BrowserTargetErrorCode, message: string);
}
/**
 * Bind one explicit page and one normalized observation to an immutable target.
 * This adapter is deliberately browser-agnostic: it never reads or mutates a
 * legacy `RuntimeEnv`, and it never performs polling or sleeps itself.
 */
export declare function bindBrowserTarget<Page extends PageLike = PageLike>(input: BrowserTargetBindingInput<Page>): BrowserTargetBinding<Page>;
