import { OPERATION_OWNERSHIP_BASELINE_SCHEMA_VERSION } from "./types.js";
import { assertOwnershipBaselineShape } from "./state-machine.js";
import { TURN_OWNERSHIP_SCHEMA_VERSION } from "./turn-ownership.js";
import { canonicalJson } from "./canonical.js";
/**
 * Work-steer is a deliberately small browser capability.  Durable action
 * intent and the complete prepared baseline belong to the caller.  Keeping
 * those writes outside this module means a tab actor is never held across a
 * journal transaction.
 */
export const PRODUCTION_WORK_STEER_SCHEMA_VERSION = "chatgpt.browser_control.production_work_steer.v1";
const DIGEST_PATTERN = /^hmac-sha256:[0-9a-f]{64}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,512}$/u;
const CAPABILITY_PATTERN = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u;
const MAX_PROMPT_BYTES = 8 * 1024 * 1024;
const MAX_TIMEOUT_MS = 30_000;
const MAX_DEADLINE_AT = Date.UTC(2100, 0, 1);
const MAX_GRAPH_DEPTH = 32;
const MAX_GRAPH_NODES = 8_192;
const BASELINE_EPOCH = "1970-01-01T00:00:00.000Z";
export class ProductionWorkSteerPrimitiveError extends Error {
    code;
    constructor(code) {
        // Keep all caller data, URLs, provider messages, and prompt text out of
        // error strings.  Integrations use the opaque code for diagnostics.
        super("The Work steer production primitive could not validate its request.");
        this.name = "ProductionWorkSteerPrimitiveError";
        this.code = code;
    }
}
/**
 * Construct one request-scoped primitive.  The public phase boundary is:
 *
 *   prepare (read) -> caller persists intent + prepared.baseline
 *   -> executePrepared (one-shot mutation) -> verify/recover (read only).
 */
