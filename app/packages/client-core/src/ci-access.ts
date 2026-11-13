/**
 * CI access: what an organization lets its CI jobs use. Connections can run
 * jobs (cloud jobs, `cloud:` in a pipeline) and lend their credentials
 * (`connections:`), SSH keys can be lent by their owners (`ssh-keys:`), and
 * resources are granted one by one (`${{ resources.<name>.<output> }}`,
 * `env-from:`). The wire types, and the rules both the server and the forms
 * apply to names, repositories and branches.
 */

export const CI_EXECUTOR_KIND_IDS = ["vm", "container", "build", "host", "cluster"] as const;
export type CiExecutorKindId = (typeof CI_EXECUTOR_KIND_IDS)[number];

/** The output a grant reads a secret-manager resource's value as (`resources.<name>.value`). */
export const CI_SECRET_VALUE_OUTPUT = "value";

/** A grant's or SSH key's name in a pipeline, as the runner accepts it. */
export const CI_GRANT_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** A connection or SSH key name as a pipeline may write it: 1-128 characters, no control characters, no padding. */
export function isCiConnectionName(name: string): boolean {
  return (
    name.length >= 1 &&
    name.length <= 128 &&
    name === name.trim() &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f]/.test(name)
  );
}

/** A resource's name as a grant's default CI name. */
export function ciGrantNameFor(resourceName: string): string {
  const slug = resourceName
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^[-_]+|-+$/g, "")
    .slice(0, 64);
  return CI_GRANT_NAME.test(slug) ? slug : "resource";
}

function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i++;
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}

/** The globs of a branch pattern, without the empty ones a stray comma leaves. */
export function ciBranchGlobs(pattern: string): string[] {
  return pattern
    .split(",")
    .map((g) => g.trim())
    .filter((g) => g.length > 0);
}

/**
 * Whether `branch` matches a branch pattern: one or more globs separated by
 * commas, where `*` stops at `/` and `**` does not (`main`, `release/*`).
 * Only a pattern that is not set (null) means every branch; a pattern with
 * no globs in it (`,`, `" , "`) matches none, never all.
 */
export function ciBranchMatches(pattern: string | null | undefined, branch: string): boolean {
  if (pattern === null || pattern === undefined) return true;
  return ciBranchGlobs(pattern).some((g) => globToRegExp(g).test(branch));
}

/**
 * Whether a repository (`owner/name`) is on a list; null means every
 * repository the organization runs CI for. Compared without case, as GitHub does.
 */
export function ciRepoAllowed(repos: readonly string[] | null | undefined, repo: string): boolean {
  if (repos === null || repos === undefined) return true;
  const want = repo.toLowerCase();
  return repos.some((r) => r.toLowerCase() === want);
}

/** One kind of compute a connection's provider can run CI jobs on. */
export interface CiExecutorKindInfo {
  kind: CiExecutorKindId;
  label: string;
  defaults: { machine?: string; image?: string; region?: string };
  typicalStartSeconds?: number;
  minimumBillingSeconds?: number;
  gpus?: boolean;
  machineSuggestions?: string[];
  /** What `cloud.region` means for this kind when it is not a region (a namespace). */
  regionLabel?: string;
}

/** The last permission check for a kind. */
export interface CiPreflightRecord {
  ok: boolean;
  missing: Array<{ permission: string; label: string }>;
  problems: string[];
  region?: string;
  checkedAt: string;
}

/** What CI may do with one connection. */
export interface CiConnectionAccessSettings {
  jobsEnabled: boolean;
  jobKinds: CiExecutorKindId[];
  maxConcurrentJobs: number;
  maxJobMinutes: number;
  /** Null: every repository the organization runs CI for. */
  jobRepos: string[] | null;
  jobBranchPattern: string | null;
  lendEnabled: boolean;
  lendRepos: string[] | null;
  lendBranchPattern: string | null;
}

export const CI_DEFAULT_CONNECTION_ACCESS: CiConnectionAccessSettings = {
  jobsEnabled: false,
  jobKinds: [],
  maxConcurrentJobs: 2,
  maxJobMinutes: 60,
  jobRepos: null,
  jobBranchPattern: null,
  lendEnabled: false,
  lendRepos: null,
  lendBranchPattern: null,
};

/** A connection whose provider can do something for CI, with what it is allowed. */
export interface CiConnectionAccess {
  accountId: string;
  /** The connection's name: what a pipeline writes in `connections:` or `cloud.connection`. */
  accountName: string;
  pluginId: string;
  pluginName: string;
  /** Null when the provider cannot run CI jobs. */
  executor: {
    kinds: CiExecutorKindInfo[];
    helpLink: { label: string; url: string } | null;
  } | null;
  /** Null when the provider cannot lend a connection. */
  credential: { description: string; shortLived: boolean; namespaces: boolean } | null;
  settings: CiConnectionAccessSettings;
  /** By kind. */
  preflight: Record<string, CiPreflightRecord>;
  updatedAt: string | null;
}

/** One resource granted to CI. */
export interface CiResourceGrant {
  id: string;
  accountId: string;
  accountName: string;
  pluginId: string;
  resourceId: string;
  resourceTypeId: string;
  resourceName: string;
  ciName: string;
  outputs: string[];
  /** `latest` or a version id when the grant includes a secret's value (`value`). */
  secretVersion: string | null;
  repos: string[] | null;
  branchPattern: string | null;
  createdAt: string;
}

/** What a resource can be granted: its outputs and, for a secret, its versions. */
export interface CiResourceOutputs {
  outputs: Array<{ key: string; label: string; sensitive: boolean }>;
  /** Null when the resource is not a secret with versions. */
  secretVersions: Array<{ id: string; state: string; createdAt: string | null }> | null;
}

/** An SSH key lent to CI by its owner. */
export interface CiSshKeyLending {
  sshKeyId: string;
  keyName: string;
  ownerUserId: string;
  ownerName: string | null;
  ciName: string;
  repos: string[] | null;
  branchPattern: string | null;
  /** The caller owns the key, so may change it (admins may only revoke). */
  mine: boolean;
  createdAt: string;
}

export interface CiAccessOverview {
  /** The caller, so the SSH keys page knows which keys they may lend. */
  viewerUserId: string | null;
  connections: CiConnectionAccess[];
  grants: CiResourceGrant[];
  sshKeys: CiSshKeyLending[];
}

/** A job's cloud compute, as the run page shows it. */
export interface CiCloudJob {
  jobId: string;
  jobName: string;
  pipeline: string;
  accountId: string | null;
  accountName: string | null;
  pluginId: string;
  kind: string;
  machine: string | null;
  region: string | null;
  /** `starting` (the machine is coming up), `running`, `tearing_down`, `done`. */
  state: "claiming" | "starting" | "running" | "tearing_down" | "done";
  outcome: string | null;
  reason: string | null;
  /** The provider's name for what runs it, e.g. `aws ec2 i-0abc (eu-west-1)`. */
  label: string | null;
  claimedAt: string;
  finishedAt: string | null;
}

/** What a job was lent, by name only. */
export interface CiJobAccessNames {
  connections?: string[];
  sshKeys?: string[];
  resources?: string[];
  envFrom?: string[];
}
