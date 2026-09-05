import { type OperationFileHashOptions, type OperationFileIdentity } from "./file-identity.js";
import type { CollectorOptions, CollectorResult } from "./collector.js";
import type { ControlOptions, ControlResult } from "./control.js";
import { OperationService, type OperationBrowserAdapter, type OperationInspectResult, type OperationRunResult, type OperationSubmitOptions, type OperationSubmitResult } from "./service.js";
import type { OperationControlRequestV1, OperationDurableCapturePolicyV1, OperationHandleV1, OperationStateV1, OperationTargetBindingV1, OperationSubmitRequestV1 } from "./types.js";
export type OperationFileFingerprinter = (sourcePath: string, displayName?: string, options?: OperationFileHashOptions) => Promise<OperationFileIdentity>;
export type OperationFileRevalidator = (identity: OperationFileIdentity, options?: OperationFileHashOptions) => Promise<void>;
export type OperationAdapterFactoryContext = Readonly<{
    /** A frozen snapshot; mutating the caller's request cannot affect the closure. */
    request: OperationSubmitRequestV1;
    /** Frozen identities retain source paths only in the ephemeral adapter closure. */
    files: readonly OperationFileIdentity[];
    signal: AbortSignal;
}>;
export type OperationAdapterFactory = (context: OperationAdapterFactoryContext) => OperationBrowserAdapter | Promise<OperationBrowserAdapter>;
/**
 * Authenticated, redacted state exposed to a post-restart adapter factory.
 *
 * This is intentionally a projection rather than `OperationStateV1`: action
 * records, receipts, blockers, and any future fields are not needed to bind a
 * browser target and therefore must not cross this boundary by accident.
 */
export type OperationAdapterDurableState = Readonly<Pick<OperationStateV1, "schemaVersion" | "operationId" | "requestDigest" | "surface" | "phase" | "mutationBoundary" | "revision"> & {
    target: OperationTargetBindingV1;
    /** Path-free immutable capture contract; absent only on legacy records. */
    capturePolicy?: OperationDurableCapturePolicyV1;
}>;
/**
 * Restart-safe handle-factory context.
 *
 * The enumerable shape remains the legacy `OperationHandleV1` so existing
 * one-argument factories continue to work.  The nested `handle`, `state`,
 * and `target` properties are non-enumerable and frozen; new factories should
 * use those properties to bind the exact authenticated durable target.
 */
export type OperationHandleAdapterFactoryContext = Readonly<OperationHandleV1 & {
    handle: OperationHandleV1;
    state: OperationAdapterDurableState;
    target: OperationTargetBindingV1;
}>;
export type OperationHandleAdapterFactory = (
/** Frozen locator-compatible context; never contains prompt or local paths. */
context: OperationHandleAdapterFactoryContext) => OperationBrowserAdapter | Promise<OperationBrowserAdapter>;
/**
 * Request-local control adapter context.
 *
 * `request` is the validated, frozen control request and may contain the raw
 * Work-steer prompt for the duration of this one factory invocation. The
 * authenticated `handle`, `state`, and `target` projections are frozen and
 * deliberately non-enumerable so a factory cannot accidentally serialize
 * durable reconstruction material alongside its ephemeral browser closure.
 * `durable` is the same authenticated context supplied to a handle factory,
 * also kept non-enumerable for the same privacy boundary. Nothing in this
 * context is journaled or retained by the client after `control` returns.
 */
export type OperationControlAdapterFactoryContext = Readonly<{
    request: OperationControlRequestV1;
    handle: OperationHandleV1;
    state: OperationAdapterDurableState;
    target: OperationTargetBindingV1;
    durable: OperationHandleAdapterFactoryContext;
}>;
export type OperationControlAdapterFactory = (context: OperationControlAdapterFactoryContext) => OperationBrowserAdapter | Promise<OperationBrowserAdapter>;
export type OperationServicePort = Pick<OperationService, "submit" | "collect" | "inspect" | "control" | "run">;
export type OperationClientOptions = Readonly<{
    /** Optional request-scoped adapter construction for raw prompt/path closure. */
    adapterFactory?: OperationAdapterFactory;
    /** Recreate a target-bound adapter after a process/backend restart. */
    handleAdapterFactory?: OperationHandleAdapterFactory;
    /**
     * Create a fresh target-bound adapter for one Stop/Work control call. This
     * is intentionally never cached: a steer prompt must not become a general
     * operation adapter closure or survive the invocation that consumed it.
     */
    controlAdapterFactory?: OperationControlAdapterFactory;
    /** Maximum number of ephemeral request/handle adapter closures retained. */
    maxCachedAdapters?: number;
    /** Injectable for deterministic file-boundary tests. */
    fingerprint?: OperationFileFingerprinter;
    /** Injectable for deterministic changed-file tests. */
    revalidate?: OperationFileRevalidator;
}>;
export type OperationClientSubmitOptions = Readonly<Pick<OperationSubmitOptions, "signal" | "deadlineAt">>;
export type OperationClientCollectOptions = CollectorOptions;
export type OperationClientControlOptions = ControlOptions;
export type OperationClientRunOptions = Readonly<Omit<OperationSubmitOptions, "requestDigest"> & CollectorOptions>;
export declare class OperationClientError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
/**
 * Additive TypeScript operations API.  The supplied adapter is also used for
 * browser-free completion paths because the service requires a uniform port;
 * `inspect` remains entirely browser-free.  A request-scoped factory may
 * replace the base adapter for submit/run and is cached in memory only for
 * subsequent collect/control calls in the same process.
 */
export declare class OperationClient {
    private readonly service;
    private readonly adapter;
    private readonly fingerprint;
    private readonly revalidate;
    private readonly adapterFactory;
    private readonly handleAdapterFactory;
    private readonly controlAdapterFactory;
    private readonly maxCachedAdapters;
    private readonly requestAdapters;
    constructor(service: OperationServicePort, adapter: OperationBrowserAdapter, options?: OperationClientOptions);
    /** Fingerprint inputs, then execute the service's one-submit protocol. */
    submit(request: OperationSubmitRequestV1, options?: OperationClientSubmitOptions): Promise<OperationSubmitResult>;
    /** Collect only the exact operation-owned turn; never composes or submits. */
    collect(handle: OperationHandleV1, options?: OperationClientCollectOptions): Promise<CollectorResult>;
    /** Inspect durable state without touching the browser. */
    inspect(handle: OperationHandleV1): Promise<OperationInspectResult>;
    /** Apply one operation-bound Stop or Work steer. */
    control(request: OperationControlRequestV1, options?: OperationClientControlOptions): Promise<ControlResult>;
    /** SDK-only composition of one submit followed by one collect. */
    run(request: OperationSubmitRequestV1, options?: OperationClientRunOptions): Promise<OperationRunResult>;
    private prepareSubmit;
    private adapterForSubmit;
    private guardAdapter;
    private adapterForHandle;
    /**
     * Authenticate a handle and project only the immutable target context
     * needed by a request-local adapter. The inspect result is intentionally
     * consumed once and passed to adapter selection; callers that need a
     * prompt-bearing control closure must not repeat this read.
     */
    private reconstructionForHandle;
    private adapterForAuthenticatedHandle;
    private adapterForControl;
    private rememberAdapter;
    private cachedAdapterForOperation;
    private forgetAdapter;
}
/** Alias kept for callers that prefer the plural namespace terminology. */
export declare const OperationsClient: typeof OperationClient;
export declare function createOperationClient(service: OperationServicePort, adapter: OperationBrowserAdapter, options?: OperationClientOptions): OperationClient;
