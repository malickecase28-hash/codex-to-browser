import { createHash } from "node:crypto";
import { readPageState } from "../browser/page-state.js";
import { resultError, resultOk } from "../errors.js";
import { EMPTY_GENERATION_STATE, latestAssistantTurnHasResponseActions, readAssistantGenerationState } from "../dom/generation-state.js";
import { countPageMessages, isTransientAssistantText, readLatestMessage, readLatestMessageText, readLatestMessageTextSnapshot, readMessages } from "../dom/messages.js";
import { composerTextbox, copyResponseButtons, sendButton, stopGenerationButton } from "../dom/selectors.js";
import { readWaitDomSnapshot, waitTextMetadata } from "../dom/wait-snapshot.js";
import { normalizeLineBreaks, normalizeWhitespace } from "../dom/visible-text.js";
import { contextFromPage } from "./context.js";
import { createDeadline, remainingMs } from "./deadline.js";
import { withCommandOutputText } from "./output.js";
import { createSingleFlightProbe } from "./probes.js";
import { ensurePage } from "./session.js";
import { withTimeout } from "./timeouts.js";
export function isResponseComplete(snapshot) {
    return snapshot.latestText.trim().length > 0
        && !isTransientAssistantText(snapshot.latestText)
        && snapshot.textStableForMs >= snapshot.stableMs
        && snapshot.generation.observed
        && !snapshot.generation.active
        && !snapshot.generation.stopped
        && snapshot.hasResponseActions;
}
export async function composeMessage(env, args) {
    const boot = await ensurePage(env);
    if (!boot.ok) {
        return boot;
    }
    const page = env.page;
    try {
        const textbox = composerTextbox(page);
        const text = args.mode === "append"
            ? `${await readLocatorText(textbox)}${args.text}`
            : args.text;
        await textbox.click?.();
        await textbox.fill?.(text);
        const actual = normalizeWhitespace(await readLocatorText(textbox));
        const wanted = normalizeWhitespace(text);
        if (actual !== wanted && actual.length > 0) {
            return {
                ok: false,
                status: "error",
                warnings: [],
                error: {
                    name: "ComposerVerificationError",
                    message: "Composer text did not match the requested prompt after fill.",
                    recoverable: true
                },
                context: await contextFromPage(page)
            };
        }
        return resultOk({ text }, await contextFromPage(page));
    }
    catch (error) {
        return resultError(error instanceof Error ? error : new Error(String(error)), await contextFromPage(page));
    }
}
export async function submitMessage(env, args = {}) {
    const boot = await ensurePage(env);
    if (!boot.ok) {
        return boot;
    }
    const page = env.page;
    const previousTurnCount = args.previousTurnCount ?? await countPageMessages(page).catch(() => undefined);
    try {
        const ready = await waitForSendButtonReady(page, args.timeoutMs ?? 30000);
        if (!ready.ready) {
            const blocker = {
                kind: ready.code === "attachment_processing" ? "upload_failed" : "selector_drift",
                code: ready.code,
                message: ready.message,
                remediation: [
                    {
                        label: "Wait for composer",
                        instruction: "Wait for ChatGPT's composer and attachments to become ready, then retry without manually changing the page.",
                        userActionRequired: false
                    }
                ],
                resumable: true
            };
            if (ready.visibleText !== undefined) {
                blocker.visibleText = ready.visibleText;
            }
            return {
                ok: false,
                status: "blocked",
                warnings: [],
                blocker,
                context: await contextFromPage(page)
            };
        }
        const timeoutMs = args.timeoutMs ?? 30000;
        const startedAt = Date.now();
        await clickSendControl(page);
        let userTurn = await waitForSubmittedUserTurn(page, args.text, previousTurnCount, initialSubmitWaitMs(timeoutMs));
        if (userTurn === undefined && Date.now() - startedAt < timeoutMs && await shouldRetryNoopSubmit(page, args.text)) {
            await sleep(page, 250);
            await clickSendControl(page);
            userTurn = await waitForSubmittedUserTurn(page, args.text, previousTurnCount, Math.max(0, timeoutMs - (Date.now() - startedAt)));
        }
        if (userTurn === undefined) {
            const latestUser = await readLatestMessage(page, "user", "normalized_text");
            const generation = await readAssistantGenerationState(page).catch(() => EMPTY_GENERATION_STATE);
            const turnCount = await countPageMessages(page).catch(() => undefined);
            if (submittedUserTurnMatches(latestUser?.text, args.text)) {
                return resultOk(submitData(latestUser?.text, turnCount, generation.active ? "submitted_generating" : "submitted", generation), await contextFromPage(page));
            }
            const turnAdvanced = previousTurnCount !== undefined && turnCount !== undefined && turnCount > previousTurnCount;
            if (turnAdvanced || generation.active) {
                return resultOk(submitData(undefined, turnCount, generation.active ? "submitted_generating" : "submitted_unconfirmed", generation), await contextFromPage(page), ["Submitted prompt could not be matched to a rendered user turn yet, but ChatGPT page state indicates progress."]);
            }
            return {
                ok: false,
                status: "timeout",
                warnings: await sendTimeoutWarnings(page),
                error: {
                    name: "SubmitTimeout",
                    message: "No matching submitted user turn appeared before the timeout.",
                    recoverable: true
                },
                context: await contextFromPage(page)
            };
        }
        return resultOk(submitData(userTurn, await countPageMessages(page).catch(() => undefined), "submitted", await readAssistantGenerationState(page).catch(() => EMPTY_GENERATION_STATE)), await contextFromPage(page));
    }
    catch (error) {
        return resultError(error instanceof Error ? error : new Error(String(error)), await contextFromPage(page));
    }
}
export async function stopGeneration(env, args = {}) {
    const timeoutMs = Math.max(1, args.timeoutMs ?? 5_000);
    const deadline = createDeadline(timeoutMs);
    if (args.confirmStop !== true) {
        return {
            ok: false,
            status: "needs_confirmation",
            warnings: [],
            blocker: {
                kind: "confirmation",
                code: "stop_generation_confirmation_required",
                fieldPath: "confirmStop",
                message: "Stopping the visible ChatGPT response requires an explicit caller decision.",
                resumable: true
            },
            context: env.page === undefined
                ? { timestamp: new Date().toISOString() }
                : await stopContext(env.page, deadline)
        };
    }
    let boot;
    try {
        boot = await withinStopDeadline(deadline, () => ensurePage(env, { minimalContext: true }), "ChatGPT page verification");
    }
    catch (error) {
        return stopDeadlineResult(error);
    }
    if (!boot.ok)
        return boot;
    const page = env.page;
    const warnings = new Set();
    let stopActivationStarted = false;
    let beforeActivation;
    try {
        const beforeProbeTimeoutMs = Math.min(1_000, Math.max(1, remainingMs(deadline)));
        const beforeResult = await readStopGenerationState(page, deadline, beforeProbeTimeoutMs);
        addWarnings(warnings, beforeResult.warnings);
        if (!beforeResult.ok || !beforeResult.value.observed) {
            if (remainingMs(deadline) <= 0) {
                return stopDeadlineResult(undefined, undefined, [...warnings]);
            }
            return {
                ok: false,
                status: "blocked",
                warnings: [...warnings],
                blocker: {
                    kind: "selector_drift",
                    code: "stop_generation_state_unavailable",
                    message: "ChatGPT generation state could not be inspected safely, so no control was clicked.",
                    resumable: true
                },
                context: await stopContext(page, deadline)
            };
        }
        const before = beforeResult.value;
        beforeActivation = before;
        if (!before.active) {
            return resultOk({
                wasGenerating: false,
                stopped: false,
                signalsBefore: before.signals,
                signalsAfter: before.signals
            }, await stopContext(page, deadline), [...warnings]);
        }
        const resolution = await resolveStopControl(page, deadline);
        if (!resolution.ok) {
            return {
                ok: false,
                status: "blocked",
                data: { wasGenerating: true, stopped: false, signalsBefore: before.signals, signalsAfter: before.signals },
                warnings: [...warnings],
                blocker: {
                    kind: "selector_drift",
                    code: resolution.code,
                    message: resolution.message,
                    resumable: true
                },
                context: await stopContext(page, deadline)
            };
        }
        stopActivationStarted = true;
        await withinNativeStopDeadline(deadline, timeoutMs => resolution.control.click?.({ timeoutMs })
            ?? Promise.reject(new Error("The resolved Stop control does not support click().")), "Stop control click");
        let after = EMPTY_GENERATION_STATE;
        while (remainingMs(deadline) > 0) {
            const afterProbeTimeoutMs = Math.min(1_000, Math.max(1, remainingMs(deadline)));
            const afterResult = await readStopGenerationState(page, deadline, afterProbeTimeoutMs);
            addWarnings(warnings, afterResult.warnings);
            if (afterResult.ok) {
                after = afterResult.value;
                if (after.observed && !after.active) {
                    return resultOk({
                        wasGenerating: true,
                        stopped: true,
                        signalsBefore: before.signals,
                        signalsAfter: after.signals
                    }, await stopContext(page, deadline), [...warnings]);
                }
            }
            await sleepWithinDeadline(page, deadline, 100);
        }
        const data = {
            wasGenerating: true,
            stopped: false,
            signalsBefore: before.signals,
            signalsAfter: after.signals
        };
        return stopDeadlineResult(undefined, data, [...warnings]);
    }
    catch (error) {
        if (remainingMs(deadline) <= 0 || error instanceof StopDeadlineError) {
            const data = stopActivationStarted && beforeActivation !== undefined
                ? {
                    wasGenerating: true,
                    stopped: false,
                    signalsBefore: beforeActivation.signals,
                    signalsAfter: beforeActivation.signals
                }
                : undefined;
            return stopDeadlineResult(error, data, [...warnings]);
        }
        return resultError(error instanceof Error ? error : new Error(String(error)), await stopContext(page, deadline));
    }
}
async function readStopGenerationState(page, deadline, capMs) {
    const timeoutMs = Math.min(capMs, remainingMs(deadline));
    if (timeoutMs <= 0) {
        return {
            ok: false,
            timedOut: true,
            warnings: ["Skipped generation state DOM probe because no deadline budget remained."]
        };
    }
    try {
        // readAssistantGenerationState propagates this one budget through its
        // evaluate/content fallbacks. Await it directly so no browser request is
        // abandoned behind an SDK-side Promise.race.
        const value = await readAssistantGenerationState(page, { timeoutMs });
        return { ok: true, value, warnings: [] };
    }
    catch (error) {
        return {
            ok: false,
            warnings: [`generation state DOM probe failed: ${error instanceof Error ? error.message : String(error)}`]
        };
    }
}
async function resolveStopControl(page, deadline) {
    const candidates = stopGenerationButton(page);
    if (typeof candidates.count !== "function") {
        return {
            ok: false,
            code: "stop_generation_control_unavailable",
            message: "ChatGPT is generating, but the Stop-control candidate set could not be enumerated safely."
        };
    }
    const count = await stopControlCount(candidates, deadline);
    if (count === 0) {
        return {
            ok: false,
            code: "stop_generation_control_unavailable",
            message: "ChatGPT is generating, but no visible Stop control was found."
        };
    }
    if (count > 8) {
        return {
            ok: false,
            code: "stop_generation_control_ambiguous",
            message: `ChatGPT exposed ${count} Stop-control candidates; refusing to choose among an unexpectedly broad set.`
        };
    }
    const eligible = [];
    for (let index = 0; index < count; index += 1) {
        const control = count === 1
            ? candidates
            : typeof candidates.nth === "function"
                ? candidates.nth(index)
                : undefined;
        if (control === undefined || typeof control.evaluate !== "function") {
            continue;
        }
        const evaluationTimeoutMs = Math.min(1_000, Math.max(1, remainingMs(deadline)));
        const scoped = await withinNativeStopDeadline(deadline, timeoutMs => control.evaluate((element) => {
            const button = element;
            if (button.closest("[hidden], [inert], [aria-hidden='true']") !== null)
                return false;
            if (button.disabled || button.getAttribute("aria-disabled") === "true")
                return false;
            const visible = (node) => {
                if (node.hidden || node.closest("[hidden], [inert], [aria-hidden='true']") !== null)
                    return false;
                const style = window.getComputedStyle(node);
                const rect = node.getBoundingClientRect();
                return style.display !== "none"
                    && style.visibility !== "hidden"
                    && style.opacity !== "0"
                    && style.pointerEvents !== "none"
                    && (rect.width > 0 || rect.height > 0);
            };
            const textboxes = Array.from(document.querySelectorAll("textarea, [contenteditable='true'], [role='textbox']")).filter(visible);
            const activeComposers = [...new Set(textboxes
                    .map(textbox => textbox.closest("form")
                    ?? textbox.closest("[data-testid*='composer' i]")
                    ?? textbox.closest("[aria-label*='composer' i]")
                    ?? textbox.closest("[class*='composer' i]"))
                    .filter((value) => value !== null))];
            return activeComposers.length === 1 && activeComposers[0].contains(button);
        }, undefined, { timeoutMs }), `Stop control ${index + 1} visibility and scope check`, evaluationTimeoutMs);
        if (scoped)
            eligible.push(control);
    }
    if (eligible.length === 1) {
        return { ok: true, control: eligible[0] };
    }
    if (eligible.length > 1) {
        return {
            ok: false,
            code: "stop_generation_control_ambiguous",
            message: `ChatGPT exposed ${eligible.length} visible Stop controls in active composer regions; no control was clicked.`
        };
    }
    return {
        ok: false,
        code: "stop_generation_control_unavailable",
        message: "ChatGPT is generating, but no uniquely scoped visible Stop control could be activated."
    };
}
async function stopControlCount(candidates, deadline) {
    if (typeof candidates.allTextContents === "function") {
        const values = await withinNativeStopDeadline(deadline, timeoutMs => candidates.allTextContents({ timeoutMs }), "Stop control enumeration", 1_000);
        return values.length;
    }
    return withinStopDeadline(deadline, () => candidates.count(), "Stop control enumeration");
}
async function withinStopDeadline(deadline, operation, label) {
    const budget = remainingMs(deadline);
    if (budget <= 0)
        throw new StopDeadlineError(label);
    try {
        return await withTimeout(operation(), budget, `${label} exceeded the messages.stop deadline.`);
    }
    catch (error) {
        if (remainingMs(deadline) <= 0)
            throw new StopDeadlineError(label);
        throw error;
    }
}
async function withinNativeStopDeadline(deadline, operation, label, capMs = 2_000) {
    const timeoutMs = Math.min(capMs, remainingMs(deadline));
    if (timeoutMs <= 0)
        throw new StopDeadlineError(label);
    try {
        // The Chrome bridge owns this timeout. Unlike Promise.race, a native
        // timeout terminates the browser request instead of abandoning it in flight.
        return await operation(timeoutMs);
    }
    catch (error) {
        if (remainingMs(deadline) <= 0 || isNativeBrowserTimeout(error)) {
            throw new StopDeadlineError(label);
        }
        throw error;
    }
}
function isNativeBrowserTimeout(error) {
    return error instanceof Error && /timed?\s*out|timeout/i.test(error.message);
}
async function sleepWithinDeadline(_page, deadline, requestedMs) {
    const waitMs = Math.min(requestedMs, Math.max(0, remainingMs(deadline) - 1));
    if (waitMs <= 0)
        return;
    // Polling does not require a browser round trip. A host timer cannot leave a
    // bridge request stranded after the Stop deadline.
    await new Promise(resolve => setTimeout(resolve, waitMs));
}
async function stopContext(page, _deadline) {
    return contextFromPage(page, {}, { minimal: true });
}
function stopDeadlineResult(error, data, warnings = []) {
    const message = data?.wasGenerating === true
        ? "Stop activation reached its browser-native deadline and was terminated, but the click may already have taken effect. Inspect the visible generation state and do not retry automatically."
        : "ChatGPT generation could not be inspected and stopped before the single operation deadline.";
    const result = {
        ok: false,
        status: "timeout",
        warnings: error === undefined
            ? warnings
            : [...warnings, error instanceof Error ? error.message : String(error)],
        blocker: {
            kind: "selector_drift",
            code: data?.wasGenerating === true ? "stop_generation_unverified" : "stop_generation_deadline_exhausted",
            message,
            resumable: data?.wasGenerating !== true
        },
        context: { timestamp: new Date().toISOString() }
    };
    if (data !== undefined)
        result.data = data;
    return result;
}
class StopDeadlineError extends Error {
    constructor(label) {
        super(`${label} could not complete before the messages.stop deadline.`);
        this.name = "StopDeadlineError";
    }
}
async function clickSendControl(page) {
    try {
        await sendButton(page).click?.();
    }
    catch {
        await page.keyboard?.press?.("Enter");
    }
}
function initialSubmitWaitMs(timeoutMs) {
    return Math.min(3000, Math.max(500, Math.floor(timeoutMs / 3)));
}
async function shouldRetryNoopSubmit(page, text) {
    const state = await readSendButtonState(page).catch(() => ({ available: false }));
    if (!isSendButtonReady(state)) {
        return false;
    }
    if (text === undefined) {
        return true;
    }
    const composerText = await readLocatorText(composerTextbox(page)).catch(() => "");
    return submittedUserTurnMatches(composerText, text);
}
async function waitForSendButtonReady(page, timeoutMs) {
    const started = Date.now();
    let lastState;
    let lastVisibleText;
    while (Date.now() - started < timeoutMs) {
        const state = await readSendButtonState(page).catch(() => ({ available: true }));
        lastState = state;
        if (isSendButtonReady(state)) {
            return { ready: true };
        }
        const visibleText = await readVisibleTextForSubmit(page).catch(() => undefined);
        if (visibleText !== undefined && /uploading|processing|attaching|preparing|reading|scanning/i.test(visibleText)) {
            lastVisibleText = visibleText.slice(0, 500);
        }
        await sleep(page, 250);
    }
    if (lastVisibleText !== undefined) {
        return {
            ready: false,
            code: "attachment_processing",
            message: "ChatGPT still appears to be processing an attachment, so the send button did not become ready.",
            visibleText: lastVisibleText
        };
    }
    return {
        ready: false,
        code: "send_button_not_ready",
        message: `ChatGPT's send button did not become ready before timeout.${describeSendState(lastState)}`
    };
}
function isSendButtonReady(state) {
    if (!state.available)
        return false;
    if (state.visible === false)
        return false;
    if (state.disabled === true)
        return false;
    if (state.busy === true)
        return false;
    return true;
}
async function readSendButtonState(page) {
    const locator = sendButton(page);
    if (typeof locator.count === "function" && await locator.count().catch(() => 1) === 0) {
        return { available: false, reason: "not_found" };
    }
    const visible = typeof locator.isVisible === "function" ? await locator.isVisible({ timeoutMs: 500 }).catch(() => undefined) : undefined;
    if (typeof locator.evaluate !== "function") {
        const state = { available: true };
        if (visible !== undefined)
            state.visible = visible;
        return state;
    }
    const evaluated = await locator.evaluate(element => {
        const htmlElement = element;
        const button = element;
        return {
            disabled: button.disabled === true
                || element.getAttribute("disabled") !== null
                || element.getAttribute("aria-disabled") === "true"
                || element.getAttribute("data-disabled") === "true",
            busy: element.getAttribute("aria-busy") === "true"
                || htmlElement.className.toString().toLocaleLowerCase().includes("loading"),
            label: element.getAttribute("aria-label")
                ?? element.getAttribute("title")
                ?? htmlElement.innerText
                ?? element.textContent
                ?? undefined
        };
    });
    const state = {
        available: true,
        disabled: evaluated.disabled,
        busy: evaluated.busy
    };
    if (visible !== undefined)
        state.visible = visible;
    if (evaluated.label !== undefined)
        state.label = evaluated.label;
    return state;
}
async function readVisibleTextForSubmit(page) {
    if (typeof page.evaluate !== "function") {
        return undefined;
    }
    // Attachment/upload status renders inside the composer form; prefer that region over
    // the whole page so the not-ready poll does not serialize the full document text.
    return page.evaluate(() => {
        const composerForm = document.querySelector("main form") ?? document.querySelector("form");
        const scopedText = composerForm?.innerText;
        if (scopedText !== undefined && scopedText.trim().length > 0) {
            return scopedText;
        }
        return document.body?.innerText ?? "";
    });
}
async function sendTimeoutWarnings(page) {
    const state = await readSendButtonState(page).catch(() => undefined);
    if (state === undefined || isSendButtonReady(state)) {
        return [];
    }
    return [`Send button state after submit timeout:${describeSendState(state)}`];
}
function describeSendState(state) {
    if (state === undefined)
        return "";
    const parts = [];
    if (!state.available)
        parts.push("available=false");
    if (state.visible !== undefined)
        parts.push(`visible=${state.visible}`);
    if (state.disabled !== undefined)
        parts.push(`disabled=${state.disabled}`);
    if (state.busy !== undefined)
        parts.push(`busy=${state.busy}`);
    if (state.label !== undefined && state.label.trim().length > 0)
        parts.push(`label=${JSON.stringify(state.label.trim().slice(0, 80))}`);
    if (state.reason !== undefined)
        parts.push(`reason=${state.reason}`);
    return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}
