import { type BackendCompatibilityReport, type BackendRuntimeIdentity } from "./protocol.js";
export type BackendCompatibilityExpectedIdentity = Partial<Pick<BackendRuntimeIdentity, "backendSessionId" | "packageName" | "packageVersion" | "runtime" | "runtimeVersion" | "buildDigest">>;
/**
 * Compare only explicitly supplied, bounded provenance. Package/runtime
 * differences are diagnostic warnings; protocol/capability rejection is
 * handled by the handshake before browser commands are admitted.
 */
export declare function compatibilityReportFromHello(value: Record<string, unknown>, expected: BackendCompatibilityExpectedIdentity | undefined, mode: "multiplexed" | "single-flight" | "legacy"): BackendCompatibilityReport;
export declare function compatibilityReportFromLegacy(version: Record<string, unknown>, expected: BackendCompatibilityExpectedIdentity | undefined): BackendCompatibilityReport;
export declare function blockedCompatibilityReport(message?: string): BackendCompatibilityReport;
/** Validate transport-owned diagnostics before exposing them through a facade. */
export declare function validateBackendCompatibilityReport(value: unknown): BackendCompatibilityReport;
