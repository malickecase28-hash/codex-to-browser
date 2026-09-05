import type { CommandResult, NewThreadArgs, OpenThreadArgs, OpenThreadData, RuntimeEnv, SearchThreadsArgs, SearchThreadsData, ThreadSearchResult } from "../types.js";
export declare function extractThreadSearchResultsFromHtml(html: string): ThreadSearchResult[];
export declare function searchThreads(env: RuntimeEnv, args: SearchThreadsArgs): Promise<CommandResult<SearchThreadsData>>;
export declare function newThread(env: RuntimeEnv, args?: NewThreadArgs): Promise<CommandResult<OpenThreadData>>;
export declare function openThread(env: RuntimeEnv, args: OpenThreadArgs, previousResults?: Map<string, CommandResult<unknown>>): Promise<CommandResult<OpenThreadData>>;
export declare function selectSearchResult(results: ThreadSearchResult[], select?: OpenThreadArgs["select"]): ThreadSearchResult | undefined;
