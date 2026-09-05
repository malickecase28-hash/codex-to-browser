import { type MenuItem } from "../dom/menus.js";
import type { ApplyConfigurationArgs, ApplyConfigurationData, ChatGPTExperience, CommandResult, ConfigurationAxis, ConfigurationInspectionData, ConfigurationSelection, InspectConfigurationArgs, RuntimeEnv, SurfaceSelectorProfile } from "../types.js";
export type ConfigurationPanelSnapshot = {
    openerLabel?: string;
    axisRows: Array<{
        axis: ConfigurationAxis;
        label: string;
        value?: string;
    }>;
    advancedVisible: boolean;
};
export declare function inspectConfiguration(env: RuntimeEnv, args?: InspectConfigurationArgs): Promise<CommandResult<ConfigurationInspectionData>>;
export declare function applyConfiguration(env: RuntimeEnv, args: ApplyConfigurationArgs): Promise<CommandResult<ApplyConfigurationData>>;
export declare function configurationInspectionFromSurface(experience: ChatGPTExperience, detectedProfile: SurfaceSelectorProfile, evidence: ConfigurationInspectionData["evidence"], panel: ConfigurationPanelSnapshot, menuItems: MenuItem[]): ConfigurationInspectionData;
export declare function configurationMatchesSelection(inspection: ConfigurationInspectionData, desired: ConfigurationSelection): boolean;
