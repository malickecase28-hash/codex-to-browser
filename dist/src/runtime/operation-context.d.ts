import { type BrowserResourceKey, type TabResourceKey } from "./tab-coordinator.js";
export type OperationRuntimeCoordinationScope = "tab" | "provider";
export type OperationRuntimeClaimReason = "missing" | "unsupported" | "unverifiable";
export type OperationRuntimeAuthoritativeClaim = Readonly<{
    status: "available";
    token: string;
    epoch: number;
} | {
    status: "unavailable";
    reason: OperationRuntimeClaimReason;
}>;
/**
 * Capabilities are provider-advertised facts.  Missing fields intentionally
 * mean false; an older or partial provider must never be treated as
 * concurrent-tab safe by inference.
 */
export type OperationRuntimeCapabilities = Readonly<{
    stableProviderId: boolean;
    stableBrowserId: boolean;
    stableTabId: boolean;
    authoritativeTabClaim: boolean;
    concurrentTabs: boolean;
}>;
export type OperationRuntimeOwner = Readonly<{
    backendSessionId: string;
    operationId: string;
}>;
export type OperationRuntimeContextInput<Page extends object = object> = Readonly<{
    providerId?: string;
    browserId?: string;
    tabId?: string;
    page: Page;
    authoritativeClaim?: OperationRuntimeAuthoritativeClaim;
    owner: OperationRuntimeOwner;
    capabilities?: Partial<OperationRuntimeCapabilities>;
    targetBindingDigest: string;
    /** Reject construction if an exact tab-scoped owner cannot be proven. */
    requireExactTabOwnership?: boolean;
}>;
export type OperationRuntimeContextChildOptions = Readonly<{
    operationId?: string;
    targetBindingDigest?: string;
}>;
export type OperationRuntimeAffinityObservation = Readonly<{
    tabId?: string;
    authoritativeClaim?: OperationRuntimeAuthoritativeClaim;
}>;
export type OperationRuntimeResourceSelection = Readonly<{
    scope: OperationRuntimeCoordinationScope;
    resourceKind: "tab" | "browser";
    resourceKey: TabResourceKey | BrowserResourceKey;
    exactTabOwnership: boolean;
    downgraded: boolean;
    downgradeReasons: readonly OperationRuntimeDowngradeReason[];
}>;
export type OperationRuntimeDowngradeReason = "provider_identity_unavailable" | "browser_identity_unavailable" | "tab_identity_unavailable" | "provider_identity_not_advertised" | "browser_identity_not_advertised" | "tab_identity_not_advertised" | "authoritative_claim_unavailable" | "authoritative_claim_not_advertised" | "concurrent_tabs_not_advertised";
export type OperationRuntimeContextDiagnostics = Readonly<{
    status: "ready";
    scope: OperationRuntimeCoordinationScope;
    resourceKind: "tab" | "browser";
    exactTabOwnership: boolean;
    downgraded: boolean;
    downgradeReasons: readonly OperationRuntimeDowngradeReason[];
    identities: Readonly<{
        provider: "available" | "unavailable";
        browser: "available" | "unavailable";
        tab: "available" | "unavailable";
    }>;
    page: "bound";
    authoritativeClaim: "available" | "unavailable";
    owner: "bound";
    targetBinding: "bound";
}>;
export type OperationRuntimeContextCapture<Page extends object = object> = Readonly<{
    page: Page;
    providerId?: string;
    browserId?: string;
    tabId?: string;
    authoritativeClaim: OperationRuntimeAuthoritativeClaim;
    owner: OperationRuntimeOwner;
    capabilities: OperationRuntimeCapabilities;
    coordinationScope: OperationRuntimeCoordinationScope;
    targetBindingDigest: string;
    resource: OperationRuntimeResourceSelection;
    assertPageAffinity: (page: unknown, observation?: OperationRuntimeAffinityObservation) => OperationRuntimeAffinityResult;
}>;
export type OperationRuntimeAffinityResult = Readonly<{
    pageMatches: true;
    tabMatches: boolean;
    claimMatches: boolean;
    exactTabOwnership: boolean;
}>;
export type OperationRuntimeContextErrorCode = "invalid_context" | "exact_ownership_unavailable" | "page_affinity_mismatch" | "tab_affinity_mismatch" | "claim_drift";
/** Error diagnostics contain statuses only; no IDs, digests, claim tokens, or page values. */
export declare class OperationRuntimeContextError extends Error {
    readonly code: OperationRuntimeContextErrorCode;
    readonly diagnostics?: OperationRuntimeContextDiagnostics;
    constructor(code: OperationRuntimeContextErrorCode, message: string, diagnostics?: OperationRuntimeContextDiagnostics);
}
/**
 * Immutable operation-scoped browser context.  A context is intentionally
 * independent from RuntimeEnv and can be passed to a future command adapter
 * without changing legacy command behavior.
 */
export declare class OperationRuntimeContext<Page extends object = object> {
    #private;
    readonly providerId: string | undefined;
    readonly browserId: string | undefined;
    readonly tabId: string | undefined;
    readonly page: Page;
    readonly authoritativeClaim: OperationRuntimeAuthoritativeClaim;
    readonly owner: OperationRuntimeOwner;
    readonly capabilities: OperationRuntimeCapabilities;
    readonly coordinationScope: OperationRuntimeCoordinationScope;
    readonly targetBindingDigest: string;
    private constructor();
    /** Fail-closed context construction with deterministic provider-wide fallback. */
    static create<Page extends object = object>(input: OperationRuntimeContextInput<Page>): OperationRuntimeContext<Page>;
    /** Alias for adapters that prefer a factory-style name. */
    static bind<Page extends object = object>(input: OperationRuntimeContextInput<Page>): OperationRuntimeContext<Page>;
    /** The exact coordinator actor resource; never returns tab scope after downgrade. */
    coordinatorResource(): OperationRuntimeResourceSelection;
    /** Status-only diagnostics suitable for logs and blockers. */
    diagnostics(): OperationRuntimeContextDiagnostics;
    /**
     * Create a child operation view without permitting a new page, tab, claim, or
     * capability to be smuggled into the existing ownership domain.
     */
    child(options?: OperationRuntimeContextChildOptions): OperationRuntimeContext<Page>;
    /**
     * Capture an immutable page-aware view.  It retains the same page identity;
     * it cannot be used to replace this context's page or ownership metadata.
     */
    capture(): OperationRuntimeContextCapture<Page>;
    /**
     * Verify both page object identity and all available stable ownership
     * evidence.  A context with an exact tab binding requires an explicit
     * observed stable tab ID and (when bound) the current authoritative claim.
     */
    assertPageAffinity(page: unknown, observation?: OperationRuntimeAffinityObservation): OperationRuntimeAffinityResult;
}
export declare function createOperationRuntimeContext<Page extends object = object>(input: OperationRuntimeContextInput<Page>): OperationRuntimeContext<Page>;
