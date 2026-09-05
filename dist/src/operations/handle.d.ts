import { type OperationControlRequestV1, type OperationHandleV1, type OperationStateV1, type OperationSubmitRequestV1 } from "./types.js";
import type { OperationFileManifestEntryV1 } from "./file-identity.js";
export declare class OperationHandleError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
export declare function operationSubmitRequestDigest(key: Uint8Array, request: OperationSubmitRequestV1, files: readonly OperationFileManifestEntryV1[]): string;
export declare function operationControlRequestDigest(key: Uint8Array, request: OperationControlRequestV1): string;
export declare function operationHandleFromState(key: Uint8Array, state: OperationStateV1): OperationHandleV1;
/**
 * Return only the immutable target material used for action/handle binding.
 * A provider-assigned identity may be added to a new target after Send, but
 * it must never change the digest that authorizes the original action.
 */
export declare function operationTargetBindingProjection(target: NonNullable<OperationStateV1["target"]>): unknown;
export declare function validateOperationHandle(key: Uint8Array, handle: OperationHandleV1, state: OperationStateV1): {
    stale: boolean;
    current: OperationHandleV1;
};
