import {
  type ResponseWatcherCompletion,
  type ResponseWatcherRecord,
  type ResponseWatcherResumer
} from "./response-watchers.js";
import type { CollectorOptions, CollectorResult } from "./operations/collector.js";
import type { OperationHandleV1 } from "./operations/types.js";

export type ResponseWatcherObservationIdentity = Readonly<Pick<
  ResponseWatcherRecord,
  "providerId" | "browserId" | "tabId" | "conversationId" | "operationId" | "targetBindingDigest"
>>;

export type ResponseWatcherCollectionResult = Readonly<{
  identity: ResponseWatcherObservationIdentity;
  status: "pending" | "blocked";
}> | Readonly<{
  identity: ResponseWatcherObservationIdentity;
  status: "terminal";
  assistantTurnId: string;
  assistantTurnCount: number;
}>;

export type ResponseWatcherObservationPort = Readonly<{
  collect(watcher: ResponseWatcherRecord): Promise<ResponseWatcherCollectionResult>;
}>;

export type ResponseWatcherOperationCollector = Readonly<{
  collect(handle: OperationHandleV1, options?: CollectorOptions): Promise<CollectorResult>;
}>;

export type ResponseWatcherHandleResolver = (
  watcher: ResponseWatcherRecord
) => Promise<OperationHandleV1> | OperationHandleV1;

export class ResponseWatcherObservationIdentityError extends Error {
  constructor() {
    super("Response watcher observation identity does not match the registered watcher.");
    this.name = "ResponseWatcherObservationIdentityError";
  }
}

/**
 * Adapt the authenticated operation collect path to the watcher resumer.
 * The resolver owns restart-safe handle reconstruction; collect owns exact
 * tab binding, ownership classification, and the read-only browser path.
 */
export function createOperationResponseWatcherObservationPort(
  collector: ResponseWatcherOperationCollector,
  resolveHandle: ResponseWatcherHandleResolver
): ResponseWatcherObservationPort {
  return {
    collect: async (watcher: ResponseWatcherRecord): Promise<ResponseWatcherCollectionResult> => {
      const handle = await resolveHandle(watcher);
      if (handle.operationId !== watcher.operationId || handle.targetBindingDigest !== watcher.targetBindingDigest) {
        throw new ResponseWatcherObservationIdentityError();
      }
      const result = await collector.collect(handle, {
        responseContent: "metadata",
        wait: false,
        maxAttempts: 1
      });
      if (result.operationId !== watcher.operationId
        || (result.targetBindingDigest !== undefined && result.targetBindingDigest !== watcher.targetBindingDigest)) {
        throw new ResponseWatcherObservationIdentityError();
      }
      if (result.kind === "completed") {
        return {
          identity: watcherIdentity(watcher),
          status: "terminal",
          assistantTurnId: result.turn.assistantTurnId,
          assistantTurnCount: watcher.baselineAssistantTurnCount + 1
        };
      }
      return { identity: watcherIdentity(watcher), status: result.kind };
    }
  };
}

export function createResponseWatcherResumer(
  port: ResponseWatcherObservationPort
): ResponseWatcherResumer {
  return async (watcher: ResponseWatcherRecord): Promise<ResponseWatcherCompletion | undefined> => {
    const result = await port.collect(watcher);
    if (!sameIdentity(watcher, result.identity)) throw new ResponseWatcherObservationIdentityError();
    if (result.status !== "terminal") return undefined;
    if (result.assistantTurnId.trim().length === 0 || !Number.isSafeInteger(result.assistantTurnCount) || result.assistantTurnCount < 1) {
      throw new TypeError("Invalid terminal response watcher observation.");
    }
    return {
      assistantTurnId: result.assistantTurnId,
      assistantTurnCount: result.assistantTurnCount
    };
  };
}

function sameIdentity(
  watcher: ResponseWatcherRecord,
  observation: ResponseWatcherObservationIdentity
): boolean {
  return watcher.providerId === observation.providerId
    && watcher.browserId === observation.browserId
    && watcher.tabId === observation.tabId
    && watcher.conversationId === observation.conversationId
    && watcher.operationId === observation.operationId
    && watcher.targetBindingDigest === observation.targetBindingDigest;
}

function watcherIdentity(watcher: ResponseWatcherRecord): ResponseWatcherObservationIdentity {
  return {
    providerId: watcher.providerId,
    browserId: watcher.browserId,
    tabId: watcher.tabId,
    conversationId: watcher.conversationId,
    operationId: watcher.operationId,
    targetBindingDigest: watcher.targetBindingDigest
  };
}
