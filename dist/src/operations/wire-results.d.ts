import type { CollectorResult } from "./collector.js";
import type { ControlResult } from "./control.js";
import type { OperationBlockerV1, OperationControlReceiptV1, OperationHandleV1, OperationResponseFormatV1, OperationReceiptV1, OperationStateV1 } from "./types.js";
import type { OperationInspectResult, OperationSubmitResult } from "./service.js";
import type { BackendCompatibilityReport } from "../backend/protocol.js";
/** Versioned result envelopes used at backend/SDK boundaries. */
export declare const OPERATION_SUBMIT_RESULT_SCHEMA_VERSION: "chatgpt.browser_control.operation_submit_result.v1";
export declare const OPERATION_COLLECT_RESULT_SCHEMA_VERSION: "chatgpt.browser_control.operation_collect_result.v1";
export declare const OPERATION_INSPECT_RESULT_SCHEMA_VERSION: "chatgpt.browser_control.operation_inspect_result.v1";
export declare const OPERATION_CONTROL_RESULT_SCHEMA_VERSION: "chatgpt.browser_control.operation_control_result.v1";
export declare const OPERATION_LIVE_RESPONSE_SCHEMA_VERSION: "chatgpt.browser_control.operation_live_response.v1";
export declare const MAX_WIRE_RESPONSE_BYTES: number;
export declare const MAX_WIRE_RESPONSE_CHARS: number;
export declare const MAX_WIRE_BLOCKER_MESSAGE_LENGTH = 512;
export declare const MAX_WIRE_ARTIFACTS = 32;
export type OperationWireStatus = "accepted" | "completed" | "pending" | "blocked" | "uncertain";
/**
 * Raw response content is deliberately a separate, explicitly ephemeral
 * value. It is never accepted by a receipt or durable state validator.
 */
export type OperationLiveResponseV1 = Readonly<{
    schemaVersion: typeof OPERATION_LIVE_RESPONSE_SCHEMA_VERSION;
    durability: "ephemeral";
    durable: false;
    content: string;
    responseFormat?: OperationResponseFormatV1;
    bytes: number;
    chars: number;
}>;
type OperationWireBase = Readonly<{
    operationId: string;
    requestDigest: string;
    handle: OperationHandleV1;
}>;
export type OperationSubmitWireResult = (OperationWireBase & Readonly<{
    schemaVersion: typeof OPERATION_SUBMIT_RESULT_SCHEMA_VERSION;
    status: "accepted";
}>) | (OperationWireBase & Readonly<{
    schemaVersion: typeof OPERATION_SUBMIT_RESULT_SCHEMA_VERSION;
    status: "completed";
    receipt: OperationReceiptV1;
}>) | (OperationWireBase & Readonly<{
    schemaVersion: typeof OPERATION_SUBMIT_RESULT_SCHEMA_VERSION;
    status: "blocked" | "uncertain";
    blocker: OperationBlockerV1;
}>);
export type OperationCollectWireResult = (OperationWireBase & Readonly<{
    schemaVersion: typeof OPERATION_COLLECT_RESULT_SCHEMA_VERSION;
    status: "completed";
    receipt: OperationReceiptV1;
    liveResponse?: OperationLiveResponseV1;
}>) | (OperationWireBase & Readonly<{
    schemaVersion: typeof OPERATION_COLLECT_RESULT_SCHEMA_VERSION;
    status: "pending";
}>) | (OperationWireBase & Readonly<{
    schemaVersion: typeof OPERATION_COLLECT_RESULT_SCHEMA_VERSION;
    status: "blocked" | "uncertain";
    blocker: OperationBlockerV1;
}>);
export type OperationInspectWireResult = OperationWireBase & Readonly<{
    schemaVersion: typeof OPERATION_INSPECT_RESULT_SCHEMA_VERSION;
    status: "completed" | "pending" | "uncertain";
    state: OperationStateV1;
    /** Additive transport provenance; absent for direct in-process backends. */
    compatibility?: BackendCompatibilityReport;
}>;
export type OperationControlWireResult = OperationWireBase & Readonly<{
    schemaVersion: typeof OPERATION_CONTROL_RESULT_SCHEMA_VERSION;
    status: "completed" | "blocked" | "uncertain";
    parentRequestDigest: string;
    parentTargetBindingDigest: string;
    controlActionId: string;
    action: "stop" | "steer";
    expectedAssistantTurnId: string;
    receipt?: OperationControlReceiptV1;
    blocker?: OperationBlockerV1;
}>;
export declare class OperationWireResultError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
/** Convert the internal submission result into a strict, versioned envelope. */
export declare function toOperationSubmitWireResult(result: OperationSubmitResult, receipt?: OperationReceiptV1): OperationSubmitWireResult;
/** Convert the collector result using the freshly reloaded handle and receipt. */
export declare function toOperationCollectWireResult(
/** The handle freshly reloaded after the collector attempt (including pending). */
handle: OperationHandleV1, result: CollectorResult, receipt?: OperationReceiptV1): OperationCollectWireResult;
/** Inspect is a durable read, so its status is derived from the fresh state. */
export declare function toOperationInspectWireResult(result: OperationInspectResult): OperationInspectWireResult;
/** Convert a control result with the current parent handle reloaded by the service. */
export declare function toOperationControlWireResult(result: ControlResult, handle: OperationHandleV1): OperationControlWireResult;
export declare function liveResponseFromText(content: string, responseFormat?: OperationResponseFormatV1): OperationLiveResponseV1;
export declare function validateOperationSubmitWireResult(value: unknown): OperationSubmitWireResult;
export declare function validateOperationCollectWireResult(value: unknown): OperationCollectWireResult;
export declare function validateOperationInspectWireResult(value: unknown): OperationInspectWireResult;
export declare function validateOperationControlWireResult(value: unknown): OperationControlWireResult;
export {};
