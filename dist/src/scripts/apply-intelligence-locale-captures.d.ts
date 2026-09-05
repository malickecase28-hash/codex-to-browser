type IntelligenceModeOptionId = "instant" | "medium" | "high" | "extraHigh" | "pro";
type ExperienceOptionId = "chat" | "work";
type ConfigurationAxisId = "model" | "intelligence" | "effort" | "speed" | "power" | "advanced";
type ConfigurationOptionId = "instant" | "light" | "medium" | "high" | "extraHigh" | "max" | "ultra" | "pro" | "standard" | "fast";
type SurfaceContribution = {
    workComposerTextbox: string[];
    experienceOptions: Partial<Record<ExperienceOptionId, string[]>>;
    configurationAxes: Partial<Record<ConfigurationAxisId, string[]>>;
    configurationOptions: Partial<Record<ConfigurationOptionId, string[]>>;
};
export declare function main(argv?: string[]): Promise<number>;
export declare function mergeCapture(source: string, labels: readonly string[], modeOptions: Partial<Record<IntelligenceModeOptionId, string[]>>, generationLabels?: {
    stopControl?: readonly string[];
    stoppedAssistant?: readonly string[];
}, surface?: SurfaceContribution): string;
export {};
