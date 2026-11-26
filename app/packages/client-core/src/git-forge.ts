/**
 * What the app shows of git.infrawrench.com: an organisation's namespace
 * there, its repositories and what they use. The forge is its own site; the
 * app links to it and reads these few things from the tables they share
 * (`/api/org/:orgId/git`, the `git` domain of the API contract).
 *
 * The plan limits are here, not in server-core, because Settings > Git and
 * the forge's own refusals word them from the same numbers.
 */
import type { CloudFetch } from "./fetch";

export const GIT_FORGE_VISIBILITIES = ["public", "private"] as const;
export type GitForgeVisibility = (typeof GIT_FORGE_VISIBILITIES)[number];

/**
 * Whose rules apply to a namespace: an organisation on the free plan, one on
 * a paid plan, or a person's own namespace (which has no plan to read).
 */
export type GitForgePlan = "free" | "paid" | "personal";

const GIB = 1024 ** 3;

export interface GitForgeLimits {
  /** How many private repositories the namespace may hold. Null is no limit. */
  privateRepositories: number | null;
  /** Bytes of private repositories at which pushes to them are refused. */
  privateStorageBytes: number;
  /**
   * Bytes of private repositories that cost nothing. Storage between this and
   * `privateStorageBytes` is metered; where the two are equal nothing is.
   */
  includedStorageBytes: number;
}

/**
 * Public repositories are free and count toward none of these. The same
 * numbers are in the docs' plan table (`team-and-billing/billing-and-plans.md`):
 * a change here changes that page.
 */
export const GIT_FORGE_LIMITS: Readonly<Record<GitForgePlan, GitForgeLimits>> = {
  free: { privateRepositories: 3, privateStorageBytes: GIB, includedStorageBytes: GIB },
  paid: {
    privateRepositories: null,
    privateStorageBytes: 100 * GIB,
    includedStorageBytes: 10 * GIB,
  },
  personal: { privateRepositories: 5, privateStorageBytes: GIB, includedStorageBytes: GIB },
};

export interface GitForgeNamespace {
  /** As its owner spelled it. */
  slug: string;
  /** The namespace's page on the forge. */
  url: string;
  /** What a new repository starts as, unless its creator says otherwise. */
  defaultVisibility: GitForgeVisibility;
  createdAt: string;
  renamedAt: string | null;
}

export interface GitForgeUsage {
  repositories: number;
  publicRepositories: number;
  privateRepositories: number;
  /** Bytes of every repository's packs. */
  storageBytes: number;
  /** The part of `storageBytes` that private repositories hold: what the limits count. */
  privateStorageBytes: number;
}

export interface GitForgeOverview {
  /** The forge's origin (`https://git.infrawrench.com`). */
  forgeUrl: string;
  /** Null until someone with `git:admin` claims one. */
  namespace: GitForgeNamespace | null;
  plan: Exclude<GitForgePlan, "personal">;
  limits: GitForgeLimits;
  usage: GitForgeUsage;
}

export interface GitForgeRepositoryCi {
  /** A CI run status (`passed`, `failed`, `running`, ...); a newer server may send one this client does not know. */
  status: string;
  runId: string;
  sha: string;
}

export interface GitForgeRepository {
  id: string;
  name: string;
  /** `namespace/name`. */
  fullName: string;
  /** The repository's page on the forge. */
  url: string;
  description: string | null;
  visibility: GitForgeVisibility;
  archived: boolean;
  isFork: boolean;
  defaultBranch: string;
  /** Null until something is pushed. */
  pushedAt: string | null;
  openPullRequests: number;
  openIssues: number;
  sizeBytes: number;
  /** The latest CI run of the default branch, or null when CI has not run there. */
  ci: GitForgeRepositoryCi | null;
}

export interface GitForgeRepositoryList {
  repositories: GitForgeRepository[];
}

/** `GET /git`: the namespace (or null), the plan's limits and the usage. */
export async function fetchGitForgeOverview(
  api: CloudFetch,
  orgId: string,
): Promise<GitForgeOverview> {
  const res = await api.org<GitForgeOverview>(orgId, "/git");
  if (!res) throw new Error("The server sent no Git overview");
  return res;
}

/** `GET /git/repositories`: most recently pushed first. */
export async function fetchGitForgeRepositories(
  api: CloudFetch,
  orgId: string,
): Promise<GitForgeRepository[]> {
  const res = await api.org<GitForgeRepositoryList>(orgId, "/git/repositories");
  return res?.repositories ?? [];
}

/** The forge page of a namespace, or of one of its repositories. */
export function gitForgeUrl(forgeUrl: string, namespace: string, repository?: string): string {
  const base = `${forgeUrl.replace(/\/+$/, "")}/${encodeURIComponent(namespace)}`;
  return repository === undefined ? base : `${base}/${encodeURIComponent(repository)}`;
}

/** `1.5 GiB`, `320 MiB`: binary units, since the limits are stated in GiB. */
export function formatGitForgeBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = unit === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${Number(value.toFixed(digits))} ${units[unit]}`;
}
