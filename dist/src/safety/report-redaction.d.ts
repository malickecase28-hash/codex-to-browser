export type ReportRedactionOptions = {
    includeContent?: boolean;
    maxPreviewChars?: number;
    maxDepth?: number;
    maxArrayItems?: number;
    maxObjectEntries?: number;
};
export declare function redactReportValue(value: unknown, options?: ReportRedactionOptions): unknown;
