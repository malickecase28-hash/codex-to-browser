import { getProcessTabCoordinator } from "../runtime/tab-coordinator.js";
import { OperationRuntimeContext } from "../runtime/operation-context.js";
import { observeBrowserPage } from "./browser-observation.js";
import { bindBrowserTarget } from "./browser-target.js";
import { canonicalJson } from "./canonical.js";
import { executePreparedSendOnce, prepareSendOnce, recoverSendOnce, runSendOnce, verifyPreparedSendOnce } from "./send-once.js";
import { revalidateOperationFile } from "./file-identity.js";
import { CONTROL_COORDINATOR_SCHEMA_VERSION, CONTROL_POSTCONDITION_RETRY_POLICY } from "./control.js";
import { transferOperationArtifact } from "./artifact-transfer.js";
export class OperationBrowserAdapterError extends Error {
    code;
    constructor(code) {
        super(code === "input_file_changed"
            ? "An operation input file changed before the file handoff; no browser handoff was attempted."
            : "The operation browser adapter could not prove the requested browser action safely.");
        this.name = "OperationBrowserAdapterError";
        this.code = code;
    }
}
const DIGEST_PATTERN = /^hmac-sha256:[0-9a-f]{64}$/u;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,512}$/u;
const OPAQUE_THREAD_URL_PATTERN = /^https:\/\/opaque\.invalid\/thread\/[0-9a-f]{64}$/u;
const CLAIM_EVIDENCE_DIGEST_DOMAIN = "codex-chatgpt-control/tab-claim-evidence/v1";
const MAX_DEADLINE_AT = Date.UTC(2100, 0, 1);
const DEFAULT_TRANSACTION_TIMEOUT_MS = 30_000;
const MAX_TRANSACTION_TIMEOUT_MS = 120_000;
function isAbsolutePath(value) {
    return value.startsWith("/")
        || /^[A-Za-z]:[\\/]/u.test(value)
        || value.startsWith("\\\\");
}
/**
 * Build the operation browser adapter over one captured page.
 *
 * The adapter is deliberately a composition layer: journal persistence stays
 * in OperationService, browser observations are supplied by narrow injected
 * primitives (or the conservative browser-observation default), and every
 * non-repeatable call is made at one explicit site.  No method reads
 * RuntimeEnv.page and no method retries a browser mutation.
 */
