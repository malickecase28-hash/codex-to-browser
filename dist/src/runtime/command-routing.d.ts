import { ProcessTabCoordinator, type CoordinatorAcquisitionContext, type CoordinatorPriority } from "./tab-coordinator.js";
import type { OperationRuntimeContext } from "./operation-context.js";
import { type CoordinatedBrowserOptions } from "./coordinated-browser.js";
import type { RuntimeEnv } from "../types.js";
/**
 * Routing keeps the implementation classes visible while also exposing a
 * binary browser-free/coordinator-routed disposition for the acceptance
 * contract. Legacy command implementations still run directly, but their
 * page and browser method calls use the bounded coordinated runtime facade.
 * That does not make the whole command or its polling loop one coordinator
 * transaction.
 *
 * `operation_opt_in` means that an explicit caller-owned operation identity is
 * handled by an operation-aware public facade. It does not authorize wrapping
 * the whole public command in a coordinator callback.
 */
export type CommandRoutingClass = "browser_free" | "operation_opt_in" | "legacy_page_facade" | "legacy_browser_unrouted" | "coordinator_entrypoint";
/** The complete routing inventory is intentionally explicit and reviewable. */
export declare const COMMAND_ROUTING_INVENTORY: Readonly<{
    browserFree: readonly ["backend.version", "backend.health", "backend.capabilities", "backend.hello", "runner.plan", "createReport", "reports.create", "reports.redact", "reports.summarize", "commands", "describe", "help", "redacted-run-report", "files.preflight", "projects.sources.planAdd", "operations.inspect"];
    /**
     * These commands opt into the operation facade only when an operation
     * identity is present. With no identity they retain their legacy path.
     */
    operationOptIn: readonly ["runner.run", "runner.stream", "responses.create", "ask", "askInThread", "askWithFiles", "askAndDownload", "work.start", "work.steer", "operations.submit", "operations.collect", "operations.control"];
    /**
     * Legacy commands retain their public workflow and now receive a
     * coordinator-backed PageLike/BrowserLike facade. This is a method-level
     * guarantee: it does not turn the whole command or its polling loop into a
     * single actor callback.
     */
    legacyPageFacade: readonly ["runMessages", "openThread", "copyLatest", "readLatest", "downloadLatest", "runPlan", "new-ask-read", "find-open-ask-read", "find-open-copy-latest", "attach-ask-read", "ask-and-download", "two-turn", "doctor-upload", "doctor", "session.bootstrap", "experience.detect", "experience.open", "configuration.inspect", "configuration.apply", "work.status", "work.wait", "work.readLatest", "threads.new", "threads.search", "threads.open", "messages.compose", "messages.submit", "messages.ask", "messages.wait", "messages.readLatest", "messages.status", "messages.stop", "messages.waitAndRead", "artifacts.listLatest", "artifacts.wait", "artifacts.downloadLatest", "files.attach", "files.downloadLatest", "projects.sources.list", "projects.sources.add", "response.copy", "modes.set", "modes.get", "tools.select", "dev.dispatch"];
    /**
     * Browser acquisition seams not covered by the facade remain explicit
     * migration gaps. The current command surface has none; discovery is
     * coordinated in browser/attach.ts.
     */
    legacyBrowserUnrouted: readonly [];
    /**
     * No backend or sequence command currently invokes
     * routeCommandBrowserTransaction. Keep this category explicit so a future
     * migration cannot silently turn a classification into an enforcement
     * claim. A command may enter this list only after its own bounded DOM seam
     * is implemented and tested.
     */
    coordinatorEntrypoint: readonly [];
}>;
type InventoryCommand = typeof COMMAND_ROUTING_INVENTORY.browserFree[number] | typeof COMMAND_ROUTING_INVENTORY.operationOptIn[number] | typeof COMMAND_ROUTING_INVENTORY.legacyPageFacade[number] | typeof COMMAND_ROUTING_INVENTORY.legacyBrowserUnrouted[number] | typeof COMMAND_ROUTING_INVENTORY.coordinatorEntrypoint[number];
type LegacyBrowserCommand = typeof COMMAND_ROUTING_INVENTORY.legacyBrowserUnrouted[number];
/**
 * The operation-aware public dispatch seams currently implemented by the
 * client/backend path. This is separate from the coordinator entrypoint
 * inventory: these commands route into the operation facade, whose adapter
 * owns its own short tab transactions, rather than calling the generic helper
 * below around the whole command.
 */
