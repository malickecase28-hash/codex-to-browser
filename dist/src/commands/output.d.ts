export declare function commandOutputText(data: unknown): string | undefined;
export declare function withCommandOutputText<T extends {
    data?: unknown;
    output_text?: string;
}>(result: T): T;