export function createOperationBrowserAdapter(options) {
    options = normalizeAdapterOptions(options);
    const page = options.page;
    const runtimeCapture = options.runtimeContext?.capture();
    if (runtimeCapture !== undefined && runtimeCapture.page !== page) {
        throw new OperationBrowserAdapterError("page_affinity_mismatch");
    }
    const coordinator = options.coordinator ?? getProcessTabCoordinator();
    const transactionTimeoutMs = options.transactionTimeoutMs ?? DEFAULT_TRANSACTION_TIMEOUT_MS;
    const bindings = new Map();
    const collectorContexts = new Map();
    let recoveryPromise;
    const ensureRecovered = async (operationId, requestDigest, surface, signal) => {
        const recovery = options.recovery;
        if (recovery === undefined) {
            throw new OperationBrowserAdapterError("target_binding_mismatch");
        }
        assertNativeAbortSignal(signal);
        if (operationId !== recovery.operationId
            || requestDigest !== recovery.requestDigest
            || surface !== recovery.surface) {
            throw new OperationBrowserAdapterError("target_binding_mismatch");
        }
        recoveryPromise ??= hydrateRecoveredTarget(options, recovery, page, coordinator);
        const binding = await recoveryPromise;
        bindings.set(recovery.operationId, binding);
        return binding;
    };
    const resolveTarget = async (request) => {
        if (options.recovery !== undefined) {
            try {
                const binding = await ensureRecovered(request.operationId, request.requestDigest, request.surface, request.signal);
                return Object.freeze({ target: binding.target });
            }
            catch (error) {
                if (error instanceof OperationBrowserAdapterError)
                    throw error;
                throw new OperationBrowserAdapterError(errorCode(error));
            }
        }
        let probe;
        try {
            probe = await resolveProbe(options, request);
            assertProbePage(page, probe.page);
            if (request.target.type === "new") {
                if (probe.targetLifecycle !== undefined && probe.targetLifecycle !== "new_pending") {
                    throw new OperationBrowserAdapterError("target_binding_mismatch");
                }
            }
            else if (probe.targetLifecycle === "new_pending") {
                throw new OperationBrowserAdapterError("target_binding_mismatch");
            }
            assertStaticTarget(request.target, probe.evidence, options.resolveTargetEvidence !== undefined);
            if (runtimeCapture !== undefined) {
                assertRuntimeAffinity(runtimeCapture, page, probe);
            }
            const owner = Object.freeze({
                ...options.owner,
                operationId: request.operationId
            });
            const input = {
                page,
                evidence: probe.evidence,
                ...(request.target.type === "new"
                    ? { targetLifecycle: "new_pending" }
                    : probe.targetLifecycle === undefined ? {} : { targetLifecycle: probe.targetLifecycle }),
                ...((probe.newTargetAnchorDigest ?? options.newTargetAnchorDigest) === undefined
                    ? {}
                    : { newTargetAnchorDigest: probe.newTargetAnchorDigest ?? options.newTargetAnchorDigest }),
                ...((probe.blankTaskEvidenceDigest ?? options.blankTaskEvidenceDigest) === undefined
                    ? {}
                    : { blankTaskEvidenceDigest: probe.blankTaskEvidenceDigest ?? options.blankTaskEvidenceDigest }),
                ...(probe.authoritativeClaim === undefined ? {} : { authoritativeClaim: probe.authoritativeClaim }),
                capabilities: {
                    ...(options.capabilities ?? {}),
                    ...(probe.capabilities ?? {})
                },
                evidenceDigest: options.evidenceDigest,
                owner,
                coordinator
            };
            const binding = bindBrowserTarget(input);
            const previous = bindings.get(request.operationId);
            if (previous !== undefined && canonicalJson(previous.target) !== canonicalJson(binding.target)) {
                throw new OperationBrowserAdapterError("target_binding_mismatch");
            }
            bindings.set(request.operationId, binding);
            return Object.freeze({ target: binding.target });
        }
        catch (error) {
            if (error instanceof OperationBrowserAdapterError)
                throw error;
            throw new OperationBrowserAdapterError(errorCode(error));
        }
    };
    const observeStaging = async (request) => {
        const binding = bindingFor(bindings, request.operationId, request.targetBindingDigest);
        if (binding === undefined)
            return unavailableStage("target");
        try {
            return await runReadTransaction(binding, request.operationId, async (context) => {
                if (options.submission?.observeStaging === undefined)
                    return unavailableStage("unknown");
                return await options.submission.observeStaging(request, context.page, context.target);
            }, options.observeCurrentTarget, options.evidenceDigest, { timeoutMs: transactionTimeoutMs });
        }
        catch {
            return unavailableStage("target");
        }
    };
    const executeFileHandoffOnce = async (request) => {
        const binding = bindingFor(bindings, request.operationId, request.targetBindingDigest);
        if (binding === undefined)
            return { status: "not_satisfied", blockerCode: "target_binding_mismatch" };
        const files = matchFileManifest(options.files, options.fileManifestDigest, request.manifest);
        if (files === undefined || options.submission?.handoffFiles === undefined) {
            return { status: "not_satisfied", blockerCode: "attachment_manifest_mismatch" };
        }
        // Target proof gets its own short read transaction. Hashing/revalidation
        // stays outside the actor, so a large file cannot monopolize the tab.
        try {
            await runReadTransaction(binding, request.operationId, async () => undefined, options.observeCurrentTarget, options.evidenceDigest, boundedRequest(request.signal, request.deadlineAt, transactionTimeoutMs, "operation-file-handoff-target"));
            for (const identity of files) {
                if (request.signal?.aborted || request.deadlineAt !== undefined && Date.now() >= request.deadlineAt) {
                    // A durable file-handoff intent already exists by the time this port
                    // is called.  Even a cancellation before the provider mutation is
                    // therefore observation-only; never let a caller retry the handoff.
                    return { status: "uncertain", quarantine: "caller" };
                }
                try {
                    await revalidateOperationFile(identity);
                }
                catch {
                    return { status: "not_satisfied", blockerCode: "input_file_changed" };
                }
            }
            if (request.signal?.aborted || request.deadlineAt !== undefined && Date.now() >= request.deadlineAt) {
                return { status: "uncertain", quarantine: "caller" };
            }
            // This is the sole file-handoff mutation site. There is no catch/retry
            // branch that invokes handoffFiles a second time.
            return await runMutationTransaction(binding, request.operationId, async (context) => {
                const providerRequest = Object.freeze({
                    ...request,
                    signal: context.acquisition.signal,
                    ...(context.acquisition.timing.deadlineAt === undefined
                        ? (request.deadlineAt === undefined ? {} : { deadlineAt: request.deadlineAt })
                        : { deadlineAt: context.acquisition.timing.deadlineAt })
                });
                const result = await options.submission.handoffFiles(providerRequest, files, context.page, context.target);
                // A provider may finish with a success-looking acknowledgement after
                // the coordinator has already aborted its in-flight mutation.  The
                // acknowledgement is no longer safe to treat as exact; recovery must
                // observe the live attachment surface and may not repeat the handoff.
                return context.acquisition.signal.aborted
                    ? { status: "uncertain", quarantine: "caller" }
                    : result;
            }, options.observeCurrentTarget, options.evidenceDigest, boundedRequest(request.signal, request.deadlineAt, transactionTimeoutMs, "operation-file-handoff", "mutation"));
        }
        catch {
            return request.signal?.aborted || request.deadlineAt !== undefined && Date.now() >= request.deadlineAt
                ? { status: "uncertain", quarantine: "caller" }
                : { status: "uncertain", quarantine: "provider" };
        }
    };
    const observeAttachments = async (request) => {
        const binding = bindingFor(bindings, request.operationId, request.targetBindingDigest);
        if (binding === undefined)
            return { status: "unavailable" };
        try {
            return await runReadTransaction(binding, request.operationId, async (context) => {
                if (options.submission?.observeAttachments === undefined)
                    return { status: "unavailable" };
                return await options.submission.observeAttachments(request, context.page, context.target);
            }, options.observeCurrentTarget, options.evidenceDigest, { timeoutMs: transactionTimeoutMs });
        }
        catch {
            return { status: "unavailable" };
        }
    };
    /**
     * Send's four phase ports deliberately share only an operation-local abort
     * controller.  The controller is linked to both the caller and whichever
     * coordinator transaction is currently executing.  This lets the provider
     * see the coordinator's cancellation without making the durable service
     * aware of a page, actor, or bridge object.
     */
    const prepareSend = async (request) => {
        const binding = bindingFor(bindings, request.operationId, request.expected.targetBindingDigest);
        if (binding === undefined)
            return blockedPrepareSend("target_binding_mismatch");
        const baseObservers = options.submission?.sendObservers;
        if (baseObservers === undefined)
            return blockedPrepareSend("target_evidence_unavailable");
        const linked = createLinkedAbortController(request.signal);
        const send = createPhaseSendObservers(binding, request.operationId, baseObservers, linked.controller, options.observeCurrentTarget, options.evidenceDigest, transactionTimeoutMs);
        try {
            const result = await prepareSendOnce({
                page,
                operationId: request.operationId,
                requestDigest: request.requestDigest,
                surface: request.surface,
                actionId: request.actionId,
                expected: request.expected,
                observers: send.observers,
                signal: linked.controller.signal,
                ...(request.deadlineAt === undefined ? {} : { deadlineAt: request.deadlineAt }),
                transaction: callback => runSendTransaction(binding, request.operationId, linked.controller, options.observeCurrentTarget, options.evidenceDigest, request.deadlineAt, transactionTimeoutMs, "operation-send-prepare", "read", context => send.withContext(context, callback))
            });
            if (result.status === "blocked")
                return resultToPrepareSend(result.result);
            try {
                return {
                    status: "prepared",
                    prepared: submissionPreparedFromSendOnce(result.prepared, request.expected)
                };
            }
            catch {
                return blockedPrepareSend("port_protocol_violation");
            }
        }
        catch {
            return blockedPrepareSend(phaseBlocker(linked.controller.signal, request.deadlineAt));
        }
        finally {
            linked.cleanup();
        }
    };
    const executePreparedSend = async (request) => {
        const binding = bindingFor(bindings, request.operationId, request.expected.targetBindingDigest);
        if (binding === undefined)
            return blockedExecuteSend("target_binding_mismatch");
        const baseObservers = options.submission?.sendObservers;
        if (baseObservers === undefined)
            return blockedExecuteSend("target_evidence_unavailable");
        let prepared;
        try {
            prepared = normalizeSubmissionPreparedSend(request.prepared, request.expected, {
                operationId: request.operationId,
                requestDigest: request.requestDigest,
                surface: request.surface,
                actionId: request.actionId
            });
        }
        catch {
            return blockedExecuteSend("port_protocol_violation");
        }
        const linked = createLinkedAbortController(request.signal);
        const send = createPhaseSendObservers(binding, request.operationId, baseObservers, linked.controller, options.observeCurrentTarget, options.evidenceDigest, transactionTimeoutMs);
        try {
            const result = await executePreparedSendOnce({
                page,
                prepared: prepared.prepared,
                observers: send.observers,
                signal: linked.controller.signal,
                ...(request.deadlineAt === undefined ? {} : { deadlineAt: request.deadlineAt }),
                transaction: callback => runSendTransaction(binding, request.operationId, linked.controller, options.observeCurrentTarget, options.evidenceDigest, request.deadlineAt, transactionTimeoutMs, "operation-send-execute", "mutation", context => send.withContext(context, callback))
            });
            if (result.status === "blocked" || result.status === "uncertain")
                return result;
            return {
                status: result.status,
                activation: result.activation,
                mutationMayHaveOccurred: true
            };
        }
        catch {
            return {
                status: "uncertain",
                result: { status: "uncertain", quarantine: "caller" }
            };
        }
        finally {
            linked.cleanup();
        }
    };
    const verifyPreparedSend = async (request) => {
        const binding = bindingFor(bindings, request.operationId, request.expected.targetBindingDigest);
        if (binding === undefined)
            return { status: "blocked", blockerCode: "target_binding_mismatch" };
        const baseObservers = options.submission?.sendObservers;
        if (baseObservers === undefined)
            return { status: "uncertain", quarantine: "provider" };
        let prepared;
        try {
            prepared = normalizeSubmissionPreparedSend(request.prepared, request.expected, {
                operationId: request.operationId,
                requestDigest: request.requestDigest,
                surface: request.surface,
                actionId: request.actionId
            });
        }
        catch {
            return { status: "uncertain", quarantine: "caller" };
        }
        const linked = createLinkedAbortController(request.signal);
        const send = createPhaseSendObservers(binding, request.operationId, baseObservers, linked.controller, options.observeCurrentTarget, options.evidenceDigest, transactionTimeoutMs);
        try {
            const result = await verifyPreparedSendOnce({
                page,
                prepared: prepared.prepared,
                observers: send.observers,
                activation: request.activation,
                mutationMayHaveOccurred: request.mutationMayHaveOccurred,
                signal: linked.controller.signal,
                ...(request.deadlineAt === undefined ? {} : { deadlineAt: request.deadlineAt })
            });
            markEstablished(binding, result);
            return result;
        }
        catch {
            return { status: "uncertain", quarantine: "caller" };
        }
        finally {
            linked.cleanup();
        }
    };
    const recoverSend = async (request) => {
        let binding = bindingFor(bindings, request.operationId, request.expected.targetBindingDigest);
        if (binding === undefined && options.recovery !== undefined) {
            try {
                binding = await ensureRecovered(request.operationId, request.requestDigest, request.surface, request.signal ?? options.recovery.signal);
            }
            catch {
                return { status: "blocked", blockerCode: "target_binding_mismatch" };
            }
        }
        if (binding === undefined)
            return { status: "blocked", blockerCode: "target_binding_mismatch" };
        const baseObservers = options.submission?.sendObservers;
        if (baseObservers === undefined)
            return { status: "uncertain", quarantine: "provider" };
        const linked = createLinkedAbortController(request.signal);
        const send = createPhaseSendObservers(binding, request.operationId, baseObservers, linked.controller, options.observeCurrentTarget, options.evidenceDigest, transactionTimeoutMs);
        try {
            const result = await recoverSendOnce({
                page,
                operationId: request.operationId,
                requestDigest: request.requestDigest,
                surface: request.surface,
                actionId: request.actionId,
                expected: request.expected,
                durableBaseline: request.durableBaseline,
                observers: send.observers,
                signal: linked.controller.signal,
                ...(request.deadlineAt === undefined ? {} : { deadlineAt: request.deadlineAt })
            });
            markEstablished(binding, result);
            return result;
        }
        catch {
            return { status: "uncertain", quarantine: "caller" };
        }
        finally {
            linked.cleanup();
        }
    };
    const executeFinalTabTransaction = async (request) => {
        const binding = bindingFor(bindings, request.operationId, request.expected.targetBindingDigest);
        if (binding === undefined) {
            return { status: "blocked", blockerCode: "target_binding_mismatch" };
        }
        const baseObservers = options.submission?.sendObservers;
        if (baseObservers === undefined)
            return { status: "blocked", blockerCode: "target_evidence_unavailable" };
        // The precondition read is part of the short activation transaction. Each
        // postcondition probe, by contrast, reacquires the same tab actor for one
        // bounded read and releases it before SendOnce waits for the next probe.
        // The provider primitive is intentionally one-shot: it must not poll or
        // sleep while this callback owns the actor.
        const observers = {
            observePrecondition: baseObservers.observePrecondition,
            observePostcondition: async (postconditionRequest) => {
                const probe = await runReadTransaction(binding, request.operationId, context => baseObservers.observePostcondition({
                    ...postconditionRequest,
                    page: context.page,
                    // A probe is owned by this individual short read transaction, not
                    // by the earlier activation transaction. Provider code must see
                    // the current actor's cancellation/deadline so an in-flight read
                    // cannot outlive its coordinator quarantine unnoticed.
                    signal: context.acquisition.signal,
                    ...(context.acquisition.timing.deadlineAt === undefined
                        ? {}
                        : { deadlineAt: context.acquisition.timing.deadlineAt })
                }), options.observeCurrentTarget, options.evidenceDigest, boundedRequest(postconditionRequest.signal, postconditionRequest.deadlineAt, transactionTimeoutMs, "operation-send-postcondition"), true);
                // Provider observers are one-shot reads. A missing/temporarily
                // ambiguous delta is a retryable observation miss; no browser
                // mutation is ever retried here. Definitive blockers stay terminal.
                if (isPlainPostconditionResult(probe)
                    && probe.status === "blocked"
                    && (probe.blockerCode === "target_evidence_unavailable" || probe.blockerCode === "ambiguous_submit")) {
                    return { result: probe, retryable: true };
                }
                return probe;
            },
            ...(baseObservers.sleep === undefined ? {} : { sleep: baseObservers.sleep }),
            ...(baseObservers.maxPostconditionAttempts === undefined ? {} : { maxPostconditionAttempts: baseObservers.maxPostconditionAttempts }),
            ...(baseObservers.postconditionIntervalMs === undefined ? {} : { postconditionIntervalMs: baseObservers.postconditionIntervalMs }),
            ...(baseObservers.postconditionTimeoutMs === undefined ? {} : { postconditionTimeoutMs: baseObservers.postconditionTimeoutMs })
        };
        const operationController = new AbortController();
        const sourceAbortCleanup = [];
        if (request.signal !== undefined) {
            const abortFromCaller = () => operationController.abort(request.signal?.reason);
            if (request.signal.aborted)
                operationController.abort(request.signal.reason);
            else {
                request.signal.addEventListener("abort", abortFromCaller, { once: true });
                sourceAbortCleanup.push(() => request.signal?.removeEventListener("abort", abortFromCaller));
            }
        }
        try {
            const transaction = async (callback) => await binding.withTabTransaction(boundedRequest(request.signal, request.deadlineAt, transactionTimeoutMs, request.mode === "mutate_once" ? "operation-send" : "operation-send-observe", request.mode === "mutate_once" ? "mutation" : "read"), async (context) => {
                const abortFromCoordinator = () => operationController.abort(context.acquisition.signal.reason);
                if (context.acquisition.signal.aborted)
                    operationController.abort(context.acquisition.signal.reason);
                else
                    context.acquisition.signal.addEventListener("abort", abortFromCoordinator, { once: true });
                try {
                    const current = await readCurrentTarget(binding, request.operationId, context.page, options.observeCurrentTarget, options.evidenceDigest, context.acquisition.signal, context.acquisition.timing.deadlineAt);
                    binding.assertCurrent(current.evidence, current.authoritativeClaim);
                    return await callback();
                }
                finally {
                    context.acquisition.signal.removeEventListener("abort", abortFromCoordinator);
                }
            });
            const result = await runSendOnce({
                page,
                operationId: request.operationId,
                requestDigest: request.requestDigest,
                surface: request.surface,
                actionId: request.actionId,
                mode: request.mode,
                expected: request.expected,
                observers,
                signal: operationController.signal,
                ...(request.deadlineAt === undefined ? { deadlineAt: MAX_DEADLINE_AT } : { deadlineAt: request.deadlineAt }),
                ...(request.persistPreSendBaseline === undefined
                    ? {}
                    : { persistPreSendBaseline: request.persistPreSendBaseline }),
                ...(request.durableBaseline === undefined
                    ? {}
                    : { durableBaseline: request.durableBaseline }),
                transaction
            });
            if (binding.markTargetEstablished !== undefined
                && (result.status === "submitted" || result.status === "already_submitted")
                && result.targetEstablishment !== undefined) {
                binding.markTargetEstablished({
                    conversationId: result.targetEstablishment.conversationId,
                    canonicalThreadUrl: result.targetEstablishment.canonicalThreadUrl
                });
            }
            return result;
        }
        catch {
            return request.mode === "mutate_once"
                ? { status: "uncertain", quarantine: "provider" }
                : { status: "blocked", blockerCode: "target_evidence_unavailable" };
        }
        finally {
            for (const cleanup of sourceAbortCleanup)
                cleanup();
        }
    };
    const readContext = async (request) => {
        if (options.recovery !== undefined) {
            await ensureRecovered(request.operationId, request.requestDigest, options.recovery.surface, request.signal);
        }
        const binding = bindingFor(bindings, request.operationId, request.targetBindingDigest);
        if (binding === undefined)
            throw new OperationBrowserAdapterError("target_binding_mismatch");
        if (options.collector?.readContext === undefined) {
            throw new OperationBrowserAdapterError("unsupported_browser_primitive");
        }
        try {
            const context = await runReadTransaction(binding, request.operationId, transaction => options.collector.readContext(request, transaction.page, transaction.target), options.observeCurrentTarget, options.evidenceDigest, {
                signal: request.signal,
                timeoutMs: transactionTimeoutMs,
                label: "operation-collect-context"
            });
            collectorContexts.set(request.operationId, context);
            return context;
        }
        catch {
            throw new OperationBrowserAdapterError("target_evidence_unavailable");
        }
    };
    const observe = async (request) => {
        if (options.recovery !== undefined) {
            await ensureRecovered(request.operationId, request.requestDigest, options.recovery.surface, request.signal);
        }
        const binding = bindingFor(bindings, request.operationId, request.targetBindingDigest);
        const context = collectorContexts.get(request.operationId);
        if (binding === undefined || context === undefined)
            throw new OperationBrowserAdapterError("target_binding_mismatch");
        try {
            return await binding.withTabTransaction(boundedRequest(request.signal, request.deadlineAt, transactionTimeoutMs, "operation-collect-observe"), async (transaction) => {
                const current = await readCurrentTarget(binding, request.operationId, transaction.page, options.observeCurrentTarget, options.evidenceDigest, transaction.acquisition.signal, transaction.acquisition.timing.deadlineAt);
                binding.assertCurrent(current.evidence, current.authoritativeClaim);
                const observation = options.collector?.observe === undefined
                    ? await defaultCollectorObservation(request, transaction, context, options.evidenceDigest, current.authoritativeClaim)
                    : await options.collector.observe(request, transaction.page, transaction.target, context);
                // The observation itself carries the exact target. Do not use a
                // page-wide latest turn or a prompt similarity fallback.
                binding.assertCurrent(observation.snapshot.target, current.authoritativeClaim);
                return observation;
            });
        }
        catch {
            throw new OperationBrowserAdapterError("target_evidence_unavailable");
        }
    };
    const sleep = async (milliseconds, signal) => {
        if (options.collector?.sleep !== undefined)
            return await options.collector.sleep(milliseconds, signal);
        await sleepOutsideCoordinator(milliseconds, signal);
    };
    const observeTurn = async (request) => {
        if (options.recovery !== undefined) {
            await ensureRecovered(request.operationId, request.parentRequestDigest, options.recovery.surface, request.signal);
        }
        const binding = bindingFor(bindings, request.operationId, request.targetBindingDigest);
        if (binding === undefined)
            return { status: "uncertain", reason: "target_mismatch" };
        if (options.control?.observeTurn === undefined)
            return { status: "uncertain", reason: "unavailable" };
        try {
            return await runReadTransaction(binding, request.operationId, transaction => options.control.observeTurn(request, transaction.page, transaction.target), options.observeCurrentTarget, options.evidenceDigest, boundedRequest(request.signal, request.deadlineAt, transactionTimeoutMs, "operation-control-observe"));
        }
        catch {
            return { status: "uncertain", reason: "unavailable" };
        }
    };
    const executeControlOnce = async (request) => {
        if (options.recovery !== undefined) {
            await ensureRecovered(request.operationId, request.parentRequestDigest, options.recovery.surface, request.signal);
        }
        const binding = bindingFor(bindings, request.operationId, request.targetBindingDigest);
        if (binding === undefined)
            return { status: "uncertain", blockerCode: "target_binding_mismatch" };
        if (options.control?.executeOnce === undefined)
            return { status: "uncertain", blockerCode: "send_control_unavailable" };
        try {
            return await binding.withTabTransaction(boundedRequest(request.signal, request.deadlineAt, transactionTimeoutMs, `operation-${request.action}`, "control"), async (transaction) => await (async () => {
                const current = await readCurrentTarget(binding, request.operationId, transaction.page, options.observeCurrentTarget, options.evidenceDigest, transaction.acquisition.signal, transaction.acquisition.timing.deadlineAt);
                binding.assertCurrent(current.evidence, current.authoritativeClaim);
                return await options.control.executeOnce(request, transaction.page, transaction.target);
            })());
        }
        catch {
            return { status: "uncertain", blockerCode: "send_control_unavailable" };
        }
    };
    const observePostcondition = async (request) => {
        if (options.recovery !== undefined) {
            await ensureRecovered(request.operationId, request.parentRequestDigest, options.recovery.surface, request.signal);
        }
        const binding = bindingFor(bindings, request.operationId, request.targetBindingDigest);
        if (binding === undefined)
            return { status: "uncertain", blockerCode: "target_binding_mismatch" };
        if (options.control?.observePostcondition === undefined)
            return { status: "uncertain", blockerCode: "send_control_unavailable" };
        try {
            return await runReadTransaction(binding, request.operationId, transaction => options.control.observePostcondition(request, transaction.page, transaction.target), options.observeCurrentTarget, options.evidenceDigest, boundedRequest(request.signal, request.deadlineAt, transactionTimeoutMs, "operation-control-postcondition"));
        }
        catch {
            return { status: "uncertain", blockerCode: "send_control_unavailable" };
        }
    };
    const getSteerBinding = async (operationId, requestDigest, signal) => await steerBindingFor(bindings, ensureRecovered, options.recovery, operationId, requestDigest, signal);
    /**
     * Work steer is deliberately separate from Stop's compatibility port.  A
     * preparation is one short read transaction and returns only the provider's
     * prompt-free prepared capability.  The caller persists that capability and
     * its baseline before it can invoke executeSteerPrepared.
     */
    const prepareSteer = async (request) => {
        const binding = await getSteerBinding(request.parentOperationId, request.parentRequestDigest, request.signal);
        if (binding === undefined)
            return blockedSteerPhase(request, "prepare", "target_binding_mismatch", false, "none");
        const provider = options.control?.prepareSteer;
        if (provider === undefined)
            return blockedSteerPhase(request, "prepare", "backend_unavailable", true, "none");
        try {
            const result = await runReadTransaction(binding, request.parentOperationId, context => provider({
                schemaVersion: request.schemaVersion,
                parentOperationId: request.parentOperationId,
                parentRequestDigest: request.parentRequestDigest,
                parentTargetBindingDigest: request.parentTargetBindingDigest,
                controlActionId: request.controlActionId,
                requestDigest: request.requestDigest,
                expectedAssistantTurnId: request.expectedAssistantTurnId,
                signal: context.acquisition.signal,
                deadlineAt: context.acquisition.timing.deadlineAt ?? request.deadlineAt
            }, context.page, context.target), options.observeCurrentTarget, options.evidenceDigest, boundedRequest(request.signal, request.deadlineAt, transactionTimeoutMs, "operation-control-steer-prepare"));
            return normalizeSteerProviderResult(result, request, "prepare");
        }
        catch (error) {
            return blockedSteerPhase(request, "prepare", phaseFailureCode(request.signal, request.deadlineAt, error), true, "none");
        }
    };
    /**
     * Execute is the only Work-steer mutation site.  `runSteerControlTransaction`
     * keeps the callback promise alive until provider settlement even when the
     * coordinator has already rejected the public transaction at its deadline.
     * That quarantine is what prevents a late fill/click from overlapping a
     * subsequent operation on the shared page.
     */
    const executeSteerPrepared = async (request) => {
        const operationId = request.prepared.parentOperationId;
        const binding = await getSteerBinding(operationId, request.prepared.parentRequestDigest, request.signal);
        if (binding === undefined)
            return blockedSteerPhase(request, "execute_prepared", "target_binding_mismatch", false, "none");
        const provider = options.control?.executeSteerPrepared;
        if (provider === undefined)
            return blockedSteerPhase(request, "execute_prepared", "backend_unavailable", false, "none", request.prepared);
        try {
            const result = await runSteerControlTransaction(binding, operationId, request.signal, request.deadlineAt, transactionTimeoutMs, options.observeCurrentTarget, options.evidenceDigest, context => provider({
                schemaVersion: request.schemaVersion,
                prepared: request.prepared,
                signal: context.acquisition.signal,
                deadlineAt: context.acquisition.timing.deadlineAt ?? request.deadlineAt
            }, context.page, context.target));
            return normalizeSteerProviderResult(result, request, "execute_prepared", request.prepared);
        }
        catch (error) {
            return uncertainSteerPhase(request, "execute_prepared", request.prepared, phaseFailureCode(request.signal, request.deadlineAt, error), "provider");
        }
    };
    /** Verification is a bounded read and releases the tab actor before any
     * caller-level retry or persistence work. */
    const verifySteer = async (request) => {
        const operationId = request.prepared.parentOperationId;
        const binding = await getSteerBinding(operationId, request.prepared.parentRequestDigest, request.signal);
        if (binding === undefined)
            return uncertainSteerPhase(request, "verify", request.prepared, "target_binding_mismatch", "caller");
        const provider = options.control?.verifySteer;
        if (provider === undefined)
            return uncertainSteerPhase(request, "verify", request.prepared, "backend_unavailable", "provider");
        try {
            const result = await runReadTransaction(binding, operationId, context => provider({
                schemaVersion: request.schemaVersion,
                prepared: request.prepared,
                signal: context.acquisition.signal,
                deadlineAt: context.acquisition.timing.deadlineAt ?? request.deadlineAt
            }, context.page, context.target), options.observeCurrentTarget, options.evidenceDigest, boundedRequest(request.signal, request.deadlineAt, transactionTimeoutMs, "operation-control-steer-verify"));
            return normalizeSteerProviderResult(result, request, "verify", request.prepared);
        }
        catch (error) {
            return uncertainSteerPhase(request, "verify", request.prepared, phaseFailureCode(request.signal, request.deadlineAt, error), "caller");
        }
    };
    /**
     * Recovery is observation-only.  It may hydrate a durable target binding,
     * but it never calls prepare, execute, composer fill, or Send/click.
     */
    const recoverSteer = async (request) => {
        const operationId = request.prepared.parentOperationId;
        const binding = await getSteerBinding(operationId, request.prepared.parentRequestDigest, request.signal);
        if (binding === undefined)
            return uncertainSteerPhase(request, "recovery", request.prepared, "target_binding_mismatch", "caller");
        const provider = options.control?.recoverSteer;
        if (provider === undefined)
            return uncertainSteerPhase(request, "recovery", request.prepared, "backend_unavailable", "provider");
        try {
            const result = await runReadTransaction(binding, operationId, context => provider({
                schemaVersion: request.schemaVersion,
                prepared: request.prepared,
                baseline: request.baseline,
                signal: context.acquisition.signal,
                deadlineAt: context.acquisition.timing.deadlineAt ?? request.deadlineAt
            }, context.page, context.target), options.observeCurrentTarget, options.evidenceDigest, boundedRequest(request.signal, request.deadlineAt, transactionTimeoutMs, "operation-control-steer-recovery"));
            return normalizeSteerProviderResult(result, request, "recovery", request.prepared);
        }
        catch (error) {
            return uncertainSteerPhase(request, "recovery", request.prepared, phaseFailureCode(request.signal, request.deadlineAt, error), "caller");
        }
    };
    const submission = Object.freeze({
        observeStaging,
        executeFileHandoffOnce,
        observeAttachments,
        prepareSend,
        executePreparedSend,
        verifyPreparedSend,
        recoverSend,
        executeFinalTabTransaction
    });
    const collector = Object.freeze({ readContext, observe, sleep });
    const control = options.control === undefined
        ? undefined
        : Object.freeze({
            observeTurn,
            executeOnce: executeControlOnce,
            observePostcondition,
            postconditionRetry: CONTROL_POSTCONDITION_RETRY_POLICY,
            prepareSteer,
            executeSteerPrepared,
            verifySteer,
            recoverSteer
        });
    const staging = options.staging === undefined
        ? undefined
        : Object.freeze({
            readCurrent: async (callbackRequest) => {
                const binding = bindings.get(callbackRequest.operationId);
                if (binding === undefined)
                    return unavailableStagingObservation(callbackRequest);
                return await runReadTransaction(binding, callbackRequest.operationId, transaction => options.staging.readCurrent === undefined
                    ? unavailableStagingObservation(callbackRequest)
                    : options.staging.readCurrent({ ...callbackRequest, page: transaction.page, target: transaction.target }), options.observeCurrentTarget, options.evidenceDigest, boundedRequest(callbackRequest.signal, callbackRequest.deadlineAt, transactionTimeoutMs, "operation-staging-read"));
            },
            observe: async (callbackRequest) => {
                const binding = bindings.get(callbackRequest.operationId);
                if (binding === undefined)
                    return unavailableStagingObservation(callbackRequest);
                return await runReadTransaction(binding, callbackRequest.operationId, transaction => options.staging.observe === undefined
                    ? unavailableStagingObservation(callbackRequest)
                    : options.staging.observe({ ...callbackRequest, page: transaction.page, target: transaction.target }), options.observeCurrentTarget, options.evidenceDigest, boundedRequest(callbackRequest.signal, callbackRequest.deadlineAt, transactionTimeoutMs, "operation-staging-observe"));
            },
            mutateOnce: async (callbackRequest) => {
                const binding = bindings.get(callbackRequest.operationId);
                if (binding === undefined)
                    throw new OperationBrowserAdapterError("target_binding_mismatch");
                return await runMutationTransaction(binding, callbackRequest.operationId, transaction => options.staging.mutateOnce === undefined
                    ? Promise.reject(new OperationBrowserAdapterError("unsupported_browser_primitive"))
                    : options.staging.mutateOnce({ ...callbackRequest, page: transaction.page, target: transaction.target }), options.observeCurrentTarget, options.evidenceDigest, boundedRequest(callbackRequest.signal, callbackRequest.deadlineAt, transactionTimeoutMs, "operation-staging-mutate", "mutation"));
            }
        });
    const artifacts = options.artifacts === undefined || options.outputDirectory === undefined
        ? undefined
        : Object.freeze({
            transfer: async (request) => {
                const binding = bindingFor(bindings, request.operationId, request.targetBindingDigest);
                if (binding === undefined) {
                    throw new OperationBrowserAdapterError("target_binding_mismatch");
                }
                // `acquireDownload` is the only browser phase. Its promise is fully
                // settled before this callback invokes `materializeDownload`, so a
                // large stream or filesystem commit never owns the tab actor.
                return await transferOperationArtifact({
                    operationId: request.operationId,
                    requestDigest: request.requestDigest,
                    targetBindingDigest: request.targetBindingDigest,
                    assistantTurnId: request.assistantTurnId,
                    sourceIdentityDigest: request.sourceIdentityDigest,
                    kind: request.kind,
                    ordinal: request.ordinal,
                    transferActionId: request.transferActionId,
                    outputDirectory: options.outputDirectory,
                    evidenceDigest: options.evidenceDigest,
                    signal: request.signal,
                    deadlineAt: request.deadlineAt,
                    ...(request.mimeTypeHint === undefined ? {} : { mimeTypeHint: request.mimeTypeHint }),
                    openSource: async (sourceRequest) => {
                        const download = await runMutationTransaction(binding, request.operationId, context => options.artifacts.acquireDownload({
                            ...sourceRequest,
                            signal: request.signal,
                            deadlineAt: request.deadlineAt
                        }, context.page, context.target), options.observeCurrentTarget, options.evidenceDigest, boundedRequest(request.signal, request.deadlineAt, transactionTimeoutMs, "operation-artifact-acquire", "mutation"));
                        // The transaction above has released the actor. This local
                        // phase must never call into the page or browser bridge.
                        return await options.artifacts.materializeDownload(download);
                    },
                    journal: request.journal
                });
            }
        });
    const adapter = Object.freeze({
        resolveTarget,
        submission,
        collector,
        ...(artifacts === undefined ? {} : { artifacts }),
        ...(staging === undefined ? {} : { staging }),
        ...(control === undefined ? {} : { control }),
    });
    return adapter;
}
function normalizeAdapterOptions(value) {
    if (!isPlainDataRecord(value))
        throw new OperationBrowserAdapterError("adapter_incomplete");
    try {
        const page = readOwnData(value, "page");
        const runtimeContext = readOwnData(value, "runtimeContext");
        const owner = readOwnData(value, "owner");
        const coordinator = readOwnData(value, "coordinator");
        const evidenceDigest = readOwnData(value, "evidenceDigest");
        const targetEvidence = readOwnData(value, "targetEvidence");
        const newTargetAnchorDigest = readOwnData(value, "newTargetAnchorDigest");
        const blankTaskEvidenceDigest = readOwnData(value, "blankTaskEvidenceDigest");
        const resolveTargetEvidence = readOwnData(value, "resolveTargetEvidence");
        const observeCurrentTarget = readOwnData(value, "observeCurrentTarget");
        const capabilities = readOwnData(value, "capabilities");
        const authoritativeClaim = readOwnData(value, "authoritativeClaim");
        const transactionTimeoutMs = readOwnData(value, "transactionTimeoutMs");
        const files = readOwnData(value, "files");
        const fileManifestDigest = readOwnData(value, "fileManifestDigest");
        const submission = readOwnData(value, "submission");
        const staging = readOwnData(value, "staging");
        const collector = readOwnData(value, "collector");
        const control = readOwnData(value, "control");
        const artifacts = readOwnData(value, "artifacts");
        const outputDirectory = readOwnData(value, "outputDirectory");
        const recovery = readOwnData(value, "recovery");
        const normalizedRecovery = recovery === undefined
            ? undefined
            : (() => {
                validateRecoveryContext(recovery);
                return normalizeRecoveryContext(recovery);
            })();
        const snapshot = {
            page,
            runtimeContext,
            owner: cloneFrozenData(owner),
            coordinator,
            evidenceDigest,
            targetEvidence: targetEvidence === undefined ? undefined : cloneFrozenData(targetEvidence),
            newTargetAnchorDigest,
            blankTaskEvidenceDigest,
            resolveTargetEvidence,
            observeCurrentTarget,
            capabilities: capabilities === undefined ? undefined : cloneFrozenData(capabilities),
            authoritativeClaim: authoritativeClaim === undefined ? undefined : cloneFrozenData(authoritativeClaim),
            transactionTimeoutMs,
            files: files === undefined ? undefined : cloneFrozenData(files),
            fileManifestDigest,
            submission: submission === undefined ? undefined : cloneFrozenProviderValue(submission),
            staging: staging === undefined ? undefined : cloneFrozenProviderValue(staging),
            collector: collector === undefined ? undefined : cloneFrozenProviderValue(collector),
            control: control === undefined ? undefined : cloneFrozenProviderValue(control),
            artifacts: artifacts === undefined ? undefined : cloneFrozenProviderValue(artifacts),
            outputDirectory,
            recovery: normalizedRecovery
        };
        const normalized = Object.freeze(snapshot);
        validateOptions(normalized);
        return normalized;
    }
    catch (error) {
        if (error instanceof OperationBrowserAdapterError)
            throw error;
        throw new OperationBrowserAdapterError("adapter_incomplete");
    }
}
function validateOptions(options) {
    if (!isPlainDataRecord(options) || options.page === null || typeof options.page !== "object") {
        throw new OperationBrowserAdapterError("adapter_incomplete");
    }
    if (typeof options.evidenceDigest !== "function")
        throw new OperationBrowserAdapterError("adapter_incomplete");
    if (!options.owner || typeof options.owner.backendSessionId !== "string")
        throw new OperationBrowserAdapterError("adapter_incomplete");
    if (options.runtimeContext !== undefined && !(options.runtimeContext instanceof OperationRuntimeContext)) {
        throw new OperationBrowserAdapterError("adapter_incomplete");
    }
    if (options.recovery !== undefined) {
        validateRecoveryContext(options.recovery);
        if (options.observeCurrentTarget === undefined) {
            throw new OperationBrowserAdapterError("target_evidence_unavailable");
        }
    }
    else if (options.targetEvidence === undefined && options.resolveTargetEvidence === undefined) {
        throw new OperationBrowserAdapterError("target_evidence_unavailable");
    }
    if (options.files !== undefined && !Array.isArray(options.files))
        throw new OperationBrowserAdapterError("adapter_incomplete");
    if (options.recovery !== undefined
        && (options.artifacts !== undefined || options.outputDirectory !== undefined)) {
        throw new OperationBrowserAdapterError("adapter_incomplete");
    }
    if (options.artifacts !== undefined) {
        if (!isPlainDataRecord(options.artifacts)
            || typeof readOwnData(options.artifacts, "acquireDownload") !== "function"
            || typeof readOwnData(options.artifacts, "materializeDownload") !== "function") {
            throw new OperationBrowserAdapterError("adapter_incomplete");
        }
    }
    if (options.outputDirectory !== undefined
        && (typeof options.outputDirectory !== "string"
            || options.outputDirectory.length === 0
            || options.outputDirectory.length > 4096
            || !isAbsolutePath(options.outputDirectory)
            || /[\u0000-\u001f\u007f]/u.test(options.outputDirectory))) {
        throw new OperationBrowserAdapterError("adapter_incomplete");
    }
    if (options.transactionTimeoutMs !== undefined
        && (!Number.isSafeInteger(options.transactionTimeoutMs) || options.transactionTimeoutMs < 1 || options.transactionTimeoutMs > MAX_TRANSACTION_TIMEOUT_MS)) {
        throw new OperationBrowserAdapterError("adapter_incomplete");
    }
}
function validateRecoveryContext(value) {
    if (!isPlainDataRecord(value))
        throw new OperationBrowserAdapterError("adapter_incomplete");
    if (readOwnData(value, "operationId") === undefined
        || readOwnData(value, "requestDigest") === undefined
        || readOwnData(value, "surface") === undefined
        || readOwnData(value, "target") === undefined
        || readOwnData(value, "signal") === undefined) {
        throw new OperationBrowserAdapterError("adapter_incomplete");
    }
    const operationId = readOwnData(value, "operationId");
    const requestDigest = readOwnData(value, "requestDigest");
    const surface = readOwnData(value, "surface");
    const target = readOwnData(value, "target");
    const signal = readOwnData(value, "signal");
    if (typeof operationId !== "string"
        || !OPAQUE_ID_PATTERN.test(operationId)
        || typeof requestDigest !== "string"
        || !DIGEST_PATTERN.test(requestDigest)
        || (surface !== "chat" && surface !== "work")
        || target === null
        || typeof target !== "object"
        || Array.isArray(target)) {
        throw new OperationBrowserAdapterError("adapter_incomplete");
    }
    assertNativeAbortSignal(signal);
    if (!isSafeDataGraph(target) || !isPlainDataRecord(target)) {
        throw new OperationBrowserAdapterError("adapter_incomplete");
    }
    const lifecycle = readOwnData(target, "targetLifecycle");
    if (lifecycle === "new_pending") {
        throw new OperationBrowserAdapterError("target_binding_mismatch");
    }
    if (lifecycle !== undefined && lifecycle !== "fixed" && lifecycle !== "new_established") {
        throw new OperationBrowserAdapterError("adapter_incomplete");
    }
    const providerId = readOwnData(target, "providerId");
    const browserId = readOwnData(target, "browserId");
    const tabId = readOwnData(target, "tabId");
    const coordinationScope = readOwnData(target, "coordinationScope");
    const evidenceProfile = readOwnData(target, "evidenceProfile");
    if (typeof providerId !== "string"
        || !OPAQUE_ID_PATTERN.test(providerId)
        || typeof browserId !== "string"
        || !OPAQUE_ID_PATTERN.test(browserId)
        || typeof tabId !== "string"
        || !OPAQUE_ID_PATTERN.test(tabId)
        || (coordinationScope !== "process" && coordinationScope !== "provider")
        || !isPlainDataRecord(evidenceProfile)) {
        throw new OperationBrowserAdapterError("adapter_incomplete");
    }
    const conversationId = readOwnData(target, "conversationId");
    const canonicalThreadUrl = readOwnData(target, "canonicalThreadUrl");
    if (typeof conversationId !== "string"
        || !OPAQUE_ID_PATTERN.test(conversationId)
        || typeof canonicalThreadUrl !== "string"
        || !OPAQUE_THREAD_URL_PATTERN.test(canonicalThreadUrl)) {
        throw new OperationBrowserAdapterError("adapter_incomplete");
    }
    if (lifecycle === "new_established" && !isPlainDataRecord(readOwnData(target, "targetEstablishment"))) {
        throw new OperationBrowserAdapterError("adapter_incomplete");
    }
    const claimDigest = readOwnData(target, "tabClaimEvidenceDigest");
    if (claimDigest !== undefined && (typeof claimDigest !== "string" || !DIGEST_PATTERN.test(claimDigest))) {
        throw new OperationBrowserAdapterError("adapter_incomplete");
    }
}
function normalizeRecoveryContext(value) {
    try {
        const record = value;
        const operationId = readOwnData(record, "operationId");
        const requestDigest = readOwnData(record, "requestDigest");
        const surface = readOwnData(record, "surface");
        const targetValue = readOwnData(record, "target");
        const signal = readOwnData(record, "signal");
        if (targetValue === undefined || signal === undefined)
            throw new Error("incomplete recovery context");
        const target = cloneFrozenData(targetValue);
        return Object.freeze({
            operationId: operationId,
            requestDigest: requestDigest,
            surface: surface,
            target,
            signal: signal
        });
    }
    catch {
        throw new OperationBrowserAdapterError("adapter_incomplete");
    }
}
async function hydrateRecoveredTarget(options, recovery, page, coordinator) {
    const observeCurrentTarget = options.observeCurrentTarget;
    if (observeCurrentTarget === undefined) {
        throw new OperationBrowserAdapterError("target_evidence_unavailable");
    }
    assertNativeAbortSignal(recovery.signal);
    let observed;
    try {
        observed = normalizeCurrentTargetResult(await observeCurrentTarget({
            page,
            operationId: recovery.operationId,
            target: recovery.target,
            signal: recovery.signal
        }));
    }
    catch (error) {
        if (error instanceof OperationBrowserAdapterError)
            throw error;
        throw new OperationBrowserAdapterError("target_evidence_unavailable");
    }
    assertRecoveredTargetIdentity(recovery.target, observed, options);
    const lifecycle = recovery.target.targetLifecycle ?? "fixed";
    let bound;
    try {
        bound = bindBrowserTarget({
            page,
            evidence: observed.evidence,
            ...(lifecycle === "new_established" ? { targetLifecycle: "new_established" } : {}),
            ...(recovery.target.coordinationScope !== "provider" || observed.authoritativeClaim === undefined
                ? {}
                : { authoritativeClaim: observed.authoritativeClaim }),
            ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
            evidenceDigest: options.evidenceDigest,
            owner: Object.freeze({ ...options.owner, operationId: recovery.operationId }),
            coordinator,
            ...(recovery.target.userTurnBaselineDigest === undefined ? {} : { userTurnBaselineDigest: recovery.target.userTurnBaselineDigest }),
            ...(recovery.target.assistantTurnBaselineDigest === undefined ? {} : { assistantTurnBaselineDigest: recovery.target.assistantTurnBaselineDigest }),
            ...(recovery.target.configurationReceiptDigest === undefined ? {} : { configurationReceiptDigest: recovery.target.configurationReceiptDigest })
        });
    }
    catch (error) {
        if (error instanceof OperationBrowserAdapterError)
            throw error;
        throw new OperationBrowserAdapterError("target_binding_mismatch");
    }
    return preserveRecoveredTarget(bound, recovery.target);
}
function assertRecoveredTargetIdentity(target, observed, options) {
    const evidence = observed.evidence;
    compareRecoveredIdentity(evidence.provider, target.providerId);
    compareRecoveredIdentity(evidence.browser, target.browserId);
    compareRecoveredIdentity(evidence.tab, target.tabId);
    compareRecoveredIdentity(evidence.conversation, target.conversationId);
    compareRecoveredIdentity(evidence.canonicalThreadUrl, target.canonicalThreadUrl);
    if (target.coordinationScope !== "provider")
        return;
    const claim = observed.authoritativeClaim;
    if (claim === undefined
        || target.tabClaimEvidenceDigest === undefined
        || options.capabilities?.stableProviderId !== true
        || options.capabilities.stableBrowserId !== true
        || options.capabilities.stableTabId !== true
        || options.capabilities.concurrentTabs !== true
        || options.capabilities.authoritativeTabClaim !== true) {
        throw new OperationBrowserAdapterError("target_binding_mismatch");
    }
    let claimDigest;
    try {
        claimDigest = options.evidenceDigest(CLAIM_EVIDENCE_DIGEST_DOMAIN, {
            token: claim.token,
            epoch: claim.epoch
        });
    }
    catch {
        throw new OperationBrowserAdapterError("target_binding_mismatch");
    }
    if (claimDigest !== target.tabClaimEvidenceDigest) {
        throw new OperationBrowserAdapterError("target_binding_mismatch");
    }
}
function compareRecoveredIdentity(observed, expected) {
    if (expected === undefined || observed.status !== "available" || observed.value !== expected) {
        throw new OperationBrowserAdapterError("target_binding_mismatch");
    }
}
function preserveRecoveredTarget(binding, target) {
    const assertCurrent = (evidence, claim, allowNewTargetEstablishment = false) => {
        binding.assertCurrent(evidence, claim, allowNewTargetEstablishment);
        compareRecoveredIdentity(evidence.provider, target.providerId);
        compareRecoveredIdentity(evidence.browser, target.browserId);
        compareRecoveredIdentity(evidence.tab, target.tabId);
        compareRecoveredIdentity(evidence.conversation, target.conversationId);
        compareRecoveredIdentity(evidence.canonicalThreadUrl, target.canonicalThreadUrl);
    };
    return Object.freeze({
        page: binding.page,
        target,
        targetEvidenceDigest: binding.targetEvidenceDigest,
        evidence: binding.evidence,
        capabilities: binding.capabilities,
        resource: binding.resource,
        owner: binding.owner,
        assertPage: binding.assertPage,
        assertCurrent,
        withTabTransaction: (transactionOptions, callback) => binding.withTabTransaction(transactionOptions, context => callback(Object.freeze({
            ...context,
            target,
            assertCurrent
        })))
    });
}
function cloneFrozenData(value, seen = new Set()) {
    if (value === null || typeof value !== "object") {
        if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
            throw new Error("unsupported recovery value");
        }
        return value;
    }
    if (seen.has(value))
        throw new Error("cyclic recovery value");
    seen.add(value);
    try {
        if (Array.isArray(value)) {
            const result = value.map(item => cloneFrozenData(item, seen));
            seen.delete(value);
            return Object.freeze(result);
        }
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null)
            throw new Error("non-plain recovery value");
        const descriptors = Object.getOwnPropertyDescriptors(value);
        // Use a null-prototype destination and explicit definitions so an own
        // `__proto__` data key cannot invoke the legacy setter and disappear.
        const result = Object.create(null);
        for (const key of Object.keys(descriptors)) {
            const descriptor = descriptors[key];
            if (descriptor === undefined || !("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined) {
                throw new Error("accessor recovery value");
            }
            Object.defineProperty(result, key, {
                value: cloneFrozenData(descriptor.value, seen),
                enumerable: descriptor.enumerable ?? false,
                writable: true,
                configurable: true
            });
        }
        seen.delete(value);
        return Object.freeze(result);
    }
    catch (error) {
        seen.delete(value);
        throw error;
    }
}
/** Clone provider primitive records without ever reading an accessor/get trap. */
function cloneFrozenProviderValue(value, seen = new Set()) {
    if (value === null || typeof value !== "object")
        return value;
    if (seen.has(value))
        throw new Error("cyclic provider value");
    seen.add(value);
    try {
        if (Array.isArray(value)) {
            const result = value.map(item => cloneFrozenProviderValue(item, seen));
            seen.delete(value);
            return Object.freeze(result);
        }
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null)
            throw new Error("non-plain provider value");
        const descriptors = Object.getOwnPropertyDescriptors(value);
        const result = Object.create(null);
        for (const key of Object.keys(descriptors)) {
            const descriptor = descriptors[key];
            if (descriptor === undefined || !("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined) {
                throw new Error("accessor provider value");
            }
            Object.defineProperty(result, key, {
                value: cloneFrozenProviderValue(descriptor.value, seen),
                enumerable: descriptor.enumerable ?? false,
                writable: true,
                configurable: true
            });
        }
        seen.delete(value);
        return Object.freeze(result);
    }
    catch (error) {
        seen.delete(value);
        throw error;
    }
}
function assertNativeAbortSignal(value) {
    if (value === null || typeof value !== "object" || typeof AbortSignal !== "function") {
        throw new OperationBrowserAdapterError("adapter_incomplete");
    }
    const getter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;
    if (getter === undefined)
        throw new OperationBrowserAdapterError("adapter_incomplete");
    try {
        if (typeof Reflect.apply(getter, value, []) !== "boolean")
            throw new Error("invalid signal");
    }
    catch {
        throw new OperationBrowserAdapterError("adapter_incomplete");
    }
}
async function resolveProbe(options, request) {
    if (options.resolveTargetEvidence !== undefined) {
        const value = await options.resolveTargetEvidence({
            page: options.page,
            operationId: request.operationId,
            requestDigest: request.requestDigest,
            surface: request.surface,
            target: request.target,
            signal: request.signal
        });
        return normalizeTargetProbe(value);
    }
    if (options.targetEvidence === undefined)
        throw new OperationBrowserAdapterError("target_evidence_unavailable");
    return normalizeTargetProbe(Object.freeze({
        page: options.page,
        evidence: options.targetEvidence,
        ...(options.newTargetAnchorDigest === undefined ? {} : { newTargetAnchorDigest: options.newTargetAnchorDigest }),
        ...(options.blankTaskEvidenceDigest === undefined ? {} : { blankTaskEvidenceDigest: options.blankTaskEvidenceDigest }),
        ...(options.authoritativeClaim === undefined ? {} : { authoritativeClaim: options.authoritativeClaim }),
        ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities })
    }));
}
/**
 * Read resolver output through own data descriptors only. Provider adapters
 * are an untrusted boundary: a getter or proxy trap must not run while the
 * operation is deciding whether the Send target is safe.
 */
