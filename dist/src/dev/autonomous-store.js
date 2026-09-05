import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { nodeErrorCode } from "../errors.js";
import { applyAutonomousWorkflowEvent, createAutonomousWorkflow, readyAutonomousTasks } from "./autonomous-workflow.js";
import { parseAutonomousWorkflowSnapshot } from "./autonomous-snapshot.js";
export const DEV_AUTONOMOUS_STORE_SCHEMA_VERSION = "chatgpt.browser_control.dev_autonomous_store.v1";
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_STALE_LOCK_MS = 30_000;
const LOCK_RETRY_MS = 25;
const queues = new Map();
export class DevAutonomousStoreError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "DevAutonomousStoreError";
    }
}
export class FileDevAutonomousWorkflowStore {
    stateRoot;
    lockTimeoutMs;
    staleLockMs;
    now;
    constructor(options = {}) {
        this.stateRoot = resolve(options.stateRoot ?? join(process.cwd(), ".chatgpt-dev", "state", "workflows"));
        this.lockTimeoutMs = positiveInteger(options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS, "lockTimeoutMs");
        this.staleLockMs = positiveInteger(options.staleLockMs ?? DEFAULT_STALE_LOCK_MS, "staleLockMs");
        this.now = options.now ?? (() => Date.now());
    }
    async create(plan) {
        const initial = createAutonomousWorkflow(plan);
        return this.withWorkflowLock(plan.workflowId, async () => {
            const existing = await this.loadOptional(plan.workflowId);
            if (existing !== undefined) {
                throw new DevAutonomousStoreError("workflow_exists", "An autonomous workflow with this ID already exists.");
            }
            await this.write(initial);
            return initial;
        });
    }
    async get(workflowId) {
        const workflow = await this.loadOptional(workflowId);
        if (workflow === undefined) {
            throw new DevAutonomousStoreError("workflow_not_found", "Autonomous workflow state was not found.");
        }
        return workflow;
    }
    async apply(workflowId, event) {
        return this.withWorkflowLock(workflowId, async () => {
            const current = await this.loadOptional(workflowId);
            if (current === undefined) {
                throw new DevAutonomousStoreError("workflow_not_found", "Autonomous workflow state was not found.");
            }
            const next = applyAutonomousWorkflowEvent(current, event);
            if (next.revision <= current.revision) {
                throw new DevAutonomousStoreError("state_corrupt", "Autonomous workflow revision did not advance.");
            }
            await this.write(next);
            return next;
        });
    }
    async ready(workflowId) {
        return readyAutonomousTasks(await this.get(workflowId));
    }
    async loadOptional(workflowId) {
        validateWorkflowId(workflowId);
        try {
            const raw = await readFile(this.path(workflowId), "utf8");
            const parsed = JSON.parse(raw);
            return parseDocument(parsed, workflowId).workflow;
        }
        catch (error) {
            if (nodeErrorCode(error) === "ENOENT")
                return undefined;
            if (error instanceof DevAutonomousStoreError)
                throw error;
            throw new DevAutonomousStoreError("state_corrupt", "Autonomous workflow state could not be decoded safely.");
        }
    }
    async write(workflow) {
        validateWorkflowId(workflow.workflowId);
        await mkdir(this.stateRoot, { recursive: true, mode: 0o700 });
        const path = this.path(workflow.workflowId);
        const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
        let handle;
        try {
            handle = await open(temporary, "wx", 0o600);
            await handle.writeFile(`${JSON.stringify({
                schemaVersion: DEV_AUTONOMOUS_STORE_SCHEMA_VERSION,
                workflow
            }, null, 2)}\n`, "utf8");
            await handle.sync();
            await handle.close();
            handle = undefined;
            await rename(temporary, path);
        }
        catch (error) {
            await handle?.close().catch(() => undefined);
            await unlink(temporary).catch(() => undefined);
            if (error instanceof DevAutonomousStoreError)
                throw error;
            throw new DevAutonomousStoreError("state_write_failed", "Autonomous workflow state could not be committed safely.");
        }
    }
    path(workflowId) {
        return join(this.stateRoot, `${hashId(workflowId)}.json`);
    }
    lockPath(workflowId) {
        return join(this.stateRoot, `${hashId(workflowId)}.lock`);
    }
    async withWorkflowLock(workflowId, action) {
        validateWorkflowId(workflowId);
        await mkdir(this.stateRoot, { recursive: true, mode: 0o700 });
        const queueKey = this.lockPath(workflowId);
        const previous = queues.get(queueKey) ?? Promise.resolve();
        let releaseQueue;
        const current = new Promise(resolveCurrent => {
            releaseQueue = resolveCurrent;
        });
        const chained = previous.catch(() => undefined).then(() => current);
        queues.set(queueKey, chained);
        await previous.catch(() => undefined);
        let token;
        try {
            token = await this.acquireFileLock(workflowId);
            return await action();
        }
        finally {
            if (token !== undefined)
                await this.releaseFileLock(workflowId, token);
            releaseQueue();
            if (queues.get(queueKey) === chained)
                queues.delete(queueKey);
        }
    }
    async acquireFileLock(workflowId) {
        const path = this.lockPath(workflowId);
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
                    throw new DevAutonomousStoreError("state_write_failed", "Autonomous workflow lock could not be acquired safely.");
                }
                await this.reclaimStaleLock(path);
                if (this.now() >= deadline) {
                    throw new DevAutonomousStoreError("lock_timeout", "Autonomous workflow state is busy in another process.");
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
            const raw = await readFile(path, "utf8");
            const record = parseLockRecord(raw);
            if (this.now() - record.createdAt < this.staleLockMs)
                return;
            await unlink(path);
        }
        catch (error) {
            if (nodeErrorCode(error) === "ENOENT")
                return;
            if (error instanceof DevAutonomousStoreError)
                throw error;
        }
    }
    async releaseFileLock(workflowId, token) {
        const path = this.lockPath(workflowId);
        try {
            const record = parseLockRecord(await readFile(path, "utf8"));
            if (record.token !== token)
                return;
            await unlink(path);
        }
        catch (error) {
            if (nodeErrorCode(error) === "ENOENT")
                return;
        }
    }
}
function parseDocument(value, workflowId) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new DevAutonomousStoreError("state_corrupt", "Autonomous workflow state is not an object.");
    }
    const record = value;
    if (record.schemaVersion !== DEV_AUTONOMOUS_STORE_SCHEMA_VERSION) {
        throw new DevAutonomousStoreError("state_corrupt", "Autonomous workflow state has an unsupported schema.");
    }
    return {
        schemaVersion: DEV_AUTONOMOUS_STORE_SCHEMA_VERSION,
        workflow: parseAutonomousWorkflowSnapshot(record.workflow, workflowId)
    };
}
function parseLockRecord(raw) {
    let value;
    try {
        value = JSON.parse(raw);
    }
    catch {
        throw new DevAutonomousStoreError("state_corrupt", "Autonomous workflow lock record is invalid.");
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new DevAutonomousStoreError("state_corrupt", "Autonomous workflow lock record is invalid.");
    }
    const record = value;
    if (typeof record.token !== "string"
        || record.token.length === 0
        || !Number.isSafeInteger(record.pid)
        || !Number.isFinite(record.createdAt)) {
        throw new DevAutonomousStoreError("state_corrupt", "Autonomous workflow lock record is invalid.");
    }
    return { token: record.token, pid: record.pid, createdAt: record.createdAt };
}
function validateWorkflowId(workflowId) {
    if (typeof workflowId !== "string" || workflowId.trim().length === 0 || workflowId.length > 512 || /[\u0000-\u001f\u007f]/u.test(workflowId)) {
        throw new DevAutonomousStoreError("state_corrupt", "Autonomous workflow ID is invalid.");
    }
}
function hashId(value) {
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
