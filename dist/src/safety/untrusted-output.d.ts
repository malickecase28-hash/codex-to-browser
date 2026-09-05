export declare const UNTRUSTED_OUTPUT_INLINE_LIMIT_BYTES = 12000;
export declare const UNTRUSTED_OUTPUT_SCHEMA_VERSION: "chatgpt.browser_control.untrusted_output_return.v1";
export declare const INTEGRITY_SCHEMA_VERSION: "chatgpt.browser_control.integrity.v1";
export type UntrustedOutputReturnEnvelope = {
    schemaVersion: typeof UNTRUSTED_OUTPUT_SCHEMA_VERSION;
    trusted: false;
    source: string;
    capturedAt: string;
    contentSha256: string;
    contentBytes: number;
    inline: boolean;
    maxInlineBytes: number;
    outputPath?: string;
    rendered: string;
};
export type UntrustedOutputEnvelopeArgs = {
    outputText: string;
    source: string;
    capturedAt: string;
    outputPath?: string;
    maxInlineBytes?: number;
    metadata?: Record<string, string | number | boolean | undefined>;
};
export type IntegrityDigest = {
    sha256: string;
    bytes: number;
};
export type IntegrityFileDigest = IntegrityDigest & {
    path: string;
};
export type IntegritySidecar = {
    schemaVersion: typeof INTEGRITY_SCHEMA_VERSION;
    createdAt: string;
    target: IntegrityFileDigest;
    prompt?: IntegrityDigest & {
        normalized: true;
    };
    output?: IntegrityDigest & {
        untrusted: true;
    };
    inputs: IntegrityFileDigest[];
};
export type IntegrityVerificationMismatch = {
    kind: "target" | "input";
    path: string;
    expected: IntegrityDigest;
    actual?: IntegrityDigest;
    error?: string;
};
export type IntegrityVerificationResult = {
    ok: boolean;
    sidecar: IntegritySidecar;
    mismatches: IntegrityVerificationMismatch[];
};
export type WriteJsonArtifactIntegrityOptions = {
    createdAt: string;
    prompt?: string;
    outputText?: string;
    inputPaths?: string[];
};
export declare function fencedTextBlock(text: string, info?: string): string;
export declare function renderUntrustedOutputReturnEnvelope(args: UntrustedOutputEnvelopeArgs): UntrustedOutputReturnEnvelope;
export declare function normalizePromptForIntegrity(prompt: string): string;
export declare function sha256Text(text: string): string;
export declare function sha256File(path: string): Promise<IntegrityFileDigest>;
export declare function writeJsonArtifactWithIntegrity(path: string, value: unknown, options: WriteJsonArtifactIntegrityOptions): Promise<{
    path: string;
    bytes: number;
    metaPath: string;
    sidecar: IntegritySidecar;
}>;
export declare function verifyIntegritySidecar(sidecarPath: string): Promise<IntegrityVerificationResult>;
export declare function writeFileAtomicNoOverwrite(path: string, payload: string): Promise<void>;
