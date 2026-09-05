import { renderUntrustedOutputReturnEnvelope } from "../safety/untrusted-output.js";
import { interruptionFromCommandResult } from "./interruptions.js";
import { augmentCommandBlocker } from "./resume.js";
const MAX_RESULT_TRAVERSAL_DEPTH = 16;
const MAX_RESULT_TRAVERSAL_NODES = 2_048;
export function toRunResult(agent, result) {
    const extractedOutput = extractOutput(result.data);
    const outputText = extractedOutput?.text ?? "";
    const finalOutput = parseFinalOutput(agent, outputText);
    const interruption = interruptionFromCommandResult(result, failedCommand(result));
    const interruptions = interruption === undefined ? [] : [interruption];
    const output = runItemsFromResult(result, outputText, extractedOutput?.source);
    const state = runStateFromResult(result, interruptions);
    const data = { outputText };
    const operationId = readOperationId(result.data);
    const handle = readOperationHandle(result.data);
    const requestDigest = readRequestDigest(result.data);
    if (operationId !== undefined)
        data.operationId = operationId;
    if (handle !== undefined)
        data.handle = handle;
    if (requestDigest !== undefined)
        data.requestDigest = requestDigest;
    const submissionState = readSubmissionState(result.data);
    const completionState = readCompletionState(result.data);
    const generationActive = readGenerationActive(result.data);
    if (submissionState !== undefined)
        data.submissionState = submissionState;
    if (completionState !== undefined)
        data.completionState = completionState;
    if (generationActive !== undefined)
        data.generationActive = generationActive;
    if (outputText.length > 0) {
        const envelopeArgs = {
            outputText,
            source: "chatgpt",
            capturedAt: result.context.timestamp,
            metadata: {
                result_status: result.status,
                report_path: result.reportPath
            }
        };
        if (result.reportPath !== undefined)
            envelopeArgs.outputPath = result.reportPath;
        data.untrustedOutput = renderUntrustedOutputReturnEnvelope(envelopeArgs);
    }
    if (finalOutput !== undefined)
        data.finalOutput = finalOutput;
    const thread = threadRefFromContext(result.context);
    if (thread !== undefined)
        data.thread = thread;
    if (result.reportPath !== undefined)
        data.reportPath = result.reportPath;
    const mapped = {
        ...result,
        data,
        output_text: outputText,
        output,
        newItems: output,
        interruptions,
        state,
        activeAgentName: agent.name,
        lastAgentName: agent.name
    };
    if (finalOutput !== undefined)
        mapped.finalOutput = finalOutput;
    return mapped;
}
function extractOutput(data, seen = new WeakSet(), depth = 0, budget = { remaining: MAX_RESULT_TRAVERSAL_NODES }) {
    if (!enterResultRecord(data, seen, depth, budget))
        return undefined;
    const responseText = ownDataProperty(data, "responseText");
    if (typeof responseText === "string") {
        return { text: responseText, source: data };
    }
    const text = ownDataProperty(data, "text");
    if (typeof text === "string") {
        return { text, source: data };
    }
    for (const value of ownDataValues(data)) {
        const nested = extractOutput(value, seen, depth + 1, budget);
        // Keep the pre-existing extractor's behavior: an empty nested record is
        // not a usable result, so continue searching siblings for real output.
        if (nested !== undefined && nested.text.length > 0)
            return nested;
    }
    return undefined;
}
function parseFinalOutput(agent, outputText) {
    if (outputText.length === 0)
        return undefined;
    if (agent.output?.parse === "json") {
        try {
            return JSON.parse(outputText);
        }
        catch {
            return agent.output.onParseError === "return_text" ? outputText : undefined;
        }
    }
    return outputText;
}
function runItemsFromResult(result, outputText, outputSource) {
    const responseFormat = responseFormatForOutput(result.data, outputSource);
    const items = lifecycleItemsFromSteps(result.steps);
    // Prompt provenance is independent from assistant-output provenance: a
    // submitted prompt may be recorded in a sibling branch of the result.
    items.push(...messageItemsFromData(result.data));
    if (!items.some(item => item.type === "message.completed" || item.type === "message.in_progress") && outputText.length > 0) {
        const assistant = assistantItemFromOutput(outputSource, outputText, responseFormat, result.status);
        if (assistant !== undefined)
            items.push(assistant);
    }
    if (result.blocker !== undefined) {
        items.push({ type: "run.blocked", blocker: augmentCommandBlocker(result.blocker) });
    }
    return items;
}
function lifecycleItemsFromSteps(steps) {
    if (steps === undefined)
        return [];
    const items = [];
    for (const step of steps) {
        if (!step.ok || !isRecord(step.dataPreview))
            continue;
        if (step.command === "experience.open") {
            const experience = step.dataPreview.experience;
            if (experience === "chat" || experience === "work") {
                const item = {
                    type: "experience.opened",
                    experience
                };
                if (typeof step.dataPreview.changed === "boolean")
                    item.changed = step.dataPreview.changed;
                items.push(item);
            }
            continue;
        }
        if (step.command === "configuration.apply") {
            const item = {
                type: "configuration.applied"
            };
            if (isRecord(step.dataPreview.requested)) {
                item.requested = step.dataPreview.requested;
            }
            if (typeof step.dataPreview.verified === "boolean") {
                item.verified = step.dataPreview.verified;
            }
            items.push(item);
        }
    }
    return items;
}
function messageItemsFromData(data, seen = new WeakSet(), depth = 0, budget = { remaining: MAX_RESULT_TRAVERSAL_NODES }) {
    if (!enterResultRecord(data, seen, depth, budget))
        return [];
    const items = [];
    const prompt = ownDataProperty(data, "prompt");
    if (typeof prompt === "string" && prompt.length > 0) {
        items.push({
            type: "message.submitted",
            role: "user",
            preview: prompt.length > 160 ? `${prompt.slice(0, 159)}...` : prompt,
            redacted: true
        });
        return items;
    }
    for (const value of ownDataValues(data)) {
        const nested = messageItemsFromData(value, seen, depth + 1, budget);
        if (nested.length > 0)
            return nested;
    }
    return items;
}
function assistantItemFromOutput(outputSource, outputText, responseFormat, resultStatus) {
    if (outputSource === undefined || outputText.length === 0)
        return undefined;
    // The selected output record is the sole authority for assistant text and
    // lifecycle metadata. In particular, do not recursively borrow completion
    // state from a later sibling branch.
    const completionState = completionStateFromRecord(outputSource);
    const complete = ownDataProperty(outputSource, "complete");
    if (completionState === "complete" || complete === true) {
        return { type: "message.completed", role: "assistant", output_text: outputText, format: responseFormat };
    }
    const incomplete = complete === false
        || completionState !== undefined
        || resultStatus === "partial";
    if (incomplete) {
        return inProgressItem(outputText, completionState, generationActiveFromRecord(outputSource), responseFormat);
    }
    return { type: "message.completed", role: "assistant", output_text: outputText, format: responseFormat };
}
function completionStateFromRecord(data) {
    const value = ownDataProperty(data, "completionState");
    return value === "complete" || value === "generating" || value === "stopped" || value === "partial" || value === "unknown"
        ? value
        : undefined;
}
function generationActiveFromRecord(data) {
    const value = ownDataProperty(data, "generationActive");
    return typeof value === "boolean" ? value : undefined;
}
function runStateFromResult(result, interruptions) {
    const resumable = interruptions.some(interruption => interruption.resume.supported);
    const firstResume = interruptions.find(interruption => interruption.resume.supported)?.resume;
    const state = {
        id: firstResume?.supported === true && firstResume.stateId !== undefined ? firstResume.stateId : `run_${Date.now().toString(36)}`,
        resumable
    };
    const operationId = readOperationId(result.data);
    const handle = readOperationHandle(result.data);
    if (operationId !== undefined) {
        state.operationId = operationId;
        // Use the durable identity for correlation without changing the runner's
        // resume-policy bit: recovery is collect-only through the operation
        // handle, not permission to replay the high-level workflow.
        state.id = operationId;
    }
    if (handle !== undefined)
        state.handle = handle;
    const thread = threadRefFromContext(result.context);
    if (thread !== undefined)
        state.thread = thread;
    const submissionState = readSubmissionState(result.data);
    const completionState = readCompletionState(result.data);
    if (submissionState !== undefined)
        state.submissionState = submissionState;
    if (completionState !== undefined)
        state.completionState = completionState;
    return state;
}
function inProgressItem(outputText, completionState, generationActive, responseFormat) {
    const item = {
        type: "message.in_progress",
        role: "assistant",
        output_text: outputText,
        preview: outputText.length > 160 ? `${outputText.slice(0, 159)}...` : outputText,
        format: responseFormat,
        textLength: outputText.length,
        textHash: hashText(outputText)
    };
    if (completionState !== undefined)
        item.completionState = completionState;
    if (generationActive !== undefined)
        item.generationActive = generationActive;
    return item;
}
function responseFormatForOutput(data, outputSource) {
    // A top-level responseFormat is an explicit result contract and therefore
    // remains authoritative even when the output text is nested below it.
    const topLevel = ownDataProperty(data, "responseFormat");
    if (isResponseFormat(topLevel))
        return topLevel;
    // Legacy format fields are only meaningful when co-located with the record
    // whose text won the bounded output traversal. Never borrow one from an
    // unrelated metadata/configuration branch.
    const local = responseFormatFromRecord(outputSource);
    return local ?? "markdown";
}
function responseFormatFromRecord(data) {
    if (data === undefined)
        return undefined;
    const explicit = ownDataProperty(data, "responseFormat");
    if (isResponseFormat(explicit))
        return explicit;
    const local = ownDataProperty(data, "format");
    return isResponseFormat(local) ? local : undefined;
}
function isResponseFormat(value) {
    return value === "markdown"
        || value === "text"
        || value === "normalized_text"
        || value === "visible_text"
        || value === "html"
        || value === "blocks"
        || value === "all";
}
function readCompletionState(data, seen = new WeakSet(), depth = 0, budget = { remaining: MAX_RESULT_TRAVERSAL_NODES }) {
    if (!enterResultRecord(data, seen, depth, budget))
        return undefined;
    const value = ownDataProperty(data, "completionState");
    if (value === "complete" || value === "generating" || value === "stopped" || value === "partial" || value === "unknown") {
        return value;
    }
    for (const nested of ownDataValues(data)) {
        const nestedState = readCompletionState(nested, seen, depth + 1, budget);
        if (nestedState !== undefined)
            return nestedState;
    }
    return undefined;
}
function readSubmissionState(data, seen = new WeakSet(), depth = 0, budget = { remaining: MAX_RESULT_TRAVERSAL_NODES }) {
    if (!enterResultRecord(data, seen, depth, budget))
        return undefined;
    const value = ownDataProperty(data, "submissionState");
    if (value === "not_submitted" || value === "submitted" || value === "submitted_unconfirmed" || value === "submitted_generating") {
        return value;
    }
    for (const nested of ownDataValues(data)) {
        const nestedState = readSubmissionState(nested, seen, depth + 1, budget);
        if (nestedState !== undefined)
            return nestedState;
    }
    return undefined;
}
function readGenerationActive(data, seen = new WeakSet(), depth = 0, budget = { remaining: MAX_RESULT_TRAVERSAL_NODES }) {
    if (!enterResultRecord(data, seen, depth, budget))
        return undefined;
    const generationActive = ownDataProperty(data, "generationActive");
    if (typeof generationActive === "boolean")
        return generationActive;
    for (const nested of ownDataValues(data)) {
        const value = readGenerationActive(nested, seen, depth + 1, budget);
        if (value !== undefined)
            return value;
    }
    return undefined;
}
function readOperationId(data) {
    const value = ownDataProperty(data, "operationId");
    return typeof value === "string"
        && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
        ? value
        : undefined;
}
function readRequestDigest(data) {
    const value = ownDataProperty(data, "requestDigest");
    return typeof value === "string" && /^hmac-sha256:[0-9a-f]{64}$/u.test(value)
        ? value
        : undefined;
}
function readOperationHandle(data) {
    const value = ownDataProperty(data, "handle");
    if (!isRecord(value))
        return undefined;
    const operationId = ownDataProperty(value, "operationId");
    const requestDigest = ownDataProperty(value, "requestDigest");
    const schemaVersion = ownDataProperty(value, "schemaVersion");
    const surface = ownDataProperty(value, "surface");
    const revision = ownDataProperty(value, "revision");
    const phase = ownDataProperty(value, "phase");
    const mutationBoundary = ownDataProperty(value, "mutationBoundary");
    const targetBindingDigest = ownDataProperty(value, "targetBindingDigest");
    if (schemaVersion !== "chatgpt.browser_control.operation_handle.v1"
        || typeof operationId !== "string"
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(operationId)
        || typeof requestDigest !== "string"
        || !/^hmac-sha256:[0-9a-f]{64}$/u.test(requestDigest)
        || (surface !== "chat" && surface !== "work")
        || !Number.isSafeInteger(revision)
        || revision < 1
        || !["prepared", "handoff_pending", "ready", "send_pending", "submitted", "generating", "capturing", "completed", "uncertain"].includes(String(phase))
        || !["none", "handoff_may_have_occurred", "send_may_have_occurred", "control_may_have_occurred"].includes(String(mutationBoundary))
        || (targetBindingDigest !== undefined
            && (typeof targetBindingDigest !== "string" || !/^hmac-sha256:[0-9a-f]{64}$/u.test(targetBindingDigest)))) {
        return undefined;
    }
    return Object.freeze({
        schemaVersion,
        operationId,
        requestDigest,
        surface,
        revision: revision,
        phase: phase,
        mutationBoundary: mutationBoundary,
        ...(targetBindingDigest === undefined ? {} : { targetBindingDigest })
    });
}
/** Never invoke a getter while extracting operation metadata from result data. */
function ownDataProperty(value, key) {
    if (!isRecord(value))
        return undefined;
    try {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
    }
    catch {
        return undefined;
    }
}
/** Enumerate data values without invoking getters or trusting proxy traps. */
function ownDataValues(value) {
    if (!isRecord(value))
        return [];
    try {
        const descriptors = Object.getOwnPropertyDescriptors(value);
        const values = [];
        for (const key of Reflect.ownKeys(descriptors)) {
            if (typeof key !== "string")
                continue;
            const descriptor = descriptors[key];
            if (descriptor !== undefined && "value" in descriptor)
                values.push(descriptor.value);
        }
        return values;
    }
    catch {
        return [];
    }
}
function enterResultRecord(value, seen, depth, budget) {
    if (!isRecord(value) || depth > MAX_RESULT_TRAVERSAL_DEPTH || budget.remaining <= 0)
        return false;
    if (seen.has(value))
        return false;
    seen.add(value);
    budget.remaining -= 1;
    return true;
}
function hashText(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
}
function threadRefFromContext(context) {
    const thread = {};
    if (context.url !== undefined)
        thread.url = context.url;
    if (context.conversationId !== undefined)
        thread.conversationId = context.conversationId;
    if (context.title !== undefined)
        thread.title = context.title;
    return Object.keys(thread).length === 0 ? undefined : thread;
}
function failedCommand(result) {
    if (result.steps === undefined)
        return undefined;
    for (let index = result.steps.length - 1; index >= 0; index -= 1) {
        const step = result.steps[index];
        if (step?.ok === false)
            return step.command;
    }
    return undefined;
}
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
