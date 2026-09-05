import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
const INVALID_ID_VALUES = new Set(["unknown", "undefined", "null", "n/a", "na"]);
const MAX_TIMER_DELAY_MS = 2_147_483_647;
function validateStableId(label, value) {
    if (typeof value !== "string") {
        throw new InvalidResourceKeyError(`${label} must be a non-empty stable string`);
    }
    const normalized = value.trim();
    if (normalized.length === 0 ||
        normalized.length > 512 ||
        INVALID_ID_VALUES.has(normalized.toLowerCase()) ||
        /[\u0000-\u001f\u007f]/u.test(normalized)) {
        throw new InvalidResourceKeyError(`${label} must be a known stable identifier`);
    }
    return normalized;
}
function validateOwner(owner) {
    if (!owner || typeof owner !== "object") {
        throw new InvalidCoordinatorRequestError("owner metadata is required");
    }
    const backendSessionId = validateStableId("owner.backendSessionId", owner.backendSessionId);
    const ownerId = owner.ownerId === undefined ? undefined : validateStableId("owner.ownerId", owner.ownerId);
    const operationId = owner.operationId === undefined ? undefined : validateStableId("owner.operationId", owner.operationId);
    return Object.freeze({
        backendSessionId,
        ...(ownerId === undefined ? {} : { ownerId }),
        ...(operationId === undefined ? {} : { operationId })
    });
}
function encodeKeyPart(value) {
    return encodeURIComponent(value);
}
export function createBrowserResourceKey(providerOrIdentity, browserId) {
    if (providerOrIdentity === null ||
        typeof providerOrIdentity !== "string" && typeof providerOrIdentity !== "object") {
        throw new InvalidResourceKeyError("browser identity must contain stable providerId and browserId");
    }
    const providerId = typeof providerOrIdentity === "string" ? providerOrIdentity : providerOrIdentity.providerId;
    const resolvedBrowserId = typeof providerOrIdentity === "string" ? browserId : providerOrIdentity.browserId;
    const provider = validateStableId("providerId", providerId);
    const browser = validateStableId("browserId", resolvedBrowserId);
    return `browser:${encodeKeyPart(provider)}:${encodeKeyPart(browser)}`;
}
export function createTabResourceKey(providerOrIdentity, browserId, tabId) {
    if (providerOrIdentity === null ||
        typeof providerOrIdentity !== "string" && typeof providerOrIdentity !== "object") {
        throw new InvalidResourceKeyError("tab identity must contain stable providerId, browserId, and tabId");
    }
    const providerId = typeof providerOrIdentity === "string" ? providerOrIdentity : providerOrIdentity.providerId;
    const resolvedBrowserId = typeof providerOrIdentity === "string" ? browserId : providerOrIdentity.browserId;
    const resolvedTabId = typeof providerOrIdentity === "string" ? tabId : providerOrIdentity.tabId;
    const provider = validateStableId("providerId", providerId);
    const browser = validateStableId("browserId", resolvedBrowserId);
    const tab = validateStableId("tabId", resolvedTabId);
    return `tab:${encodeKeyPart(provider)}:${encodeKeyPart(browser)}:${encodeKeyPart(tab)}`;
}
export class CoordinatorError extends Error {
    code;
    diagnostics;
    constructor(code, message, diagnostics) {
        super(message);
        this.name = "CoordinatorError";
        this.code = code;
        // Errors can be returned while an in-flight callback remains quarantined.
        // Never expose the actor's live timing object to a caller that could
        // mutate scheduler state before that callback settles.
        if (diagnostics !== undefined)
            this.diagnostics = freezeCoordinatorDiagnostics(diagnostics);
    }
}
export class InvalidResourceKeyError extends CoordinatorError {
    constructor(message) {
        super("invalid_resource_key", message);
        this.name = "InvalidResourceKeyError";
    }
}
export class InvalidCoordinatorRequestError extends CoordinatorError {
    constructor(message) {
        super("invalid_request", message);
        this.name = "InvalidCoordinatorRequestError";
    }
}
export class CoordinatorQueueFullError extends CoordinatorError {
    constructor(diagnostics) {
        super("queue_full", `The ${diagnostics.resourceKind} coordinator queue is full (${diagnostics.queueDepth} pending requests)`, diagnostics);
        this.name = "CoordinatorQueueFullError";
    }
}
export class CoordinatorAbortedError extends CoordinatorError {
    phase;
    constructor(phase, diagnostics) {
        super("aborted", `Coordinator request was aborted while ${phase}`, diagnostics);
        this.name = "CoordinatorAbortedError";
        this.phase = phase;
    }
}
export class CoordinatorDeadlineExceededError extends CoordinatorError {
    phase;
    constructor(phase, diagnostics) {
        super("deadline_exceeded", `Coordinator deadline exceeded while ${phase}`, diagnostics);
        this.name = "CoordinatorDeadlineExceededError";
        this.phase = phase;
    }
}
export class ReentrantAcquisitionError extends CoordinatorError {
    resourceKind;
    resourceKey;
    constructor(context) {
        super("reentrant_acquisition", `Re-entrant ${context.resourceKind} acquisition rejected for ${context.resourceKey}; use a short callback and release the actor before reacquiring`, context.timing);
        this.name = "ReentrantAcquisitionError";
        this.resourceKind = context.resourceKind;
        this.resourceKey = context.resourceKey;
    }
}
const acquisitionContexts = new AsyncLocalStorage();
const activeAcquisitionTokens = new Set();
function cloneTiming(timing) {
    return {
        ...timing,
        owner: { ...timing.owner }
    };
}
function cloneBrowserGateDiagnostics(diagnostics) {
    return {
        ...diagnostics,
        ...(diagnostics.activeExclusiveOwner === undefined ? {} : {
            activeExclusiveOwner: { ...diagnostics.activeExclusiveOwner }
        })
    };
}
function cloneQueueDiagnostics(diagnostics) {
    return {
        ...diagnostics,
        ...(diagnostics.activeOwner === undefined ? {} : { activeOwner: { ...diagnostics.activeOwner } }),
        ...(diagnostics.lastCompleted === undefined ? {} : { lastCompleted: cloneTiming(diagnostics.lastCompleted) }),
        ...(diagnostics.lastRejected === undefined ? {} : { lastRejected: cloneTiming(diagnostics.lastRejected) }),
        ...(diagnostics.quarantinedUntilSettled === undefined ? {} : {
            quarantinedUntilSettled: cloneTiming(diagnostics.quarantinedUntilSettled)
        }),
        ...(diagnostics.browserGate === undefined ? {} : {
            browserGate: cloneBrowserGateDiagnostics(diagnostics.browserGate)
        })
    };
}
function freezeTiming(timing) {
    return Object.freeze({
        ...timing,
        owner: Object.freeze({ ...timing.owner })
    });
}
function freezeCoordinatorDiagnostics(diagnostics) {
    if ("requestId" in diagnostics)
        return freezeTiming(diagnostics);
    return Object.freeze({
        ...diagnostics,
        ...(diagnostics.activeOwner === undefined ? {} : {
            activeOwner: Object.freeze({ ...diagnostics.activeOwner })
        }),
        ...(diagnostics.lastCompleted === undefined ? {} : {
            lastCompleted: freezeTiming(diagnostics.lastCompleted)
        }),
        ...(diagnostics.lastRejected === undefined ? {} : {
            lastRejected: freezeTiming(diagnostics.lastRejected)
        }),
        ...(diagnostics.quarantinedUntilSettled === undefined ? {} : {
            quarantinedUntilSettled: freezeTiming(diagnostics.quarantinedUntilSettled)
        }),
        ...(diagnostics.browserGate === undefined ? {} : {
            browserGate: Object.freeze({
                ...diagnostics.browserGate,
                ...(diagnostics.browserGate.activeExclusiveOwner === undefined ? {} : {
                    activeExclusiveOwner: Object.freeze({ ...diagnostics.browserGate.activeExclusiveOwner })
                })
            })
        })
    });
}
function validateResourceKey(kind, value) {
    if (typeof value !== "string") {
        throw new InvalidResourceKeyError(`${kind} resource key must be created by the coordinator key factory`);
    }
    parseResourceIdentity(kind, value);
}
/**
 * Decode only the canonical keys produced by the factories above.  In
 * particular, do not derive a browser key by splitting a caller-provided tab
 * key and interpolating strings: the encoded parts must round-trip exactly
 * through the stable-id validators first.
 */
