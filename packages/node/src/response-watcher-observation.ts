import {
  type ResponseWatcherCompletion,
  type ResponseWatcherRecord,
  type ResponseWatcherResumer
} from "./response-watchers.js";

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

export class ResponseWatcherObservationIdentityError extends Error {
  constructor() {
    super("Response watcher observation identity does not match the registered watcher.");
    this.name = "ResponseWatcherObservationIdentityError";
  }
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
