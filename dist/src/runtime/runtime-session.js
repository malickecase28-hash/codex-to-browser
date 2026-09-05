const MUTABLE_FIELDS = Object.freeze([
    "browser",
    "page",
    "expectedTabId"
]);
const BASE_FIELDS = Object.freeze([
    "agent",
    "clipboard",
    "now"
]);
const ALLOWED_OPTION_FIELDS = new Set([...BASE_FIELDS, ...MUTABLE_FIELDS]);
const STATIC_ERROR_MESSAGES = Object.freeze({
    invalid_options: "RuntimeEnvSession options are invalid.",
    invalid_capture: "RuntimeEnvSession capture contains an unsupported value.",
    capture_closed: "RuntimeEnvSession capture is already closed.",
    commit_conflict: "RuntimeEnvSession commit conflicts with a newer invocation.",
    revision_exhausted: "RuntimeEnvSession revision capacity is exhausted."
});
/**
 * Errors intentionally have a fixed message.  In particular, no browser,
 * page, tab id, caller object, or native error is interpolated into a
 * RuntimeEnvSession diagnostic.
 */
export class RuntimeEnvSessionError extends Error {
    code;
    constructor(code) {
        super(STATIC_ERROR_MESSAGES[code]);
        this.name = "RuntimeEnvSessionError";
        this.code = code;
    }
}
function invalidOptions() {
    return new RuntimeEnvSessionError("invalid_options");
}
function invalidCapture() {
    return new RuntimeEnvSessionError("invalid_capture");
}
function readDataOptions(options) {
    if (options === undefined)
        return {};
    if (options === null || typeof options !== "object" || Array.isArray(options)) {
        throw invalidOptions();
    }
    let descriptors;
    try {
        // Reading descriptors does not invoke accessor values.  A hostile proxy
        // may still reject reflection; that is converted to the fixed error.
        descriptors = Object.getOwnPropertyDescriptors(options);
    }
    catch {
        throw invalidOptions();
    }
    const result = {};
    for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key !== "string" || !ALLOWED_OPTION_FIELDS.has(key)) {
            throw invalidOptions();
        }
        const descriptor = descriptors[key];
        if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined || !("value" in descriptor)) {
            throw invalidOptions();
        }
        result[key] = descriptor;
    }
    return result;
}
function readOption(descriptors, key) {
    return descriptors[key]?.value;
}
function validateOptions(options) {
    const descriptors = readDataOptions(options);
    const expectedTabId = readOption(descriptors, "expectedTabId");
    if (expectedTabId !== undefined && typeof expectedTabId !== "string")
        throw invalidOptions();
    const now = readOption(descriptors, "now");
    if (now !== undefined && typeof now !== "function")
        throw invalidOptions();
    return {
        agent: readOption(descriptors, "agent"),
        browser: readOption(descriptors, "browser"),
        page: readOption(descriptors, "page"),
        clipboard: readOption(descriptors, "clipboard"),
        now,
        expectedTabId
    };
}
function presence(value) {
    return value === undefined ? "unset" : "set";
}
function sameValue(left, right) {
    return Object.is(left, right);
}
function freezeFields(fields) {
    return Object.freeze([...fields]);
}
function createInvocationEnv(base, snapshot) {
    const env = {};
    // Base/provider references are copied once and cannot be overwritten by a
    // legacy command.  Snapshot values are writable and are committed through
    // the owning session's CAS path only.
    for (const key of BASE_FIELDS) {
        Object.defineProperty(env, key, {
            configurable: false,
            enumerable: true,
            value: base[key],
            writable: false
        });
    }
    for (const key of MUTABLE_FIELDS) {
        Object.defineProperty(env, key, {
            configurable: false,
            enumerable: true,
            value: snapshot[key],
            writable: true
        });
    }
    return env;
}
function readInvocationSnapshot(env) {
    const snapshot = {};
    for (const key of MUTABLE_FIELDS) {
        let descriptor;
        try {
            descriptor = Object.getOwnPropertyDescriptor(env, key);
        }
        catch {
            throw invalidCapture();
        }
        // The fields are installed as data properties.  Treat any attempted
        // descriptor/prototype tampering as invalid without invoking a getter.
        if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined || !("value" in descriptor)) {
            throw invalidCapture();
        }
        const value = descriptor.value;
        if (key === "expectedTabId" && value !== undefined && typeof value !== "string") {
            throw invalidCapture();
        }
        snapshot[key] = value;
    }
    return snapshot;
}
function freezeCommitResult(revision, changedFields, appliedFields, converged) {
    return Object.freeze({
        revision,
        changedFields: freezeFields(changedFields),
        appliedFields: freezeFields(appliedFields),
        converged
    });
}
/**
 * Owns the mutable browser/page/tab snapshot used by invocation-scoped
 * RuntimeEnv captures.  It intentionally performs no browser locking or
 * command dispatch; this is the synchronous in-process snapshot/CAS boundary
 * used by `createChatGPT` to isolate concurrent legacy invocations.
 */