function normalizeTargetProbe(value) {
    if (!isPlainDataRecord(value))
        throw new OperationBrowserAdapterError("target_evidence_unavailable");
    const page = readOwnData(value, "page");
    const evidence = readOwnData(value, "evidence");
    const targetLifecycle = readOwnData(value, "targetLifecycle");
    const newTargetAnchorDigest = readOwnData(value, "newTargetAnchorDigest");
    const blankTaskEvidenceDigest = readOwnData(value, "blankTaskEvidenceDigest");
    const authoritativeClaim = readOwnData(value, "authoritativeClaim");
    const capabilities = readOwnData(value, "capabilities");
    const allowed = new Set([
        "page",
        "evidence",
        "targetLifecycle",
        "newTargetAnchorDigest",
        "blankTaskEvidenceDigest",
        "authoritativeClaim",
        "capabilities"
    ]);
    try {
        for (const key of Object.keys(value))
            if (!allowed.has(key))
                throw new Error("unsupported probe field");
    }
    catch {
        throw new OperationBrowserAdapterError("target_evidence_unavailable");
    }
    if (evidence === undefined)
        throw new OperationBrowserAdapterError("target_evidence_unavailable");
    if (!isSafeDataGraph(evidence) || (authoritativeClaim !== undefined && !isSafeDataGraph(authoritativeClaim)) || (capabilities !== undefined && !isSafeDataGraph(capabilities))) {
        throw new OperationBrowserAdapterError("target_evidence_unavailable");
    }
    if (targetLifecycle !== undefined
        && targetLifecycle !== "fixed"
        && targetLifecycle !== "new_pending"
        && targetLifecycle !== "new_established") {
        throw new OperationBrowserAdapterError("target_evidence_unavailable");
    }
    return Object.freeze({
        ...(page === undefined ? {} : { page: page }),
        evidence: evidence,
        ...(targetLifecycle === undefined ? {} : { targetLifecycle }),
        ...(newTargetAnchorDigest === undefined ? {} : { newTargetAnchorDigest: newTargetAnchorDigest }),
        ...(blankTaskEvidenceDigest === undefined ? {} : { blankTaskEvidenceDigest: blankTaskEvidenceDigest }),
        ...(authoritativeClaim === undefined ? {} : { authoritativeClaim: authoritativeClaim }),
        ...(capabilities === undefined ? {} : { capabilities: capabilities })
    });
}
function isPlainDataRecord(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        return false;
    try {
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null)
            return false;
        for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
            if (!("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined)
                return false;
        }
        return true;
    }
    catch {
        return false;
    }
}
function readOwnData(value, key) {
    try {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor !== undefined && "value" in descriptor && descriptor.get === undefined && descriptor.set === undefined
            ? descriptor.value
            : undefined;
    }
    catch {
        return undefined;
    }
}
function isSafeDataGraph(value, seen = new Set(), depth = 0) {
    if (value === null || (typeof value !== "object" && typeof value !== "function"))
        return true;
    if (typeof value === "function")
        return true;
    if (depth > 16 || seen.has(value))
        return depth <= 16;
    seen.add(value);
    try {
        const prototype = Object.getPrototypeOf(value);
        if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null)
            return false;
        const descriptors = Object.getOwnPropertyDescriptors(value);
        if (Object.keys(descriptors).length > 1024)
            return false;
        for (const descriptor of Object.values(descriptors)) {
            if (!("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined)
                return false;
            if (!isSafeDataGraph(descriptor.value, seen, depth + 1))
                return false;
        }
        return true;
    }
    catch {
        return false;
    }
}
function assertProbePage(boundPage, probedPage) {
    if (probedPage !== undefined && probedPage !== boundPage)
        throw new OperationBrowserAdapterError("page_affinity_mismatch");
}
function assertRuntimeAffinity(runtimeCapture, page, probe) {
    const tabId = probe.evidence.tab.status === "available" ? probe.evidence.tab.value : undefined;
    const claim = probe.authoritativeClaim === undefined
        ? undefined
        : { status: "available", token: probe.authoritativeClaim.token, epoch: probe.authoritativeClaim.epoch };
    runtimeCapture.assertPageAffinity(page, {
        ...(tabId === undefined ? {} : { tabId }),
        ...(claim === undefined ? {} : { authoritativeClaim: claim })
    });
}
function assertStaticTarget(target, evidence, hasResolver) {
    if (hasResolver)
        return;
    switch (target.type) {
        case "selected_tab":
            return;
        case "tab_id":
            if (evidence.tab.status === "available" && evidence.tab.value === target.tabId)
                return;
            break;
        case "conversation_id":
            if (evidence.conversation.status === "available" && evidence.conversation.value === target.conversationId)
                return;
            break;
        case "new":
        case "url":
            break;
    }
    throw new OperationBrowserAdapterError("target_evidence_unavailable");
}
function bindingFor(bindings, operationId, _targetBindingDigest) {
    const binding = bindings.get(operationId);
    // The journal owner computes the durable target-binding digest after the
    // target-bound event is appended. `bindBrowserTarget` also emits a local
    // evidence digest, but those domains intentionally differ. Operation ID is
    // therefore the only safe adapter lookup key here; OperationService has
    // already authenticated the caller handle before reaching these ports.
    if (binding === undefined)
        return undefined;
    return binding;
}
function unavailableStage(reason) {
    return { status: "unavailable", reason };
}
function unavailableStagingObservation(request) {
    return {
        status: "unavailable",
        desiredStateDigest: request.desiredStateDigest,
        blockerCode: "target_evidence_unavailable"
    };
}
function matchFileManifest(identities, manifestDigest, manifest) {
    if (manifest.count === 0)
        return [];
    if (identities === undefined || identities.length !== manifest.count || manifestDigest === undefined)
        return undefined;
    const sorted = [...identities];
    for (let ordinal = 0; ordinal < manifest.count; ordinal += 1) {
        const identity = sorted[ordinal];
        const expected = manifest.identities[ordinal];
        if (identity === undefined || expected === undefined || expected.ordinal !== ordinal)
            return undefined;
        let digest;
        try {
            digest = manifestDigest(ordinal, identity.manifest);
        }
        catch {
            return undefined;
        }
        if (digest !== expected.identityDigest || !DIGEST_PATTERN.test(digest))
            return undefined;
    }
    return Object.freeze(sorted);
}
async function runReadTransaction(binding, operationId, callback, observeCurrentTarget, evidenceDigest, transactionOptions = { timeoutMs: DEFAULT_TRANSACTION_TIMEOUT_MS }, allowNewTargetEstablishment = false) {
    return await binding.withTabTransaction({ ...transactionOptions, priority: transactionOptions.priority ?? "read", label: transactionOptions.label ?? "operation-read" }, async (context) => {
        const current = await readCurrentTarget(binding, operationId, context.page, observeCurrentTarget, evidenceDigest, context.acquisition.signal, context.acquisition.timing.deadlineAt);
        binding.assertCurrent(current.evidence, current.authoritativeClaim, allowNewTargetEstablishment);
        return await callback(context);
    });
}
async function runMutationTransaction(binding, operationId, callback, observeCurrentTarget, evidenceDigest, transactionOptions = { timeoutMs: DEFAULT_TRANSACTION_TIMEOUT_MS }) {
    return await binding.withTabTransaction({ ...transactionOptions, priority: transactionOptions.priority ?? "mutation", label: transactionOptions.label ?? "operation-mutation" }, async (context) => {
        const current = await readCurrentTarget(binding, operationId, context.page, observeCurrentTarget, evidenceDigest, context.acquisition.signal, context.acquisition.timing.deadlineAt);
        binding.assertCurrent(current.evidence, current.authoritativeClaim);
        return await callback(context);
    });
}
/** Resolve one durable identity from either a fresh or prepared phase call. */
function steerPhaseIdentity(request) {
    if ("prepared" in request) {
        return {
            parentOperationId: request.prepared.parentOperationId,
            parentRequestDigest: request.prepared.parentRequestDigest,
            parentTargetBindingDigest: request.prepared.parentTargetBindingDigest,
            controlActionId: request.prepared.controlActionId,
            requestDigest: request.prepared.requestDigest,
            expectedAssistantTurnId: request.prepared.expectedAssistantTurnId
        };
    }
    return {
        parentOperationId: request.parentOperationId,
        parentRequestDigest: request.parentRequestDigest,
        parentTargetBindingDigest: request.parentTargetBindingDigest,
        controlActionId: request.controlActionId,
        requestDigest: request.requestDigest,
        expectedAssistantTurnId: request.expectedAssistantTurnId
    };
}
function steerPhaseBase(request, phase, prepared) {
    const identity = steerPhaseIdentity(request);
    const selected = prepared ?? ("prepared" in request ? request.prepared : undefined);
    return {
        schemaVersion: CONTROL_COORDINATOR_SCHEMA_VERSION,
        phase,
        parentOperationId: identity.parentOperationId,
        parentRequestDigest: identity.parentRequestDigest,
        parentTargetBindingDigest: identity.parentTargetBindingDigest,
        controlActionId: identity.controlActionId,
        action: "steer",
        requestDigest: identity.requestDigest,
        expectedAssistantTurnId: identity.expectedAssistantTurnId,
        ...(selected === undefined ? {} : {
            assistantBranchId: selected.assistantBranchId,
            assistantParentTurnId: selected.assistantParentTurnId,
            baselineSnapshotDigest: selected.baselineSnapshotDigest,
            preparedDigest: selected.preparedDigest
        })
    };
}
function blockedSteerPhase(request, phase, blockerCode, observationRequired, mutationBoundary, prepared, evidenceDigest) {
    return Object.freeze({
        ...steerPhaseBase(request, phase, prepared),
        status: "blocked",
        blockerCode,
        observationRequired,
        mutationBoundary,
        ...(evidenceDigest === undefined ? {} : { evidenceDigest })
    });
}
function uncertainSteerPhase(request, phase, prepared, blockerCode, quarantine, evidenceDigest) {
    return Object.freeze({
        ...steerPhaseBase(request, phase, prepared),
        status: "uncertain",
        blockerCode,
        observationRequired: true,
        mutationBoundary: "control_may_have_occurred",
        quarantine,
        ...(evidenceDigest === undefined ? {} : { evidenceDigest })
    });
}
/** Do not expose provider diagnostics or untrusted extra fields downstream. */
function normalizeSteerProviderResult(value, request, phase, prepared) {
    const clone = cloneFrozenData(value);
    if (!isPlainDataRecord(clone))
        throw new Error("invalid steer phase result");
    const expected = steerPhaseBase(request, phase, prepared);
    for (const [key, expectedValue] of Object.entries(expected)) {
        if (readOwnData(clone, key) !== expectedValue)
            throw new Error("steer phase identity mismatch");
    }
    const status = readOwnData(clone, "status");
    const observationRequired = readOwnData(clone, "observationRequired");
    const mutationBoundary = readOwnData(clone, "mutationBoundary");
    if (typeof observationRequired !== "boolean"
        || (mutationBoundary !== "none" && mutationBoundary !== "control_may_have_occurred")) {
        throw new Error("invalid steer phase boundary");
    }
    const evidenceDigest = readOwnData(clone, "evidenceDigest");
    if (evidenceDigest !== undefined && (typeof evidenceDigest !== "string" || !DIGEST_PATTERN.test(evidenceDigest))) {
        throw new Error("invalid steer evidence");
    }
    const blockerCode = readOwnData(clone, "blockerCode");
    if (blockerCode !== undefined && (typeof blockerCode !== "string" || !/^[a-z][a-z0-9_]{0,63}$/u.test(blockerCode))) {
        throw new Error("invalid steer blocker");
    }
    if (status === "prepared") {
        if (phase !== "prepare" || observationRequired !== false || mutationBoundary !== "none")
            throw new Error("invalid steer preparation");
        const preparedValue = readOwnData(clone, "prepared");
        if (!isPlainDataRecord(preparedValue))
            throw new Error("missing steer preparation");
        assertSteerPreparedIdentity(preparedValue, steerPhaseIdentity(request));
        return Object.freeze({
            ...expected,
            status: "prepared",
            observationRequired: false,
            mutationBoundary: "none",
            prepared: cloneFrozenData(preparedValue)
        });
    }
    if (status === "executed") {
        if (phase !== "execute_prepared" || prepared === undefined || observationRequired !== true || mutationBoundary !== "control_may_have_occurred") {
            throw new Error("invalid steer execution");
        }
        return Object.freeze({
            ...expected,
            status: "executed",
            observationRequired: true,
            mutationBoundary: "control_may_have_occurred"
        });
    }
    if (status === "satisfied") {
        if ((phase !== "verify" && phase !== "recovery") || prepared === undefined || observationRequired !== false || mutationBoundary !== "control_may_have_occurred") {
            throw new Error("invalid steer satisfaction");
        }
        const receipt = readOwnData(clone, "receipt");
        if (!isPlainDataRecord(receipt))
            throw new Error("missing steer receipt");
        assertSteerReceiptIdentity(receipt, prepared);
        return Object.freeze({
            ...expected,
            status: "satisfied",
            observationRequired: false,
            mutationBoundary: "control_may_have_occurred",
            receipt: cloneFrozenData(receipt)
        });
    }
    if (status === "blocked") {
        if (typeof blockerCode !== "string" || readOwnData(clone, "quarantine") !== undefined)
            throw new Error("invalid steer blocker result");
        if (phase === "prepare" && mutationBoundary !== "none")
            throw new Error("preparation crossed mutation boundary");
        return Object.freeze({
            ...expected,
            status: "blocked",
            blockerCode,
            observationRequired,
            mutationBoundary,
            ...(evidenceDigest === undefined ? {} : { evidenceDigest })
        });
    }
    if (status === "uncertain") {
        const quarantine = readOwnData(clone, "quarantine");
        if (typeof blockerCode !== "string"
            || observationRequired !== true
            || mutationBoundary !== "control_may_have_occurred"
            || (quarantine !== "caller" && quarantine !== "provider")
            || phase === "prepare") {
            throw new Error("invalid steer uncertainty");
        }
        return Object.freeze({
            ...expected,
            status: "uncertain",
            blockerCode,
            observationRequired: true,
            mutationBoundary: "control_may_have_occurred",
            quarantine,
            ...(evidenceDigest === undefined ? {} : { evidenceDigest })
        });
    }
    throw new Error("invalid steer phase status");
}
function assertSteerPreparedIdentity(value, expected) {
    if (readOwnData(value, "schemaVersion") !== CONTROL_COORDINATOR_SCHEMA_VERSION
        || readOwnData(value, "parentOperationId") !== expected.parentOperationId
        || readOwnData(value, "parentRequestDigest") !== expected.parentRequestDigest
        || readOwnData(value, "parentTargetBindingDigest") !== expected.parentTargetBindingDigest
        || readOwnData(value, "controlActionId") !== expected.controlActionId
        || readOwnData(value, "action") !== "steer"
        || readOwnData(value, "requestDigest") !== expected.requestDigest
        || readOwnData(value, "expectedAssistantTurnId") !== expected.expectedAssistantTurnId) {
        throw new Error("steer prepared identity mismatch");
    }
    for (const key of ["assistantBranchId", "assistantParentTurnId", "baselineSnapshotDigest", "preparedDigest"]) {
        const field = readOwnData(value, key);
        if (typeof field !== "string" || field.length === 0)
            throw new Error("steer prepared evidence is invalid");
    }
}
function assertSteerReceiptIdentity(value, prepared) {
    if (readOwnData(value, "schemaVersion") !== CONTROL_COORDINATOR_SCHEMA_VERSION
        || readOwnData(value, "baselineSnapshotDigest") !== prepared.baselineSnapshotDigest
        || readOwnData(value, "preparedDigest") !== prepared.preparedDigest
        || readOwnData(value, "assistantTurnId") !== prepared.expectedAssistantTurnId
        || readOwnData(value, "assistantBranchId") !== prepared.assistantBranchId
        || readOwnData(value, "assistantParentTurnId") !== prepared.assistantParentTurnId) {
        throw new Error("steer receipt identity mismatch");
    }
}
function phaseFailureCode(signal, deadlineAt, error) {
    if (signal.aborted)
        return "operation_cancelled";
    const code = error !== null && typeof error === "object" && "code" in error
        ? error.code
        : undefined;
    if (code === "deadline_exceeded")
        return "operation_timeout";
    if (code === "aborted")
        return "operation_cancelled";
    if (Date.now() >= deadlineAt)
        return "operation_timeout";
    if (code === "navigation_mismatch" || code === "claim_mismatch" || code === "page_mismatch" || code === "target_binding_mismatch") {
        return "target_binding_mismatch";
    }
    return "target_evidence_unavailable";
}
/**
 * Rehydrate a missing binding only through the durable recovery context. The
 * helper never selects a new page or target and never performs a mutation.
 */
async function steerBindingFor(bindings, ensureRecovered, recovery, operationId, requestDigest, signal) {
    const binding = bindingFor(bindings, operationId, undefined);
    if (binding !== undefined || recovery === undefined)
        return binding;
    try {
        await ensureRecovered(operationId, requestDigest, recovery.surface, signal);
    }
    catch {
        return undefined;
    }
    return bindingFor(bindings, operationId, undefined);
}
/**
 * Unlike a plain `withTabTransaction` call, retain and await the provider
 * callback when the coordinator rejects its public promise at a deadline.
 */
async function runSteerControlTransaction(binding, operationId, signal, deadlineAt, transactionTimeoutMs, observeCurrentTarget, evidenceDigest, callback) {
    let workPromise;
    const transaction = binding.withTabTransaction(boundedRequest(signal, deadlineAt, transactionTimeoutMs, "operation-control-steer-execute", "control"), async (context) => {
        workPromise = (async () => {
            const current = await readCurrentTarget(binding, operationId, context.page, observeCurrentTarget, evidenceDigest, context.acquisition.signal, context.acquisition.timing.deadlineAt);
            binding.assertCurrent(current.evidence, current.authoritativeClaim);
            return await callback(context);
        })();
        return await workPromise;
    });
    try {
        return await transaction;
    }
    catch (error) {
        if (workPromise !== undefined)
            await workPromise.catch(() => undefined);
        throw error;
    }
}
/** Link caller cancellation to a phase-local signal without retaining it. */
function createLinkedAbortController(source) {
    const controller = new AbortController();
    if (source === undefined)
        return { controller, cleanup: () => undefined };
    const onAbort = () => {
        if (!controller.signal.aborted)
            controller.abort(source.reason);
    };
    if (source.aborted)
        onAbort();
    else
        source.addEventListener("abort", onAbort, { once: true });
    return {
        controller,
        cleanup: () => source.removeEventListener("abort", onAbort)
    };
}
/**
 * Adapt one provider's one-shot Send observers to the four phase protocol.
 * Precondition reads use the phase's active actor; each postcondition probe
 * acquires a fresh read actor and releases it before SendOnce sleeps/polls.
 */
function createPhaseSendObservers(binding, operationId, baseObservers, controller, observeCurrentTarget, evidenceDigest, transactionTimeoutMs) {
    let activeContext;
    const observers = {
        observePrecondition: async (request) => {
            const context = activeContext;
            const signal = context?.acquisition.signal ?? controller.signal;
            return await baseObservers.observePrecondition({
                ...request,
                ...(context === undefined ? {} : { page: context.page }),
                signal,
                ...(context?.acquisition.timing.deadlineAt === undefined
                    ? {}
                    : { deadlineAt: context.acquisition.timing.deadlineAt })
            });
        },
        observePostcondition: async (request) => {
            const probe = await runSendTransaction(binding, operationId, controller, observeCurrentTarget, evidenceDigest, request.deadlineAt, transactionTimeoutMs, "operation-send-postcondition", "read", context => baseObservers.observePostcondition({
                ...request,
                page: context.page,
                signal: context.acquisition.signal,
                ...(context.acquisition.timing.deadlineAt === undefined
                    ? {}
                    : { deadlineAt: context.acquisition.timing.deadlineAt })
            }));
            if (isPlainPostconditionResult(probe)
                && probe.status === "blocked"
                && (probe.blockerCode === "target_evidence_unavailable" || probe.blockerCode === "ambiguous_submit")) {
                return { result: probe, retryable: true };
            }
            return probe;
        },
        ...(baseObservers.sleep === undefined ? {} : { sleep: baseObservers.sleep }),
        ...(baseObservers.maxPostconditionAttempts === undefined ? {} : { maxPostconditionAttempts: baseObservers.maxPostconditionAttempts }),
        ...(baseObservers.postconditionIntervalMs === undefined ? {} : { postconditionIntervalMs: baseObservers.postconditionIntervalMs }),
        ...(baseObservers.postconditionTimeoutMs === undefined ? {} : { postconditionTimeoutMs: baseObservers.postconditionTimeoutMs })
    };
    return {
        observers,
        withContext: async (context, callback) => {
            activeContext = context;
            try {
                return await callback();
            }
            finally {
                if (activeContext === context)
                    activeContext = undefined;
            }
        }
    };
}
/**
 * Run a single target revalidation plus provider callback in one coordinator
 * transaction. The coordinator may reject its public promise at a deadline
 * while its callback is still in flight; retain the callback promise and await
 * it before propagating that error so an activation can never be overlapped.
 */
async function runSendTransaction(binding, operationId, controller, observeCurrentTarget, evidenceDigest, requestedDeadlineAt, transactionTimeoutMs, label, priority, callback) {
    let workPromise;
    const transaction = binding.withTabTransaction(boundedRequest(controller.signal, requestedDeadlineAt, transactionTimeoutMs, label, priority), async (context) => {
        const abortFromCoordinator = () => {
            if (!controller.signal.aborted)
                controller.abort(context.acquisition.signal.reason);
        };
        if (context.acquisition.signal.aborted)
            abortFromCoordinator();
        else
            context.acquisition.signal.addEventListener("abort", abortFromCoordinator, { once: true });
        workPromise = (async () => {
            const current = await readCurrentTarget(binding, operationId, context.page, observeCurrentTarget, evidenceDigest, context.acquisition.signal, context.acquisition.timing.deadlineAt);
            binding.assertCurrent(current.evidence, current.authoritativeClaim);
            return await callback(context);
        })();
        try {
            return await workPromise;
        }
        finally {
            context.acquisition.signal.removeEventListener("abort", abortFromCoordinator);
        }
    });
    try {
        return await transaction;
    }
    catch (error) {
        // `workPromise` is set before target proof/provider work starts. Awaiting it
        // here preserves coordinator quarantine semantics without releasing an
        // actor while the browser call is still running.
        if (workPromise !== undefined)
            await workPromise.catch(() => undefined);
        throw error;
    }
}
function blockedPrepareSend(blockerCode) {
    return { status: "blocked", result: { status: "blocked", blockerCode } };
}
function resultToPrepareSend(result) {
    return { status: "blocked", result };
}
function blockedExecuteSend(blockerCode) {
    return { status: "blocked", result: { status: "blocked", blockerCode } };
}
function phaseBlocker(signal, deadlineAt) {
    if (signal.aborted)
        return "operation_cancelled";
    if (deadlineAt !== undefined && Date.now() >= deadlineAt)
        return "operation_timeout";
    return "port_protocol_violation";
}
function submissionPreparedFromSendOnce(prepared, expected) {
    const baseline = prepared.baseline.ownershipBaseline;
    if (baseline === undefined)
        throw new Error("missing durable Send baseline");
    return normalizeSubmissionPreparedSend({
        prepared: cloneFrozenData(prepared),
        baseline: cloneFrozenData(baseline),
        evidenceDigest: prepared.observation.evidenceDigest
    }, expected, {
        operationId: prepared.operationId,
        requestDigest: prepared.requestDigest,
        surface: prepared.surface,
        actionId: prepared.actionId
    });
}
function normalizeSubmissionPreparedSend(value, expected, identity) {
    const clone = cloneFrozenData(value);
    if (!isPlainDataRecord(clone))
        throw new Error("invalid opaque Send capability");
    assertExactDataKeys(clone, ["prepared", "baseline", "evidenceDigest"]);
    const prepared = readOwnData(clone, "prepared");
    const baseline = readOwnData(clone, "baseline");
    const evidence = readOwnData(clone, "evidenceDigest");
    if (!isPlainDataRecord(prepared) || !isPlainDataRecord(baseline) || typeof evidence !== "string" || !DIGEST_PATTERN.test(evidence)) {
        throw new Error("invalid opaque Send capability");
    }
    assertExactDataKeys(prepared, ["schemaVersion", "operationId", "requestDigest", "surface", "actionId", "expected", "observation", "baseline"]);
    if (readOwnData(prepared, "schemaVersion") !== "chatgpt.browser_control.send_once_prepared.v1"
        || readOwnData(prepared, "operationId") !== identity.operationId
        || readOwnData(prepared, "requestDigest") !== identity.requestDigest
        || readOwnData(prepared, "surface") !== identity.surface
        || readOwnData(prepared, "actionId") !== identity.actionId
        || canonicalJson(readOwnData(prepared, "expected")) !== canonicalJson(expected)) {
        throw new Error("opaque Send identity mismatch");
    }
    const preparedBaseline = readOwnData(prepared, "baseline");
    if (!isPlainDataRecord(preparedBaseline)) {
        throw new Error("missing opaque Send baseline");
    }
    const ownershipBaseline = readOwnData(preparedBaseline, "ownershipBaseline");
    if (!isPlainDataRecord(ownershipBaseline) || canonicalJson(ownershipBaseline) !== canonicalJson(baseline)) {
        throw new Error("opaque Send baseline mismatch");
    }
    const observation = readOwnData(prepared, "observation");
    if (!isPlainDataRecord(observation) || readOwnData(observation, "status") !== "exact" || readOwnData(observation, "evidenceDigest") !== evidence) {
        throw new Error("opaque Send observation mismatch");
    }
    return clone;
}
function assertExactDataKeys(value, keys) {
    const allowed = new Set(keys);
    for (const key of Object.keys(value)) {
        if (!allowed.has(key))
            throw new Error("unsupported opaque Send field");
    }
}
function markEstablished(binding, result) {
    if (binding.markTargetEstablished !== undefined
        && (result.status === "submitted" || result.status === "already_submitted")
        && result.targetEstablishment !== undefined) {
        binding.markTargetEstablished({
            conversationId: result.targetEstablishment.conversationId,
            canonicalThreadUrl: result.targetEstablishment.canonicalThreadUrl
        });
    }
}
async function readCurrentTarget(binding, operationId, page, observeCurrentTarget, evidenceDigest, signal = new AbortController().signal, deadlineAt) {
    if (observeCurrentTarget !== undefined) {
        const observed = await observeCurrentTarget({ page, operationId, target: binding.target, signal, ...(deadlineAt === undefined ? {} : { deadlineAt }) });
        return normalizeCurrentTargetResult(observed);
    }
    // The default read is a bounded, read-only browser observation. Provider
    // implementations can inject a narrower identity probe when their DOM
    // exposes stable target evidence without a complete turn snapshot.
    const target = binding.target;
    const boundThreadId = binding.evidence.thread.status === "available"
        ? binding.evidence.thread.value
        : undefined;
    const boundClaim = binding.evidence.authoritativeTabClaim.status === "available"
        ? binding.evidence.authoritativeTabClaim.value
        : undefined;
    const result = await observeBrowserPage(page, {
        operationId,
        target: {
            providerId: target.providerId,
            browserId: target.browserId,
            tabId: target.tabId,
            coordinationScope: target.coordinationScope,
            ...(boundClaim === undefined ? {} : { authoritativeTabClaim: boundClaim }),
            ...(target.targetLifecycle === undefined ? {} : { targetLifecycle: target.targetLifecycle }),
            ...(target.conversationId === undefined ? {} : { expectedConversationId: target.conversationId }),
            ...(boundThreadId === undefined ? {} : { expectedThreadId: boundThreadId })
        },
        // An injected digest is required for target evidence. Never manufacture a
        // placeholder digest: unavailable evidence must remain unavailable.
        evidenceDigest: evidenceDigest ?? (() => {
            throw new OperationBrowserAdapterError("target_evidence_unavailable");
        }),
        responseContent: "metadata"
    });
    return { evidence: result.snapshot.target };
}
function normalizeCurrentTargetResult(value) {
    if (!isPlainDataRecord(value))
        throw new OperationBrowserAdapterError("target_evidence_unavailable");
    const evidence = readOwnData(value, "evidence");
    if (evidence === undefined)
        throw new OperationBrowserAdapterError("target_evidence_unavailable");
    const authoritativeClaim = readOwnData(value, "authoritativeClaim");
    if (!isSafeDataGraph(evidence) || (authoritativeClaim !== undefined && !isSafeDataGraph(authoritativeClaim))) {
        throw new OperationBrowserAdapterError("target_evidence_unavailable");
    }
    try {
        for (const key of Object.keys(value)) {
            if (key !== "evidence" && key !== "authoritativeClaim") {
                throw new Error("unsupported current target field");
            }
        }
    }
    catch {
        throw new OperationBrowserAdapterError("target_evidence_unavailable");
    }
    return Object.freeze({
        evidence: evidence,
        ...(authoritativeClaim === undefined ? {} : { authoritativeClaim: authoritativeClaim })
    });
}
function boundedRequest(signal, requestedDeadlineAt, transactionTimeoutMs, label, priority = "read") {
    const localDeadline = Date.now() + transactionTimeoutMs;
    return {
        priority,
        signal: signal ?? new AbortController().signal,
        deadlineAt: Math.min(requestedDeadlineAt ?? MAX_DEADLINE_AT, localDeadline),
        label
    };
}
async function defaultCollectorObservation(request, transaction, context, evidenceDigest, authoritativeClaim) {
    const target = transaction.target;
    const observation = await observeBrowserPage(transaction.page, {
        operationId: request.operationId,
        target: {
            providerId: target.providerId,
            browserId: target.browserId,
            tabId: target.tabId,
            coordinationScope: target.coordinationScope,
            ...(authoritativeClaim === undefined ? {} : { authoritativeTabClaim: authoritativeClaim.token }),
            ...(target.conversationId === undefined ? {} : { expectedConversationId: target.conversationId })
        },
        evidenceDigest,
        responseContent: request.responseContent,
        ...(request.responseFormat === undefined ? {} : { responseFormat: request.responseFormat }),
        ...(context.baseline === undefined ? {} : { baseline: context.baseline }),
        ...(context.prior?.assistantTurnId === undefined ? {} : {
            terminalAssistantTurnId: context.prior.assistantTurnId,
            ...(request.responseContent === "include" ? { rawAssistantTurnId: context.prior.assistantTurnId } : {})
        })
    });
    return {
        schemaVersion: "chatgpt.browser_control.collector.v1",
        snapshot: observation.snapshot,
        ...(observation.terminal === undefined ? {} : { terminal: observation.terminal })
    };
}
function sleepOutsideCoordinator(milliseconds, signal) {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || milliseconds > 60_000) {
        return Promise.reject(new OperationBrowserAdapterError("adapter_incomplete"));
    }
    if (signal.aborted)
        return Promise.reject(new OperationBrowserAdapterError("browser_bridge_unavailable"));
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
        }, milliseconds);
        const onAbort = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", onAbort);
            reject(new OperationBrowserAdapterError("browser_bridge_unavailable"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
    });
}
function isPlainPostconditionResult(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, "status");
    return descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string";
}
function errorCode(error) {
    if (error instanceof OperationBrowserAdapterError)
        return error.code;
    return "target_evidence_unavailable";
}
