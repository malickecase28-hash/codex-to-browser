/** A stable provider/browser identity.  Ephemeral tab labels are not accepted. */
export type StableBrowserIdentity = Readonly<{
    providerId: string;
    browserId: string;
}>;
/** A stable provider/browser/tab identity.  The tab id must come from the provider. */
export type StableTabIdentity = Readonly<StableBrowserIdentity & {
    tabId: string;
}>;
declare const browserResourceKeyBrand: unique symbol;
declare const tabResourceKeyBrand: unique symbol;
/** Opaque key for the short browser acquisition actor. */
export type BrowserResourceKey = string & {
    readonly [browserResourceKeyBrand]: "BrowserResourceKey";
};
/** Opaque key for the process-scoped tab actor. */
export type TabResourceKey = string & {
    readonly [tabResourceKeyBrand]: "TabResourceKey";
};
export type CoordinatorResourceKind = "browser" | "tab";
export type CoordinatorPriority = "read" | "mutation" | "control";
export type CoordinatorOwner = Readonly<{
    /** Backend process/session that owns this SDK call. */
    backendSessionId: string;
    /** Optional operation or caller id used only for diagnostics. */
    ownerId?: string;
    operationId?: string;
}>;
export type CoordinatorTimingDiagnostics = {
    readonly requestId: string;
    readonly resourceKind: CoordinatorResourceKind;
    readonly resourceKey: string;
    readonly priority: CoordinatorPriority;
    readonly owner: CoordinatorOwner;
    readonly label?: string;
    readonly enqueuedAt: number;
    readonly deadlineAt?: number;
    startedAt?: number;
    /** Time the hierarchical browser gate admitted the callback. */
    admittedAt?: number;
    settledAt?: number;
    queueDelayMs?: number;
    /** Time spent waiting at the parent browser gate after this actor started. */
    admissionDelayMs?: number;
    executionMs?: number;
    totalMs?: number;
    queuedCancellation?: boolean;
    queuedDeadlineExceeded?: boolean;
    aborted?: boolean;
    deadlineExceededInFlight?: boolean;
    quarantinedUntilSettled?: boolean;
    outcome?: "fulfilled" | "rejected";
};
export type CoordinatorAcquisitionContext = Readonly<{
    resourceKind: CoordinatorResourceKind;
    resourceKey: string;
    acquisitionToken: string;
    owner: CoordinatorOwner;
    priority: CoordinatorPriority;
    signal: AbortSignal;
    timing: CoordinatorTimingDiagnostics;
}>;
export type CoordinatorQueueDiagnostics = Readonly<{
    resourceKind: CoordinatorResourceKind;
    resourceKey: string;
    queueDepth: number;
    active: boolean;
    activeRequestId?: string;
    activeOwner?: CoordinatorOwner;
    completedCount: number;
    rejectedCount: number;
    lastCompleted?: CoordinatorTimingDiagnostics;
    lastRejected?: CoordinatorTimingDiagnostics;
    /** Present while a deadline-aborted callback is still settling. */
    quarantinedUntilSettled?: CoordinatorTimingDiagnostics;
    /**
     * The browser-level parent gate for tab diagnostics, or the gate backing a
     * browser actor's own diagnostics.  This is intentionally a detached
     * summary: callers must not be able to mutate scheduler state through
     * diagnostics.
     */
    browserGate?: CoordinatorBrowserGateDiagnostics;
}>;
export type CoordinatorBrowserGateDiagnostics = Readonly<{
    resourceKind: "browser";
    resourceKey: BrowserResourceKey;
    queueDepth: number;
    active: boolean;
    activeSharedCount: number;
    queuedExclusiveCount: number;
    queuedSharedCount: number;
    rejectedCount: number;
    activeExclusiveRequestId?: string;
    activeExclusiveOwner?: CoordinatorOwner;
}>;
export type CoordinatorRequestOptions = Readonly<{
    owner: CoordinatorOwner;
    priority?: CoordinatorPriority;
    signal?: AbortSignal;
    /** An absolute epoch-millisecond deadline. */
    deadlineAt?: number;
    /** A relative deadline. Cannot be combined with deadlineAt. */
    timeoutMs?: number;
    label?: string;
    /** Explicit parent context for re-entry detection across async boundaries. */
    acquisitionContext?: CoordinatorAcquisitionContext;
}>;
export type TabCoordinatorOptions = Readonly<{
    /** Maximum number of queued (not active) calls per resource actor. */
    maxQueueSize?: number;
    /** Maximum consecutive reads before a waiting mutation is selected. */
    maxConsecutiveReads?: number;
    /** Maximum consecutive mutations before a waiting control is selected. */
    maxConsecutiveMutations?: number;
    /** Maximum consecutive controls before a waiting mutation is selected. */
    maxConsecutiveControls?: number;
    /** A waiting request older than this is selected by age, regardless of priority. */
    maxWaitMs?: number;
    /** Maximum consecutive browser-exclusive turns before a queued shared turn. */
    maxConsecutiveBrowserExclusives?: number;
    /** Maximum number of detached idle diagnostics retained for later inspection. */
    maxIdleDiagnostics?: number;
    now?: () => number;
}>;
export declare function createBrowserResourceKey(identity: StableBrowserIdentity): BrowserResourceKey;
export declare function createBrowserResourceKey(providerId: string, browserId: string): BrowserResourceKey;
export declare function createTabResourceKey(identity: StableTabIdentity): TabResourceKey;
export declare function createTabResourceKey(providerId: string, browserId: string, tabId: string): TabResourceKey;
export declare class CoordinatorError extends Error {
    readonly code: string;
    readonly diagnostics?: CoordinatorTimingDiagnostics | CoordinatorQueueDiagnostics;
    constructor(code: string, message: string, diagnostics?: CoordinatorTimingDiagnostics | CoordinatorQueueDiagnostics);
}
export declare class InvalidResourceKeyError extends CoordinatorError {
    constructor(message: string);
}
export declare class InvalidCoordinatorRequestError extends CoordinatorError {
    constructor(message: string);
}
export declare class CoordinatorQueueFullError extends CoordinatorError {
    constructor(diagnostics: CoordinatorQueueDiagnostics);
}
export type CoordinatorCancellationPhase = "queued" | "in_flight";
export declare class CoordinatorAbortedError extends CoordinatorError {
    readonly phase: CoordinatorCancellationPhase;
    constructor(phase: CoordinatorCancellationPhase, diagnostics: CoordinatorTimingDiagnostics);
}
export declare class CoordinatorDeadlineExceededError extends CoordinatorError {
    readonly phase: CoordinatorCancellationPhase;
    constructor(phase: CoordinatorCancellationPhase, diagnostics: CoordinatorTimingDiagnostics);
}
export declare class ReentrantAcquisitionError extends CoordinatorError {
    readonly resourceKind: CoordinatorResourceKind;
    readonly resourceKey: string;
    constructor(context: CoordinatorAcquisitionContext);
}
type Callback<T, Context extends CoordinatorAcquisitionContext> = (context: Context) => T | PromiseLike<T>;
/**
 * Process-local actors for short browser acquisition and tab transactions.
 *
 * The class intentionally coordinates only cooperating callers in this
 * process.  It does not advertise provider-level or cross-process tab
 * concurrency; a provider claim/fencing capability must be integrated before
 * those guarantees can be made.  Callback code should perform one short
 * browser operation.  Polling, sleeps, journal I/O, hashing, and report work
 * belong outside this API so no scheduler actor is held by those waits.
 */
