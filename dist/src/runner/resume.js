const NEVER_AUTO_RESUME = new Set([
    "captcha",
    "login_required",
    "rate_limit",
    "selector_drift",
    "artifact_selector_drift",
    "unknown"
]);
export function resumeDecisionForBlocker(blocker, stateId) {
    if (blocker === undefined) {
        return { supported: false, reason: "This result has no resumable browser-control blocker." };
    }
    if (NEVER_AUTO_RESUME.has(blocker.kind)) {
        return { supported: false, reason: "This blocker is not safe to resume automatically." };
    }
    if (blocker.resumable === true) {
        return stateId === undefined ? { supported: true } : { supported: true, stateId };
    }
    return { supported: false, reason: "The underlying browser-control command did not mark this blocker as resumable." };
}
export function augmentCommandBlocker(blocker) {
    const augmented = { ...blocker };
    if (augmented.resumable === undefined) {
        augmented.resumable = blocker.kind === "confirmation" || blocker.kind === "permission";
    }
    return augmented;
}
