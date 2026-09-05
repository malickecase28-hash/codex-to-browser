import { resultError } from "../errors.js";
import { assertOperationAwareDispatchAllowed, CommandRoutingError, classifyCommandRouting, routeCommandRuntimeEnv } from "../runtime/command-routing.js";
import { downloadLatestArtifact, listLatestArtifacts, waitForArtifact } from "./artifacts.js";
import { applyConfiguration, inspectConfiguration } from "./configuration.js";
import { detectExperience, openExperience } from "./experience.js";
import { attachFiles, downloadLatestFile } from "./files.js";
import { addProjectSources, buildProjectSourceAddPlan, listProjectSources } from "./project-sources.js";
import { askMessage, composeMessage, messageStatus, readLatest, stopGeneration, submitMessage, waitAndRead, waitForMessage } from "./messages.js";
import { copyResponse } from "./response-actions.js";
import { bootstrap } from "./session.js";
import { newThread, openThread, searchThreads } from "./threads.js";
import { setMode, selectTool } from "./modes.js";
import { withCommandOutputText } from "./output.js";
import { readLatestWork, startWork, steerWork, waitForWork, workStatus } from "./work.js";
export const defaultSequencePolicy = {
    stopOnError: true,
    returnPartial: true,
    defaultTimeoutMs: 120000,
    screenshotOnBlocker: true,
    allowPromptResubmit: "only_if_no_matching_user_turn"
};
export async function runSequence(plan, env = {}) {
    return runSequenceWithExecutor(plan, executeStep, env);
}
export async function runSequenceWithExecutor(plan, executor, env = {}) {
    const policy = normalizePolicy(plan.policy);
    const stepResults = [];
    const values = new Map();
    const input = plan.input ?? {};
    for (const step of plan.steps) {
        const startedAt = new Date().toISOString();
        const resolvedStep = resolveStepArgs(step, values, input);
        const result = await executor(resolvedStep, env, values, policy);
        values.set(step.id, result);
        stepResults.push(toStepResult(step, result, startedAt));
        if (!result.ok && policy.stopOnError) {
            return sequenceFailure(result, values, stepResults, policy);
        }
    }
    const lastStep = plan.steps.at(-1);
    const finalResult = lastStep === undefined ? okSequenceResult(values, stepResults) : values.get(lastStep.id);
    if (finalResult === undefined) {
        return okSequenceResult(values, stepResults);
    }
    return withCommandOutputText({ ...finalResult, steps: stepResults });
}
export async function executeStep(step, env, previousResults) {
    // The sequence executor is a direct dispatch seam as well as a helper for
    // backend workflows. Keep it fail-closed if a runtime caller supplies a
    // command outside the explicit inventory. This guard does not acquire a
    // coordinator: legacy commands retain their existing behavior, while an
    // operation-aware request may use only an explicitly migrated facade seam.
    if (classifyCommandRouting(step.command) === undefined) {
        return resultError(new CommandRoutingError("unclassified_command"));
    }
    try {
        assertOperationAwareDispatchAllowed(step.command, step.args);
    }
    catch (error) {
        return resultError(error instanceof Error ? error : new Error(String(error)));
    }
    let routedEnv;
    try {
        // Legacy sequence steps receive a fresh coordinated facade. The facade
        // routes each browser/page method through the process-scoped coordinator;
        // this function never wraps the complete step, so waits, polling, report
        // work, and caller callbacks do not retain a tab actor.
        routedEnv = routeCommandRuntimeEnv(step.command, env);
    }
    catch (error) {
        return resultError(error instanceof Error ? error : new Error(String(error)));
    }
    switch (step.command) {
        case "session.bootstrap":
            return bootstrap(routedEnv, step.args);
        case "experience.detect":
            return detectExperience(routedEnv, step.args);
        case "experience.open":
            return openExperience(routedEnv, step.args);
        case "configuration.inspect":
            return inspectConfiguration(routedEnv, step.args);
        case "configuration.apply":
            return applyConfiguration(routedEnv, step.args);
        case "work.start":
            return startWork(routedEnv, step.args);
        case "work.status":
            return workStatus(routedEnv, step.args);
        case "work.wait":
            return waitForWork(routedEnv, step.args);
        case "work.steer":
            return steerWork(routedEnv, step.args);
        case "work.readLatest":
            return readLatestWork(routedEnv, step.args);
        case "threads.search":
            return searchThreads(routedEnv, step.args);
        case "threads.open":
            return openThread(routedEnv, step.args, previousResults);
        case "threads.new":
            return newThread(routedEnv, step.args);
        case "messages.compose":
            return composeMessage(routedEnv, step.args);
        case "messages.submit":
            return submitMessage(routedEnv, step.args);
        case "messages.ask":
            return askMessage(routedEnv, step.args);
        case "messages.wait":
            return waitForMessage(routedEnv, step.args);
        case "messages.readLatest":
            return readLatest(routedEnv, step.args);
        case "messages.status":
            return messageStatus(routedEnv, step.args);
        case "messages.stop":
            return stopGeneration(routedEnv, step.args);
        case "messages.waitAndRead":
            return waitAndRead(routedEnv, step.args);
        case "artifacts.listLatest":
            return listLatestArtifacts(routedEnv, step.args);
        case "artifacts.wait":
            return waitForArtifact(routedEnv, step.args);
        case "artifacts.downloadLatest":
            return downloadLatestArtifact(routedEnv, step.args);
        case "files.attach":
            return attachFiles(routedEnv, step.args);
        case "files.downloadLatest":
            return downloadLatestFile(routedEnv, step.args);
        case "projects.sources.list":
            return listProjectSources(routedEnv, step.args);
        case "projects.sources.planAdd":
            return buildProjectSourceAddPlan(routedEnv, step.args);
        case "projects.sources.add":
            return addProjectSources(routedEnv, step.args);
        case "response.copy":
            return copyResponse(routedEnv, step.args);
        case "modes.set":
            return setMode(routedEnv, step.args);
        case "tools.select":
            return selectTool(routedEnv, step.args);
    }
}
export function normalizePolicy(policy) {
    return { ...defaultSequencePolicy, ...(policy ?? {}) };
}
export function resolveStepArgs(step, previousResults, input = {}) {
    if (!("args" in step) || step.args === undefined) {
        return step;
    }
    return {
        ...step,
        args: resolveValue(step.args, previousResults, input)
    };
}
export function resolveVariableReference(reference, previousResults, input = {}) {
    const match = /^\$\{([^}]+)\}$/.exec(reference);
    if (match === null) {
        return reference;
    }
    const path = match[1];
    if (path === undefined || path.length === 0) {
        throw new Error("Empty variable reference is not allowed.");
    }
    if (path.includes("__proto__") || path.includes("prototype") || path.includes("constructor")) {
        throw new Error(`Unsafe variable reference rejected: ${path}`);
    }
    const [root, ...segments] = tokenizePath(path);
    let current;
    if (root === "input") {
        current = input;
    }
    else if (root !== undefined && previousResults.has(root)) {
        current = previousResults.get(root);
    }
    else {
        throw new Error(`Unknown variable root: ${root ?? ""}`);
    }
    for (const segment of segments) {
        current = readPathSegment(current, segment);
    }
    return current;
}
function resolveValue(value, previousResults, input) {
    if (typeof value === "string") {
        return resolveVariableReference(value, previousResults, input);
    }
    if (Array.isArray(value)) {
        return value.map(item => resolveValue(item, previousResults, input));
    }
    if (value !== null && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, resolveValue(child, previousResults, input)]));
    }
    return value;
}
function tokenizePath(path) {
    const segments = [];
    for (const part of path.split(".")) {
        const head = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(part)?.[1];
        if (head === undefined) {
            throw new Error(`Invalid variable path segment: ${part}`);
        }
        segments.push(head);
        for (const indexMatch of part.matchAll(/\[(\d+)\]/g)) {
            segments.push(indexMatch[1]);
        }
        const consumed = `${head}${Array.from(part.matchAll(/\[(\d+)\]/g)).map(match => `[${match[1]}]`).join("")}`;
        if (consumed !== part) {
            throw new Error(`Invalid variable path segment: ${part}`);
        }
    }
    return segments;
}
function readPathSegment(value, segment) {
    if (value === null || value === undefined) {
        return undefined;
    }
    if (Array.isArray(value)) {
        const index = Number(segment);
        if (!Number.isInteger(index)) {
            throw new Error(`Array segment must be numeric: ${segment}`);
        }
        return value[index];
    }
    if (typeof value === "object") {
        return value[segment];
    }
    return undefined;
}
function toStepResult(step, result, startedAt) {
    const stepResult = {
        id: step.id,
        command: step.command,
        status: result.status,
        ok: result.ok,
        startedAt,
        endedAt: new Date().toISOString(),
        warnings: result.warnings
    };
    const dataPreview = previewData(result.data);
    if (dataPreview !== undefined) {
        stepResult.dataPreview = dataPreview;
    }
    return stepResult;
}
function previewData(data) {
    if (data === undefined) {
        return undefined;
    }
    if (typeof data === "string") {
        return data.length > 120 ? `${data.slice(0, 119)}...` : data;
    }
    if (Array.isArray(data)) {
        return { type: "array", length: data.length };
    }
    if (typeof data === "object" && data !== null) {
        return Object.fromEntries(Object.entries(data).map(([key, value]) => {
            if (/text|prompt|response/i.test(key) && typeof value === "string") {
                return [key, value.length > 120 ? `${value.slice(0, 119)}...` : value];
            }
            return [key, value];
        }));
    }
    return data;
}
function sequenceFailure(result, values, stepResults, policy) {
    const failure = {
        ok: false,
        status: policy.returnPartial ? "partial" : result.status,
        data: collectSequenceData(values),
        warnings: collectWarnings(stepResults, result.warnings),
        context: result.context,
        steps: stepResults
    };
    if (result.error !== undefined) {
        failure.error = result.error;
    }
    if (result.blocker !== undefined) {
        failure.blocker = result.blocker;
    }
    return withCommandOutputText(failure);
}
function okSequenceResult(values, stepResults) {
    return withCommandOutputText({
        ok: true,
        status: "ok",
        data: collectSequenceData(values),
        warnings: collectWarnings(stepResults),
        context: { timestamp: new Date().toISOString() },
        steps: stepResults
    });
}
function collectSequenceData(values) {
    return Object.fromEntries(Array.from(values.entries()).map(([id, result]) => [id, result.data]));
}
function collectWarnings(stepResults, extra = []) {
    return [...stepResults.flatMap(step => step.warnings), ...extra];
}
