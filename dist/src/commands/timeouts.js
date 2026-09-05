export async function withTimeout(promise, timeoutMs, message) {
    let timeout;
    try {
        return await Promise.race([
            promise,
            new Promise((_resolve, reject) => {
                timeout = setTimeout(() => reject(new Error(message)), Math.max(0, timeoutMs));
            })
        ]);
    }
    finally {
        if (timeout !== undefined)
            clearTimeout(timeout);
    }
}
export function localGuardTimeout(timeoutMs, capMs) {
    return Math.max(1, Math.min(timeoutMs ?? capMs, capMs));
}
