// The wire types come from `@infrawrench/client-core`; this module only adds
// the client seam a host must provide.
import type {
  CiAccessOverview,
  CiConnectionAccess,
  CiConnectionAccessSettings,
  CiExecutorKindId,
  CiResourceGrant,
  CiResourceOutputs,
  SearchResult,
  CiAccount,
  CiCacheCleared,
  CiCaches,
  CiDownloadLink,
  CiLogEvent,
  CiRun,
  CiRunDetail,
  CiRunStatus,
  CiStatus,
  CiUsage,
  CiValues,
} from "@infrawrench/client-core";

/** What a host (web, desktop) provides for the CI panel. */
export interface CiClient {
  status(): Promise<CiStatus>;
  setAccount(installationId: number, enabled: boolean): Promise<CiAccount>;
  /** Where to install the GitHub App, or `null` when this server has none. */
  installUrl(): Promise<string | null>;
  listRuns(status?: CiRunStatus): Promise<CiRun[]>;
  getRun(id: string): Promise<CiRunDetail>;
  /**
   * A running run's live log: the runner's events as they happen, from the
   * first (each pipeline's job graph). Ends with the run; throws when the
   * log cannot be followed (the run is not running, the network).
   */
  streamRunLogs(id: string, signal: AbortSignal): AsyncIterable<CiLogEvent>;
  /** A short-lived link to a file a job of a finished run kept with `downloads:`. */
  downloadLink(runId: string, jobId: string, path: string): Promise<CiDownloadLink>;
  approveRun(id: string): Promise<void>;
  rejectRun(id: string): Promise<void>;
  /**
   * Queues a finished run again (same commit, branch and event) and answers
   * the new run. With `noTaskCache` every `task-cache:` job runs.
   */
  retryRun(id: string, opts: { noTaskCache: boolean }): Promise<CiRun>;
  /**
   * Cancels a queued, waiting or running run and answers it: cancelled, or
   * still running with `cancelRequested` while its runner stops it.
   */
  cancelRun(id: string): Promise<CiRun>;
  /** The caches CI keeps, per connected account and repository. */
  listCaches(): Promise<CiCaches>;
  /** Deletes one repository's caches and answers what went. */
  clearCache(installationId: number, repo: string): Promise<CiCacheCleared>;
  usage(): Promise<CiUsage>;
  /** The repository names an installation can see, for the scope picker. */
  listRepos(installationId: number): Promise<string[]>;
  listValues(installationId: number, repo: string | null): Promise<CiValues>;
  setValue(
    installationId: number,
    repo: string | null,
    kind: "secrets" | "variables",
    name: string,
    value: string,
  ): Promise<void>;
  deleteValue(
    installationId: number,
    repo: string | null,
    kind: "secrets" | "variables",
    name: string,
  ): Promise<void>;
  /** What CI jobs may use: connections, resource grants, lent SSH keys. */
  access(): Promise<CiAccessOverview>;
  setConnectionAccess(
    accountId: string,
    settings: CiConnectionAccessSettings,
  ): Promise<CiConnectionAccess>;
  /** Checks, through the provider, whether the connection can run jobs of a kind. */
  preflightConnection(accountId: string, kind: CiExecutorKindId): Promise<CiConnectionAccess>;
  /** Resources by name, for the grant picker (never a typed id). */
  searchResources(query: string): Promise<SearchResult[]>;
  resourceOutputs(resourceId: string): Promise<CiResourceOutputs>;
  createGrant(input: CiGrantInput): Promise<CiResourceGrant>;
  updateGrant(id: string, input: CiGrantInput): Promise<CiResourceGrant>;
  deleteGrant(id: string): Promise<void>;
  /** Stops CI jobs using someone's SSH key (admins). */
  revokeSshKeyLending(sshKeyId: string): Promise<void>;
  /** Every repository (`owner/name`) of the accounts that run CI, for the repository pickers. */
  listAllRepos(): Promise<string[]>;
}

/** A resource grant as the form sends it. */
export interface CiGrantInput {
  resourceId: string;
  ciName: string;
  outputs: string[];
  secretVersion: string | null;
  repos: string[] | null;
  branchPattern: string | null;
}
