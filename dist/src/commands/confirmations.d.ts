import type { CommandResult } from "../types.js";
export type Confirmation = {
    targetKind: string;
    targetDisplayName: string;
    action: string;
    understood: true;
};
export declare function requireConfirmation<T>(confirm: Confirmation | undefined, expected: Omit<Confirmation, "understood">): CommandResult<T> | undefined;
export declare function rejectNetworkCommand<T>(command: string): CommandResult<T> | undefined;
