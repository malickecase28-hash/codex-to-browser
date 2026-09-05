import { type OperationCollectRequestV1, type OperationControlRequestV1, type OperationInspectRequestV1, type OperationSubmitRequestV1 } from "./types.js";
/**
 * Raised by the closed runtime validators in this module.
 *
 * The message intentionally contains no field name or value. Operation
 * requests can contain prompts and local paths, and validation failures must
 * be safe to send across a backend boundary.
 */
export declare class OperationWireRequestError extends Error {
    readonly code: "invalid_operation_request";
    readonly recoverable: false;
    constructor();
}
/** Validate the canonical direct v1 submit payload. */
export declare function validateOperationSubmitRequest(value: unknown): asserts value is OperationSubmitRequestV1;
/** Validate the canonical direct v1 collect payload. */
export declare function validateOperationCollectRequest(value: unknown): asserts value is OperationCollectRequestV1;
/** Validate the canonical direct v1 inspect payload. */
export declare function validateOperationInspectRequest(value: unknown): asserts value is OperationInspectRequestV1;
/** Validate the canonical direct v1 control payload. */
export declare function validateOperationControlRequest(value: unknown): asserts value is OperationControlRequestV1;
