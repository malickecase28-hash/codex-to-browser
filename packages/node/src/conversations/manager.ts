import type { AskWorkflowArgs, ChatGPTClient, RunMessagesArgs, WorkflowThread } from "../client.js";
import type { CommandResult, ReadLatestArgs } from "../types.js";
import { join } from "node:path";
import {
  ConversationRegistry,
  type ConversationRecord,
  type ConversationRegistryOptions,
  type ConversationSurface,
  type RememberConversationArgs
} from "./registry.js";
import { BrowserAffinityRegistry, defaultBrowserAffinityStateRoot } from "./browser-affinity.js";

export type ConversationPolicy = "reuse" | "new" | "current";
export type ConversationIfMissing = "search" | "create" | "block";
export type ConversationSearchSelection = "first" | { index: number } | { title: string };
export type ConversationUse = {
  key: string;
  policy?: ConversationPolicy;
  ifMissing?: ConversationIfMissing;
  searchQuery?: string;
  select?: ConversationSearchSelection;
  limit?: number;
  surface?: ConversationSurface;
};
export type ConversationResolutionSource = "registry" | "history-search" | "new" | "current";
export type ConversationResolution = { key: string; source: ConversationResolutionSource; thread: WorkflowThread; record?: ConversationRecord };
export type ConversationAskArgs = Omit<AskWorkflowArgs, "thread"> & { conversation: ConversationUse };
export type ConversationRunMessagesArgs = Omit<RunMessagesArgs, "thread"> & { conversation: ConversationUse };
export type ConversationManagerOptions = ConversationRegistryOptions & { affinityStateRoot?: string };
export type ConversationClient = Pick<ChatGPTClient, "ask" | "runMessages" | "openThread" | "readLatest" | "session">;

export class ConversationNotFoundError extends Error {
  readonly key: string;

  constructor(key: string) {
    super(`No remembered ChatGPT conversation exists for "${key}".`);
    this.name = "ConversationNotFoundError";
    this.key = key;
  }
}

export class ConversationManager {
  readonly registry: ConversationRegistry;
  readonly affinity: BrowserAffinityRegistry;

  constructor(private readonly client: ConversationClient, options: ConversationManagerOptions = {}) {
    this.registry = new ConversationRegistry(options);
    this.affinity = new BrowserAffinityRegistry({
      stateRoot: options.affinityStateRoot
        ?? (options.stateRoot === undefined ? defaultBrowserAffinityStateRoot() : join(this.registry.stateRoot, "browser-affinity-v1")),
      ...(options.now === undefined ? {} : { now: options.now })
    });
  }

  remember(args: RememberConversationArgs): Promise<ConversationRecord> {
    return this.registry.remember(args);
  }

  get(key: string): Promise<ConversationRecord | undefined> {
    return this.registry.get(key);
  }

  find(keyOrAlias: string): Promise<ConversationRecord | undefined> {
    return this.registry.find(keyOrAlias);
  }

  list(): Promise<ConversationRecord[]> {
    return this.registry.list();
  }

  forget(key: string): Promise<boolean> {
    return this.forgetBoth(key);
  }

  private async forgetBoth(key: string): Promise<boolean> {
    const forgotten = await this.registry.forget(key);
    await this.affinity.forget(key);
    return forgotten;
  }

  async resolve(use: ConversationUse): Promise<ConversationResolution> {
    const policy = use.policy ?? "reuse";
    if (policy === "new") return { key: use.key, source: "new", thread: { type: "new" } };
    if (policy === "current") return { key: use.key, source: "current", thread: { type: "current" } };

    const record = await this.registry.find(use.key);
    if (record?.conversationId !== undefined) {
      return { key: record.key, source: "registry", thread: { type: "conversationId", conversationId: record.conversationId }, record };
    }
    if (record?.url !== undefined) return { key: record.key, source: "registry", thread: { type: "url", url: record.url }, record };

    const ifMissing = use.ifMissing ?? "search";
    if (ifMissing === "create") return { key: use.key, source: "new", thread: { type: "new" } };
    if (ifMissing === "search") {
      const thread: Extract<WorkflowThread, { type: "search" }> = { type: "search", query: use.searchQuery ?? use.key };
      if (use.select !== undefined) thread.select = use.select;
      if (use.limit !== undefined) thread.limit = use.limit;
      return { key: use.key, source: "history-search", thread };
    }
    throw new ConversationNotFoundError(use.key);
  }