export function createProductionWorkSteerPrimitive(options) {
    const captured = captureOptions(options);
    const clock = makeClock(captured.now);
    let executionConsumed = false;
    const base = (phase, prepared) => Object.freeze({
        schemaVersion: PRODUCTION_WORK_STEER_SCHEMA_VERSION,
        operationId: captured.operationId,
        parentRequestDigest: captured.parentRequestDigest,
        targetBindingDigest: captured.targetBindingDigest,
        controlActionId: captured.controlActionId,
        action: "work_steer",
        phase,
        expectedAssistantTurnId: captured.expectedAssistantTurnId,
        ...(prepared === undefined ? {} : {
            assistantBranchId: prepared.assistantBranchId,
            assistantParentTurnId: prepared.assistantParentTurnId,
            baselineSnapshotDigest: prepared.baselineSnapshotDigest,
            preparedDigest: prepared.preparedDigest
        })
    });
    const prepare = async (request) => {
        let call;
        try {
            call = normalizeCall(request, captured, clock, "prepare");
        }
        catch (error) {
            return blocked(base("prepare"), normalizeInputError(error), false, "none");
        }
        const initialCancellation = cancellationCode(call, clock);
        if (initialCancellation !== undefined)
            return blocked(base("prepare"), initialCancellation, false, "none");
        const observed = await observeBounded(call, captured, clock, "prepare");
        if (observed.kind === "cancelled")
            return blocked(base("prepare"), observed.code, false, "none");
        if (observed.kind === "error")
            return blocked(base("prepare"), "target_evidence_unavailable", true, "none");
        const prepared = makePrepared(observed.value.snapshot, captured);
        if (prepared.kind === "failure") {
            return blocked(base("prepare"), prepared.blockerCode, prepared.observationRequired, "none", prepared.evidenceDigest);
        }
        return Object.freeze({
            ...base("prepare", prepared.value),
            status: "prepared",
            observationRequired: false,
            mutationBoundary: "none",
            prepared: prepared.value
        });
    };
    const executePrepared = async (request) => {
        let call;
        let prepared;
        try {
            call = normalizeCall(request, captured, clock, "execute_prepared");
            prepared = validatePrepared(request.prepared, captured);
        }
        catch (error) {
            return blocked(base("execute_prepared"), normalizeInputError(error), false, "none");
        }
        if (executionConsumed)
            return uncertain(base("execute_prepared", prepared), "send_control_unavailable", "caller");
        executionConsumed = true;
        const initialCancellation = cancellationCode(call, clock);
        if (initialCancellation !== undefined)
            return blocked(base("execute_prepared", prepared), initialCancellation, false, "none");
        const finalRead = await observeBounded(call, captured, clock, "final_recheck", prepared);
        if (finalRead.kind === "cancelled")
            return blocked(base("execute_prepared", prepared), finalRead.code, false, "none");
        if (finalRead.kind === "error")
            return blocked(base("execute_prepared", prepared), "target_evidence_unavailable", true, "none");
        const finalBaseline = makeBaseline(finalRead.value.snapshot, captured);
        if (finalBaseline.kind === "failure") {
            return blocked(base("execute_prepared", prepared), finalBaseline.blockerCode, finalBaseline.observationRequired, "none", finalBaseline.evidenceDigest);
        }
        const parentFailure = validateGeneratingParent(finalRead.value.snapshot, captured, prepared);
        if (parentFailure !== undefined) {
            return blocked(base("execute_prepared", prepared), parentFailure.blockerCode, parentFailure.observationRequired, "none", parentFailure.evidenceDigest);
        }
        if (canonicalJson(finalBaseline.value) !== canonicalJson(prepared.baseline)) {
            return blocked(base("execute_prepared", prepared), "turn_ownership_ambiguous", true, "none", safeDigest(captured, "work-steer-final-baseline", {
                baselineSnapshotDigest: prepared.baselineSnapshotDigest,
                observedSnapshotDigest: finalBaseline.value.snapshotDigest
            }));
        }
        const resolverRequest = resolverRequestFor(call, captured, prepared);
        const composer = await resolveComposer(resolverRequest, call, captured, clock);
        if (composer.kind === "cancelled")
            return blocked(base("execute_prepared", prepared), composer.code, false, "none");
        if (composer.kind === "error" || composer.value === undefined)
            return blocked(base("execute_prepared", prepared), "send_control_unavailable", false, "none");
        const composerValidation = await validateComposer(composer.value, call, clock);
        if (composerValidation !== undefined)
            return blocked(base("execute_prepared", prepared), composerValidation, false, "none");
        const send = await resolveSendControl(resolverRequest, call, captured, clock);
        if (send.kind === "cancelled")
            return blocked(base("execute_prepared", prepared), send.code, false, "none");
        if (send.kind === "error" || send.value === undefined)
            return blocked(base("execute_prepared", prepared), "send_control_unavailable", false, "none");
        const sendValidation = await validateSend(send.value, call, clock, false);
        if (sendValidation !== undefined)
            return blocked(base("execute_prepared", prepared), sendValidation, false, "none");
        const beforeFillCancellation = cancellationCode(call, clock);
        if (beforeFillCancellation !== undefined)
            return blocked(base("execute_prepared", prepared), beforeFillCancellation, false, "none");
        // Resolver callbacks are not authority to mutate later. Recheck the exact
        // composer immediately before fill so a stale locator/candidate set cannot
        // turn the one-shot action into a best-effort write.
        const finalComposerValidation = await validateComposer(composer.value, call, clock);
        if (finalComposerValidation !== undefined)
            return blocked(base("execute_prepared", prepared), finalComposerValidation, false, "none");
        // Mutations are intentionally not bounded with Promise.race.  A provider
        // may accept timeout options, but this primitive always awaits settlement
        // before it releases effect authority or returns to its caller.
        const fillTimeout = remainingMs(call, clock);
        const beforeFillEffect = cancellationCode(call, clock);
        if (beforeFillEffect !== undefined)
            return blocked(base("execute_prepared", prepared), beforeFillEffect, false, "none");
        try {
            await composer.value.fill(captured.prompt, { timeout: fillTimeout });
        }
        catch {
            return uncertain(base("execute_prepared", prepared), "send_control_unavailable", "provider");
        }
        const afterFillCancellation = cancellationCode(call, clock);
        if (afterFillCancellation !== undefined)
            return uncertain(base("execute_prepared", prepared), afterFillCancellation, "caller");
        // Filling normally enables Send. Recheck uniqueness, visibility, and the
        // actual disabled/ARIA/inert state after that local mutation and directly
        // before the sole click.
        const finalSendValidation = await validateSend(send.value, call, clock, true);
        if (finalSendValidation !== undefined)
            return uncertain(base("execute_prepared", prepared), finalSendValidation, "caller");
        const clickTimeout = remainingMs(call, clock);
        const beforeClickEffect = cancellationCode(call, clock);
        if (beforeClickEffect !== undefined)
            return uncertain(base("execute_prepared", prepared), beforeClickEffect, "caller");
        try {
            await send.value.click({ timeout: clickTimeout });
        }
        catch {
            return uncertain(base("execute_prepared", prepared), "send_control_unavailable", "provider");
        }
        const afterClickCancellation = cancellationCode(call, clock);
        if (afterClickCancellation !== undefined)
            return uncertain(base("execute_prepared", prepared), afterClickCancellation, "caller");
        return Object.freeze({
            ...base("execute_prepared", prepared),
            status: "executed",
            observationRequired: true,
            mutationBoundary: "control_may_have_occurred"
        });
    };
    const verify = async (request) => {
        return verifyObservation(request, "verify", undefined);
    };
    const recover = async (request) => {
        return verifyObservation(request, "recovery", request.baseline);
    };
    const verifyObservation = async (request, phase, suppliedBaseline) => {
        let call;
        let prepared;
        try {
            call = normalizeCall(request, captured, clock, phase);
            prepared = validatePrepared(request.prepared, captured);
            if (suppliedBaseline !== undefined) {
                validateBaselineInput(suppliedBaseline, captured, prepared.baselineSnapshotDigest);
                if (canonicalJson(suppliedBaseline) !== canonicalJson(prepared.baseline))
                    throw new ProductionWorkSteerPrimitiveError("invalid_baseline");
            }
        }
        catch (error) {
            return blocked(base(phase), normalizeInputError(error), true, "control_may_have_occurred");
        }
        const initialCancellation = cancellationCode(call, clock);
        if (initialCancellation !== undefined)
            return uncertain(base(phase, prepared), initialCancellation, "caller");
        const observed = await observeBounded(call, captured, clock, phase, prepared, suppliedBaseline);
        if (observed.kind === "cancelled")
            return uncertain(base(phase, prepared), observed.code, "caller");
        if (observed.kind === "error")
            return uncertain(base(phase, prepared), "target_evidence_unavailable", "caller");
        const exact = exactPostcondition(observed.value.snapshot, prepared, captured);
        if (exact.kind === "failure")
            return uncertain(base(phase, prepared), exact.blockerCode, "caller", exact.evidenceDigest);
        return Object.freeze({
            ...base(phase, prepared),
            status: "satisfied",
            observationRequired: false,
            mutationBoundary: "control_may_have_occurred",
            ...exact.value.receipt,
            receipt: exact.value.receipt
        });
    };
    return Object.freeze({ prepare, executePrepared, verify, recover });
}
export const createOperationProductionWorkSteer = createProductionWorkSteerPrimitive;
export const createProductionWorkSteer = createProductionWorkSteerPrimitive;
function captureOptions(options) {
    if (!isPlainRecord(options) || hasAccessorInGraph(options))
        throw new ProductionWorkSteerPrimitiveError("invalid_options");
    const allowed = new Set([
        "evidenceDigest", "operationId", "parentRequestDigest", "targetBindingDigest", "controlActionId",
        "expectedAssistantTurnId", "target", "prompt", "observe", "resolveComposer", "resolveSendControl",
        "timeoutMs", "now"
    ]);
    if (Reflect.ownKeys(options).some(key => typeof key !== "string" || !allowed.has(key))
        || !hasOwn(options, "evidenceDigest")
        || !hasOwn(options, "operationId")
        || !hasOwn(options, "parentRequestDigest")
        || !hasOwn(options, "targetBindingDigest")
        || !hasOwn(options, "controlActionId")
        || !hasOwn(options, "expectedAssistantTurnId")
        || !hasOwn(options, "target")
        || !hasOwn(options, "prompt")
        || !hasOwn(options, "observe")
        || !hasOwn(options, "resolveComposer")
        || !hasOwn(options, "resolveSendControl")) {
        throw new ProductionWorkSteerPrimitiveError("invalid_options");
    }
    const evidenceDigest = own(options, "evidenceDigest");
    const operationId = own(options, "operationId");
    const parentRequestDigest = own(options, "parentRequestDigest");
    const targetBindingDigest = own(options, "targetBindingDigest");
    const controlActionId = own(options, "controlActionId");
    const expectedAssistantTurnId = own(options, "expectedAssistantTurnId");
    const target = own(options, "target");
    const prompt = own(options, "prompt");
    const observe = own(options, "observe");
    const resolveComposer = own(options, "resolveComposer");
    const resolveSendControl = own(options, "resolveSendControl");
    const timeoutMs = own(options, "timeoutMs");
    const now = own(options, "now");
    if (typeof evidenceDigest !== "function"
        || typeof observe !== "function"
        || typeof resolveComposer !== "function"
        || typeof resolveSendControl !== "function")
        throw new ProductionWorkSteerPrimitiveError("invalid_options");
    assertUuid(operationId, "operationId");
    assertDigest(parentRequestDigest, "parentRequestDigest");
    assertDigest(targetBindingDigest, "targetBindingDigest");
    assertUuid(controlActionId, "controlActionId");
    assertIdentifier(expectedAssistantTurnId, "expectedAssistantTurnId");
    if (typeof prompt !== "string" || prompt.length === 0 || prompt.includes("\u0000") || utf8Bytes(prompt) > MAX_PROMPT_BYTES) {
        throw new ProductionWorkSteerPrimitiveError("invalid_prompt");
    }
    const timeout = timeoutMs === undefined ? MAX_TIMEOUT_MS : timeoutMs;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_MS)
        throw new ProductionWorkSteerPrimitiveError("invalid_timeout");
    if (now !== undefined && typeof now !== "function")
        throw new ProductionWorkSteerPrimitiveError("invalid_clock");
    return Object.freeze({
        evidenceDigest: evidenceDigest,
        operationId,
        parentRequestDigest,
        targetBindingDigest,
        controlActionId,
        expectedAssistantTurnId,
        target: cloneTarget(target),
        prompt,
        observe: observe,
        resolveComposer: resolveComposer,
        resolveSendControl: resolveSendControl,
        timeoutMs: timeout,
        now: (now ?? Date.now)
    });
}
function normalizeCall(request, options, clock, phase) {
    if (!isPlainRecord(request) || hasUnsafeRequestGraph(request))
        throw new ProductionWorkSteerPrimitiveError("invalid_call");
    const allowed = phase === "prepare"
        ? new Set(["page", "signal", "deadlineAt"])
        : phase === "recovery"
            ? new Set(["page", "prepared", "baseline", "signal", "deadlineAt"])
            : new Set(["page", "prepared", "signal", "deadlineAt"]);
    if (Reflect.ownKeys(request).some(key => typeof key !== "string" || !allowed.has(key)))
        throw new ProductionWorkSteerPrimitiveError("invalid_call");
    const page = own(request, "page");
    const signal = own(request, "signal");
    if (page === null || (typeof page !== "object" && typeof page !== "function"))
        throw new ProductionWorkSteerPrimitiveError("invalid_call");
    if (!isAbortSignal(signal))
        throw new ProductionWorkSteerPrimitiveError("invalid_signal");
    const initialNow = readClock(clock);
    const requestedDeadline = own(request, "deadlineAt");
    const deadlineAt = requestedDeadline === undefined ? initialNow + options.timeoutMs : requestedDeadline;
    if (!Number.isSafeInteger(deadlineAt) || deadlineAt < 0 || deadlineAt > MAX_DEADLINE_AT || deadlineAt < initialNow) {
        throw new ProductionWorkSteerPrimitiveError("invalid_deadline");
    }
    return Object.freeze({ page: page, signal, deadlineAt });
}
function resolverRequestFor(call, options, prepared) {
    return Object.freeze({
        schemaVersion: PRODUCTION_WORK_STEER_SCHEMA_VERSION,
        operationId: options.operationId,
        parentRequestDigest: options.parentRequestDigest,
        targetBindingDigest: options.targetBindingDigest,
        controlActionId: options.controlActionId,
        expectedAssistantTurnId: options.expectedAssistantTurnId,
        assistantBranchId: prepared.assistantBranchId,
        assistantParentTurnId: prepared.assistantParentTurnId,
        preparedDigest: prepared.preparedDigest,
        page: call.page,
        signal: call.signal,
        deadlineAt: call.deadlineAt
    });
}
async function observeBounded(call, options, clock, phase, prepared, recoveryBaseline) {
    const cancellation = cancellationCode(call, clock);
    if (cancellation !== undefined)
        return { kind: "cancelled", code: cancellation };
    const request = Object.freeze({
        schemaVersion: PRODUCTION_WORK_STEER_SCHEMA_VERSION,
        phase,
        operationId: options.operationId,
        parentRequestDigest: options.parentRequestDigest,
        targetBindingDigest: options.targetBindingDigest,
        controlActionId: options.controlActionId,
        expectedAssistantTurnId: options.expectedAssistantTurnId,
        ...(prepared === undefined ? {} : {
            assistantBranchId: prepared.assistantBranchId,
            assistantParentTurnId: prepared.assistantParentTurnId,
            baselineSnapshotDigest: prepared.baselineSnapshotDigest,
            preparedDigest: prepared.preparedDigest
        }),
        page: call.page,
        signal: call.signal,
        deadlineAt: call.deadlineAt,
        ...(prepared === undefined
            ? {}
            : { baseline: cloneBaseline(recoveryBaseline ?? prepared.baseline) })
    });
    try {
        const result = await boundedRead(() => options.observe(request), call, clock);
        if (result.kind !== "ok")
            return result;
        const afterReadCancellation = cancellationCode(call, clock);
        if (afterReadCancellation !== undefined)
            return { kind: "cancelled", code: afterReadCancellation };
        if (!isPlainRecord(result.value) || hasAccessorInGraph(result.value) || !hasOwn(result.value, "snapshot"))
            return { kind: "error" };
        const rawSnapshot = own(result.value, "snapshot");
        const snapshot = cloneSnapshot(rawSnapshot);
        validateSnapshotShape(snapshot);
        if (!matchesTargetEvidence(options.target, snapshot.target))
            return { kind: "error" };
        return { kind: "ok", value: { snapshot } };
    }
    catch {
        return { kind: "error" };
    }
}
async function boundedRead(invoke, call, clock) {
    const cancellation = cancellationCode(call, clock);
    if (cancellation !== undefined)
        return { kind: "cancelled", code: cancellation };
    try {
        // Never race an in-flight provider/browser call. The outer tab actor owns
        // deadline quarantine; returning while this promise is still running
        // would hide it from the coordinator and allow unsafe overlap.
        const value = await Promise.resolve().then(invoke);
        const after = cancellationCode(call, clock);
        return after === undefined ? { kind: "ok", value } : { kind: "cancelled", code: after };
    }
    catch {
        return { kind: "error" };
    }
}
async function resolveComposer(request, call, options, clock) {
    const result = await boundedRead(() => options.resolveComposer(request), call, clock);
    if (result.kind !== "ok")
        return result;
    if (result.value === undefined)
        return { kind: "ok", value: undefined };
    try {
        return { kind: "ok", value: captureComposer(result.value) };
    }
    catch {
        return { kind: "error" };
    }
}
async function resolveSendControl(request, call, options, clock) {
    const result = await boundedRead(() => options.resolveSendControl(request), call, clock);
    if (result.kind !== "ok")
        return result;
    if (result.value === undefined)
        return { kind: "ok", value: undefined };
    try {
        return { kind: "ok", value: captureSend(result.value) };
    }
    catch {
        return { kind: "error" };
    }
}
async function validateComposer(composer, call, clock) {
    const count = await boundedRead(composer.count, call, clock);
    if (count.kind !== "ok" || count.value !== 1)
        return count.kind === "cancelled" ? count.code : "send_control_unavailable";
    const visible = await boundedRead(composer.isVisible, call, clock);
    if (visible.kind !== "ok" || visible.value !== true)
        return visible.kind === "cancelled" ? visible.code : "send_control_unavailable";
    return undefined;
}
async function validateSend(send, call, clock, requireEnabled) {
    const count = await boundedRead(send.count, call, clock);
    if (count.kind !== "ok" || count.value !== 1)
        return count.kind === "cancelled" ? count.code : "send_control_unavailable";
    const visible = await boundedRead(send.isVisible, call, clock);
    if (visible.kind !== "ok" || visible.value !== true)
        return visible.kind === "cancelled" ? visible.code : "send_control_unavailable";
    if (requireEnabled) {
        const enabled = await boundedRead(send.isEnabled, call, clock);
        if (enabled.kind !== "ok" || enabled.value !== true)
            return enabled.kind === "cancelled" ? enabled.code : "send_control_unavailable";
    }
    return undefined;
}
function captureComposer(value) {
    if (!isPlainRecord(value) || hasUnsafeCapabilityGraph(value, ["locator", "capabilityKey", "candidateCount"]) || !exactKeys(value, ["locator", "capabilityKey", "candidateCount"]))
        throw new ProductionWorkSteerPrimitiveError("invalid_composer");
    const locator = own(value, "locator");
    const capabilityKey = own(value, "capabilityKey");
    const candidateCount = own(value, "candidateCount");
    if (!isObject(locator) || !isSafeCapability(capabilityKey) || candidateCount !== 1)
        throw new ProductionWorkSteerPrimitiveError("invalid_composer");
    const count = captureMethod(locator, "count");
    const isVisible = captureMethod(locator, "isVisible");
    const fill = captureMethod(locator, "fill");
    return Object.freeze({
        locator: locator,
        count: async () => Number(await Reflect.apply(count, locator, [])),
        isVisible: async () => (await Reflect.apply(isVisible, locator, [])) === true,
        fill: async (prompt, fillOptions) => {
            await Reflect.apply(fill, locator, [prompt, fillOptions]);
        }
    });
}
function captureSend(value) {
    if (!isPlainRecord(value) || hasUnsafeCapabilityGraph(value, ["locator", "capabilityKey", "localeKey", "candidateCount"]) || !exactKeys(value, ["locator", "capabilityKey", "localeKey", "candidateCount"]))
        throw new ProductionWorkSteerPrimitiveError("invalid_send");
    const locator = own(value, "locator");
    const capabilityKey = own(value, "capabilityKey");
    const localeKey = own(value, "localeKey");
    const candidateCount = own(value, "candidateCount");
    if (!isObject(locator) || !isSafeCapability(capabilityKey) || !isSafeCapability(localeKey) || candidateCount !== 1)
        throw new ProductionWorkSteerPrimitiveError("invalid_send");
    const count = captureMethod(locator, "count");
    const isVisible = captureMethod(locator, "isVisible");
    const evaluate = captureMethod(locator, "evaluate");
    const click = captureMethod(locator, "click");
    return Object.freeze({
        locator: locator,
        count: async () => Number(await Reflect.apply(count, locator, [])),
        isVisible: async () => (await Reflect.apply(isVisible, locator, [])) === true,
        isEnabled: async () => (await Reflect.apply(evaluate, locator, [
            (element) => {
                const ariaDisabled = element.getAttribute("aria-disabled");
                return element.disabled !== true
                    && !element.hasAttribute("disabled")
                    && ariaDisabled !== "true"
                    && !element.hasAttribute("inert")
                    && element.getAttribute("aria-hidden") !== "true";
            }
        ])) === true,
        click: async (clickOptions) => {
            await Reflect.apply(click, locator, [clickOptions]);
        }
    });
}
function captureMethod(value, key) {
    let cursor = value;
    while (cursor !== null) {
        const descriptor = Object.getOwnPropertyDescriptor(cursor, key);
        if (descriptor !== undefined) {
            if (!("value" in descriptor) || typeof descriptor.value !== "function")
                throw new ProductionWorkSteerPrimitiveError("invalid_capability");
            return descriptor.value;
        }
        try {
            cursor = Object.getPrototypeOf(cursor);
        }
        catch {
            throw new ProductionWorkSteerPrimitiveError("invalid_capability");
        }
    }
    throw new ProductionWorkSteerPrimitiveError("invalid_capability");
}
/** The locator is an opaque provider capability; only its captured methods are used. */
function hasUnsafeCapabilityGraph(value, allowed) {
    try {
        const keys = Reflect.ownKeys(value);
        if (keys.some(key => typeof key !== "string" || !allowed.includes(key)))
            return true;
        const descriptors = Object.getOwnPropertyDescriptors(value);
        for (const key of keys) {
            const descriptor = descriptors[key];
            if (descriptor === undefined || !("value" in descriptor))
                return true;
            if (key !== "locator" && hasAccessorInGraph(descriptor.value))
                return true;
        }
        return false;
    }
    catch {
        return true;
    }
}
function makePrepared(snapshot, options) {
    const baselineResult = makeBaseline(snapshot, options);
    if (baselineResult.kind === "failure")
        return baselineResult;
    const assistant = findExpectedAssistant(snapshot, options.expectedAssistantTurnId);
    if (assistant === undefined || assistant.state !== "generating" || snapshot.terminalState !== "generating") {
        return { kind: "failure", blockerCode: "turn_ownership_ambiguous", observationRequired: true, evidenceDigest: safeDigest(options, "work-steer-parent", snapshot.snapshotDigest) };
    }
    if (assistant.parentStableId === undefined || assistant.branchStableId === undefined
        || !isSafeIdentifier(assistant.parentStableId) || !isSafeIdentifier(assistant.branchStableId)) {
        return { kind: "failure", blockerCode: "turn_ownership_ambiguous", observationRequired: true, evidenceDigest: safeDigest(options, "work-steer-parent", snapshot.snapshotDigest) };
    }
    if (!baselineResult.value.userTurns.some(turn => turn.stableId === assistant.parentStableId)) {
        return { kind: "failure", blockerCode: "turn_ownership_ambiguous", observationRequired: true, evidenceDigest: safeDigest(options, "work-steer-parent", snapshot.snapshotDigest) };
    }
    if (snapshot.assistantTurns.some(turn => turn !== assistant && turn.parentStableId === assistant.parentStableId && turn.branchStableId !== assistant.branchStableId)) {
        return { kind: "failure", blockerCode: "turn_ownership_ambiguous", observationRequired: true, evidenceDigest: safeDigest(options, "work-steer-branch", snapshot.snapshotDigest) };
    }
    const material = {
        schemaVersion: PRODUCTION_WORK_STEER_SCHEMA_VERSION,
        operationId: options.operationId,
        parentRequestDigest: options.parentRequestDigest,
        targetBindingDigest: options.targetBindingDigest,
        controlActionId: options.controlActionId,
        action: "work_steer",
        expectedAssistantTurnId: options.expectedAssistantTurnId,
        assistantBranchId: assistant.branchStableId,
        assistantParentTurnId: assistant.parentStableId,
        baselineSnapshotDigest: baselineResult.value.snapshotDigest,
        baseline: baselineResult.value
    };
    const preparedDigest = safeDigest(options, "work-steer-prepared", material);
    if (preparedDigest === undefined)
        return { kind: "failure", blockerCode: "send_control_unavailable", observationRequired: true, evidenceDigest: undefined };
    return {
        kind: "ok",
        value: deepFreeze({
            ...material,
            preparedDigest
        })
    };
}
function validatePrepared(value, options) {
    if (!isPlainRecord(value) || hasAccessorInGraph(value) || !exactKeys(value, [
        "schemaVersion", "operationId", "parentRequestDigest", "targetBindingDigest", "controlActionId", "action",
        "expectedAssistantTurnId", "assistantBranchId", "assistantParentTurnId", "baselineSnapshotDigest", "preparedDigest", "baseline"
    ]))
        throw new ProductionWorkSteerPrimitiveError("invalid_prepared");
    const cloned = cloneData(value, 0, { count: 0, active: new Set() });
    if (!isPlainRecord(cloned))
        throw new ProductionWorkSteerPrimitiveError("invalid_prepared");
    if (cloned.schemaVersion !== PRODUCTION_WORK_STEER_SCHEMA_VERSION
        || cloned.operationId !== options.operationId
        || cloned.parentRequestDigest !== options.parentRequestDigest
        || cloned.targetBindingDigest !== options.targetBindingDigest
        || cloned.controlActionId !== options.controlActionId
        || cloned.action !== "work_steer"
        || cloned.expectedAssistantTurnId !== options.expectedAssistantTurnId
        || !isSafeIdentifier(cloned.assistantBranchId)
        || !isSafeIdentifier(cloned.assistantParentTurnId)
        || typeof cloned.baselineSnapshotDigest !== "string"
        || !DIGEST_PATTERN.test(cloned.baselineSnapshotDigest)
        || typeof cloned.preparedDigest !== "string"
        || !DIGEST_PATTERN.test(cloned.preparedDigest))
        throw new ProductionWorkSteerPrimitiveError("invalid_prepared");
    validateBaselineInput(cloned.baseline, {
        ...options,
        // validateBaselineInput compares only the redacted baseline and identity.
    }, cloned.baselineSnapshotDigest);
    const material = {
        schemaVersion: PRODUCTION_WORK_STEER_SCHEMA_VERSION,
        operationId: cloned.operationId,
        parentRequestDigest: cloned.parentRequestDigest,
        targetBindingDigest: cloned.targetBindingDigest,
        controlActionId: cloned.controlActionId,
        action: "work_steer",
        expectedAssistantTurnId: cloned.expectedAssistantTurnId,
        assistantBranchId: cloned.assistantBranchId,
        assistantParentTurnId: cloned.assistantParentTurnId,
        baselineSnapshotDigest: cloned.baselineSnapshotDigest,
        baseline: cloned.baseline
    };
    const expectedDigest = safeDigest(options, "work-steer-prepared", material);
    if (expectedDigest === undefined || expectedDigest !== cloned.preparedDigest)
        throw new ProductionWorkSteerPrimitiveError("invalid_prepared");
    const baseline = cloned.baseline;
    const parent = baseline.assistantTurns.find(turn => turn.stableId === cloned.expectedAssistantTurnId);
    if (parent === undefined || parent.state !== "generating" || parent.parentStableId !== cloned.assistantParentTurnId || parent.branchStableId !== cloned.assistantBranchId) {
        throw new ProductionWorkSteerPrimitiveError("invalid_prepared");
    }
    return deepFreeze(cloned);
}
function validateBaselineInput(value, options, expectedSnapshotDigest) {
    if (!isPlainRecord(value) || hasAccessorInGraph(value))
        throw new ProductionWorkSteerPrimitiveError("invalid_baseline");
    const cloned = cloneData(value, 0, { count: 0, active: new Set() });
    if (!isPlainRecord(cloned))
        throw new ProductionWorkSteerPrimitiveError("invalid_baseline");
    const wrapper = {
        schemaVersion: OPERATION_OWNERSHIP_BASELINE_SCHEMA_VERSION,
        operationId: options.operationId,
        requestDigest: options.parentRequestDigest,
        targetBindingDigest: options.targetBindingDigest,
        actionId: options.controlActionId,
        baseline: cloned,
        observedAt: BASELINE_EPOCH
    };
    try {
        assertOwnershipBaselineShape(wrapper);
    }
    catch {
        throw new ProductionWorkSteerPrimitiveError("invalid_baseline");
    }
    const baseline = cloned;
    if (expectedSnapshotDigest !== undefined && baseline.snapshotDigest !== expectedSnapshotDigest)
        throw new ProductionWorkSteerPrimitiveError("invalid_baseline");
    if (baseline.target.canonicalThreadUrl.status !== "unavailable" || baseline.target.canonicalThreadUrl.reason !== "redacted")
        throw new ProductionWorkSteerPrimitiveError("invalid_baseline");
    if (!matchesRedactedTarget(options.target, baseline.target))
        throw new ProductionWorkSteerPrimitiveError("target_binding_mismatch");
}
function makeBaseline(snapshot, options) {
    if (snapshot.completeness !== "complete" || snapshot.terminalState === "unknown") {
        return { kind: "failure", blockerCode: "target_evidence_unavailable", observationRequired: true, evidenceDigest: safeDigest(options, "work-steer-snapshot", snapshot.snapshotDigest) };
    }
    const target = redactTargetEvidence(snapshot.target);
    const baseline = deepFreeze({
        schemaVersion: TURN_OWNERSHIP_SCHEMA_VERSION,
        snapshotDigest: snapshot.snapshotDigest,
        target,
        userTurns: snapshot.userTurns,
        assistantTurns: snapshot.assistantTurns,
        completeness: "complete"
    });
    try {
        const wrapper = {
            schemaVersion: OPERATION_OWNERSHIP_BASELINE_SCHEMA_VERSION,
            operationId: options.operationId,
            requestDigest: options.parentRequestDigest,
            targetBindingDigest: options.targetBindingDigest,
            actionId: options.controlActionId,
            baseline,
            observedAt: BASELINE_EPOCH
        };
        assertOwnershipBaselineShape(wrapper);
    }
    catch {
        return { kind: "failure", blockerCode: "target_evidence_unavailable", observationRequired: true, evidenceDigest: safeDigest(options, "work-steer-snapshot", snapshot.snapshotDigest) };
    }
    return { kind: "ok", value: baseline };
}
function validateGeneratingParent(snapshot, options, prepared) {
    const assistant = findExpectedAssistant(snapshot, options.expectedAssistantTurnId);
    if (assistant === undefined || assistant.state !== "generating" || snapshot.terminalState !== "generating"
        || assistant.parentStableId !== prepared.assistantParentTurnId
        || assistant.branchStableId !== prepared.assistantBranchId) {
        return { blockerCode: "turn_ownership_ambiguous", observationRequired: true, evidenceDigest: safeDigest(options, "work-steer-parent", snapshot.snapshotDigest) };
    }
    if (snapshot.assistantTurns.some(turn => turn !== assistant && turn.parentStableId === prepared.assistantParentTurnId && turn.branchStableId !== prepared.assistantBranchId)) {
        return { blockerCode: "turn_ownership_ambiguous", observationRequired: true, evidenceDigest: safeDigest(options, "work-steer-branch", snapshot.snapshotDigest) };
    }
    return undefined;
}
function exactPostcondition(snapshot, prepared, options) {
    if (snapshot.completeness !== "complete" || snapshot.terminalState === "unknown")
        return { kind: "failure", blockerCode: "target_evidence_unavailable", observationRequired: true, evidenceDigest: safeDigest(options, "work-steer-postcondition", snapshot.snapshotDigest) };
    const baseline = prepared.baseline;
    if (!preserveUsers(baseline.userTurns, snapshot.userTurns))
        return { kind: "failure", blockerCode: "turn_ownership_ambiguous", observationRequired: true, evidenceDigest: safeDigest(options, "work-steer-delta", snapshot.snapshotDigest) };
    if (snapshot.userTurns.length !== baseline.userTurns.length + 1) {
        return { kind: "failure", blockerCode: snapshot.userTurns.length > baseline.userTurns.length + 1 ? "concurrent_user_turn" : "ambiguous_submit", observationRequired: true, evidenceDigest: safeDigest(options, "work-steer-delta", snapshot.snapshotDigest) };
    }
    const addedUser = snapshot.userTurns[baseline.userTurns.length];
    if (addedUser === undefined || addedUser.stableId === undefined || addedUser.ordinal !== baseline.userTurns.length) {
        return { kind: "failure", blockerCode: "ambiguous_submit", observationRequired: true, evidenceDigest: safeDigest(options, "work-steer-delta", snapshot.snapshotDigest) };
    }
    const delta = snapshot.postSendDelta;
    if (delta === undefined || delta.baselineSnapshotDigest !== prepared.baselineSnapshotDigest || delta.addedUserEvidenceDigests.length !== 1 || delta.addedUserEvidenceDigests[0] !== addedUser.evidenceDigest) {
        return { kind: "failure", blockerCode: "ambiguous_submit", observationRequired: true, evidenceDigest: safeDigest(options, "work-steer-delta", snapshot.snapshotDigest) };
    }
    const expectedDelta = safeDigest(options, "browser-observation-post-send-delta", {
        baselineSnapshotDigest: prepared.baselineSnapshotDigest,
        addedUserEvidenceDigests: delta.addedUserEvidenceDigests
    });
    if (expectedDelta === undefined || expectedDelta !== delta.deltaDigest) {
        return { kind: "failure", blockerCode: "ambiguous_submit", observationRequired: true, evidenceDigest: safeDigest(options, "work-steer-delta", snapshot.snapshotDigest) };
    }
    if (!preserveAssistants(baseline.assistantTurns, snapshot.assistantTurns, prepared))
        return { kind: "failure", blockerCode: "turn_ownership_ambiguous", observationRequired: true, evidenceDigest: safeDigest(options, "work-steer-branch", snapshot.snapshotDigest) };
    const addedAssistants = snapshot.assistantTurns.slice(baseline.assistantTurns.length);
    if (addedAssistants.length > 1 || addedAssistants.some(turn => turn.parentStableId !== addedUser.stableId || turn.branchStableId !== prepared.assistantBranchId || turn.ordinal !== baseline.assistantTurns.length))
        return { kind: "failure", blockerCode: "turn_ownership_ambiguous", observationRequired: true, evidenceDigest: safeDigest(options, "work-steer-branch", snapshot.snapshotDigest) };
    const evidenceDigest = safeDigest(options, "work-steer-postcondition", {
        operationId: options.operationId,
        targetBindingDigest: options.targetBindingDigest,
        controlActionId: options.controlActionId,
        expectedAssistantTurnId: options.expectedAssistantTurnId,
        assistantBranchId: prepared.assistantBranchId,
        assistantParentTurnId: prepared.assistantParentTurnId,
        userTurnEvidenceDigest: addedUser.evidenceDigest,
        postSendDeltaDigest: delta.deltaDigest
    });
    if (evidenceDigest === undefined)
        return { kind: "failure", blockerCode: "send_control_unavailable", observationRequired: true, evidenceDigest: undefined };
    const receipt = deepFreeze({
        schemaVersion: PRODUCTION_WORK_STEER_SCHEMA_VERSION,
        baselineSnapshotDigest: prepared.baselineSnapshotDigest,
        preparedDigest: prepared.preparedDigest,
        assistantTurnId: prepared.expectedAssistantTurnId,
        assistantBranchId: prepared.assistantBranchId,
        assistantParentTurnId: prepared.assistantParentTurnId,
        userTurnId: addedUser.stableId,
        userTurnEvidenceDigest: addedUser.evidenceDigest,
        postSendDeltaDigest: delta.deltaDigest,
        evidenceDigest
    });
    return { kind: "ok", value: { receipt } };
}
function preserveUsers(before, after) {
    if (after.length < before.length)
        return false;
    for (let index = 0; index < before.length; index += 1) {
        if (canonicalJson(before[index]) !== canonicalJson(after[index]))
            return false;
    }
    return true;
}
function preserveAssistants(before, after, prepared) {
    if (after.length < before.length)
        return false;
    for (let index = 0; index < before.length; index += 1) {
        const prior = before[index];
        const current = after[index];
        if (prior === undefined || current === undefined)
            return false;
        if (prior.stableId !== prepared.expectedAssistantTurnId) {
            if (canonicalJson(prior) !== canonicalJson(current))
                return false;
            continue;
        }
        if (current.stableId !== prior.stableId || current.ordinal !== prior.ordinal || current.parentStableId !== prepared.assistantParentTurnId || current.branchStableId !== prepared.assistantBranchId)
            return false;
    }
    return true;
}
function findExpectedAssistant(snapshot, id) {
    const found = snapshot.assistantTurns.filter(turn => turn.stableId === id);
    return found.length === 1 ? found[0] : undefined;
}
function cloneSnapshot(value) {
    const cloned = cloneData(value, 0, { count: 0, active: new Set() });
    if (!isPlainRecord(cloned))
        throw new ProductionWorkSteerPrimitiveError("invalid_snapshot");
    return cloned;
}
function validateSnapshotShape(value) {
    if (!isPlainRecord(value) || !allowedKeys(value, ["schemaVersion", "snapshotDigest", "target", "userTurns", "assistantTurns", "completeness", "terminalState", "postSendDelta"]) || !["schemaVersion", "snapshotDigest", "target", "userTurns", "assistantTurns", "completeness", "terminalState"].every(key => hasOwn(value, key)))
        throw new ProductionWorkSteerPrimitiveError("invalid_snapshot");
    const wrapper = {
        schemaVersion: OPERATION_OWNERSHIP_BASELINE_SCHEMA_VERSION,
        operationId: "11111111-1111-4111-8111-111111111111",
        requestDigest: "hmac-sha256:" + "0".repeat(64),
        targetBindingDigest: "hmac-sha256:" + "0".repeat(64),
        actionId: "11111111-1111-4111-8111-111111111111",
        baseline: {
            schemaVersion: value.schemaVersion,
            snapshotDigest: value.snapshotDigest,
            target: value.target,
            userTurns: value.userTurns,
            assistantTurns: value.assistantTurns,
            completeness: value.completeness
        },
        observedAt: BASELINE_EPOCH
    };
    try {
        assertOwnershipBaselineShape(wrapper);
    }
    catch {
        throw new ProductionWorkSteerPrimitiveError("invalid_snapshot");
    }
    if (value.terminalState !== "idle" && value.terminalState !== "generating" && value.terminalState !== "terminal" && value.terminalState !== "unknown")
        throw new ProductionWorkSteerPrimitiveError("invalid_snapshot");
    if (value.postSendDelta !== undefined) {
        const delta = value.postSendDelta;
        if (!isPlainRecord(delta) || !exactKeys(delta, ["baselineSnapshotDigest", "addedUserEvidenceDigests", "deltaDigest"]) || !DIGEST_PATTERN.test(delta.baselineSnapshotDigest) || !DIGEST_PATTERN.test(delta.deltaDigest) || !Array.isArray(delta.addedUserEvidenceDigests) || delta.addedUserEvidenceDigests.length > 256 || delta.addedUserEvidenceDigests.some(item => typeof item !== "string" || !DIGEST_PATTERN.test(item)))
            throw new ProductionWorkSteerPrimitiveError("invalid_snapshot");
    }
    const ids = new Set();
    for (const turn of [...value.userTurns, ...value.assistantTurns]) {
        if (turn.stableId !== undefined) {
            if (ids.has(turn.stableId))
                throw new ProductionWorkSteerPrimitiveError("duplicate_identity");
            ids.add(turn.stableId);
        }
    }
}
function redactTargetEvidence(target) {
    return {
        ...target,
        canonicalThreadUrl: { status: "unavailable", reason: "redacted" }
    };
}
function matchesTargetEvidence(target, evidence) {
    return identityEquals(evidence.provider, target.providerId)
        && identityEquals(evidence.browser, target.browserId)
        && identityEquals(evidence.tab, target.tabId)
        && optionalIdentityEquals(evidence.conversation, target.conversationId)
        && optionalIdentityEquals(evidence.canonicalThreadUrl, target.canonicalThreadUrl)
        && evidence.coordinationScope === target.coordinationScope
        && (target.evidenceProfile.authoritativeTabClaim === "unavailable" || evidence.authoritativeTabClaim.status === "available");
}
function matchesRedactedTarget(target, evidence) {
    return identityEquals(evidence.provider, target.providerId)
        && identityEquals(evidence.browser, target.browserId)
        && identityEquals(evidence.tab, target.tabId)
        && optionalIdentityEquals(evidence.conversation, target.conversationId)
        && evidence.canonicalThreadUrl.status === "unavailable"
        && evidence.coordinationScope === target.coordinationScope
        && (target.evidenceProfile.authoritativeTabClaim === "unavailable" || evidence.authoritativeTabClaim.status === "available");
}
function identityEquals(value, expected) {
    return isPlainRecord(value) && value.status === "available" && value.value === expected;
}
function optionalIdentityEquals(value, expected) {
    return expected === undefined || identityEquals(value, expected);
}
function cloneTarget(value) {
    if (!isPlainRecord(value) || hasAccessorInGraph(value))
        throw new ProductionWorkSteerPrimitiveError("invalid_target");
    const allowed = new Set([
        "providerId", "browserId", "tabId", "coordinationScope", "tabClaimEvidenceDigest", "canonicalThreadUrl", "conversationId",
        "userTurnBaselineDigest", "assistantTurnBaselineDigest", "configurationReceiptDigest", "evidenceProfile", "targetLifecycle",
        "newTargetAnchorDigest", "blankTaskEvidenceDigest", "targetEstablishment"
    ]);
    if (Reflect.ownKeys(value).some(key => typeof key !== "string" || !allowed.has(key))
        || !hasOwn(value, "providerId") || !hasOwn(value, "browserId") || !hasOwn(value, "tabId") || !hasOwn(value, "coordinationScope") || !hasOwn(value, "evidenceProfile"))
        throw new ProductionWorkSteerPrimitiveError("invalid_target");
    const cloned = cloneData(value, 0, { count: 0, active: new Set() });
    if (!isPlainRecord(cloned) || !isSafeIdentifier(cloned.providerId) || !isSafeIdentifier(cloned.browserId) || !isSafeIdentifier(cloned.tabId) || (cloned.coordinationScope !== "process" && cloned.coordinationScope !== "provider"))
        throw new ProductionWorkSteerPrimitiveError("invalid_target");
    if (!isPlainRecord(cloned.evidenceProfile) || !exactKeys(cloned.evidenceProfile, ["providerIdentity", "stableTabId", "stableConversationId", "stableUserTurnId", "authoritativeTabClaim", "replacementTabRecovery"]))
        throw new ProductionWorkSteerPrimitiveError("invalid_target");
    for (const key of ["providerIdentity", "stableTabId", "stableConversationId", "stableUserTurnId", "authoritativeTabClaim"])
        if (cloned.evidenceProfile[key] !== "required" && cloned.evidenceProfile[key] !== "unavailable")
            throw new ProductionWorkSteerPrimitiveError("invalid_target");
    if (typeof cloned.evidenceProfile.replacementTabRecovery !== "boolean")
        throw new ProductionWorkSteerPrimitiveError("invalid_target");
    for (const key of ["tabClaimEvidenceDigest", "userTurnBaselineDigest", "assistantTurnBaselineDigest", "configurationReceiptDigest", "newTargetAnchorDigest", "blankTaskEvidenceDigest"]) {
        if (cloned[key] !== undefined)
            assertDigest(cloned[key], key);
    }
    if (cloned.canonicalThreadUrl !== undefined)
        assertCanonicalUrl(cloned.canonicalThreadUrl);
    if (cloned.conversationId !== undefined)
        assertIdentifier(cloned.conversationId, "conversationId");
    if (cloned.targetLifecycle !== undefined && cloned.targetLifecycle !== "fixed" && cloned.targetLifecycle !== "new_pending" && cloned.targetLifecycle !== "new_established")
        throw new ProductionWorkSteerPrimitiveError("invalid_target");
    return deepFreeze(cloned);
}
function cloneBaseline(value) {
    const cloned = cloneData(value, 0, { count: 0, active: new Set() });
    if (!isPlainRecord(cloned))
        throw new ProductionWorkSteerPrimitiveError("invalid_baseline");
    return deepFreeze(cloned);
}
function cloneData(value, depth, state) {
    if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
        if (typeof value === "number" && !Number.isFinite(value))
            throw new ProductionWorkSteerPrimitiveError("invalid_data");
        return value;
    }
    if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint" || value === undefined)
        throw new ProductionWorkSteerPrimitiveError("invalid_data");
    if (depth > MAX_GRAPH_DEPTH || ++state.count > MAX_GRAPH_NODES)
        throw new ProductionWorkSteerPrimitiveError("data_bounds");
    const object = value;
    if (state.active.has(object))
        throw new ProductionWorkSteerPrimitiveError("cyclic_data");
    state.active.add(object);
    try {
        let prototype;
        try {
            prototype = Object.getPrototypeOf(object);
        }
        catch {
            throw new ProductionWorkSteerPrimitiveError("invalid_data");
        }
        if (prototype !== Object.prototype && prototype !== null && !Array.isArray(object))
            throw new ProductionWorkSteerPrimitiveError("invalid_data");
        let keys;
        let descriptors;
        try {
            keys = Reflect.ownKeys(object);
            descriptors = Object.getOwnPropertyDescriptors(object);
        }
        catch {
            throw new ProductionWorkSteerPrimitiveError("invalid_data");
        }
        if (keys.some(key => typeof key !== "string"))
            throw new ProductionWorkSteerPrimitiveError("invalid_data");
        const output = Array.isArray(object) ? [] : {};
        for (const rawKey of keys) {
            if (typeof rawKey !== "string")
                throw new ProductionWorkSteerPrimitiveError("invalid_data");
            const key = rawKey;
            if (Array.isArray(object) && key === "length")
                continue;
            const descriptor = descriptors[key];
            if (descriptor === undefined || !("value" in descriptor))
                throw new ProductionWorkSteerPrimitiveError("accessor_data");
            if (Array.isArray(object) && !/^\d+$/u.test(key))
                throw new ProductionWorkSteerPrimitiveError("invalid_data");
            if (Array.isArray(output))
                output[Number(key)] = cloneData(descriptor.value, depth + 1, state);
            else
                output[key] = cloneData(descriptor.value, depth + 1, state);
        }
        return output;
    }
    finally {
        state.active.delete(object);
    }
}
function deepFreeze(value, seen = new Set()) {
    if (value === null || typeof value !== "object" || seen.has(value))
        return value;
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key === "string")
            deepFreeze(value[key], seen);
    }
    return Object.freeze(value);
}
/** Page and AbortSignal are opaque capabilities; inspect only the data graph. */
function hasUnsafeRequestGraph(value) {
    try {
        const keys = Reflect.ownKeys(value);
        if (keys.some(key => typeof key !== "string"))
            return true;
        const descriptors = Object.getOwnPropertyDescriptors(value);
        for (const key of keys) {
            const descriptor = descriptors[key];
            if (descriptor === undefined || !("value" in descriptor))
                return true;
            if (key === "page" || key === "signal")
                continue;
            if (hasAccessorInGraph(descriptor.value))
                return true;
        }
        return false;
    }
    catch {
        return true;
    }
}
function hasAccessorInGraph(value, state = { seen: new Set(), active: new Set(), count: 0 }, depth = 0) {
    if (value === null || (typeof value !== "object" && typeof value !== "function"))
        return false;
    if (typeof value === "function")
        return false;
    if (depth > MAX_GRAPH_DEPTH || ++state.count > MAX_GRAPH_NODES)
        return true;
    const object = value;
    if (state.active.has(object))
        return true;
    if (state.seen.has(object))
        return false;
    state.seen.add(object);
    state.active.add(object);
    try {
        const keys = Reflect.ownKeys(object);
        if (keys.some(key => typeof key !== "string"))
            return true;
        const descriptors = Object.getOwnPropertyDescriptors(object);
        for (const key of keys) {
            const descriptor = descriptors[key];
            if (descriptor === undefined || !("value" in descriptor))
                return true;
            if (hasAccessorInGraph(descriptor.value, state, depth + 1))
                return true;
        }
        return false;
    }
    catch {
        return true;
    }
    finally {
        state.active.delete(object);
    }
}
function exactKeys(value, allowed) {
    try {
        const keys = Reflect.ownKeys(value);
        return keys.length === allowed.length && keys.every(key => typeof key === "string" && allowed.includes(key));
    }
    catch {
        return false;
    }
}
function allowedKeys(value, allowed) {
    try {
        return Reflect.ownKeys(value).every(key => typeof key === "string" && allowed.includes(key));
    }
    catch {
        return false;
    }
}
function hasOwn(value, key) {
    try {
        return Object.prototype.hasOwnProperty.call(value, key);
    }
    catch {
        return false;
    }
}
function own(value, key) {
    try {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
    }
    catch {
        return undefined;
    }
}
function isPlainRecord(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        return false;
    try {
        const prototype = Object.getPrototypeOf(value);
        return prototype === Object.prototype || prototype === null;
    }
    catch {
        return false;
    }
}
function isObject(value) {
    return value !== null && (typeof value === "object" || typeof value === "function");
}
function isAbortSignal(value) {
    try {
        return typeof AbortSignal !== "undefined" && value instanceof AbortSignal;
    }
    catch {
        return false;
    }
}
function isSafeCapability(value) {
    return typeof value === "string" && CAPABILITY_PATTERN.test(value);
}
function isSafeIdentifier(value) {
    return typeof value === "string" && ID_PATTERN.test(value) && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/u.test(value);
}
function assertIdentifier(value, label) {
    if (!isSafeIdentifier(value))
        throw new ProductionWorkSteerPrimitiveError(`invalid_${label}`);
}
function assertUuid(value, label) {
    if (typeof value !== "string" || !UUID_PATTERN.test(value))
        throw new ProductionWorkSteerPrimitiveError(`invalid_${label}`);
}
function assertDigest(value, label) {
    if (typeof value !== "string" || !DIGEST_PATTERN.test(value))
        throw new ProductionWorkSteerPrimitiveError(`invalid_${label}`);
}
function assertCanonicalUrl(value) {
    if (typeof value !== "string" || value.length > 4096)
        throw new ProductionWorkSteerPrimitiveError("invalid_target");
    try {
        const parsed = new URL(value);
        if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== "" || parsed.toString() !== value)
            throw new Error();
    }
    catch {
        throw new ProductionWorkSteerPrimitiveError("invalid_target");
    }
}
function utf8Bytes(value) {
    return Buffer.byteLength(value, "utf8");
}
function makeClock(source) {
    let last = -1;
    let faulted = false;
    const now = () => {
        if (faulted)
            throw new ProductionWorkSteerPrimitiveError("clock_fault");
        let value;
        try {
            value = source();
        }
        catch {
            faulted = true;
            throw new ProductionWorkSteerPrimitiveError("clock_fault");
        }
        if (!Number.isSafeInteger(value) || value < 0 || value > MAX_DEADLINE_AT || (last >= 0 && value < last)) {
            faulted = true;
            throw new ProductionWorkSteerPrimitiveError("clock_fault");
        }
        last = value;
        return value;
    };
    return Object.freeze({ now, isFaulted: () => faulted });
}
function readClock(clock) {
    try {
        return clock.now();
    }
    catch {
        throw new ProductionWorkSteerPrimitiveError("invalid_clock");
    }
}
function cancellationCode(call, clock) {
    if (clock.isFaulted())
        return "operation_state_corrupt";
    if (call.signal.aborted)
        return "operation_cancelled";
    let now;
    try {
        now = clock.now();
    }
    catch {
        return "operation_state_corrupt";
    }
    return now >= call.deadlineAt ? "operation_timeout" : undefined;
}
function remainingMs(call, clock) {
    if (call.signal.aborted || clock.isFaulted())
        return 0;
    let now;
    try {
        now = clock.now();
    }
    catch {
        return 0;
    }
    return Math.max(0, Math.min(MAX_TIMEOUT_MS, call.deadlineAt - now));
}
function normalizeInputError(error) {
    if (error instanceof ProductionWorkSteerPrimitiveError) {
        if (error.code === "target_binding_mismatch")
            return "target_binding_mismatch";
        if (error.code === "invalid_clock" || error.code === "clock_fault")
            return "operation_state_corrupt";
    }
    return "operation_state_corrupt";
}
function blocked(base, blockerCode, observationRequired, mutationBoundary, evidenceDigest) {
    return Object.freeze({
        ...base,
        status: "blocked",
        blockerCode,
        observationRequired,
        mutationBoundary,
        ...(evidenceDigest === undefined ? {} : { evidenceDigest })
    });
}
function uncertain(base, blockerCode, quarantine, evidenceDigest) {
    return Object.freeze({
        ...base,
        status: "uncertain",
        blockerCode,
        observationRequired: true,
        mutationBoundary: "control_may_have_occurred",
        quarantine,
        ...(evidenceDigest === undefined ? {} : { evidenceDigest })
    });
}
function safeDigest(options, domain, material) {
    try {
        const safeMaterial = deepFreeze(cloneData(material, 0, { count: 0, active: new Set() }));
        const result = options.evidenceDigest(domain, safeMaterial);
        return typeof result === "string" && DIGEST_PATTERN.test(result) ? result : undefined;
    }
    catch {
        return undefined;
    }
}