export class RuntimeEnvSession {
    base;
    state;
    captureCount = 0;
    openCaptureCount = 0;
    constructor(options) {
        const validated = validateOptions(options);
        this.base = Object.freeze({
            agent: validated.agent,
            clipboard: validated.clipboard,
            now: validated.now
        });
        this.state = {
            browser: validated.browser,
            page: validated.page,
            expectedTabId: validated.expectedTabId,
            revision: 0
        };
    }
    /** Current revision; no browser or page value is exposed. */
    get revision() {
        return this.state.revision;
    }
    /** Return frozen, redacted state diagnostics. */
    diagnostics() {
        return Object.freeze({
            revision: this.state.revision,
            captures: this.captureCount,
            openCaptures: this.openCaptureCount,
            base: Object.freeze({
                agent: presence(this.base.agent),
                clipboard: presence(this.base.clipboard),
                now: presence(this.base.now)
            }),
            snapshot: Object.freeze({
                browser: presence(this.state.browser),
                page: presence(this.state.page),
                expectedTabId: presence(this.state.expectedTabId)
            })
        });
    }
    capture() {
        const capturedRevision = this.state.revision;
        const baseline = {
            browser: this.state.browser,
            page: this.state.page,
            expectedTabId: this.state.expectedTabId
        };
        const env = createInvocationEnv(this.base, baseline);
        let status = "open";
        this.captureCount += 1;
        this.openCaptureCount += 1;
        const close = (nextStatus) => {
            if (status !== "open")
                throw new RuntimeEnvSessionError("capture_closed");
            status = nextStatus;
            this.openCaptureCount -= 1;
        };
        const commit = () => {
            // A commit attempt is one-shot, including invalid captures and CAS
            // conflicts.  Retrying a mutated stale environment would be ambiguous.
            close("committed");
            const candidate = readInvocationSnapshot(env);
            const changedFields = MUTABLE_FIELDS.filter((key) => !sameValue(candidate[key], baseline[key]));
            // Read-only invocations never clobber a newer snapshot, regardless of
            // how many commits occurred after this capture was made.
            if (changedFields.length === 0) {
                return freezeCommitResult(this.state.revision, changedFields, [], false);
            }
            const stale = capturedRevision !== this.state.revision;
            if (stale) {
                // Merge only fields intentionally changed by this invocation.  A
                // stale commit converges only if each such field already has the same
                // reference/value in the current session state.
                for (const key of changedFields) {
                    if (!sameValue(candidate[key], this.state[key])) {
                        throw new RuntimeEnvSessionError("commit_conflict");
                    }
                }
            }
            const appliedFields = changedFields.filter((key) => !sameValue(candidate[key], this.state[key]));
            if (appliedFields.length === 0) {
                return freezeCommitResult(this.state.revision, changedFields, appliedFields, stale);
            }
            if (this.state.revision >= Number.MAX_SAFE_INTEGER) {
                throw new RuntimeEnvSessionError("revision_exhausted");
            }
            // The state object is replaced once, after every field has passed the
            // CAS checks.  Consumers can therefore never observe a partial tuple.
            const nextState = {
                browser: this.state.browser,
                page: this.state.page,
                expectedTabId: this.state.expectedTabId,
                revision: this.state.revision + 1
            };
            for (const key of appliedFields) {
                if (key === "browser")
                    nextState.browser = candidate.browser;
                else if (key === "page")
                    nextState.page = candidate.page;
                else
                    nextState.expectedTabId = candidate.expectedTabId;
            }
            this.state = nextState;
            return freezeCommitResult(this.state.revision, changedFields, appliedFields, stale);
        };
        const abandon = () => {
            close("abandoned");
        };
        const diagnostics = () => Object.freeze({
            status,
            revision: capturedRevision
        });
        return Object.freeze({
            env,
            revision: capturedRevision,
            commit,
            abandon,
            diagnostics
        });
    }
    /** Capture, run one invocation, and publish its snapshot only on success. */
    async run(callback) {
        if (typeof callback !== "function")
            throw new RuntimeEnvSessionError("invalid_options");
        const capture = this.capture();
        try {
            const result = await callback(capture.env);
            try {
                capture.commit();
            }
            catch (error) {
                // The snapshot is only a convenience default for a later invocation;
                // it is not part of the browser command's outcome. A newer invocation
                // may legitimately publish a different tab while this callback is in
                // flight. Never turn an already-completed browser action into a
                // rejected promise (and a tempting caller retry) merely because that
                // stale convenience snapshot could not be published.
                if (!(error instanceof RuntimeEnvSessionError) || error.code !== "commit_conflict") {
                    throw error;
                }
            }
            return result;
        }
        catch (error) {
            // Preserve the callback/commit error exactly.  Abandon is best effort
            // and has a fixed error if the callback already closed the capture.
            try {
                capture.abandon();
            }
            catch {
                // The original callback or commit error is the useful result.
            }
            throw error;
        }
    }
}
export function createRuntimeEnvSession(options) {
    return new RuntimeEnvSession(options);
}