  async open(use: ConversationUse): Promise<CommandResult<unknown>> {
    const resolution = await this.resolve(use);
    const blocked = await this.preflightAffinity(resolution);
    if (blocked !== undefined) return blocked;
    const result = await this.client.openThread(resolution.thread);
    if (result.ok) await this.persistObserved({ ...use, key: resolution.key }, result, undefined, resolution.source === "new" || resolution.source === "current");
    return result;
  }

  async readLatest(use: ConversationUse, args?: ReadLatestArgs): Promise<CommandResult<unknown>> {
    const resolution = await this.resolve(use);
    const blocked = await this.preflightAffinity(resolution);
    if (blocked !== undefined) return blocked;
    const opened = await this.client.openThread(resolution.thread);
    if (!opened.ok) return opened;
    await this.persistObserved({ ...use, key: resolution.key }, opened, undefined, resolution.source === "new" || resolution.source === "current");
    const result = await this.client.readLatest(args);
    if (result.ok) await this.persistObserved({ ...use, key: resolution.key }, result, undefined, resolution.source === "new" || resolution.source === "current");
    return result;
  }

  async ask(args: ConversationAskArgs): Promise<CommandResult<unknown>> {
    const resolution = await this.resolve(args.conversation);
    const blocked = await this.preflightAffinity(resolution);
    if (blocked !== undefined) return blocked;
    const { conversation: _conversation, ...input } = args;
    const result = await this.client.ask({ ...input, thread: resolution.thread, ...(await this.existingTab(resolution)) });
    await this.assertObservedAffinity(resolution, result);
    if (result.ok) await this.persistObserved({ ...args.conversation, key: resolution.key }, result, input.experience, resolution.source === "new" || resolution.source === "current");
    return result;
  }

  async runMessages(args: ConversationRunMessagesArgs): Promise<CommandResult<unknown>> {
    const resolution = await this.resolve(args.conversation);
    const blocked = await this.preflightAffinity(resolution);
    if (blocked !== undefined) return blocked;
    const { conversation: _conversation, ...input } = args;
    const result = await this.client.runMessages({ ...input, thread: resolution.thread, ...(await this.existingTab(resolution)) });
    await this.assertObservedAffinity(resolution, result);
    if (result.ok) await this.persistObserved({ ...args.conversation, key: resolution.key }, result, input.experience, resolution.source === "new" || resolution.source === "current");
    return result;
  }

  private async rememberObserved(use: ConversationUse, result: CommandResult<unknown>, experience?: "chat" | "work", replaceIdentity = false): Promise<void> {
    const { conversationId, url, title } = result.context;
    const usableUrl = url !== undefined && isConversationUrl(url) ? url : undefined;
    if (conversationId === undefined && usableUrl === undefined) return;

    const args: RememberConversationArgs = { key: use.key };
    if (conversationId !== undefined) args.conversationId = conversationId;
    if (usableUrl !== undefined) args.url = usableUrl;
    if (title !== undefined) args.title = title;
    if (use.surface !== undefined) args.surface = use.surface;
    else if (experience === "chat" || experience === "work") args.surface = experience;
    if (replaceIdentity) args.replaceIdentity = true;
    await this.registry.remember(args);
  }

  private async persistObserved(use: ConversationUse, result: CommandResult<unknown>, experience?: "chat" | "work", replaceIdentity = false): Promise<void> {
    try {
      await this.rememberObserved(use, result, experience, replaceIdentity);
      await this.rememberAffinityObserved(use, result, experience);
    } catch {
      result.warnings.push("Conversation metadata could not be persisted.");
    }
  }

  private async existingTab(resolution: ConversationResolution): Promise<{ existingTab?: ConversationAskArgs["existingTab"] }> {
    const record = await this.affinity.get(resolution.key);
    return record === undefined ? {} : { existingTab: { target: { type: "tabId", tabId: record.tabId }, ifMissing: "block", ifMultiple: "block", requireChatGPT: true } };
  }