export declare const OPERATION_AWARE_DISPATCH_COMMANDS: readonly ["runner.run", "runner.stream", "responses.create", "ask", "askInThread", "askWithFiles", "askAndDownload", "work.start", "work.steer", "operations.submit", "operations.collect", "operations.control"];
export type CommandRoutingGap = Readonly<{
    command: LegacyBrowserCommand;
    status: "legacy_browser_unrouted";
    owner: string;
    requiredSeam: "bounded_tab_transaction";
    reason: "legacy_command_dispatch_has_no_operation_aware_tab_seam";
}>;
export declare const COMMAND_ROUTING_GAPS: readonly CommandRoutingGap[];
/** Return undefined for a command that has not been explicitly classified. */
export declare function classifyCommandRouting(command: string): CommandRoutingClass | undefined;
export declare function isBrowserFreeCommand(command: string): boolean;
export declare function isOperationOptInCommand(command: string): boolean;
export declare function isLegacyBrowserUnroutedCommand(command: string): boolean;
export declare function isLegacyPageFacadeCommand(command: string): boolean;
export declare function isCoordinatorEntrypointCommand(command: string): boolean;
/**
 * The public acceptance contract intentionally collapses the implementation
 * classes into the two meaningful routing dispositions.  `operation_opt_in`
 * is coordinator-routed by its operation adapter; the legacy page facade is
 * coordinator-routed by the bounded environment adapter below.  An explicit
 * `legacy_browser_unrouted` entry is a migration gap and therefore has no
 * safe disposition.
 */
export type CommandRoutingDisposition = "browser_free" | "coordinator_routed";
export declare function commandRoutingDisposition(command: string): CommandRoutingDisposition | undefined;
export declare function isCoordinatorRoutedCommand(command: string): boolean;
/** Options for the bounded legacy command adapter. */
export type CommandRoutingAdapterOptions = Readonly<Pick<CoordinatedBrowserOptions, "coordinator" | "owner">>;
/**
 * Prepare the environment for one command invocation.
 *
 * This is deliberately an adapter rather than a whole-command coordinator
 * transaction.  `coordinateRuntimeEnv` returns PageLike/BrowserLike facades
 * whose individual browser calls acquire the process-scoped actor for a
 * bounded operation and release it before the next await.  Consequently a
 * command may wait for generation, poll, write a journal, or invoke caller
 * code without retaining a tab actor.  The coordinated browser/page values
 * are copied back into the supplied invocation environment so legacy command
 * mutations (notably `session.bootstrap`) remain visible to later sequence
 * steps. Calling this on an already-coordinated environment is idempotent
 * through the wrapper caches.
 */
export declare function routeCommandRuntimeEnv(command: string, env: RuntimeEnv, options?: CommandRoutingAdapterOptions): RuntimeEnv;
/**
 * Run one command with the bounded legacy environment adapter.
 *
 * The callback is invoked outside any coordinator callback.  The returned
 * PageLike/BrowserLike values enforce short method-level transactions, so a
 * caller callback or a generation/poll sleep cannot deadlock a nested actor.
 */
export declare function routeCommandExecution<T>(command: string, env: RuntimeEnv, callback: (routedEnv: RuntimeEnv) => T | PromiseLike<T>, options?: CommandRoutingAdapterOptions): Promise<T>;
export type CommandRoutingContext<Page extends object = object> = Readonly<{
    coordinator: ProcessTabCoordinator;
    runtimeContext: OperationRuntimeContext<Page>;
    priority?: CoordinatorPriority;
    signal?: AbortSignal;
    deadlineAt?: number;
    timeoutMs?: number;
    label?: string;
}>;
export type CommandRoutingErrorCode = "unclassified_command" | "coordinator_context_required" | "exact_ownership_unavailable" | "legacy_command_unrouted" | "legacy_page_facade" | "operation_facade_managed" | "operation_routing_unavailable";
/** Stable error for callers that try to route without enough ownership proof. */
export declare class CommandRoutingError extends Error {
    readonly code: CommandRoutingErrorCode;
    constructor(code: CommandRoutingErrorCode);
}
/**
 * Execute one already-bounded browser transaction for an explicit coordinator
 * entrypoint. The callback is intentionally the transaction boundary, not
 * the command or request boundary. Callers must keep generation waits,
 * polling sleeps, file hashing/transfers, journal writes, and report/caller
 * callbacks outside this helper.
 */
export declare function routeCommandBrowserTransaction<T, Page extends object = object>(command: string, context: CommandRoutingContext<Page> | undefined, callback: (acquisition: CoordinatorAcquisitionContext | undefined) => T | PromiseLike<T>): Promise<T>;
/** Return a readonly snapshot useful for diagnostics and inventory tests. */
export declare function commandRoutingInventory(): Readonly<Record<string, CommandRoutingClass>>;
/**
 * Return true when a request carries one of the reserved caller-owned
 * operation identity fields. This is intentionally structural and never
 * reads or serializes prompt/instruction values.
 */
export declare function hasOperationIdentity(value: unknown): boolean;
/**
 * Backend and sequence dispatchers call this before direct command dispatch.
 * Legacy callers without an operation identity remain byte-for-byte on the
 * existing path. An operation-aware request is allowed only for explicitly
 * migrated facade commands (or browser-free diagnostics); all other browser
 * commands fail before their handler can touch the browser.
 */
export declare function assertOperationAwareDispatchAllowed(command: string, payload: unknown): void;
export type ClassifiedCommand = InventoryCommand;
export {};