function parseResourceIdentity(kind, value) {
    const parts = value.split(":");
    const expectedParts = kind === "browser" ? 3 : 4;
    if (parts.length !== expectedParts || parts[0] !== kind) {
        throw new InvalidResourceKeyError(`${kind} resource key must be created by the coordinator key factory`);
    }
    const decode = (encoded, label) => {
        if (encoded.length === 0) {
            throw new InvalidResourceKeyError(`${kind} resource key must be created by the coordinator key factory`);
        }
        let decoded;
        try {
            decoded = decodeURIComponent(encoded);
        }
        catch {
            throw new InvalidResourceKeyError(`${kind} resource key must be created by the coordinator key factory`);
        }
        // Reject alternate encodings (for example %62 for b) so this parser is a
        // canonical identity boundary rather than permissive string guesswork.
        if (encodeKeyPart(decoded) !== encoded) {
            throw new InvalidResourceKeyError(`${kind} resource key must be created by the coordinator key factory`);
        }
        return validateStableId(label, decoded);
    };
    const providerId = decode(parts[1], "providerId");
    const browserId = decode(parts[2], "browserId");
    if (kind === "browser")
        return { providerId, browserId };
    return { providerId, browserId, tabId: decode(parts[3], "tabId") };
}
function browserKeyForResource(kind, resourceKey) {
    const identity = parseResourceIdentity(kind, resourceKey);
    return createBrowserResourceKey(identity.providerId, identity.browserId);
}
function validatePriority(priority) {
    if (priority === undefined)
        return "read";
    if (priority !== "read" && priority !== "mutation" && priority !== "control") {
        throw new InvalidCoordinatorRequestError(`Unsupported coordinator priority: ${String(priority)}`);
    }
    return priority;
}
function validatePositiveInteger(label, value) {
    if (!Number.isInteger(value) || value < 1) {
        throw new InvalidCoordinatorRequestError(`${label} must be a positive integer`);
    }
    return value;
}
/**
 * One gate per provider/browser.  Browser acquisitions are exclusive.  Tab
 * transactions are shared leases, but only while no exclusive browser waiter
 * exists.  This gives the browser actor a bounded writer turn even when tab
 * actors for many different tabs are active concurrently.
 */
