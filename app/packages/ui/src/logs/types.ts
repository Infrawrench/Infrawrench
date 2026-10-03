import type { LogsFetchParams, LogsFetchResult } from "@infrawrench/plugin-base";
import type {
  LogResourceOption as WireLogResourceOption,
  LogStreamSelector,
  LogWorkspaceQuery,
  LogWorkspaceQueryCreate,
  LogWorkspaceQueryPatch,
} from "@infrawrench/client-core";

/**
 * One pickable log stream source, as the discovery endpoint returns it. The
 * wire type lives in client-core; aliased (not re-exported) so the dts bundler
 * cannot drop it from this package's barrel.
 */
export type LogResourceOption = WireLogResourceOption;

/**
 * Saved-query storage. Cloud-only: hosts without it (desktop local mode)
 * leave the field undefined and the panel hides the saved-query bar.
 */
export interface LogWorkspaceSavedQueriesClient {
  list(): Promise<LogWorkspaceQuery[]>;
  create(input: LogWorkspaceQueryCreate): Promise<LogWorkspaceQuery>;
  update(queryId: string, patch: LogWorkspaceQueryPatch): Promise<LogWorkspaceQuery>;
  remove(queryId: string): Promise<void>;
}

/** Everything the log workspace panel needs from its host. */
export interface LogWorkspaceClient {
  /** Org/local resources whose rendered detail declares the logs capability. */
  listLogResources(): Promise<LogResourceOption[]>;
  /** Fetch a tail chunk for one stream: the per-resource logs machinery. */
  fetchLogs(selector: LogStreamSelector, params: LogsFetchParams): Promise<LogsFetchResult>;
  /** Undefined when the host has no server-side saved-query storage. */
  savedQueries?: LogWorkspaceSavedQueriesClient | undefined;
}
