import { type ResponseWatcherRecord, type ResponseWatcherResumer } from "./response-watchers.js";
import type { CollectorOptions, CollectorResult } from "./operations/collector.js";
import type { OperationHandleV1 } from "./operations/types.js";
export type ResponseWatcherObservationIdentity = Readonly<Pick<ResponseWatcherRecord, "providerId" | "browserId" | "tabId" | "conversationId" | "operationId" | "targetBindingDigest">>;
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
export type ResponseWatcherHandleResolver = (watcher: ResponseWatcherRecord) => Promise<OperationHandleV1> | OperationHandleV1;
export declare class ResponseWatcherObservationIdentityError extends Error {
    constructor();
}
/**
 * Adapt the authenticated operation collect path to the watcher resumer.
 * The resolver owns restart-safe handle reconstruction; collect owns exact
 * tab binding, ownership classification, and the read-only browser path.
 */
export declare function createOperationResponseWatcherObservationPort(collector: ResponseWatcherOperationCollector, resolveHandle: ResponseWatcherHandleResolver): ResponseWatcherObservationPort;
export declare function createResponseWatcherResumer(port: ResponseWatcherObservationPort): ResponseWatcherResumer;
