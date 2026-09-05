import type { BrowserLike, ExistingTabPolicy, PageLike } from "../types.js";
import { type CoverageLanguage } from "./locale-capture/language-coverage.js";
import { type CapturedChatConfigurationRow, type CapturedWorkConfigurationRow } from "./locale-capture/surface-graph.js";
declare const SCHEMA_VERSION = "chatgpt.browser_control.intelligence_locale_capture.v1";
type CaptureStatus = "ok" | "blocked";
type CaptureRecord = {
    schemaVersion: typeof SCHEMA_VERSION;
    status: CaptureStatus;
    capturedAt: string;
    requestedLocale: string;
    requestedNativeName: string;
    htmlLang?: string | undefined;
    url?: string | undefined;
    menuHeading?: string | undefined;
    intelligenceLabels?: string[] | undefined;
    selectedIntelligenceLabel?: string | undefined;
    versionFamilyLabels?: string[] | undefined;
    modelVersionLabels?: string[] | undefined;
    generationStopLabels?: string[] | undefined;
    generationStoppedLabels?: string[] | undefined;
    generationSignals?: string[] | undefined;
    surfaceCapture?: LocaleSurfaceCapture | undefined;
    warnings: string[];
    blocker?: {
        kind: string;
        code: string;
        message: string;
    };
};
type LocaleSurfaceCapture = {
    schemaVersion: "chatgpt.browser_control.locale_surface_capture.v1";
    status: CaptureStatus;
    chat?: {
        optionLabel: string;
        composerLabels: string[];
        power: CapturedPowerControl;
        advanced: CapturedAdvancedControl;
        configurationRows: CapturedChatConfigurationRow[];
    };
    work?: {
        optionLabel: string;
        composerLabels: string[];
        power: CapturedPowerControl;
        advanced: CapturedAdvancedControl;
        configurationRows: CapturedWorkConfigurationRow[];
    };
    restoredChat: boolean;
    warnings: string[];
    blocker?: {
        kind: "selector_drift";
        code: string;
        message: string;
    };
};
type CapturedPowerControl = {
    axisLabel: string;
    valueLabel: string;
    minimum: number;
    maximum: number;
    value: number;
    position: number;
    count: number;
};
type CapturedAdvancedControl = {
    label: string;
    accessibleLabel?: string | undefined;
    expanded: boolean;
    initiallyExpanded?: boolean | undefined;
};
type CapturedConfigurationMenu<TRow extends CapturedChatConfigurationRow | CapturedWorkConfigurationRow> = {
    openerLabel: string;
    power: CapturedPowerControl;
    advanced: CapturedAdvancedControl;
    rows: TRow[];
};
type CaptureOptions = {
    locale: string | undefined;
    nativeName: string | undefined;
    out: string;
    printQueue: boolean;
    autoSwitch: boolean;
    all: boolean;
    limit: number | undefined;
    locales: string[] | undefined;
    openVersionSubmenu: boolean;
    captureGenerationState: boolean;
    captureSurfaces: boolean;
    generationPrompt: string;
    generationCaptureTimeoutMs: number;
    restore: boolean;
    settleMs: number;
    switchTimeoutMs: number;
    coveragePath: string;
    ifMissing: NonNullable<ExistingTabPolicy["ifMissing"]>;
    tabId: string | undefined;
};
type CaptureRuntime = {
    agent?: unknown;
    browser?: BrowserLike;
};
type GenerationUiSnapshot = {
    controls: CapturedGenerationControl[];
    shortLatestAssistantTexts: string[];
};
type CapturedGenerationControl = {
    label: string;
    text?: string | undefined;
    ariaLabel?: string | undefined;
    title?: string | undefined;
    testId?: string | undefined;
    role?: string | undefined;
};
type GenerationStateCapture = {
    stopLabels: string[];
    stoppedLabels: string[];
    signals: string[];
    warnings: string[];
    submitted: boolean;
    stopped: boolean;
};
type CaptureDependencies = {
    captureIntelligencePicker: typeof captureIntelligencePicker;
    captureGenerationStateLabels: typeof captureGenerationStateLabels;
};
export declare function main(argv?: string[], runtime?: CaptureRuntime): Promise<number>;
export declare function surfaceCaptureSucceeded(requested: boolean, capture: {
    status: "ok" | "blocked";
    restoredChat: boolean;
} | undefined): boolean;
export declare function parseArgs(argv: readonly string[]): CaptureOptions;
export declare function captureOne(page: PageLike, language: CoverageLanguage, options: CaptureOptions, knownLanguageNames: readonly string[], dependencies?: Partial<CaptureDependencies>): Promise<CaptureRecord>;
declare function captureIntelligencePicker(page: PageLike, options: CaptureOptions): Promise<{
    htmlLang: string;
    url: string;
    menuHeading?: string;
    intelligenceLabels: string[];
    selectedIntelligenceLabel?: string;
    versionFamilyLabels: string[];
    modelVersionLabels: string[];
    configuration: CapturedConfigurationMenu<CapturedChatConfigurationRow>;
}>;
declare function captureGenerationStateLabels(page: PageLike, options: Pick<CaptureOptions, "generationPrompt" | "generationCaptureTimeoutMs" | "settleMs">): Promise<GenerationStateCapture>;
export declare function generationStopLabels(before: GenerationUiSnapshot, active: GenerationUiSnapshot): string[];
export declare function snapshotLooksActive(snapshot: GenerationUiSnapshot): boolean;
export declare function stopGenerationIfVisible(page: PageLike, labels: readonly string[]): Promise<boolean>;
export {};