export async function waitForMessage(env, args = {}) {
    const boot = await ensurePage(env);
    if (!boot.ok) {
        return boot;
    }
    const page = env.page;
    const timeoutMs = args.timeoutMs ?? (args.mode === "deep_research" ? 1_800_000 : 120_000);
    const stableMs = args.stableMs ?? (args.mode === "deep_research" ? 10_000 : 2_000);
    const pollMs = args.pollMs ?? 750;
    const started = Date.now();
    const deadline = createDeadline(timeoutMs, started);
    const probeTimeoutMs = Math.max(50, Math.min(1000, Math.max(pollMs, Math.floor(timeoutMs / 4))));
    const waitWarnings = new Set();
    // One combined DOM probe per poll: counts, latest-text metadata, generation state, and
    // response actions come back in a single evaluate, sampled from the same DOM instant.
    // The full assistant text never crosses the bridge during polling; it is fetched once
    // at loop exit. Page-state blocker scans run on a coarser cadence below.
    const waitSnapshotProbe = createSingleFlightProbe("wait snapshot", readWaitDomSnapshot);
    const pageStateProbe = createSingleFlightProbe("page state", readPageState);
    const PAGE_STATE_POLL_STRIDE = 4;
    let pollIndex = 0;
    let lastTargetKey = "";
    let lastChangedAt = Date.now();
    let lastObservedTextLength = 0;
    let latestAssistantCount = await countPageMessages(page, "assistant").catch(() => 0);
    let lastGeneration = EMPTY_GENERATION_STATE;
    while (Date.now() - started < timeoutMs) {
        const probeResult = await waitSnapshotProbe(page, deadline, { timeoutMs: probeTimeoutMs });
        addWarnings(waitWarnings, probeResult.warnings);
        const snapshot = await waitSnapshotFromProbeResult(page, probeResult, latestAssistantCount);
        latestAssistantCount = snapshot.assistantTurnCount;
        const targetReached = waitTargetReached(args, snapshot);
        const targetKey = targetReached && snapshot.text.length > 0
            ? `${snapshot.text.length}:${snapshot.text.hash}`
            : "";
        if (targetKey !== lastTargetKey) {
            lastTargetKey = targetKey;
            lastChangedAt = Date.now();
        }
        if (targetReached && snapshot.text.length > 0) {
            lastObservedTextLength = snapshot.text.length;
        }
        if (pollIndex % PAGE_STATE_POLL_STRIDE === 0) {
            const state = await pageStateFromProbe(pageStateProbe(page, deadline, { timeoutMs: probeTimeoutMs }), waitWarnings);
            if (state?.blocker !== undefined && state.blocker.kind !== "modal") {
                return {
                    ok: false,
                    status: "blocked",
                    warnings: [...waitWarnings],
                    blocker: state.blocker,
                    context: await contextFromPage(page)
                };
            }
        }
        pollIndex += 1;
        const hasResponseActions = await resolveResponseActions(page, snapshot);
        lastGeneration = snapshot.generation;
        if (targetReached && snapshot.generation.stopped && snapshot.text.length > 0) {
            const stoppedText = normalizeWhitespace(await fetchLatestAssistantText(page) ?? "");
            // A failed re-read must not fabricate an empty capture: real text was observed in
            // the snapshot, so omit response content entirely and tell the caller how to get it.
            const data = stoppedText.length > 0
                ? waitDataFromText(args, false, stoppedText, latestAssistantCount, Date.now() - started)
                : waitDataWithoutText(latestAssistantCount, Date.now() - started);
            data.completionState = "stopped";
            data.generationActive = snapshot.generation.active;
            data.generationSignals = snapshot.generation.signals;
            if (stoppedText.length === 0) {
                waitWarnings.add(`The interrupted assistant text (~${snapshot.text.length} chars observed) could not be re-read at wait exit; call messages.readLatest on the same thread to capture it.`);
            }
            return withCommandOutputText({
                ok: false,
                status: "partial",
                data,
                warnings: [
                    ...waitWarnings,
                    ...(stoppedText.length > 0 ? responseContentWarnings(args, false) : []),
                    "ChatGPT generation appears to have been stopped or interrupted before completion.",
                    ...snapshot.generation.signals.map(signal => `Generation state signal: ${signal}`)
                ],
                context: await contextFromPage(page)
            });
        }
        const metadataComplete = targetReached
            && snapshot.text.length > 0
            && !snapshot.text.transient
            && Date.now() - lastChangedAt >= stableMs
            && snapshot.generation.observed
            && !snapshot.generation.active
            && !snapshot.generation.stopped
            && hasResponseActions;
        if (metadataComplete) {
            // Fetch the text once and confirm it still matches the stable snapshot before
            // declaring completion; a hash mismatch means the answer moved on mid-fetch.
            const latestText = normalizeWhitespace(await fetchLatestAssistantText(page) ?? "");
            const fetchedMetadata = waitTextMetadata(latestText);
            const completionSnapshot = {
                latestText,
                stableMs,
                textStableForMs: Date.now() - lastChangedAt,
                generation: snapshot.generation,
                hasResponseActions
            };
            if (fetchedMetadata.hash === snapshot.text.hash && isResponseComplete(completionSnapshot)) {
                const data = waitDataFromText(args, true, latestText, latestAssistantCount, Date.now() - started);
                data.completionState = "complete";
                data.generationActive = false;
                data.generationSignals = snapshot.generation.signals;
                return withCommandOutputText(resultOk(data, await contextFromPage(page), [...waitWarnings, ...responseContentWarnings(args, true)]));
            }
            if (latestText.length > 0) {
                lastTargetKey = `${fetchedMetadata.length}:${fetchedMetadata.hash}`;
                lastChangedAt = Date.now();
                lastObservedTextLength = fetchedMetadata.length;
            }
        }
        await sleep(page, pollMs);
    }
    if (lastObservedTextLength > 0) {
        const partialText = await fetchLatestAssistantText(page);
        if (partialText !== undefined && normalizeWhitespace(partialText).length > 0) {
            const normalizedPartialText = normalizeWhitespace(partialText);
            const data = waitDataFromText(args, false, normalizedPartialText, latestAssistantCount, Date.now() - started);
            data.completionState = completionStateFromGeneration(lastGeneration, false, normalizedPartialText.length > 0);
            data.generationActive = lastGeneration.active;
            data.generationSignals = lastGeneration.signals;
            return withCommandOutputText({
                ok: false,
                status: "partial",
                data,
                warnings: [...waitWarnings, ...responseContentWarnings(args, false), "Timed out after receiving partial assistant text."],
                context: await contextFromPage(page)
            });
        }
        waitWarnings.add(`Partial assistant text (${lastObservedTextLength} chars) was observed during polling but could not be re-read at wait exit.`);
    }
    return {
        ok: false,
        status: "timeout",
        warnings: [...waitWarnings],
        error: {
            name: "WaitTimeout",
            message: "No assistant response appeared before the timeout.",
            recoverable: true
        },
        context: await contextFromPage(page)
    };
}
async function fetchLatestAssistantText(page) {
    const first = await readLatestMessageText(page, "assistant").catch(() => undefined);
    if (first !== undefined) {
        return first;
    }
    // One retry: exit-time reads race DOM reflow/navigation, and a transient failure here
    // would otherwise discard an answer the polling snapshots proved exists.
    await sleep(page, 150);
    return readLatestMessageText(page, "assistant").catch(() => undefined);
}
function waitDataWithoutText(assistantTurnCount, elapsedMs) {
    return { complete: false, assistantTurnCount, elapsedMs };
}
async function resolveResponseActions(page, snapshot) {
    if (snapshot.hasResponseActions !== undefined) {
        return snapshot.hasResponseActions;
    }
    // No conversation-turn markers: fall back to the structural copy-button locator, as
    // the standalone response-actions probe does.
    try {
        const copyButtons = copyResponseButtons(page);
        const count = await copyButtons.count?.();
        if (count !== undefined) {
            return count > 0;
        }
        return await copyButtons.isVisible?.() === true;
    }
    catch {
        return false;
    }
}
async function waitSnapshotFromProbeResult(page, result, previousAssistantTurnCount) {
    if (result.ok && result.value !== undefined) {
        return result.value;
    }
    if (!result.ok && (result.timedOut === true || result.skipped === true)) {
        return {
            turnCount: 0,
            assistantTurnCount: previousAssistantTurnCount,
            text: waitTextMetadata(""),
            generation: EMPTY_GENERATION_STATE,
            hasResponseActions: false
        };
    }
    return fallbackWaitSnapshot(page, previousAssistantTurnCount);
}
/**
 * Degraded snapshot for pages where the combined evaluate is unavailable or failed.
 * Reuses the standalone facet probes, which carry their own content/locator fallbacks;
 * text metadata is computed SDK-side from the extracted text.
 */
