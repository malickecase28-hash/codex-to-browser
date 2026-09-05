import { type MutationBoundary, type OperationActionKind, type OperationCapturePolicyV1, type OperationDurableCapturePolicyV1, type OperationEventV1, type OperationOwnershipBaselineV1, type OperationRepeatPolicy, type OperationStateV1 } from "./types.js";
/**
 * Copy only the closed capture contract into durable state.  In particular,
 * the request-local outputDirectory is intentionally not read or returned.
 * Missing capture options preserve the historical collect defaults while the
 * response format receives its explicit Markdown default.
 */
export declare function durableCapturePolicyFromRequest(capture: OperationCapturePolicyV1 | undefined): OperationDurableCapturePolicyV1;
export declare class OperationStateError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
export declare function assertOperationId(value: string, label?: string): void;
export declare function reduceOperationEvents(events: readonly OperationEventV1[]): OperationStateV1;
export declare function applyOperationEvent(state: OperationStateV1 | undefined, event: OperationEventV1, revision: number): OperationStateV1;
/**
 * Rejects unknown or request-only fields before an event can enter the durable
 * journal. TypeScript's structural types do not protect JavaScript callers at
 * runtime, so the privacy boundary must be closed explicitly.
 */
export declare function assertOperationEventShape(value: unknown): asserts value is OperationEventV1;
/** Validates the closed durable-state shape used by authenticated compaction. */
export declare function assertOperationStateShape(value: unknown): asserts value is OperationStateV1;
export declare function requiredRepeatPolicy(kind: OperationActionKind): OperationRepeatPolicy;
export declare function boundaryForAction(kind: OperationActionKind): MutationBoundary | undefined;
/** Closed-shape validation for the redacted pre-Send baseline. */
export declare function assertOwnershipBaselineShape(value: unknown): asserts value is OperationOwnershipBaselineV1;
/** Validate the closed, path-free policy carried by creation/state records. */
export declare function assertDurableCapturePolicyShape(value: unknown): asserts value is OperationDurableCapturePolicyV1;
