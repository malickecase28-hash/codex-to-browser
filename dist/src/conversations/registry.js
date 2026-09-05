import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { nodeErrorCode } from "../errors.js";
// ponytail: process-local registry queue; add a lockfile if cross-process writers become a supported workload.
const writeQueues = new Map();
export class ConversationRegistry {
    stateRoot;
    now;
    constructor(options = {}) {
        this.stateRoot = options.stateRoot ?? defaultConversationStateRoot();
        this.now = options.now ?? (() => new Date());
    }
    async get(key) {
        const normalizedKey = normalizeKey(key);
        const path = this.recordPath(normalizedKey);
        try {
            const parsed = JSON.parse(await readFile(path, "utf8"));
            if (!isConversationRecord(parsed))
                throw new Error(`Invalid conversation registry record: ${path}`);
            if (parsed.key !== normalizedKey)
                throw new Error(`Conversation registry key mismatch: ${path}`);
            return parsed;
        }
        catch (error) {
            if (isNodeError(error, "ENOENT"))
                return undefined;
            throw error;
        }
    }
    async find(keyOrAlias) {
        const candidate = normalizeKey(keyOrAlias);
        const direct = await this.get(candidate);
        if (direct !== undefined)
            return direct;
        const wanted = candidate.toLocaleLowerCase();
        for (const record of await this.list()) {
            if (record.aliases.some(alias => alias.toLocaleLowerCase() === wanted))
                return record;
        }
        return undefined;
    }
    async remember(args) {
        const key = normalizeKey(args.key);
        return this.withMutationLock(async () => {
            const existing = await this.get(key);
            const now = this.now().toISOString();
            const aliases = existing?.aliases.slice() ?? [];
            for (const alias of args.aliases ?? []) {
                const normalizedAlias = alias.trim();
                if (normalizedAlias.length > 0 && !aliases.includes(normalizedAlias))
                    aliases.push(normalizedAlias);
            }
            const conversationId = args.replaceIdentity ? args.conversationId : args.conversationId ?? existing?.conversationId;
            const url = args.replaceIdentity ? args.url : args.url ?? existing?.url;
            const title = args.title ?? existing?.title;
            if (args.conversationId !== undefined && args.conversationId.trim().length === 0)
                throw new Error("conversationId must not be empty.");
            if (args.url !== undefined && args.url.trim().length === 0)
                throw new Error("URL must not be empty.");
            const suppliedUrlId = args.url === undefined ? undefined : conversationIdFromUrl(args.url);
            const existingUrlId = existing?.url === undefined ? undefined : conversationIdFromUrl(existing.url);
            if (args.conversationId !== undefined && suppliedUrlId !== undefined && suppliedUrlId !== args.conversationId) {
                throw new Error(`Conversation "${key}" URL does not match its conversationId.`);
            }
            if (!args.replaceIdentity && args.url !== undefined && existing?.conversationId !== undefined && suppliedUrlId !== undefined && suppliedUrlId !== existing.conversationId) {
                throw new Error(`Conversation "${key}" URL does not match its remembered conversationId.`);
            }
            if (!args.replaceIdentity && args.conversationId !== undefined && existingUrlId !== undefined && existingUrlId !== args.conversationId) {
                throw new Error(`Conversation "${key}" conversationId does not match its remembered URL.`);
            }
            const identities = new Set([key, ...aliases].map(identity => identity.toLocaleLowerCase()));
            for (const other of await this.list()) {
                if (other.key === key)
                    continue;
                if (identities.has(other.key.toLocaleLowerCase()) || other.aliases.some(alias => identities.has(alias.toLocaleLowerCase()))) {
                    throw new Error(`Conversation identifier for "${key}" already identifies "${other.key}".`);
                }
            }
            const record = {
                schemaVersion: 1,
                key,
                surface: args.surface ?? existing?.surface ?? "chat",
                aliases,
                createdAt: existing?.createdAt ?? now,
                updatedAt: now,
                lastUsedAt: args.touch === false ? existing?.lastUsedAt ?? now : now
            };
            if (conversationId !== undefined)
                record.conversationId = conversationId;
            if (url !== undefined)
                record.url = url;
            if (title !== undefined)
                record.title = title;
            if (record.conversationId === undefined && record.url === undefined) {
                throw new Error(`Conversation "${key}" needs a conversationId or URL before it can be remembered.`);
            }
            await this.writeRecordFile(record, this.recordPath(key));
            return record;
        });
    }
    async touch(key) {
        const existing = await this.get(key);
        return existing === undefined ? undefined : this.remember({ key: existing.key });
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
            try {
                const parsed = JSON.parse(await readFile(join(this.stateRoot, name), "utf8"));
                if (!isConversationRecord(parsed))
                    throw new Error(`Invalid conversation registry record: ${join(this.stateRoot, name)}`);
                records.push(parsed);
            }
            catch (error) {
                if (!isNodeError(error, "ENOENT"))
                    throw error;
            }
        }
        records.sort((left, right) => right.lastUsedAt.localeCompare(left.lastUsedAt));
        return records;
    }
    async forget(key) {
        const normalizedKey = normalizeKey(key);
        return this.withMutationLock(async () => {
            try {
                await unlink(this.recordPath(normalizedKey));
                return true;
            }
            catch (error) {
                if (isNodeError(error, "ENOENT"))
                    return false;
                throw error;
            }
        });
    }
    recordPath(key) {
        const digest = createHash("sha256").update(key, "utf8").digest("hex");
        return join(this.stateRoot, `${digest}.json`);
    }
    async withMutationLock(action) {
        const target = this.stateRoot;
        const previous = writeQueues.get(target) ?? Promise.resolve();
        const queued = previous.catch(() => undefined).then(action);
        writeQueues.set(target, queued);
        try {
            return await queued;
        }
        finally {
            if (writeQueues.get(target) === queued)
                writeQueues.delete(target);
        }
    }
    async writeRecordFile(record, target) {
        await mkdir(this.stateRoot, { recursive: true, mode: 0o700 });
        const temporary = join(this.stateRoot, `${randomUUID()}.tmp`);
        try {
            await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
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
export function defaultConversationStateRoot() {
    if (platform() === "darwin")
        return join(homedir(), "Library", "Application Support", "codex-chatgpt-control", "conversations-v1");
    if (platform() === "win32") {
        const localAppData = process.env.LOCALAPPDATA;
        return join(localAppData?.trim() || join(homedir(), "AppData", "Local"), "codex-chatgpt-control", "conversations-v1");
    }
    const xdgStateHome = process.env.XDG_STATE_HOME;
    return join(xdgStateHome?.trim() || join(homedir(), ".local", "state"), "codex-chatgpt-control", "conversations-v1");
}
function normalizeKey(key) {
    const normalized = key.trim();
    if (normalized.length === 0)
        throw new Error("Conversation key must not be empty.");
    if (normalized.length > 200)
        throw new Error("Conversation key must be 200 characters or fewer.");
    return normalized;
}
function conversationIdFromUrl(value) {
    try {
        const pathname = new URL(value).pathname;
        if (!pathname.startsWith("/c/"))
            return undefined;
        const id = pathname.slice(3).split("/")[0];
        return id === "" ? undefined : id;
    }
    catch {
        return undefined;
    }
}
function isConversationRecord(value) {
    if (typeof value !== "object" || value === null)
        return false;
    const record = value;
    if (record.schemaVersion !== 1 || typeof record.key !== "string" || record.key.length === 0)
        return false;
    if (record.surface !== "chat" && record.surface !== "work")
        return false;
    if (!Array.isArray(record.aliases) || !record.aliases.every(alias => typeof alias === "string"))
        return false;
    if (typeof record.createdAt !== "string" || typeof record.updatedAt !== "string" || typeof record.lastUsedAt !== "string")
        return false;
    if (record.conversationId !== undefined && (typeof record.conversationId !== "string" || record.conversationId.trim().length === 0))
        return false;
    if (record.url !== undefined && (typeof record.url !== "string" || record.url.trim().length === 0))
        return false;
    if (record.title !== undefined && typeof record.title !== "string")
        return false;
    return record.conversationId !== undefined || record.url !== undefined;
}
function isNodeError(error, code) {
    return nodeErrorCode(error) === code;
}