export declare class ProcessTabCoordinator {
    private readonly browserActors;
    private readonly tabActors;
    private readonly browserGates;
    private readonly idleDiagnostics;
    private readonly options;
    constructor(options?: TabCoordinatorOptions);
    withBrowserAcquisition<T>(resourceKey: BrowserResourceKey, options: CoordinatorRequestOptions, callback: Callback<T, CoordinatorAcquisitionContext>): Promise<T>;
    withTabTransaction<T>(resourceKey: TabResourceKey, options: CoordinatorRequestOptions, callback: Callback<T, CoordinatorAcquisitionContext>): Promise<T>;
    getBrowserDiagnostics(resourceKey: BrowserResourceKey): CoordinatorQueueDiagnostics;
    getTabDiagnostics(resourceKey: TabResourceKey): CoordinatorQueueDiagnostics;
    private getActor;
    private createActor;
    private diagnosticsKey;
    private emptyDiagnostics;
    private onActorIdle;
    private getBrowserGate;
    private maybeCleanupGate;
    private enqueue;
}
/** Explicit factory to make process/runtime ownership visible at call sites. */
export declare function createProcessTabCoordinator(options?: TabCoordinatorOptions): ProcessTabCoordinator;
/**
 * Return the lifecycle-wide coordinator used by default SDK/runtime services.
 *
 * Constructing a coordinator per client would make each queue internally
 * correct while allowing two clients in the same backend process to overlap
 * on the same tab.  Callers that need deterministic test limits may still
 * inject an explicitly constructed coordinator; production integration should
 * use this shared instance.
 */
export declare function getProcessTabCoordinator(): ProcessTabCoordinator;
export {};