class BrowserGate {
    resourceKey;
    maxQueueSize;
    maxConsecutiveExclusives;
    /** Reserved but not yet acquired waiters; Set gives O(1) removal. */
    queued = new Set();
    /** Started shared waiters are the only shared entries a drain may grant. */
    startedShared = new Set();
    /** Min-heap by reservation sequence; stale cancelled entries are removed lazily. */
    startedExclusiveHeap = [];
    activeShared = new Set();
    activeExclusive;
    queuedExclusiveCount = 0;
    queuedSharedCount = 0;
    sequence = 0;
    drainScheduled = false;
    rejectedCount = 0;
    consecutiveExclusive = 0;
    /**
     * Shared admissions are reserved when their tab actor accepts a request,
     * not only when that actor reaches its execution turn.  Without this
     * counter a gate could look idle while another tab still had queued work
     * holding a closure over the old gate, allowing a replacement gate to be
     * created for the same browser.
     */
    acceptedSharedReservations = 0;
    pendingSharedReservations = 0;
    constructor(resourceKey, maxQueueSize, maxConsecutiveExclusives) {
        this.resourceKey = resourceKey;
        this.maxQueueSize = maxQueueSize;
        this.maxConsecutiveExclusives = maxConsecutiveExclusives;
    }
    createExclusiveAdmission() {
        let waiter;
        return {
            onAccepted: () => {
                if (waiter !== undefined) {
                    throw new InvalidCoordinatorRequestError("browser admission was accepted more than once");
                }
                waiter = this.reserve("exclusive");
            },
            onStarted: (context) => {
                if (waiter === undefined) {
                    return Promise.reject(new InvalidCoordinatorRequestError("browser admission was not accepted"));
                }
                return this.start(waiter, context);
            },
            onAbandoned: () => {
                if (waiter !== undefined)
                    this.cancel(waiter);
                waiter = undefined;
            },
            onSettled: () => {
                if (waiter !== undefined)
                    this.settle(waiter);
                waiter = undefined;
            }
        };
    }
    createSharedAdmission() {
        let waiter;
        let accepted = false;
        let started = false;
        return {
            onAccepted: () => {
                if (accepted) {
                    throw new InvalidCoordinatorRequestError("tab admission was accepted more than once");
                }
                this.assertReservationCapacity();
                accepted = true;
                started = false;
                this.acceptedSharedReservations += 1;
                this.pendingSharedReservations += 1;
            },
            onStarted: (context) => {
                if (!accepted || waiter !== undefined) {
                    return Promise.reject(new InvalidCoordinatorRequestError("tab admission was accepted more than once"));
                }
                // Convert the already-counted pending reservation into a concrete gate
                // waiter without briefly double-counting it against the browser-wide
                // queue bound. Restore the reservation if allocation fails so the
                // actor's settlement path can release it exactly once.
                this.pendingSharedReservations -= 1;
                try {
                    waiter = this.reserve("shared");
                    started = true;
                }
                catch (error) {
                    this.pendingSharedReservations += 1;
                    throw error;
                }
                return this.start(waiter, context);
            },
            onAbandoned: () => {
                if (waiter !== undefined)
                    this.cancel(waiter);
                waiter = undefined;
                if (accepted) {
                    this.acceptedSharedReservations -= 1;
                    if (!started)
                        this.pendingSharedReservations -= 1;
                }
                accepted = false;
                started = false;
            },
            onSettled: () => {
                if (waiter !== undefined)
                    this.settle(waiter);
                waiter = undefined;
                if (accepted) {
                    this.acceptedSharedReservations -= 1;
                    if (!started)
                        this.pendingSharedReservations -= 1;
                }
                accepted = false;
                started = false;
            }
        };
    }
    isIdle() {
        return this.queued.size === 0 &&
            this.activeExclusive === undefined &&
            this.activeShared.size === 0 &&
            this.acceptedSharedReservations === 0;
    }
    snapshot() {
        return {
            resourceKind: "browser",
            resourceKey: this.resourceKey,
            queueDepth: this.queued.size + this.pendingSharedReservations,
            active: this.activeExclusive !== undefined || this.activeShared.size > 0,
            activeSharedCount: this.activeShared.size,
            queuedExclusiveCount: this.queuedExclusiveCount,
            queuedSharedCount: this.queuedSharedCount + this.pendingSharedReservations,
            rejectedCount: this.rejectedCount,
            ...(this.activeExclusive === undefined ? {} : {
                activeExclusiveRequestId: this.activeExclusive.requestId,
                ...(this.activeExclusive.context === undefined ? {} : {
                    activeExclusiveOwner: { ...this.activeExclusive.context.owner }
                })
            })
        };
    }
    queueSnapshot() {
        return {
            resourceKind: "browser",
            resourceKey: this.resourceKey,
            queueDepth: this.queued.size + this.pendingSharedReservations,
            active: this.activeExclusive !== undefined || this.activeShared.size > 0,
            ...(this.activeExclusive === undefined ? {} : { activeRequestId: this.activeExclusive.requestId }),
            completedCount: 0,
            rejectedCount: this.rejectedCount
        };
    }
    reserve(kind) {
        this.assertReservationCapacity();
        const waiter = {
            requestId: randomUUID(),
            sequence: ++this.sequence,
            kind,
            started: false,
            acquired: false,
            settled: false
        };
        this.queued.add(waiter);
        if (kind === "exclusive")
            this.queuedExclusiveCount += 1;
        else
            this.queuedSharedCount += 1;
        return waiter;
    }
    assertReservationCapacity() {
        if (this.queued.size + this.pendingSharedReservations < this.maxQueueSize)
            return;
        this.rejectedCount += 1;
        throw new CoordinatorQueueFullError(this.queueSnapshot());
    }
    start(waiter, context) {
        if (waiter.settled) {
            return Promise.reject(new InvalidCoordinatorRequestError("coordinator admission is no longer active"));
        }
        if (waiter.started) {
            return Promise.reject(new InvalidCoordinatorRequestError("coordinator admission was started more than once"));
        }
        waiter.started = true;
        waiter.context = context;
        if (waiter.kind === "exclusive")
            this.pushStartedExclusive(waiter);
        else
            this.startedShared.add(waiter);
        waiter.promise = new Promise((resolve, reject) => {
            waiter.resolve = resolve;
            waiter.reject = reject;
        });
        const onAbort = () => {
            if (waiter.acquired || waiter.settled)
                return;
            const reason = context.signal.reason;
            const error = reason instanceof CoordinatorDeadlineExceededError || reason instanceof CoordinatorAbortedError
                ? reason
                : new CoordinatorAbortedError("in_flight", context.timing);
            this.cancel(waiter, error);
        };
        waiter.abortListener = onAbort;
        context.signal.addEventListener("abort", onAbort, { once: true });
        if (context.signal.aborted)
            onAbort();
        this.scheduleDrain();
        return waiter.promise;
    }
    hasExclusiveWaiter() {
        return this.queuedExclusiveCount > 0;
    }
    scheduleDrain() {
        if (this.drainScheduled)
            return;
        this.drainScheduled = true;
        queueMicrotask(() => {
            this.drainScheduled = false;
            this.drain();
        });
    }
    drain() {
        if (this.activeExclusive !== undefined)
            return;
        // A queued exclusive request freezes new shared leases until every
        // already-active tab lease has released.  This is the writer gate that
        // prevents a stream of other tabs from starving browser-level controls.
        if (this.activeShared.size > 0 && this.hasExclusiveWaiter())
            return;
        const exclusive = this.nextStartedExclusive();
        if (this.startedShared.size > 0 &&
            this.consecutiveExclusive >= this.maxConsecutiveExclusives) {
            // A browser-exclusive waiter has writer preference so new tab work
            // cannot continually extend an existing shared turn.  Bound that
            // preference as well: after the configured number of exclusive turns,
            // admit the already queued shared batch.  New shared reservations remain
            // blocked while the batch is active because hasExclusiveWaiter() is
            // still true.
            for (const waiter of [...this.startedShared])
                this.grant(waiter);
            this.consecutiveExclusive = 0;
            return;
        }
        if (exclusive !== undefined && this.activeShared.size === 0) {
            this.grant(exclusive);
            this.consecutiveExclusive += 1;
            return;
        }
        // A reserved browser request may not have reached its ResourceActor
        // execution turn yet.  It still blocks readers, so that handoff cannot
        // be overtaken by a tab started in the meantime.
        if (this.hasExclusiveWaiter())
            return;
        for (const waiter of [...this.startedShared])
            this.grant(waiter);
    }
    grant(waiter) {
        if (!this.queued.has(waiter) || waiter.settled || !waiter.started)
            return;
        this.removeQueued(waiter);
        waiter.acquired = true;
        if (waiter.kind === "exclusive")
            this.activeExclusive = waiter;
        else
            this.activeShared.add(waiter);
        this.detachAbortListener(waiter);
        waiter.resolve?.(() => this.release(waiter));
    }
    release(waiter) {
        if (waiter.settled)
            return;
        if (!waiter.acquired) {
            this.cancel(waiter);
            return;
        }
        waiter.acquired = false;
        waiter.settled = true;
        if (waiter.kind === "exclusive") {
            if (this.activeExclusive === waiter)
                delete this.activeExclusive;
        }
        else {
            this.activeShared.delete(waiter);
        }
        this.detachAbortListener(waiter);
        this.scheduleDrain();
    }
    settle(waiter) {
        if (waiter.settled)
            return;
        if (waiter.acquired) {
            this.release(waiter);
            return;
        }
        this.cancel(waiter);
    }
    cancel(waiter, reason) {
        if (waiter.settled || waiter.acquired)
            return;
        this.removeQueued(waiter);
        waiter.settled = true;
        this.detachAbortListener(waiter);
        if (waiter.started) {
            waiter.reject?.(reason ?? new CoordinatorAbortedError("in_flight", waiter.context.timing));
        }
        this.scheduleDrain();
    }
    removeQueued(waiter) {
        if (!this.queued.delete(waiter))
            return;
        if (waiter.kind === "exclusive")
            this.queuedExclusiveCount -= 1;
        else {
            this.queuedSharedCount -= 1;
            this.startedShared.delete(waiter);
        }
    }
    pushStartedExclusive(waiter) {
        const heap = this.startedExclusiveHeap;
        heap.push(waiter);
        let index = heap.length - 1;
        while (index > 0) {
            const parent = Math.floor((index - 1) / 2);
            if (heap[parent].sequence <= waiter.sequence)
                break;
            heap[index] = heap[parent];
            index = parent;
        }
        heap[index] = waiter;
    }
    nextStartedExclusive() {
        const heap = this.startedExclusiveHeap;
        while (heap.length > 0 && !this.queued.has(heap[0]))
            this.popStartedExclusive();
        return heap[0];
    }
    popStartedExclusive() {
        const heap = this.startedExclusiveHeap;
        const first = heap[0];
        const last = heap.pop();
        if (first === undefined || last === undefined || heap.length === 0)
            return first;
        let index = 0;
        while (true) {
            const left = index * 2 + 1;
            const right = left + 1;
            if (left >= heap.length)
                break;
            const child = right < heap.length && heap[right].sequence < heap[left].sequence ? right : left;
            if (heap[child].sequence >= last.sequence)
                break;
            heap[index] = heap[child];
            index = child;
        }
        heap[index] = last;
        return first;
    }
    detachAbortListener(waiter) {
        if (waiter.abortListener !== undefined && waiter.context !== undefined) {
            waiter.context.signal.removeEventListener("abort", waiter.abortListener);
            delete waiter.abortListener;
        }
    }
}
class ResourceActor {
    options;
    onIdle;
    queue = [];
    active;
    sequence = 0;
    drainScheduled = false;
    consecutive = { read: 0, mutation: 0, control: 0 };
    completedCount;
    rejectedCount;
    lastCompleted;
    lastRejected;
    quarantinedUntilSettled;
    constructor(options, initialDiagnostics, onIdle) {
        this.options = options;
        this.onIdle = onIdle;
        this.completedCount = initialDiagnostics?.completedCount ?? 0;
        this.rejectedCount = initialDiagnostics?.rejectedCount ?? 0;
        if (initialDiagnostics?.lastCompleted !== undefined) {
            this.lastCompleted = cloneTiming(initialDiagnostics.lastCompleted);
        }
        if (initialDiagnostics?.lastRejected !== undefined) {
            this.lastRejected = cloneTiming(initialDiagnostics.lastRejected);
        }
        if (initialDiagnostics?.quarantinedUntilSettled !== undefined) {
            this.quarantinedUntilSettled = cloneTiming(initialDiagnostics.quarantinedUntilSettled);
        }
    }
    isIdle() {
        return this.active === undefined && this.queue.length === 0 && this.quarantinedUntilSettled === undefined;
    }
    notifyIfIdle() {
        if (this.isIdle())
            this.onIdle?.(this);
    }
    snapshot() {
        return {
            resourceKind: this.options.resourceKind,
            resourceKey: this.options.resourceKey,
            queueDepth: this.queue.length,
            active: this.active !== undefined,
            ...(this.active === undefined ? {} : {
                activeRequestId: this.active.requestId,
                activeOwner: this.active.owner
            }),
            completedCount: this.completedCount,
            rejectedCount: this.rejectedCount,
            ...(this.lastCompleted === undefined ? {} : { lastCompleted: cloneTiming(this.lastCompleted) }),
            ...(this.lastRejected === undefined ? {} : { lastRejected: cloneTiming(this.lastRejected) }),
            ...(this.quarantinedUntilSettled === undefined ? {} : {
                quarantinedUntilSettled: cloneTiming(this.quarantinedUntilSettled)
            })
        };
    }
    enqueue(request, externalSignal) {
        if (this.queue.length >= this.options.maxQueueSize) {
            this.rejectedCount += 1;
            request.timing.outcome = "rejected";
            request.timing.settledAt = this.options.now();
            request.timing.totalMs = request.timing.settledAt - request.timing.enqueuedAt;
            this.lastRejected = request.timing;
            this.notifyIfIdle();
            return Promise.reject(new CoordinatorQueueFullError(this.snapshot()));
        }
        return new Promise((resolve, reject) => {
            const pending = {
                ...request,
                ...(externalSignal === undefined ? {} : { externalSignal }),
                sequence: ++this.sequence,
                resolve: (value) => resolve(value),
                reject,
                started: false,
                settled: false,
                callerSettled: false,
                cancelled: false
            };
            if (externalSignal !== undefined) {
                const onAbort = () => this.handleAbort(pending, externalSignal.reason);
                pending.abortListener = onAbort;
                externalSignal.addEventListener("abort", onAbort, { once: true });
                if (externalSignal.aborted) {
                    this.handleAbort(pending, externalSignal.reason);
                    return;
                }
            }
            if (pending.deadlineAt !== undefined && pending.deadlineAt <= this.options.now()) {
                this.handleDeadline(pending);
                return;
            }
            try {
                pending.admission.onAccepted();
            }
            catch (error) {
                this.clearDeadline(pending);
                this.detachAbortListener(pending);
                pending.settled = true;
                pending.callerSettled = true;
                pending.timing.outcome = "rejected";
                pending.timing.settledAt = this.options.now();
                pending.timing.totalMs = pending.timing.settledAt - pending.timing.enqueuedAt;
                pending.admission.onAbandoned();
                this.rejectedCount += 1;
                this.lastRejected = pending.timing;
                pending.reject(error);
                this.notifyIfIdle();
                return;
            }
            this.queue.push(pending);
            this.armDeadline(pending);
            this.scheduleDrain();
        });
    }
    armDeadline(request) {
        if (request.deadlineAt === undefined)
            return;
        const tick = () => {
            if (request.settled || request.cancelled)
                return;
            const remaining = request.deadlineAt - this.options.now();
            if (remaining <= 0) {
                this.handleDeadline(request);
                return;
            }
            request.deadlineTimer = setTimeout(tick, Math.min(remaining, MAX_TIMER_DELAY_MS));
        };
        tick();
    }
    clearDeadline(request) {
        if (request.deadlineTimer !== undefined) {
            clearTimeout(request.deadlineTimer);
            delete request.deadlineTimer;
        }
    }
    detachAbortListener(request) {
        if (request.abortListener !== undefined && request.externalSignal !== undefined) {
            request.externalSignal.removeEventListener("abort", request.abortListener);
            delete request.abortListener;
        }
    }
    handleAbort(request, reason) {
        if (request.settled)
            return;
        if (!request.started) {
            request.cancelled = true;
            request.timing.queuedCancellation = true;
            this.removeQueued(request);
            request.admission.onAbandoned();
            request.settled = true;
            request.callerSettled = true;
            request.timing.outcome = "rejected";
            request.timing.settledAt = this.options.now();
            request.timing.totalMs = request.timing.settledAt - request.timing.enqueuedAt;
            this.rejectedCount += 1;
            this.lastRejected = request.timing;
            request.reject(new CoordinatorAbortedError("queued", request.timing));
            this.scheduleDrain();
            this.notifyIfIdle();
            return;
        }
        request.timing.aborted = true;
        request.timing.quarantinedUntilSettled = true;
        this.quarantinedUntilSettled = request.timing;
        request.inFlightError ??= new CoordinatorAbortedError("in_flight", request.timing);
        if (!request.callerSettled) {
            request.callerSettled = true;
            request.reject(request.inFlightError);
        }
        request.controller.abort(reason ?? new Error("The caller aborted the coordinator request"));
    }
    handleDeadline(request) {
        if (request.settled)
            return;
        if (!request.started) {
            request.cancelled = true;
            request.timing.queuedDeadlineExceeded = true;
            this.removeQueued(request);
            request.admission.onAbandoned();
            request.settled = true;
            request.callerSettled = true;
            request.timing.outcome = "rejected";
            request.timing.settledAt = this.options.now();
            request.timing.totalMs = request.timing.settledAt - request.timing.enqueuedAt;
            this.rejectedCount += 1;
            this.lastRejected = request.timing;
            request.reject(new CoordinatorDeadlineExceededError("queued", request.timing));
            this.scheduleDrain();
            this.notifyIfIdle();
            return;
        }
        request.timing.deadlineExceededInFlight = true;
        request.timing.quarantinedUntilSettled = true;
        this.quarantinedUntilSettled = request.timing;
        request.inFlightError ??= new CoordinatorDeadlineExceededError("in_flight", request.timing);
        if (!request.callerSettled) {
            request.callerSettled = true;
            request.reject(request.inFlightError);
        }
        request.controller.abort(new CoordinatorDeadlineExceededError("in_flight", request.timing));
    }
    removeQueued(request) {
        const index = this.queue.indexOf(request);
        if (index >= 0)
            this.queue.splice(index, 1);
        this.clearDeadline(request);
        this.detachAbortListener(request);
    }
    scheduleDrain() {
        if (this.drainScheduled || this.active !== undefined)
            return;
        this.drainScheduled = true;
        queueMicrotask(() => {
            this.drainScheduled = false;
            this.drain();
        });
    }
    drain() {
        if (this.active !== undefined)
            return;
        let request = this.selectNext();
        while (request !== undefined && request.cancelled)
            request = this.selectNext();
        if (request === undefined)
            return;
        request.started = true;
        request.timing.startedAt = this.options.now();
        request.timing.queueDelayMs = request.timing.startedAt - request.timing.enqueuedAt;
        // Keep the deadline timer and external abort listener attached while the
        // callback is in flight.  The actor remains active until it settles.
        this.active = request;
        const acquisitionToken = randomUUID();
        const context = Object.freeze({
            resourceKind: this.options.resourceKind,
            resourceKey: this.options.resourceKey,
            acquisitionToken,
            owner: request.owner,
            priority: request.priority,
            signal: request.controller.signal,
            timing: freezeTiming(request.timing)
        });
        request.context = context;
        void this.execute(request, context);
    }
    async execute(request, context) {
        activeAcquisitionTokens.add(context.acquisitionToken);
        let admissionLease;
        try {
            admissionLease = await acquisitionContexts.run(context, () => request.admission.onStarted(context));
            request.timing.admittedAt = this.options.now();
            request.timing.admissionDelayMs = request.timing.admittedAt - (request.timing.startedAt ?? request.timing.admittedAt);
            const value = await acquisitionContexts.run(context, () => request.callback(context));
            if (request.inFlightError !== undefined) {
                throw request.inFlightError;
            }
            if (!request.callerSettled) {
                request.callerSettled = true;
                request.resolve(value);
            }
            request.timing.outcome = "fulfilled";
        }
        catch (error) {
            if (!request.callerSettled) {
                request.callerSettled = true;
                request.reject(request.inFlightError ?? error);
            }
            request.timing.outcome = "rejected";
        }
        finally {
            admissionLease?.();
            request.admission.onSettled();
            activeAcquisitionTokens.delete(context.acquisitionToken);
            request.settled = true;
            this.clearDeadline(request);
            this.detachAbortListener(request);
            request.timing.settledAt = this.options.now();
            request.timing.executionMs = request.timing.settledAt - (request.timing.admittedAt ?? request.timing.startedAt ?? request.timing.settledAt);
            request.timing.totalMs = request.timing.settledAt - request.timing.enqueuedAt;
            if (request.timing.outcome === "fulfilled") {
                this.completedCount += 1;
                this.lastCompleted = request.timing;
            }
            else {
                this.rejectedCount += 1;
                this.lastRejected = request.timing;
            }
            if (this.quarantinedUntilSettled === request.timing)
                delete this.quarantinedUntilSettled;
            delete this.active;
            this.scheduleDrain();
            this.notifyIfIdle();
        }
    }
    selectNext() {
        this.removeExpiredQueued();
        if (this.queue.length === 0)
            return undefined;
        const now = this.options.now();
        const aged = this.queue
            .filter((request) => now - request.enqueuedAt >= this.options.maxWaitMs)
            .sort((left, right) => left.sequence - right.sequence)[0];
        if (aged !== undefined) {
            this.queue.splice(this.queue.indexOf(aged), 1);
            this.recordSelection(aged.priority);
            return aged;
        }
        const controls = this.queue.filter((request) => request.priority === "control");
        const mutations = this.queue.filter((request) => request.priority === "mutation");
        const reads = this.queue.filter((request) => request.priority === "read");
        let selected;
        if (controls.length > 0 &&
            (mutations.length === 0 || this.consecutive.control < this.options.maxConsecutiveControls)) {
            selected = controls[0];
        }
        else if (mutations.length > 0 &&
            (reads.length === 0 || (this.consecutive.read >= this.options.maxConsecutiveReads &&
                this.consecutive.mutation < this.options.maxConsecutiveMutations))) {
            selected = mutations[0];
        }
        else if (reads.length > 0) {
            selected = reads[0];
        }
        else if (mutations.length > 0) {
            selected = mutations[0];
        }
        else {
            selected = controls[0];
        }
        if (selected === undefined)
            return undefined;
        this.queue.splice(this.queue.indexOf(selected), 1);
        this.recordSelection(selected.priority);
        return selected;
    }
    recordSelection(priority) {
        for (const candidate of ["read", "mutation", "control"]) {
            this.consecutive[candidate] = candidate === priority ? this.consecutive[candidate] + 1 : 0;
        }
    }
    removeExpiredQueued() {
        const now = this.options.now();
        for (const request of [...this.queue]) {
            if (request.deadlineAt !== undefined && request.deadlineAt <= now)
                this.handleDeadline(request);
        }
    }
}
function makeDeadline(options, now) {
    if (options.deadlineAt !== undefined && options.timeoutMs !== undefined) {
        throw new InvalidCoordinatorRequestError("Use deadlineAt or timeoutMs, not both");
    }
    if (options.deadlineAt !== undefined) {
        if (!Number.isFinite(options.deadlineAt))
            throw new InvalidCoordinatorRequestError("deadlineAt must be finite");
        return options.deadlineAt;
    }
    if (options.timeoutMs !== undefined) {
        if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0) {
            throw new InvalidCoordinatorRequestError("timeoutMs must be a non-negative finite number");
        }
        return now + options.timeoutMs;
    }
    return undefined;
}
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
export class ProcessTabCoordinator {
    browserActors = new Map();
    tabActors = new Map();
    browserGates = new Map();
    idleDiagnostics = new Map();
    options;
    constructor(options = {}) {
        this.options = {
            maxQueueSize: validatePositiveInteger("maxQueueSize", options.maxQueueSize ?? 64),
            maxConsecutiveReads: validatePositiveInteger("maxConsecutiveReads", options.maxConsecutiveReads ?? 4),
            maxConsecutiveMutations: validatePositiveInteger("maxConsecutiveMutations", options.maxConsecutiveMutations ?? 4),
            maxConsecutiveControls: validatePositiveInteger("maxConsecutiveControls", options.maxConsecutiveControls ?? 4),
            maxWaitMs: (() => {
                const value = options.maxWaitMs ?? 1_000;
                if (!Number.isFinite(value) || value < 0)
                    throw new InvalidCoordinatorRequestError("maxWaitMs must be non-negative");
                return value;
            })(),
            maxConsecutiveBrowserExclusives: validatePositiveInteger("maxConsecutiveBrowserExclusives", options.maxConsecutiveBrowserExclusives ?? 4),
            maxIdleDiagnostics: validatePositiveInteger("maxIdleDiagnostics", options.maxIdleDiagnostics ?? 256),
            now: options.now ?? (() => Date.now())
        };
    }
    withBrowserAcquisition(resourceKey, options, callback) {
        return this.enqueue("browser", resourceKey, options, callback);
    }
    withTabTransaction(resourceKey, options, callback) {
        return this.enqueue("tab", resourceKey, options, callback);
    }
    getBrowserDiagnostics(resourceKey) {
        validateResourceKey("browser", resourceKey);
        const actor = this.browserActors.get(resourceKey);
        const diagnostics = actor?.snapshot()
            ?? this.idleDiagnostics.get(this.diagnosticsKey("browser", resourceKey))
            ?? this.emptyDiagnostics("browser", resourceKey);
        const gate = this.browserGates.get(resourceKey);
        return cloneQueueDiagnostics(gate === undefined ? diagnostics : { ...diagnostics, browserGate: gate.snapshot() });
    }
    getTabDiagnostics(resourceKey) {
        validateResourceKey("tab", resourceKey);
        const diagnostics = this.tabActors.get(resourceKey)?.snapshot()
            ?? this.idleDiagnostics.get(this.diagnosticsKey("tab", resourceKey))
            ?? this.emptyDiagnostics("tab", resourceKey);
        const gate = this.browserGates.get(browserKeyForResource("tab", resourceKey));
        return cloneQueueDiagnostics(gate === undefined ? diagnostics : { ...diagnostics, browserGate: gate.snapshot() });
    }
    getActor(kind, key) {
        const actors = kind === "browser" ? this.browserActors : this.tabActors;
        let actor = actors.get(key);
        if (actor === undefined) {
            actor = this.createActor(kind, key);
            actors.set(key, actor);
        }
        return actor;
    }
    createActor(kind, key) {
        const actors = kind === "browser" ? this.browserActors : this.tabActors;
        const diagnosticsKey = this.diagnosticsKey(kind, key);
        const initialDiagnostics = this.idleDiagnostics.get(diagnosticsKey);
        let actor;
        actor = new ResourceActor({
            resourceKind: kind,
            resourceKey: key,
            maxQueueSize: this.options.maxQueueSize,
            maxConsecutiveReads: this.options.maxConsecutiveReads,
            maxConsecutiveMutations: this.options.maxConsecutiveMutations,
            maxConsecutiveControls: this.options.maxConsecutiveControls,
            maxWaitMs: this.options.maxWaitMs,
            now: this.options.now
        }, initialDiagnostics, (idleActor) => this.onActorIdle(kind, key, idleActor));
        // The callback runs only after a later asynchronous request turn, but
        // retaining this identity check makes cleanup safe if a caller creates a
        // replacement actor after an idle notification has been queued.
        if (actors.get(key) === undefined)
            this.idleDiagnostics.delete(diagnosticsKey);
        return actor;
    }
    diagnosticsKey(kind, key) {
        return `${kind}:${key}`;
    }
    emptyDiagnostics(kind, key) {
        return {
            resourceKind: kind,
            resourceKey: key,
            queueDepth: 0,
            active: false,
            completedCount: 0,
            rejectedCount: 0
        };
    }
    onActorIdle(kind, key, actor) {
        const actors = kind === "browser" ? this.browserActors : this.tabActors;
        if (actors.get(key) !== actor || !actor.isIdle())
            return;
        const browserKey = kind === "browser" ? key : browserKeyForResource("tab", key);
        // Keep a browser actor discoverable while its parent gate still carries a
        // shared or exclusive lease.  Otherwise a diagnostics lookup could
        // create a replacement actor during an in-flight sibling-tab operation.
        if (kind === "browser") {
            const gate = this.browserGates.get(browserKey);
            if (gate !== undefined && !gate.isIdle())
                return;
        }
        this.idleDiagnostics.delete(this.diagnosticsKey(kind, key));
        this.idleDiagnostics.set(this.diagnosticsKey(kind, key), cloneQueueDiagnostics(actor.snapshot()));
        while (this.idleDiagnostics.size > this.options.maxIdleDiagnostics) {
            const oldest = this.idleDiagnostics.keys().next().value;
            if (oldest === undefined)
                break;
            this.idleDiagnostics.delete(oldest);
        }
        actors.delete(key);
        this.maybeCleanupGate(browserKey);
    }
    getBrowserGate(kind, resourceKey) {
        const browserKey = browserKeyForResource(kind, resourceKey);
        let gate = this.browserGates.get(browserKey);
        if (gate === undefined) {
            gate = new BrowserGate(browserKey, this.options.maxQueueSize, this.options.maxConsecutiveBrowserExclusives);
            this.browserGates.set(browserKey, gate);
        }
        return gate;
    }
    maybeCleanupGate(browserKey) {
        const gate = this.browserGates.get(browserKey);
        if (gate === undefined || !gate.isIdle())
            return;
        const browserActor = this.browserActors.get(browserKey);
        if (browserActor !== undefined && !browserActor.isIdle())
            return;
        if (browserActor !== undefined) {
            // The browser actor may have completed before the last tab lease.  Its
            // idle callback intentionally deferred eviction so the parent gate
            // remained visible; finish that deterministic handoff now.
            this.onActorIdle("browser", browserKey, browserActor);
            if (this.browserActors.has(browserKey))
                return;
        }
        this.browserGates.delete(browserKey);
    }
    enqueue(kind, resourceKey, requestOptions, callback) {
        if (typeof callback !== "function")
            throw new InvalidCoordinatorRequestError("callback is required");
        validateResourceKey(kind, resourceKey);
        const stored = acquisitionContexts.getStore();
        const current = stored !== undefined && activeAcquisitionTokens.has(stored.acquisitionToken) ? stored : undefined;
        const explicit = requestOptions.acquisitionContext;
        if (explicit !== undefined && !activeAcquisitionTokens.has(explicit.acquisitionToken)) {
            return Promise.reject(new InvalidCoordinatorRequestError("acquisitionContext is stale or does not belong to an active coordinator callback"));
        }
        if (current !== undefined && explicit !== undefined && current.acquisitionToken !== explicit.acquisitionToken) {
            return Promise.reject(new InvalidCoordinatorRequestError("acquisitionContext cannot override the active async coordinator context"));
        }
        const parent = current ?? explicit;
        if (parent !== undefined) {
            // Nested acquisition of any coordinator actor can deadlock when another
            // caller acquires the same resources in the opposite order. Callers must
            // finish one short browser transaction before requesting another.
            return Promise.reject(new ReentrantAcquisitionError(parent));
        }
        const owner = validateOwner(requestOptions.owner);
        const priority = validatePriority(requestOptions.priority);
        const now = this.options.now();
        const deadlineAt = makeDeadline(requestOptions, now);
        const browserKey = browserKeyForResource(kind, resourceKey);
        const gate = this.getBrowserGate(kind, resourceKey);
        const admission = kind === "browser"
            ? gate.createExclusiveAdmission()
            : gate.createSharedAdmission();
        const timing = {
            requestId: randomUUID(),
            resourceKind: kind,
            resourceKey,
            priority,
            owner,
            ...(requestOptions.label === undefined ? {} : { label: requestOptions.label }),
            enqueuedAt: now,
            ...(deadlineAt === undefined ? {} : { deadlineAt })
        };
        const controller = new AbortController();
        const request = {
            requestId: timing.requestId,
            priority,
            owner,
            ...(requestOptions.label === undefined ? {} : { label: requestOptions.label }),
            enqueuedAt: now,
            ...(deadlineAt === undefined ? {} : { deadlineAt }),
            callback,
            timing,
            controller,
            admission
        };
        const actor = this.getActor(kind, resourceKey);
        const result = actor.enqueue(request, requestOptions.signal);
        // Queue-full and already-aborted requests may never call admission's
        // accepted hook.  Remove a gate created solely for that rejected request,
        // while leaving any active/queued parent work untouched.
        this.maybeCleanupGate(browserKey);
        return result;
    }
}
/** Explicit factory to make process/runtime ownership visible at call sites. */
export function createProcessTabCoordinator(options) {
    return new ProcessTabCoordinator(options);
}
let defaultProcessCoordinator;
/**
 * Return the lifecycle-wide coordinator used by default SDK/runtime services.
 *
 * Constructing a coordinator per client would make each queue internally
 * correct while allowing two clients in the same backend process to overlap
 * on the same tab.  Callers that need deterministic test limits may still
 * inject an explicitly constructed coordinator; production integration should
 * use this shared instance.
 */
export function getProcessTabCoordinator() {
    defaultProcessCoordinator ??= new ProcessTabCoordinator();
    return defaultProcessCoordinator;
}
