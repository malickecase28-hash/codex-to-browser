import type { BrowserObservationDigest } from "./browser-observation.js";
import type { OperationBrowserStagingPrimitive } from "./browser-adapter.js";
import type { OperationConfigurationRequestV1 } from "./types.js";
export type ProductionConfigurationSurface = "chat" | "work";
export type ProductionConfigurationPrimitiveOptions = Readonly<{
    evidenceDigest: BrowserObservationDigest;
    operationId: string;
    requestDigest: string;
    surface: ProductionConfigurationSurface;
    configuration?: Readonly<OperationConfigurationRequestV1>;
}>;
export type ProductionConfigurationBlockerCode = "staging_request_mismatch" | "staging_observation_required" | "staging_mutation_already_attempted" | "staging_mutation_unreconciled" | "configuration_not_configured" | "configuration_surface_unavailable" | "configuration_surface_unsupported" | "configuration_control_ambiguous" | "configuration_option_unavailable" | "configuration_state_drift" | "configuration_observation_limit_exceeded" | "tool_not_configured" | "tool_surface_unavailable" | "tool_surface_unsupported" | "tool_selection_ambiguous" | "tool_option_unavailable" | "tool_state_unavailable" | "tool_state_drift" | "power_not_configured" | "power_surface_unavailable" | "power_surface_unsupported" | "power_mapping_incomplete" | "power_state_drift" | "power_restoration_required" | "power_control_unavailable" | "configuration_evidence_failed";
/**
 * A serializable probe result is exported so provider adapters and unit tests
 * can use deterministic fake pages without weakening the production path.
 * Labels remain internal to the primitive after this boundary and are never
 * returned by a staging callback.
 */
export type ProductionConfigurationDomControl = Readonly<{
    label: string;
    role?: string;
    testId?: string;
    id?: string;
    menuKey?: string;
    menuLabel?: string;
    selected?: boolean;
    visible?: boolean;
}>;
export type ProductionConfigurationDomSnapshot = Readonly<{
    surface: ProductionConfigurationSurface | "unknown";
    controls: readonly ProductionConfigurationDomControl[];
    truncated?: boolean;
}>;
export declare class ProductionConfigurationPrimitiveError extends Error {
    readonly code: ProductionConfigurationBlockerCode;
    constructor(code: ProductionConfigurationBlockerCode);
}
/** Create one request-scoped production configuration staging primitive. */
export declare function createProductionConfigurationStaging(options: ProductionConfigurationPrimitiveOptions): OperationBrowserStagingPrimitive;
/** Descriptive aliases for provider integrations that call this a primitive. */
export declare const createProductionConfigurationPrimitive: typeof createProductionConfigurationStaging;
export declare const createOperationProductionConfigurationStaging: typeof createProductionConfigurationStaging;
