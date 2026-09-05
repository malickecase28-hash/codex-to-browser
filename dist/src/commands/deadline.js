export function createDeadline(timeoutMs, startedAtMs = Date.now()) {
    const safeTimeoutMs = Math.max(0, timeoutMs);
    return {
        startedAtMs,
        timeoutMs: safeTimeoutMs,
        expiresAtMs: startedAtMs + safeTimeoutMs,
    };
}
export function remainingMs(deadline, nowMs = Date.now()) {
    return Math.max(0, deadline.expiresAtMs - nowMs);
}
export function childTimeoutMs(deadline, capMs, nowMs = Date.now()) {
    return Math.max(0, Math.min(Math.max(0, capMs), remainingMs(deadline, nowMs)));
}