async function fallbackWaitSnapshot(page, previousAssistantTurnCount) {
    const progress = await fallbackAssistantProgressSnapshot(page, previousAssistantTurnCount);
    const generation = await readAssistantGenerationState(page).catch(() => EMPTY_GENERATION_STATE);
    const hasResponseActions = await latestAssistantTurnHasResponseActions(page).catch(() => false);
    const snapshot = {
        turnCount: progress.turnCount ?? 0,
        assistantTurnCount: progress.assistantTurnCount,
        text: waitTextMetadata(progress.latestText),
        generation,
        hasResponseActions
    };
    if (progress.latestAssistantTurnIndex !== undefined) {
        snapshot.latestAssistantTurnIndex = progress.latestAssistantTurnIndex;
    }
    return snapshot;
}
function waitDataFromText(args, complete, responseText, assistantTurnCount, elapsedMs) {
    const data = {
        complete,
        assistantTurnCount,
        elapsedMs
    };
    if (args.responseContent === "metadata") {
        data.responseContent = "metadata";
        data.responseChars = responseText.length;
        data.responseSha256 = createHash("sha256").update(responseText).digest("hex");
        return data;
    }
    data.responseText = responseText;
    return data;
}
function responseContentWarnings(args, complete) {
    if (args.responseContent !== "metadata")
        return [];
    return [
        complete
            ? "Assistant response text was omitted because responseContent is metadata; call readLatest to capture the completed answer."
            : "Partial assistant text was omitted because responseContent is metadata; call wait again on the same thread or readLatest after completion."
    ];
}
async function pageStateFromProbe(probe, warnings) {
    const result = await probe;
    addWarnings(warnings, result.warnings);
    return result.ok ? result.value : undefined;
}
function addWarnings(target, warnings) {
    for (const warning of warnings) {
        target.add(warning);
    }
}
export async function readLatest(env, args = {}) {
    const boot = await ensurePage(env);
    if (!boot.ok) {
        return boot;
    }
    const page = env.page;
    const role = args.role ?? "assistant";
    const format = args.format ?? "markdown";
    const latest = await readLatestMessage(page, role, format, args.maxChars);
    if (latest === undefined) {
        return {
            ok: false,
            status: "not_found",
            warnings: [],
            blocker: {
                kind: "not_found",
                message: `No ${role} message is currently loaded.`
            },
            context: await contextFromPage(page)
        };
    }
    const data = { role, text: latest.text, format: latest.format };
    if (latest.source !== undefined)
        data.source = latest.source;
    if (latest.fidelity !== undefined)
        data.fidelity = latest.fidelity;
    if (latest.captureLimit !== undefined)
        data.captureLimit = latest.captureLimit;
    if (latest.warnings !== undefined)
        data.warnings = latest.warnings;
    if (latest.markdown !== undefined)
        data.markdown = latest.markdown;
    if (latest.visibleText !== undefined)
        data.visibleText = latest.visibleText;
    if (latest.normalizedText !== undefined)
        data.normalizedText = latest.normalizedText;
    if (latest.html !== undefined)
        data.html = latest.html;
    if (latest.blocks !== undefined)
        data.blocks = latest.blocks;
    if (latest.citations !== undefined)
        data.citations = latest.citations;
    if (latest.codeBlocks !== undefined)
        data.codeBlocks = latest.codeBlocks;
    if (latest.tables !== undefined)
        data.tables = latest.tables;
    if (latest.branch !== undefined)
        data.branch = latest.branch;
    if (latest.actions !== undefined)
        data.actions = latest.actions;
    if (latest.thoughtDurationText !== undefined)
        data.thoughtDurationText = latest.thoughtDurationText;
    if (latest.sourcesAvailable !== undefined)
        data.sourcesAvailable = latest.sourcesAvailable;
    if (role === "assistant") {
        const generation = await readAssistantGenerationState(page).catch(() => EMPTY_GENERATION_STATE);
        data.completionState = completionStateFromGeneration(generation, undefined, latest.text.trim().length > 0);
        data.generationActive = generation.active;
        data.generationSignals = generation.signals;
    }
    return withCommandOutputText(resultOk(data, await contextFromPage(page), data.warnings ?? []));
}
export async function messageStatus(env, args = {}) {
    const boot = await ensurePage(env);
    if (!boot.ok) {
        return boot;
    }
    const page = env.page;
    // Reuse the combined wait-snapshot evaluate for counts and generation state in a single
    // round trip; it never carries full assistant text, so a bounded preview is fetched
    // separately below only when the snapshot proves an assistant turn has text.
    const snapshot = await readWaitDomSnapshot(page).catch(() => undefined) ?? await fallbackWaitSnapshot(page, 0);
    const maxPreviewChars = Math.max(0, args.maxPreviewChars ?? 240);
    const latestText = snapshot.text.length > 0
        ? normalizeWhitespace(await fetchLatestAssistantText(page) ?? "")
        : "";
    const data = {
        turnCount: snapshot.turnCount,
        assistantTurnCount: snapshot.assistantTurnCount,
        completionState: completionStateFromGeneration(snapshot.generation, undefined, latestText.length > 0),
        generationActive: snapshot.generation.active,
        generationSignals: snapshot.generation.signals
    };
    if (snapshot.latestAssistantTurnIndex !== undefined)
        data.latestAssistantTurnIndex = snapshot.latestAssistantTurnIndex;
    if (latestText.length > 0) {
        data.latestAssistantTextLength = latestText.length;
        data.latestAssistantPreview = latestText.length > maxPreviewChars
            ? `${latestText.slice(0, Math.max(0, maxPreviewChars - 1))}...`
            : latestText;
    }
    return resultOk(data, await contextFromPage(page));
}
export async function askMessage(env, args) {
    const normalizedPrompt = normalizeAskPrompt(args);
    if (!normalizedPrompt.ok) {
        return normalizedPrompt.result;
    }
    const prompt = normalizedPrompt.text;
    const boot = await ensurePage(env);
    if (!boot.ok) {
        return boot;
    }
    const page = env.page;
    const beforeTurnCount = await countPageMessages(page).catch(() => undefined);
    const beforeAssistantTurnCount = await countPageMessages(page, "assistant").catch(() => undefined);
    const composeArgs = { text: prompt, mode: "replace" };
    if (args.timeoutMs !== undefined) {
        composeArgs.timeoutMs = args.timeoutMs;
    }
    const compose = await composeMessage(env, composeArgs);
    if (!compose.ok) {
        return forwardFailure(compose);
    }
    const submitArgs = { text: prompt };
    if (beforeTurnCount !== undefined) {
        submitArgs.previousTurnCount = beforeTurnCount;
    }
    if (args.timeoutMs !== undefined) {
        submitArgs.timeoutMs = args.timeoutMs;
    }
    const submit = await submitMessage(env, submitArgs);
    if (!submit.ok) {
        return forwardFailure(submit);
    }
    const readRequested = args.read === true || typeof args.read === "object";
    let waitResult;
    let waitFailure;
    if (args.wait === true || typeof args.wait === "object") {
        const waitArgs = typeof args.wait === "object" ? { ...args.wait } : {};
        if (beforeTurnCount !== undefined) {
            waitArgs.afterTurnCount = beforeTurnCount;
        }
        if (beforeAssistantTurnCount !== undefined) {
            waitArgs.afterAssistantTurnCount = beforeAssistantTurnCount;
        }
        waitResult = await waitForMessage(env, waitArgs);
        if (!waitResult.ok) {
            if (waitResult.status === "partial") {
                waitFailure = waitResult;
            }
            else {
                if (!readRequested || readRole(args.read) === "user") {
                    return forwardFailure(waitResult);
                }
                waitFailure = waitResult;
            }
        }
    }
    let responseText = waitResult?.data?.responseText;
    const warnings = [];
    if (readRequested) {
        const read = await readLatest(env, typeof args.read === "object" ? args.read : {});
        if (read.ok) {
            if (waitFailure !== undefined && !readCapturedNewAssistantTurn(read, beforeTurnCount, beforeAssistantTurnCount)) {
                return forwardFailure(waitFailure);
            }
            responseText = read.data?.text;
            warnings.push(...read.warnings);
            if (waitFailure !== undefined) {
                warnings.push(...waitFailure.warnings, `Assistant response was read after ${waitFailure.status}, but completion was not confirmed by the wait step.`);
            }
        }
        else if (responseText === undefined) {
            return forwardFailure(waitFailure ?? read);
        }
    }
    if (waitFailure !== undefined && responseText === undefined) {
        return forwardFailure(waitFailure);
    }
    const state = await readPageState(page).catch(() => undefined);
    const data = { prompt };
    const complete = waitResult?.data?.complete ?? (waitResult === undefined ? undefined : false);
    if (complete !== undefined) {
        data.complete = complete;
    }
    if (responseText !== undefined) {
        data.responseText = responseText;
    }
    if (state?.conversationId !== undefined) {
        data.conversationId = state.conversationId;
    }
    if (state?.title !== undefined) {
        data.title = state.title;
    }
    applyMessageState(data, submit.data, waitResult?.data);
    if (waitFailure !== undefined) {
        data.complete = false;
        return withCommandOutputText({
            ok: false,
            status: "partial",
            data,
            warnings: [
                ...warnings,
                `Assistant response was read after ${waitFailure.status}, but completion was not confirmed.`
            ],
            context: await contextFromPage(page)
        });
    }
    return withCommandOutputText(resultOk(data, await contextFromPage(page), warnings));
}
export async function waitAndRead(env, args = {}) {
    const wait = await waitForMessage(env, args);
    if (!wait.ok && wait.status !== "partial") {
        return forwardFailure(wait);
    }
    const read = await readLatest(env, args);
    if (!read.ok) {
        if (wait.data?.responseText !== undefined) {
            return withCommandOutputText({
                ok: wait.ok,
                status: wait.status,
                data: {
                    prompt: "",
                    responseText: wait.data.responseText,
                    complete: wait.data.complete
                },
                warnings: wait.warnings,
                context: wait.context
            });
        }
        return forwardFailure(read);
    }
    const data = askReadData("", read.data?.text, wait.data?.complete, wait.data, read.data);
    const warnings = [...read.warnings, ...wait.warnings];
    if (!wait.ok && wait.status === "partial") {
        data.complete = false;
        return withCommandOutputText({
            ok: false,
            status: "partial",
            data,
            warnings: [
                ...warnings,
                "Assistant response was read after partial wait, but completion was not confirmed."
            ],
            context: read.context
        });
    }
    return withCommandOutputText(resultOk(data, read.context, warnings));
}
async function waitForSubmittedUserTurn(page, text, previousTurnCount, timeoutMs) {
    const started = Date.now();
    const wanted = text === undefined ? undefined : normalizeWhitespace(text);
    while (Date.now() - started < timeoutMs) {
        const snapshot = await readLatestMessageTextSnapshot(page, "user").catch(() => undefined);
        const latestText = snapshot?.latestText;
        const turnCount = snapshot?.turnCount;
        const countIncreased = previousTurnCount === undefined || (turnCount !== undefined && turnCount > previousTurnCount);
        const latestMatches = submittedUserTurnMatches(latestText, wanted);
        if (latestText !== undefined && countIncreased && latestMatches) {
            return latestText;
        }
        await sleep(page, 250);
    }
    return undefined;
}
export function submittedUserTurnMatches(actual, wanted) {
    if (wanted === undefined) {
        return actual !== undefined && normalizeWhitespace(actual).length > 0;
    }
    const normalizedActual = normalizeWhitespace(actual ?? "");
    const normalizedWanted = normalizeWhitespace(wanted);
    if (normalizedActual === normalizedWanted || normalizedActual.includes(normalizedWanted)) {
        return true;
    }
    const renderedActual = normalizeSubmittedTurnRenderedText(actual ?? "");
    const renderedWanted = normalizeSubmittedTurnRenderedText(wanted);
    if (renderedActual === renderedWanted || renderedActual.includes(renderedWanted)) {
        return true;
    }
    const structuralActual = normalizeSubmittedTurnText(actual ?? "");
    const structuralWanted = normalizeSubmittedTurnText(wanted);
    if (structuralActual === structuralWanted || structuralActual.includes(structuralWanted)) {
        return true;
    }
    const structuralActualWithoutLanguage = normalizeSubmittedTurnText(actual ?? "", false);
    const structuralWantedWithoutLanguage = normalizeSubmittedTurnText(wanted, false);
    return structuralActualWithoutLanguage === structuralWantedWithoutLanguage
        || structuralActualWithoutLanguage.includes(structuralWantedWithoutLanguage);
}
function normalizeSubmittedTurnRenderedText(text) {
    return normalizeWhitespace(renderSubmittedTurnMarkdownSyntax(text));
}
function normalizeSubmittedTurnText(text, preserveFenceLanguage = true) {
    return normalizeWhitespace(renderSubmittedTurnMarkdownSyntax(text, preserveFenceLanguage)
        .replace(/^\s{0,3}#{1,6}\s+/gm, "")
        .replace(/^\s*[-*+]\s+/gm, "")
        .replace(/\|/g, " ")
        .replace(/(?:^|\s)-{3,}(?:\s|$)/g, " "));
}
function renderSubmittedTurnMarkdownSyntax(text, preserveFenceLanguage = true) {
    return normalizeLineBreaks(text)
        .replace(/```[ \t]*([a-z0-9_+#.-]+)?/gi, (_match, language) => language && preserveFenceLanguage ? `\n${language}\n` : "\n")
        .replace(/~~~[ \t]*([a-z0-9_+#.-]+)?/gi, (_match, language) => language && preserveFenceLanguage ? `\n${language}\n` : "\n")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
        .replace(/\*\*([^*]+)\*\*/g, "$1")
        .replace(/__([^_]+)__/g, "$1")
        .replace(/\*([^*]+)\*/g, "$1")
        .replace(/_([^_]+)_/g, "$1");
}
async function fallbackAssistantProgressSnapshot(page, previousAssistantTurnCount) {
    const messages = await readMessages(page, { format: "normalized_text" }).catch(() => undefined);
    if (messages !== undefined) {
        let latestAssistantTurnIndex = -1;
        for (let index = messages.length - 1; index >= 0; index -= 1) {
            if (messages[index]?.role === "assistant") {
                latestAssistantTurnIndex = index;
                break;
            }
        }
        const assistantMessages = messages.filter(message => message.role === "assistant");
        const snapshot = {
            turnCount: messages.length,
            assistantTurnCount: assistantMessages.length
        };
        const latestAssistant = latestAssistantTurnIndex === -1 ? undefined : messages[latestAssistantTurnIndex];
        if (latestAssistant?.text !== undefined)
            snapshot.latestText = latestAssistant.text;
        if (latestAssistantTurnIndex !== -1)
            snapshot.latestAssistantTurnIndex = latestAssistantTurnIndex + 1;
        return snapshot;
    }
    const snapshot = {
        assistantTurnCount: await countPageMessages(page, "assistant").catch(() => previousAssistantTurnCount)
    };
    const latestText = await readLatestMessageText(page, "assistant").catch(() => undefined);
    const turnCount = await countPageMessages(page).catch(() => undefined);
    if (latestText !== undefined)
        snapshot.latestText = latestText;
    if (turnCount !== undefined)
        snapshot.turnCount = turnCount;
    return snapshot;
}
function waitTargetReached(args, snapshot) {
    const assistantTargetReached = args.afterAssistantTurnCount === undefined
        || snapshot.assistantTurnCount > args.afterAssistantTurnCount;
    const turnTargetReached = args.afterTurnCount === undefined
        || (snapshot.latestAssistantTurnIndex !== undefined
            ? snapshot.latestAssistantTurnIndex > args.afterTurnCount
            : snapshot.turnCount !== undefined && snapshot.turnCount > args.afterTurnCount);
    return assistantTargetReached && turnTargetReached;
}
async function readLocatorText(locator) {
    if (typeof locator.innerText === "function") {
        return locator.innerText().catch(() => "");
    }
    if (typeof locator.textContent === "function") {
        return locator.textContent().then(text => text ?? "").catch(() => "");
    }
    return "";
}
async function sleep(page, ms) {
    if (typeof page.waitForTimeout === "function") {
        await page.waitForTimeout(ms);
        return;
    }
    await new Promise(resolve => setTimeout(resolve, ms));
}
function submitData(userTurnText, turnCount, submissionState, generation) {
    const data = { submitted: true };
    if (userTurnText !== undefined) {
        data.userTurnText = userTurnText;
    }
    if (turnCount !== undefined) {
        data.turnCount = turnCount;
    }
    data.submissionState = submissionState;
    data.completionState = completionStateFromGeneration(generation);
    data.generationActive = generation.active;
    data.generationSignals = generation.signals;
    return data;
}
function askReadData(prompt, responseText, complete, wait, read) {
    const data = { prompt };
    if (responseText !== undefined) {
        data.responseText = responseText;
    }
    if (complete !== undefined) {
        data.complete = complete;
    }
    applyMessageState(data, undefined, wait, read);
    return data;
}
function applyMessageState(data, submit, wait, read) {
    if (submit?.submissionState !== undefined)
        data.submissionState = submit.submissionState;
    const completionState = wait?.completionState ?? read?.completionState ?? submit?.completionState;
    if (completionState !== undefined)
        data.completionState = completionState;
    const generationActive = wait?.generationActive ?? read?.generationActive ?? submit?.generationActive;
    if (generationActive !== undefined)
        data.generationActive = generationActive;
    const generationSignals = wait?.generationSignals ?? read?.generationSignals ?? submit?.generationSignals;
    if (generationSignals !== undefined)
        data.generationSignals = generationSignals;
}
function completionStateFromGeneration(generation, complete, hasPartialText = false) {
    if (complete === true)
        return "complete";
    if (generation.active)
        return "generating";
    if (generation.stopped)
        return "stopped";
    if (complete === false || hasPartialText)
        return "partial";
    return "unknown";
}
function normalizeAskPrompt(args) {
    const text = args.text;
    const prompt = args.prompt;
    if (text !== undefined && prompt !== undefined && text !== prompt) {
        return {
            ok: false,
            result: {
                ok: false,
                status: "error",
                warnings: [],
                error: {
                    name: "InvalidAskArgs",
                    message: "messages.ask received both text and prompt with different values.",
                    recoverable: false
                },
                context: { timestamp: new Date().toISOString() }
            }
        };
    }
    const normalized = text ?? prompt;
    if (normalized === undefined || normalized.trim().length === 0) {
        return {
            ok: false,
            result: {
                ok: false,
                status: "error",
                warnings: [],
                error: {
                    name: "InvalidAskArgs",
                    message: "messages.ask requires a non-empty text or prompt argument.",
                    recoverable: false
                },
                context: { timestamp: new Date().toISOString() }
            }
        };
    }
    return { ok: true, text: normalized };
}
function readRole(read) {
    return typeof read === "object" ? read.role : undefined;
}
function readCapturedNewAssistantTurn(read, beforeTurnCount, beforeAssistantTurnCount) {
    const assistantAdvanced = beforeAssistantTurnCount === undefined
        || (read.context.assistantTurnCount !== undefined && read.context.assistantTurnCount > beforeAssistantTurnCount);
    const turnAdvanced = beforeTurnCount === undefined
        || (read.context.turnCount !== undefined && read.context.turnCount > beforeTurnCount);
    return assistantAdvanced && turnAdvanced;
}
function forwardFailure(result) {
    const forwarded = {
        ok: false,
        status: result.status,
        warnings: result.warnings,
        context: result.context
    };
    if (result.error !== undefined) {
        forwarded.error = result.error;
    }
    if (result.blocker !== undefined) {
        forwarded.blocker = result.blocker;
    }
    if (result.steps !== undefined) {
        forwarded.steps = result.steps;
    }
    return forwarded;
}
