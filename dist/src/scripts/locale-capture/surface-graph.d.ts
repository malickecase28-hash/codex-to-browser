export type RawSurfaceOption = {
    label: string;
    checked: boolean;
};
export type RawConfigurationRow = {
    label: string;
    axisLabel: string;
    valueLabel?: string;
    options: Array<{
        label: string;
        checked: boolean;
    }>;
};
export type RawWorkConfigurationRow = RawConfigurationRow;
export type CapturedChatConfigurationRow = RawConfigurationRow & {
    axis: "model" | "effort";
};
export type CapturedWorkConfigurationRow = RawConfigurationRow & {
    axis: "model" | "effort" | "speed";
};
export declare function assignChatSelectedSurfaceOptions(options: readonly RawSurfaceOption[]): {
    chatLabel: string;
    workLabel: string;
};
export declare function assignOrderedSurfaceOptions(options: readonly RawSurfaceOption[]): {
    chatLabel: string;
    workLabel: string;
    selected: "chat" | "work";
};
export declare function assignOrderedWorkConfigurationRows(rows: readonly RawWorkConfigurationRow[]): CapturedWorkConfigurationRow[];
export declare function assignOrderedChatConfigurationRows(rows: readonly RawConfigurationRow[]): CapturedChatConfigurationRow[];
