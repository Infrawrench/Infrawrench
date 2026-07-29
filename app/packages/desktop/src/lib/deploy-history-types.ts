/**
 * The shape of a local deploy record, shared by the two halves of the app: the
 * CLI/main process writes it (`electron/deploy-history.ts`) and the renderer's
 * Deploy tab reads it back over IPC.
 *
 * Types only, no imports — it is compiled by both the node and the web
 * tsconfig, the same arrangement `src/db/schema.ts` has.
 */

/**
 * One run of `infrawrench deploy` on this machine.
 *
 * A superset of the cloud's `DeploymentRunRow`: the extra fields are the ones
 * only a local run has (which directory it built, whether the tree was dirty)
 * or that the org stores separately (notes, error).
 */
export interface LocalDeployRun {
  id: string;
  /** ISO 8601, UTC. */
  startedAt: string;
  env: string;
  repo: string | null;
  branch: string | null;
  gitSha: string | null;
  /** The working tree had uncommitted changes when it was built. */
  dirty: boolean;
  image: string | null;
  status: "success" | "failure" | "canceled" | "running" | "pending";
  /** How far it got — "plan" | "dockerfile" | "build" | "deploy". */
  stage: string | null;
  durationMs: number | null;
  /** Directory holding the Infrafile, i.e. the Docker build context. */
  dir: string;
  notes: string[];
  /**
   * Resources the run provisioned through `infra.accounts.*.create(...)`.
   * Same shape the org's record stores (`InfrafileCreatedResource`), kept as a
   * structural copy because this file deliberately imports nothing.
   */
  createdResources: {
    pluginId: string;
    accountId: string;
    resourceTypeId: string;
    resourceId: string;
    externalId?: string;
    displayName: string;
    sidecar?: { pluginId: string; parentResourceId: string };
  }[];
  error: string | null;
  /** The org it was also reported to, when it was not a `--local` run. */
  orgId: string | null;
  /** Whatever the run's `plan()` returned — what `deploy --plan` diffs against. */
  plan?: unknown;
  /** The value `infra.output(...)` declared, read back by `deploy outputs`. */
  output?: unknown;
}
