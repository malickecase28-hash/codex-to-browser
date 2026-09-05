import path from "node:path";
import { platform as readHostPlatform } from "node:os";
export function currentHostPathPlatform() {
    return readHostPlatform();
}
export function isHostAbsolutePath(value, platform = currentHostPathPlatform()) {
    if (value.length === 0)
        return false;
    if (platform === "win32")
        return isFullyQualifiedWindowsPath(value);
    return path.posix.isAbsolute(value);
}
export function resolveForHostPath(value, platform = currentHostPathPlatform()) {
    if (!isHostAbsolutePath(value, platform)) {
        throw new Error(`File attachment path must be absolute for the backend host: ${value}`);
    }
    return platform === "win32" ? path.win32.resolve(value) : path.posix.resolve(value);
}
export function basenameForHostPath(value, platform = currentHostPathPlatform()) {
    return platform === "win32" ? path.win32.basename(value) : path.posix.basename(value);
}
function isFullyQualifiedWindowsPath(value) {
    return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+[\\/]/.test(value);
}
