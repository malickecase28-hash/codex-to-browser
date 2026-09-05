import { type ProductionAttachmentPrimitive } from "./production-attachments.js";
import type { BrowserObservationDigest } from "./browser-observation.js";
import type { OperationFileIdentity, OperationFileManifestEntryV1 } from "./file-identity.js";
/**
 * Options for the ChatGPT-specific attachment provider.
 *
 * This adapter deliberately composes the provider-neutral attachment
 * primitive.  It only supplies bounded, semantic ChatGPT DOM callbacks; the
 * primitive retains ownership of the one-shot chooser state machine and of
 * all request-local file paths.
 */
export type ChatGPTAttachmentProviderOptions = Readonly<{
    evidenceDigest: BrowserObservationDigest;
    files: readonly OperationFileIdentity[];
    identityDigest: (ordinal: number, manifest: OperationFileManifestEntryV1) => string;
    revalidateFile: (identity: OperationFileIdentity) => Promise<void>;
    timeoutMs?: number;
    maxCandidates?: number;
    /** Optional BCP-47 tag used only to select locale-aware DOM labels. */
    locale?: string;
    /** Request-local cancellation.  It is never serialized or returned. */
    signal?: AbortSignal;
}>;
/** The resulting capability is the same narrow surface as the core primitive. */
export type ChatGPTAttachmentProvider = ProductionAttachmentPrimitive;
export declare const CHATGPT_ATTACHMENT_PROVIDER_SCHEMA_VERSION: "chatgpt.browser_control.production_chatgpt_attachments.v1";
type RawAttachmentFact = Readonly<{
    ordinal: number;
    namePresent: boolean;
    sizePresent: boolean;
    nameMatch?: boolean;
    bytesMatch?: boolean;
    matchOrdinal?: number;
    ambiguous?: boolean;
    orderKey?: number;
}>;
type RawComposerProbe = Readonly<{
    status: "ready" | "ambiguous" | "unavailable";
    composerCount: number;
    fileInputCount: number;
    inputFilesReadable: boolean;
    attachmentRegionCount: number;
    facts: readonly RawAttachmentFact[];
    secondaryFacts: readonly RawAttachmentFact[];
    factSource: "input" | "metadata" | "none" | "mixed";
    orderDeterministic: boolean;
    directActivationSelector?: string;
    menuOpenerSelector?: string;
    menuUploadSelector?: string;
    activationCandidateCount: number;
}>;
/**
 * Build a request-scoped ChatGPT attachment capability.
 *
 * Important recovery property: a non-empty exact observation is impossible
 * until this exact returned capability has completed its own chooser handoff.
 * A fresh provider instance observing an existing/same-name attachment stays
 * ambiguous, including after a process restart.
 */
export declare function createChatGPTAttachmentProvider(options: ChatGPTAttachmentProviderOptions): ChatGPTAttachmentProvider;
export declare const createProductionChatGPTAttachments: typeof createChatGPTAttachmentProvider;
export declare const createChatGPTProductionAttachmentPrimitive: typeof createChatGPTAttachmentProvider;
/**
 * This function is serialized into the page. It uses HTML/ARIA structure as
 * the primary semantic contract and only uses the verified locale registry as
 * a text fallback for localized menu rows. It returns no raw labels, URLs,
 * prompts, account data, or file paths.
 */
/** @internal Exact serialized evaluator, exported only for bridge-contract tests. */
export declare function inspectChatGPTComposer(argument: unknown): RawComposerProbe;
export {};
