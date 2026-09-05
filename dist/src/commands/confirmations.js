export function requireConfirmation(confirm, expected) {
    if (confirm?.understood === true
        && confirm.targetKind === expected.targetKind
        && confirm.targetDisplayName === expected.targetDisplayName
        && confirm.action === expected.action) {
        return undefined;
    }
    return {
        ok: false,
        status: "needs_confirmation",
        warnings: [],
        blocker: {
            kind: "confirmation",
            message: `Confirmation required before ${expected.action} on ${expected.targetKind} "${expected.targetDisplayName}".`
        },
        context: { timestamp: new Date().toISOString() }
    };
}
export function rejectNetworkCommand(command) {
    if (!command.startsWith("network.")) {
        return undefined;
    }
    return {
        ok: false,
        status: "unsupported",
        warnings: [],
        blocker: {
            kind: "confirmation",
            message: "Private ChatGPT network replay commands are intentionally unsupported."
        },
        context: { timestamp: new Date().toISOString() }
    };
}