  private async preflightAffinity(resolution: ConversationResolution): Promise<CommandResult<unknown> | undefined> {
    const affinity = await this.affinity.get(resolution.key);
    if (affinity === undefined) return undefined;

    const result = await this.client.session.bootstrap({
      existingTab: {
        target: { type: "tabId", tabId: affinity.tabId },
        ifMissing: "block",
        ifMultiple: "block",
        requireChatGPT: true
      },
      preferExistingTab: true
    });
    if (!result.ok) return result;

    const expectedIdentity = resolution.record?.conversationId
      ?? conversationIdFromUrl(resolution.record?.url)
      ?? affinity.conversationId
      ?? conversationIdFromUrl(affinity.url);
    const actualIdentity = result.context.conversationId ?? conversationIdFromUrl(result.context.url);
    if (
      result.context.tabId !== affinity.tabId
      || !isChatGPTConversationUrl(result.context.url)
      || (expectedIdentity !== undefined && actualIdentity !== expectedIdentity)
    ) {
      return affinityBlocker(result);
    }
    return undefined;
  }

  private async assertObservedAffinity(resolution: ConversationResolution, result: CommandResult<unknown>): Promise<void> {
    if (!result.ok) return;
    const expected = await this.affinity.get(resolution.key);
    if (expected === undefined) return;
    const actual = result.context;
    const matchesId = expected.conversationId === undefined || actual.conversationId === expected.conversationId;
    const matchesUrl = expected.url === undefined || (actual.url !== undefined && conversationUrlMatches(actual.url, expected.url));
    if (actual.tabId !== expected.tabId || !isChatGPTConversationUrl(actual.url) || !matchesId || !matchesUrl) {
      throw new Error("ChatGPT browser affinity verification failed.");
    }
  }

  private async rememberAffinityObserved(use: ConversationUse, result: CommandResult<unknown>, experience?: "chat" | "work"): Promise<void> {
    const { tabId, conversationId, url } = result.context;
    if (tabId === undefined || (conversationId === undefined && url === undefined)) return;
    await this.affinity.remember({
      key: use.key,
      tabId,
      surface: use.surface ?? experience ?? "chat",
      ...(conversationId === undefined ? {} : { conversationId }),
      ...(url === undefined ? {} : { url })
    });
  }
}

function isChatGPTConversationUrl(value: string | undefined): boolean {
  try { const url = new URL(value ?? ""); return ["chatgpt.com", "www.chatgpt.com", "chat.openai.com"].includes(url.hostname) && url.pathname.startsWith("/c/"); }
  catch { return false; }
}

function conversationUrlMatches(actual: string, expected: string): boolean {
  try { return new URL(actual).pathname === new URL(expected).pathname; } catch { return false; }
}

function conversationIdFromUrl(value: string | undefined): string | undefined {
  try {
    const url = new URL(value ?? "");
    if (!["chatgpt.com", "www.chatgpt.com", "chat.openai.com"].includes(url.hostname)) return undefined;
    const id = url.pathname.split("/")[2];
    return id === undefined || id.length === 0 ? undefined : decodeURIComponent(id);
  } catch {
    return undefined;
  }
}

function affinityBlocker(result: CommandResult<unknown>): CommandResult<unknown> {
  return {
    ok: false,
    status: "blocked",
    warnings: result.warnings,
    blocker: {
      kind: "selector_drift",
      code: "tab_affinity_lost",
      message: "ChatGPT browser affinity verification failed before the requested action.",
      remediation: [
        {
          label: "Reclaim the intended tab",
          instruction: "Run session.bootstrap again with an exact existingTab target, or pass the correct page/tab to createChatGPT before retrying.",
          userActionRequired: false
        }
      ],
      resumable: false
    },
    context: result.context
  };
}

export function createConversationManager(client: ConversationClient, options: ConversationManagerOptions = {}): ConversationManager {
  return new ConversationManager(client, options);
}

function isConversationUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ["chatgpt.com", "www.chatgpt.com", "chat.openai.com"].includes(url.hostname) && url.pathname.startsWith("/c/");
  } catch {
    return false;
  }
}
