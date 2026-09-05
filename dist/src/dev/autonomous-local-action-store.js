import { createHash, randomUUID } from "node:crypto";
import { lstat, link, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { nodeErrorCode } from "../errors.js";
export const DEV_AUTONOMOUS_LOCAL_ACTION_SCHEMA_VERSION = "chatgpt.browser_control.dev_autonomous_local_action.v1";
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_STALE_LOCK_MS = 30_000;
const LOCK_RETRY_MS = 25;
const MAX_RESULT_BYTES = 1024 * 1024;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const ACTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const queues = new Map();
export class DevAutonomousLocalActionStoreError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "DevAutonomousLocalActionStoreError";
    }
}
/**
 * Durable local side-effect journal used beneath the Codex/Git autonomous port.
 *
 * Records are immutable in identity and move prepared -> started -> completed.
 * Scope locks serialize every physical worktree mutation across processes. A
 * dead owner may be reclaimed only after the stale interval and a failed PID
 * liveness check; a live long-running Codex process never loses its lock merely
 * because the wall clock advanced.
 */
export class FileDevAutonomousLocalActionStore {
    stateRoot;
    lockTimeoutMs;
    staleLockMs;
    now;
    constructor(options = {}) {
        this.stateRoot = resolve(options.stateRoot ?? join(process.cwd(), ".chatgpt-dev", "local", "actions"));
        this.lockTimeoutMs = positiveInteger(options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS, "lockTimeoutMs");
        this.staleLockMs = positiveInteger(options.staleLockMs ?? DEFAULT_STALE_LOCK_MS, "staleLockMs");
        this.now = options.now ?? (() => Date.now());
    }
    async get(actionId) {
        validateActionId(actionId);
        const path = this.actionPath(actionId);
        try {
            const metadata = await lstat(path);
            if (!metadata.isFile() || metadata.isSymbolicLink())
                throw corrupt();
            return parseRecord(JSON.parse(await readFile(path, "utf8")), actionId);
        }
        catch (error) {
            if (nodeErrorCode(error) === "ENOENT")
                return undefined;
            if (error instanceof DevAutonomousLocalActionStoreError)
                throw error;
            throw corrupt();
        }
    }
    async require(actionId) {
        const record = await this.get(actionId);
        if (record === undefined) {
            throw new DevAutonomousLocalActionStoreError("not_found", "Autonomous local action state was not found.");
        }
        return record;
    }
    async prepare(identity) {
        validateIdentity(identity);
        await this.ensureDirectories();
        const existing = await this.get(identity.actionId);
        if (existing !== undefined) {
            assertSameIdentity(existing, identity);
            return existing;
        }
        const timestamp = new Date(this.now()).toISOString();
        const record = freezeRecord({
            schemaVersion: DEV_AUTONOMOUS_LOCAL_ACTION_SCHEMA_VERSION,
            ...identity,
            phase: "prepared",
            createdAt: timestamp,
            updatedAt: timestamp
        });
        const target = this.actionPath(identity.actionId);
        const temporary = this.temporaryPath();
        let handle;
        try {
            handle = await open(temporary, "wx", 0o600);
            await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
            await handle.sync();
            await handle.close();
            handle = undefined;
            try {
                await link(temporary, target);
                return record;
            }
            catch (error) {
                if (nodeErrorCode(error) !== "EEXIST")
                    throw error;
                const raced = await this.require(identity.actionId);
                assertSameIdentity(raced, identity);
                return raced;
            }
        }
        catch (error) {
            if (error instanceof DevAutonomousLocalActionStoreError)
                throw error;
            throw new DevAutonomousLocalActionStoreError("write_failed", "Autonomous local action intent could not be committed safely.");
        }
        finally {
            await handle?.close().catch(() => undefined);
            await unlink(temporary).catch(() => undefined);
        }
    }
    async start(actionId) {
        return this.withRecordLock(actionId, async () => {
            const current = await this.require(actionId);
            if (current.phase === "started" || current.phase === "completed")
                return current;
            const next = freezeRecord({
                ...current,
                phase: "started",
                updatedAt: new Date(this.now()).toISOString()
            });
            await this.write(next);
            return next;
        });
    }
    async complete(actionId, result) {
        const safeResult = jsonValue(result);
        return this.withRecordLock(actionId, async () => {
            const current = await this.require(actionId);
            if (current.phase === "prepared") {
                throw new DevAutonomousLocalActionStoreError("invalid_transition", "A local action must be marked started before completion evidence can be committed.");
            }
            if (current.phase === "completed") {
                if (canonicalJson(current.result) !== canonicalJson(safeResult)) {
                    throw new DevAutonomousLocalActionStoreError("identity_mismatch", "Completed local action evidence conflicts with its durable receipt.");
                }
                return current;
            }
            const next = freezeRecord({
                ...current,
                phase: "completed",
                updatedAt: new Date(this.now()).toISOString(),
                result: safeResult
            });
            await this.write(next);
            return next;
        });
    }
    async withScope(scopeId, action) {
        validateText(scopeId, "scopeId", 512);
        await this.ensureDirectories();
        return this.withQueuedFileLock(`scope:${scopeId}`, action);
    }
    async withRecordLock(actionId, action) {
        validateActionId(actionId);
        await this.ensureDirectories();
        return this.withQueuedFileLock(`action:${actionId}`, action);
    }
    async withQueuedFileLock(key, action) {
        const queueKey = this.lockPath(key);
        const previous = queues.get(queueKey) ?? Promise.resolve();
        let releaseQueue;
        const current = new Promise(resolveCurrent => { releaseQueue = resolveCurrent; });
        const chained = previous.catch(() => undefined).then(() => current);
        queues.set(queueKey, chained);
        await previous.catch(() => undefined);
        let token;
        try {
            token = await this.acquireFileLock(key);
            return await action();
        }
        finally {
            if (token !== undefined)
                await this.releaseFileLock(key, token);
            releaseQueue();
            if (queues.get(queueKey) === chained)
                queues.delete(queueKey);
        }
    }
    async acquireFileLock(key) {
        const path = this.lockPath(key);
        const deadline = this.now() + this.lockTimeoutMs;
        for (;;) {
            const token = randomUUID();
            let handle;
            try {
                handle = await open(path, "wx", 0o600);
                const record = { token, pid: process.pid, createdAt: this.now() };
                await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
                await handle.sync();
                await handle.close();
                return token;
            }
            catch (error) {
                await handle?.close().catch(() => undefined);
                if (nodeErrorCode(error) !== "EEXIST") {
                    throw new DevAutonomousLocalActionStoreError("write_failed", "Autonomous local action lock could not be acquired safely.");
                }
                await this.reclaimStaleLock(path);
                if (this.now() >= deadline) {
                    throw new DevAutonomousLocalActionStoreError("lock_timeout", "Autonomous local action state is busy in another process.");
                }
                await sleep(LOCK_RETRY_MS);
            }
        }
    }
    async reclaimStaleLock(path) {
        try {
            const metadata = await stat(path);
            if (this.now() - metadata.mtimeMs < this.staleLockMs)
                return;
            const record = parseLockRecord(await readFile(path, "utf8"));
            if (this.now() - record.createdAt < this.staleLockMs)
                return;
            if (processIsAlive(record.pid))
                return;
            await unlink(path);
        }
        catch (error) {
            if (nodeErrorCode(error) === "ENOENT")
                return;
            if (error instanceof DevAutonomousLocalActionStoreError)
                throw error;
            throw corrupt();
        }
    }
    async releaseFileLock(key, token) {
        const path = this.lockPath(key);
        try {
            const record = parseLockRecord(await readFile(path, "utf8"));
            if (record.token === token)
                await unlink(path);
        }
        catch (error) {
            if (nodeErrorCode(error) === "ENOENT")
                return;
        }
    }
    async write(record) {
        const target = this.actionPath(record.actionId);
        const temporary = this.temporaryPath();
        let handle;
        try {
            handle = await open(temporary, "wx", 0o600);
            await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
            await handle.sync();
            await handle.close();
            handle = undefined;
            await rename(temporary, target);
        }
        catch {
            await handle?.close().catch(() => undefined);
            await unlink(temporary).catch(() => undefined);
            throw new DevAutonomousLocalActionStoreError("write_failed", "Autonomous local action state could not be committed safely.");
        }
    }
    async ensureDirectories() {
        await mkdir(this.stateRoot, { recursive: true, mode: 0o700 });
        await mkdir(join(this.stateRoot, "records"), { recursive: true, mode: 0o700 });
        await mkdir(join(this.stateRoot, "locks"), { recursive: true, mode: 0o700 });
        await mkdir(join(this.stateRoot, "tmp"), { recursive: true, mode: 0o700 });
    }
    actionPath(actionId) {
        return join(this.stateRoot, "records", `${hash(actionId)}.json`);
    }
    lockPath(key) {
        return join(this.stateRoot, "locks", `${hash(key)}.lock`);
    }
    temporaryPath() {
        return join(this.stateRoot, "tmp", `${process.pid}.${randomUUID()}.tmp`);
    }
}
function parseRecord(value, actionId) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        throw corrupt();
    const record = value;
    const allowed = new Set([
        "schemaVersion", "actionId", "kind", "workflowId", "scopeId", "inputDigest",
        "branch", "taskId", "attempt", "baselineHead", "phase", "createdAt", "updatedAt", "result"
    ]);
    if (Object.keys(record).some(key => !allowed.has(key)))
        throw corrupt();
    const identity = {
        actionId,
        kind: record.kind,
        workflowId: record.workflowId,
        scopeId: record.scopeId,
        inputDigest: record.inputDigest,
        ...(record.branch === undefined ? {} : { branch: record.branch }),
        ...(record.taskId === undefined ? {} : { taskId: record.taskId }),
        ...(record.attempt === undefined ? {} : { attempt: record.attempt }),
        ...(record.baselineHead === undefined ? {} : { baselineHead: record.baselineHead })
    };
    validateIdentity(identity);
    if (record.schemaVersion !== DEV_AUTONOMOUS_LOCAL_ACTION_SCHEMA_VERSION
        || record.actionId !== actionId
        || (record.phase !== "prepared" && record.phase !== "started" && record.phase !== "completed")
        || typeof record.createdAt !== "string"
        || typeof record.updatedAt !== "string"
        || !Number.isFinite(Date.parse(record.createdAt))
        || !Number.isFinite(Date.parse(record.updatedAt)))
        throw corrupt();
    if (record.phase === "completed" && record.result === undefined)
        throw corrupt();
    if (record.result !== undefined)
        jsonValue(record.result);
    return freezeRecord({
        schemaVersion: DEV_AUTONOMOUS_LOCAL_ACTION_SCHEMA_VERSION,
        ...identity,
        phase: record.phase,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        ...(record.result === undefined ? {} : { result: jsonValue(record.result) })
    });
}
function validateIdentity(identity) {
    validateActionId(identity.actionId);
    if (![
        "implement", "test", "push", "integrate", "integration_test", "integration_push"
    ].includes(identity.kind))
        throw corrupt();
    validateText(identity.workflowId, "workflowId", 512);
    validateText(identity.scopeId, "scopeId", 512);
    if (!DIGEST_PATTERN.test(identity.inputDigest))
        throw corrupt();
    if (identity.branch !== undefined)
        validateText(identity.branch, "branch", 512);
    if (identity.taskId !== undefined)
        validateText(identity.taskId, "taskId", 256);
    if (identity.attempt !== undefined && (!Number.isSafeInteger(identity.attempt) || identity.attempt < 1 || identity.attempt > 1_000_000)) {
        throw corrupt();
    }
    if (identity.baselineHead !== undefined && !COMMIT_PATTERN.test(identity.baselineHead))
        throw corrupt();
}
function assertSameIdentity(record, identity) {
    const fields = [
        "actionId", "kind", "workflowId", "scopeId", "inputDigest", "branch", "taskId", "attempt", "baselineHead"
    ];
    if (fields.some(field => record[field] !== identity[field])) {
        throw new DevAutonomousLocalActionStoreError("identity_mismatch", "Autonomous local action identity conflicts with its durable receipt.");
    }
}
function parseLockRecord(raw) {
    let value;
    try {
        value = JSON.parse(raw);
    }
    catch {
        throw corrupt();
    }
    if (value === null || typeof value !== "object" || Array.isArray(value))
        throw corrupt();
    const record = value;
    if (Object.keys(record).sort().join(",") !== "createdAt,pid,token"
        || typeof record.token !== "string"
        || record.token.length === 0
        || !Number.isSafeInteger(record.pid)
        || typeof record.createdAt !== "number"
        || !Number.isFinite(record.createdAt))
        throw corrupt();
    return { token: record.token, pid: record.pid, createdAt: record.createdAt };
}
function processIsAlive(pid) {
    if (pid === process.pid)
        return true;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        const code = nodeErrorCode(error);
        if (code === "ESRCH")
            return false;
        return true;
    }
}
function jsonValue(value) {
    let encoded;
    try {
        encoded = JSON.stringify(value);
    }
    catch {
        throw corrupt();
    }
    if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > MAX_RESULT_BYTES)
        throw corrupt();
    return deepFreeze(JSON.parse(encoded));
}
function deepFreeze(value) {
    if (Array.isArray(value)) {
        for (const item of value)
            deepFreeze(item);
        return Object.freeze(value);
    }
    if (value !== null && typeof value === "object") {
        for (const item of Object.values(value))
            deepFreeze(item);
        return Object.freeze(value);
    }
    return value;
}
function canonicalJson(value) {
    if (Array.isArray(value))
        return `[${value.map(canonicalJson).join(",")}]`;
    if (value !== null && typeof value === "object") {
        const record = value;
        return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
}
function validateActionId(value) {
    if (typeof value !== "string" || !ACTION_ID_PATTERN.test(value))
        throw corrupt();
}
function validateText(value, _label, maxLength) {
    if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength || /[\u0000-\u001f\u007f]/u.test(value))
        throw corrupt();
}
function hash(value) {
    return createHash("sha256").update(value, "utf8").digest("hex");
}
function positiveInteger(value, label) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 86_400_000) {
        throw new TypeError(`${label} must be a positive bounded integer.`);
    }
    return value;
}
async function sleep(milliseconds) {
    await new Promise(resolveSleep => setTimeout(resolveSleep, milliseconds));
}
function freezeRecord(record) {
    return Object.freeze({ ...record });
}
function corrupt() {
    return new DevAutonomousLocalActionStoreError("state_corrupt", "Autonomous local action state is corrupt or unsafe to follow.");
}
