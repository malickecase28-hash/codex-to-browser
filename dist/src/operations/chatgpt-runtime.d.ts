import type { PageLike, RuntimeEnv } from "../types.js";
import { type CoordinatorOwner, type ProcessTabCoordinator } from "../runtime/tab-coordinator.js";
import type { OperationRuntimeCapabilities } from "../runtime/operation-context.js";
import { type OperationRuntimeBrowserPrimitives } from "./runtime-adapter.js";
import type { BrowserTargetEvidenceDigest } from "./browser-target.js";
import type { OperationAdapterFactory, OperationAdapterFactoryContext, OperationHandleAdapterFactory, OperationControlAdapterFactory } from "./client.js";
import type { OperationConfigurationRequestV1, OperationSurface, OperationTargetBindingV1 } from "./types.js";
export type ChatGPTRuntimeFactoryOptions = Readonly<{
    env: RuntimeEnv;
    owner: CoordinatorOwner;
    evidenceDigest: BrowserTargetEvidenceDigest;
    coordinator?: ProcessTabCoordinator;
    transactionTimeoutMs?: number;
    surfaceTimeoutMs?: number;
    capabilities?: Partial<OperationRuntimeCapabilities>;
    primitives?: (context: ChatGPTPrimitiveFactoryContext) => Partial<OperationRuntimeBrowserPrimitives> | undefined;
}>;
export type ChatGPTPrimitiveFactoryContext = Readonly<{
    operationId: string;
    requestDigest: string;
    surface: OperationSurface;
    prompt?: string;
    configuration?: OperationConfigurationRequestV1;
    files: OperationAdapterFactoryContext["files"];
    signal: AbortSignal;
    page: Readonly<PageLike>;
    target?: OperationTargetBindingV1;
}>;
export declare function createChatGPTOperationControlAdapterFactory(options: ChatGPTRuntimeFactoryOptions): OperationControlAdapterFactory;
export declare const createChatGPTControlAdapterFactory: typeof createChatGPTOperationControlAdapterFactory;
export declare class ChatGPTRuntimeFactoryError extends Error {
    readonly code: "chatgpt_runtime_unavailable";
    constructor();
}
export declare function createChatGPTOperationAdapterFactory(options: ChatGPTRuntimeFactoryOptions): OperationAdapterFactory;
export declare const createChatGPTOperationRuntimeFactory: typeof createChatGPTOperationAdapterFactory;
export declare function createChatGPTOperationHandleAdapterFactory(options: ChatGPTRuntimeFactoryOptions): OperationHandleAdapterFactory;
export declare const createChatGPTOperationRecoveryFactory: typeof createChatGPTOperationHandleAdapterFactory;
