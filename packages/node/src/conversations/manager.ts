import type { AskWorkflowArgs, ChatGPTClient, RunMessagesArgs, WorkflowThread } from "../client.js";
import type { CommandContext, CommandResult, ReadLatestArgs } from "../types.js";
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
type AffinityPreflight =
  | { state: "none" }
  | { state: "verified"; tabId: string; semantic: Pick<CommandContext, "conversationId" | "url"> }
  | { state: "blocked"; result: CommandResult<unknown> };

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
    const preflight = await this.preflightAffinity(resolution);
    if (preflight.state === "blocked") return preflight.result;
    const result = this.applyAffinity(await this.client.openThread(resolution.thread), preflight);
    if (result.ok) await this.persistObserved({ ...use, key: resolution.key }, result, undefined, resolution.source === "new" || resolution.source === "current");
    return result;
  }

  async readLatest(use: ConversationUse, args?: ReadLatestArgs): Promise<CommandResult<unknown>> {
    const resolution = await this.resolve(use);
    const preflight = await this.preflightAffinity(resolution);
    if (preflight.state === "blocked") return preflight.result;
    const verifiedOpened = this.applyAffinity(await this.client.openThread(resolution.thread), preflight);
    if (!verifiedOpened.ok) return verifiedOpened;
    await this.persistObserved({ ...use, key: resolution.key }, verifiedOpened, undefined, resolution.source === "new" || resolution.source === "current");
    const result = this.applyAffinity(await this.client.readLatest(args), preflight);
    if (result.ok) await this.persistObserved({ ...use, key: resolution.key }, result, undefined, resolution.source === "new" || resolution.source === "current");
    return result;
  }

  async ask(args: ConversationAskArgs): Promise<CommandResult<unknown>> {
    const resolution = await this.resolve(args.conversation);
    const preflight = await this.preflightAffinity(resolution);
    if (preflight.state === "blocked") return preflight.result;
    const { conversation: _conversation, ...input } = args;
    const result = this.applyAffinity(await this.client.ask({ ...input, thread: resolution.thread, ...(await this.existingTab(resolution)) }), preflight);
    if (!result.ok) return result;
    if (result.ok) await this.persistObserved({ ...args.conversation, key: resolution.key }, result, input.experience, resolution.source === "new" || resolution.source === "current");
    return result;
  }

  async runMessages(args: ConversationRunMessagesArgs): Promise<CommandResult<unknown>> {
    const resolution = await this.resolve(args.conversation);
    const preflight = await this.preflightAffinity(resolution);
    if (preflight.state === "blocked") return preflight.result;
    const { conversation: _conversation, ...input } = args;
    const result = this.applyAffinity(await this.client.runMessages({ ...input, thread: resolution.thread, ...(await this.existingTab(resolution)) }), preflight);
    if (!result.ok) return result;
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

  private async preflightAffinity(resolution: ConversationResolution): Promise<AffinityPreflight> {
    const affinity = await this.affinity.get(resolution.key);
    if (affinity === undefined) return { state: "none" };

    const result = await this.client.session.bootstrap({
      existingTab: {
        target: { type: "tabId", tabId: affinity.tabId },
        ifMissing: "block",
        ifMultiple: "block",
        requireChatGPT: true
      },
      preferExistingTab: true
    });
    if (!result.ok) return { state: "blocked", result };

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
      return { state: "blocked", result: affinityBlocker(result) };
    }
    return { state: "verified", tabId: affinity.tabId, semantic: { ...(actualIdentity === undefined ? {} : { conversationId: actualIdentity }), ...(result.context.url === undefined ? {} : { url: result.context.url }) } };
  }

  private applyAffinity(result: CommandResult<unknown>, preflight: AffinityPreflight): CommandResult<unknown> {
    if (preflight.state !== "verified") return result;
    const actual = result.context;
    if (actual.tabId !== undefined && actual.tabId !== preflight.tabId) return affinityBlocker(result);
    const actualIdentity = actual.conversationId ?? conversationIdFromUrl(actual.url);
    if (
      (preflight.semantic.conversationId !== undefined && actualIdentity !== preflight.semantic.conversationId)
      || (preflight.semantic.url !== undefined && (actual.url === undefined || !conversationUrlMatches(actual.url, preflight.semantic.url)))
    ) return affinityBlocker(result);
    return actual.tabId === undefined ? { ...result, context: { ...actual, tabId: preflight.tabId } } : result;
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
