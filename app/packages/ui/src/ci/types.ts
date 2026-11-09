// The wire types come from `@infrawrench/client-core`; this module only adds
// the client seam a host must provide.
import type {
  CiAccount,
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
  approveRun(id: string): Promise<void>;
  rejectRun(id: string): Promise<void>;
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
}
