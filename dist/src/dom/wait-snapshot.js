import { localeLabels } from "./locale-labels.js";
import { isTransientAssistantText } from "./messages.js";
import { normalizeWhitespace } from "./visible-text.js";
/**
 * SDK-side twin of the in-page metadata computation. The transient check delegates to
 * dom/messages.ts isTransientAssistantText — the ground truth used by isResponseComplete —
 * so only the in-page copy below is a true duplicate. The evaluate callback inlines the
 * same normalization, hash, and transient rules because serialized callbacks cannot close
 * over imports; `wait-snapshot.test.ts` pins the in-page copy to this helper (and thereby,
 * transitively, to the ground truth).
 */
export function waitTextMetadata(rawText) {
    const normalized = normalizeWhitespace(rawText ?? "");
    return {
        length: normalized.length,
        hash: fnv1a32Hex(normalized),
        transient: isTransientAssistantText(normalized)
    };
}
export function fnv1a32Hex(text) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
}
export async function readWaitDomSnapshot(page) {
    if (typeof page.evaluate !== "function") {
        return undefined;
    }
    return page.evaluate((args) => {
        const __combinedWaitSnapshot = true;
        void __combinedWaitSnapshot;
        const normalizeWs = (value) => value.replace(/\s+/g, " ").trim();
        const normalizeLower = (value) => (value ?? "").trim().toLowerCase();
        // --- Progress: turn counts and latest assistant text metadata (no text transfer) ---
        const nodes = Array.from(document.querySelectorAll("[data-message-author-role]"));
        const assistantNodes = nodes.filter(node => node.getAttribute("data-message-author-role") === "assistant");
        const latestAssistant = assistantNodes.at(-1);
        const latestAssistantTurnIndex = latestAssistant === undefined ? undefined : nodes.indexOf(latestAssistant) + 1;
        const normalizedText = normalizeWs(latestAssistant?.innerText ?? latestAssistant?.textContent ?? "");
        let hash = 0x811c9dc5;
        for (let index = 0; index < normalizedText.length; index += 1) {
            hash ^= normalizedText.charCodeAt(index);
            hash = Math.imul(hash, 0x01000193);
        }
        const textHash = (hash >>> 0).toString(16).padStart(8, "0");
        const trimmedForTransient = normalizedText.replace(/[.。…]+$/g, "").trim().toLowerCase();
        const transient = args.transient.some(phrase => trimmedForTransient === phrase.toLowerCase())
            || /^analyzing (?:the )?images?$/.test(trimmedForTransient)
            || /^processing (?:the )?images?$/.test(trimmedForTransient)
            || /^reading (?:the )?images?$/.test(trimmedForTransient);
        // --- Generation state: mirrors dom/generation-state.ts readAssistantGenerationState ---
        const isVisible = (element) => {
            if (element.hidden || element.closest("[hidden], [inert], [aria-hidden='true']") !== null) {
                return false;
            }
            const style = window.getComputedStyle(element);
            if (style.display === "none"
                || style.visibility === "hidden"
                || style.opacity === "0"
                || style.pointerEvents === "none") {
                return false;
            }
            const rect = element.getBoundingClientRect();
            return rect.width > 0 || rect.height > 0;
        };
        const elementValues = (element) => [
            element.getAttribute("aria-label"),
            element.getAttribute("title"),
            element.innerText,
            element.textContent
        ].map(normalizeLower).filter(Boolean);
        const matchingLabels = (element, phrases) => {
            const values = elementValues(element);
            return phrases.filter(phrase => values.includes(normalizeLower(phrase)));
        };
        const isScopedStopControl = (button) => {
            if (button.matches("[data-testid='stop-button'], [data-testid*='stop' i]"))
                return true;
            if (button.closest("[data-testid*='composer' i], [aria-label*='composer' i]") !== null)
                return true;
            const form = button.closest("form");
            return form?.querySelector("textarea, [contenteditable='true'], [role='textbox']") !== null;
        };
        const visibleStopButtons = Array.from(document.querySelectorAll("button"))
            .filter((button) => isVisible(button)
            && button.disabled !== true
            && button.getAttribute("aria-disabled") !== "true"
            && isScopedStopControl(button)
            && matchingLabels(button, args.send).length === 0
            && matchingLabels(button, args.stop).length > 0);
        const activeSignals = [...new Set(visibleStopButtons.flatMap(button => matchingLabels(button, args.stop)))];
        const latestAssistantTurn = latestAssistant?.closest("[data-testid^='conversation-turn']")
            ?? Array.from(document.querySelectorAll("[data-testid^='conversation-turn']")).at(-1);
        const stoppedSignals = latestAssistantTurn === undefined
            ? []
            : [...new Set(Array.from(latestAssistantTurn.querySelectorAll("button, [role='status'], [aria-label], [title], p, span, div"))
                    .filter(element => isVisible(element))
                    .flatMap(element => matchingLabels(element, args.stopped)))];
        const generation = {
            observed: true,
            active: activeSignals.length > 0,
            stopped: stoppedSignals.length > 0,
            signals: [...new Set([...activeSignals, ...stoppedSignals])].slice(0, 5)
        };
        // --- Response actions: mirrors dom/generation-state.ts latestAssistantTurnHasResponseActions ---
        const turns = Array.from(document.querySelectorAll("[data-testid^='conversation-turn']"));
        let hasResponseActions;
        if (turns.length === 0) {
            hasResponseActions = undefined;
        }
        else {
            const latestTurn = [...turns].reverse().find(turn => turn.querySelector("[data-message-author-role='assistant']") !== null);
            if (latestTurn === undefined) {
                hasResponseActions = false;
            }
            else {
                const actionText = Array.from(latestTurn.querySelectorAll("button"))
                    .map(button => [
                    button.innerText,
                    button.textContent,
                    button.getAttribute("aria-label"),
                    button.getAttribute("title")
                ].filter(Boolean).join(" "))
                    .join(" ")
                    .toLowerCase();
                hasResponseActions = args.actions.some(phrase => actionText.includes(phrase.toLowerCase()));
            }
        }
        const snapshot = {
            turnCount: nodes.length,
            assistantTurnCount: assistantNodes.length,
            text: { length: normalizedText.length, hash: textHash, transient },
            generation
        };
        if (latestAssistantTurnIndex !== undefined)
            snapshot.latestAssistantTurnIndex = latestAssistantTurnIndex;
        if (hasResponseActions !== undefined)
            snapshot.hasResponseActions = hasResponseActions;
        return snapshot;
    }, {
        transient: [...localeLabels.transientAssistant],
        stop: [...localeLabels.stopControl],
        stopped: [...localeLabels.stoppedAssistant],
        send: [...localeLabels.sendButton],
        actions: [...localeLabels.responseActions]
    });
}
