export type CoverageLanguage = {
    language: string;
    nativeName: string;
    bcp47: string;
    speakers: string;
    status: string;
};
export declare function parseLanguageCoverageMarkdown(markdown: string): CoverageLanguage[];
export declare function readLanguageCoverage(path: string): Promise<CoverageLanguage[]>;
export declare function nonEnglishLanguages(languages: readonly CoverageLanguage[]): CoverageLanguage[];
