import type { CommandContext, CommandResult, ExistingTabDiagnostics } from "../types.js";
type RemediationStep = NonNullable<NonNullable<CommandResult["blocker"]>["remediation"]>[number];
type VisibleCandidate = NonNullable<NonNullable<CommandResult["blocker"]>["candidates"]>[number];
export type BlockerSeverity = "info" | "warning" | "action_required" | "blocked";
export type BlockerCategory = "environment" | "auth" | "permission" | "ui_drift" | "user_confirmation" | "targeting" | "runtime" | "not_found" | "artifact" | "download" | "upload" | "unknown";
export type BlockerRetryGuidance = {
    safe: true;
    when: string;
    command?: string;
} | {
    safe: false;
    reason: string;
};
export type BlockerResumeGuidance = {
    supported: true;
    stateId?: string;
    command?: string;
} | {
    supported: false;
    reason: string;
};
export type BlockerExplanation = {
    kind: string;
    code?: string;
    title: string;
    summary: string;
    severity: BlockerSeverity;
    category: BlockerCategory;
    userActionRequired: boolean;
    retry: BlockerRetryGuidance;
    resume: BlockerResumeGuidance;
    remediation: RemediationStep[];
    candidates?: VisibleCandidate[];
    context?: {
        command?: string;
        url?: string;
        conversationId?: string;
        tabId?: string;
    };
    diagnostics?: {
        existingTab?: ExistingTabDiagnostics;
    };
    nextCommands: string[];
    markdown: string;
};
export type ExplainBlockerOptions = {
    command?: string;
    context?: Partial<CommandContext>;
    stateId?: string;
    nextCommands?: string[];
};
type Blocker = NonNullable<CommandResult["blocker"]>;
export declare function explainCommandBlocker(resultOrBlocker: CommandResult<unknown> | Blocker | undefined, options?: ExplainBlockerOptions): BlockerExplanation;
export {};
