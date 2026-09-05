import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { nodeErrorCode } from "../errors.js";
const writeQueues = new Map();
export class BrowserAffinityRegistry {
    stateRoot;
    now;
    constructor(options = {}) {
        this.stateRoot = options.stateRoot ?? defaultBrowserAffinityStateRoot();
        this.now = options.now ?? (() => new Date());
    }
    async get(key) {
        const normalizedKey = normalizeKey(key);
        try {
            const parsed = JSON.parse(await readFile(this.recordPath(normalizedKey), "utf8"));
            if (!isBrowserAffinityRecord(parsed) || parsed.key !== normalizedKey)
                throw new Error("Invalid browser affinity record.");
            return parsed;
        }
        catch (error) {
            if (isNodeError(error, "ENOENT"))
                return undefined;
            throw error;
        }
    }
    async remember(args) {
        const key = normalizeKey(args.key);
        if (!args.tabId.trim())
            throw new Error("Browser affinity tabId must not be empty.");
        if (args.conversationId !== undefined && !args.conversationId.trim())
            throw new Error("Browser affinity conversationId must not be empty.");
        if (args.url !== undefined && !args.url.trim())
            throw new Error("Browser affinity URL must not be empty.");
        return this.withMutationLock(async () => {
            const existing = await this.get(key);
            const now = this.now().toISOString();
            const record = {
                schemaVersion: 1,
                key,
                tabId: args.tabId,
                surface: args.surface,
                createdAt: existing?.createdAt ?? now,
                updatedAt: now
            };
            if (args.conversationId !== undefined)
                record.conversationId = args.conversationId;
            if (args.url !== undefined)
                record.url = args.url;
            await this.writeRecordFile(record, this.recordPath(key));
            return record;
        });
    }
    async list() {
        let names;
        try {
            names = await readdir(this.stateRoot);
        }
        catch (error) {
            if (isNodeError(error, "ENOENT"))
                return [];
            throw error;
        }
        const records = [];
        for (const name of names) {
            if (!name.endsWith(".json"))
                continue;
            const path = join(this.stateRoot, name);
            const parsed = JSON.parse(await readFile(path, "utf8"));
            if (!isBrowserAffinityRecord(parsed))
                throw new Error(`Invalid browser affinity record: ${path}`);
            records.push(parsed);
        }
        return records;
    }
    async forget(key) {
        return this.withMutationLock(async () => {
            try {
                await unlink(this.recordPath(normalizeKey(key)));
                return true;
            }
            catch (error) {
                if (isNodeError(error, "ENOENT"))
                    return false;
                throw error;
            }
        });
    }
    recordPath(key) { return join(this.stateRoot, `${createHash("sha256").update(key, "utf8").digest("hex")}.json`); }
    async withMutationLock(action) {
        const previous = writeQueues.get(this.stateRoot) ?? Promise.resolve();
        const queued = previous.catch(() => undefined).then(action);
        writeQueues.set(this.stateRoot, queued);
        try {
            return await queued;
        }
        finally {
            if (writeQueues.get(this.stateRoot) === queued)
                writeQueues.delete(this.stateRoot);
        }
    }
    async writeRecordFile(record, target) {
        await mkdir(this.stateRoot, { recursive: true, mode: 0o700 });
        await chmod(this.stateRoot, 0o700);
        const temporary = join(this.stateRoot, `${randomUUID()}.tmp`);
        try {
            await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
            await chmod(temporary, 0o600);
            for (let attempt = 0;; attempt += 1) {
                try {
                    await rename(temporary, target);
                    break;
                }
                catch (error) {
                    if (attempt >= 2 || !(isNodeError(error, "EPERM") || isNodeError(error, "EBUSY")))
                        throw error;
                    await new Promise(resolve => setTimeout(resolve, 10));
                }
            }
        }
        finally {
            await unlink(temporary).catch(() => undefined);
        }
    }
}
export function defaultBrowserAffinityStateRoot() {
    if (platform() === "darwin")
        return join(homedir(), "Library", "Application Support", "codex-chatgpt-control", "browser-affinity-v1");
    if (platform() === "win32")
        return join(process.env.LOCALAPPDATA?.trim() || join(homedir(), "AppData", "Local"), "codex-chatgpt-control", "browser-affinity-v1");
    return join(process.env.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state"), "codex-chatgpt-control", "browser-affinity-v1");
}
export function siblingBrowserAffinityStateRoot(conversationStateRoot) {
    return join(dirname(conversationStateRoot), "browser-affinity-v1");
}
function normalizeKey(key) { const value = key.trim(); if (!value || value.length > 200)
    throw new Error("Browser affinity key is invalid."); return value; }
function isBrowserAffinityRecord(value) {
    if (typeof value !== "object" || value === null)
        return false;
    const record = value;
    const keys = Object.keys(record).sort().join(",");
    const expected = ["conversationId", "createdAt", "key", "schemaVersion", "surface", "tabId", "updatedAt", "url"].filter(key => record[key] !== undefined).sort().join(",");
    if (keys !== expected || record.schemaVersion !== 1 || typeof record.key !== "string" || typeof record.tabId !== "string" || !record.tabId || (record.surface !== "chat" && record.surface !== "work"))
        return false;
    if (typeof record.createdAt !== "string" || typeof record.updatedAt !== "string")
        return false;
    return (record.conversationId === undefined || typeof record.conversationId === "string") && (record.url === undefined || typeof record.url === "string") && (record.conversationId !== undefined || record.url !== undefined);
}
function isNodeError(error, code) { return nodeErrorCode(error) === code; }
