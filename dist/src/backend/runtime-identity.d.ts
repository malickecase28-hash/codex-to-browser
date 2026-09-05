import type { BackendSessionOptions } from "./session.js";
/**
 * Resolve truthful provenance for the exact backend entry artifact.
 *
 * The digest is computed from the loaded file, so copied/sanitized plugin
 * bundles do not accidentally inherit the source bundle's identity. Package
 * metadata is discovered from a bounded ancestor walk and is optional:
 * unknown is preferable to guessing when a custom embedding has no manifest.
 */
export declare function detectPackagedBackendIdentity(moduleUrl: string | URL): Promise<BackendSessionOptions["backendIdentity"]>;
