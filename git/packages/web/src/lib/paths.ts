/**
 * Every page's URL, in one place. Pages link with these (through `AppLink`),
 * never with a hand-built string, so a URL scheme changes here only.
 *
 * Refs and tree paths keep their slashes in the URL (`/tree/feature/x/src`),
 * the way every forge writes them; `lib/refs.ts` splits them back apart
 * against the repository's ref names. A branch page's key does the same
 * (`/branches/feature/x`), written by the contract's `branchPagePath`.
 */
import {
  branchPagePath,
  encodePathSegments,
  repositoryPath,
  type RepoRef,
} from "@infrawrench/git-contract";

const seg = encodeURIComponent;

const withRef = (base: string, ref: string, path?: string): string =>
  `${base}/${encodePathSegments(ref)}${
    path === undefined || path === "" ? "" : `/${encodePathSegments(path)}`
  }`;

const search = (values: Record<string, string | number | undefined>): string => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  const text = params.toString();
  return text === "" ? "" : `?${text}`;
};

/** A branch page's tabs besides its review, kept in `?tab=`: a splat route has no room for a suffix. */
export type BranchPageTab = "commits" | "checks";

export const paths = {
  home: () => "/",
  /** Branches across the reader's repositories, and the two lists beside it. */
  changes: (query: { state?: "merged" | "all"; author?: "mine" | "team" } = {}) =>
    `/changes${search(query)}`,
  reviews: () => "/reviews",
  mentions: () => "/mentions",
  explore: (query: { q?: string; language?: string } = {}) => `/explore${search(query)}`,
  newRepository: (owner?: string) => `/new${search({ owner })}`,
  onboardingUsername: (returnTo?: string) => `/onboarding/username${search({ returnTo })}`,
  /** Personal settings: profile, organisations, SSH keys, tokens. */
  settings: (section?: string) =>
    section === undefined ? "/settings" : `/settings/${seg(section)}`,

  namespace: (owner: string, query: { tab?: string } = {}) => `/${seg(owner)}${search(query)}`,

  repo: (repo: RepoRef) => repositoryPath(repo),
  tree: (repo: RepoRef, ref: string, path = "") =>
    withRef(`${repositoryPath(repo)}/tree`, ref, path),
  blob: (repo: RepoRef, ref: string, path: string, lines?: string) =>
    `${withRef(`${repositoryPath(repo)}/blob`, ref, path)}${lines === undefined ? "" : `#${lines}`}`,
  blame: (repo: RepoRef, ref: string, path: string) =>
    withRef(`${repositoryPath(repo)}/blame`, ref, path),
  commits: (repo: RepoRef, ref?: string, path?: string) =>
    ref === undefined
      ? `${repositoryPath(repo)}/commits`
      : withRef(`${repositoryPath(repo)}/commits`, ref, path),
  commit: (repo: RepoRef, sha: string) => `${repositoryPath(repo)}/commit/${seg(sha)}`,
  /**
   * The Branches tab: the branch pages, searched with `?q=` the way the issue
   * list is; `view: "all"` is every Git branch, to create and delete them.
   */
  branches: (repo: RepoRef, query: { q?: string | undefined; view?: "all" | undefined } = {}) =>
    `${repositoryPath(repo)}/branches${search(query)}`,
  /**
   * A branch's page, named by its key (`feature/a`, `bob/infra:feature/a`,
   * `feature/a~2`) with the key's slashes as the path's own. The version and
   * the diff picked, and the Commits and Checks tabs, are in the query.
   */
  branchPage: (
    repo: RepoRef,
    key: string,
    query: { v?: number; diff?: "whole" | "step" | "since"; tab?: BranchPageTab } = {},
  ) => `${branchPagePath(repo.owner, repo.repo, key)}${search(query)}`,
  /** An agent starts a branch from an ask. */
  startWork: (repo: RepoRef) => `${repositoryPath(repo)}/start`,
  tags: (repo: RepoRef) => `${repositoryPath(repo)}/tags`,
  /**
   * `/compare/base...head`; without refs, the page that picks them. A head in
   * a fork is `owner/name:ref` (`lib/refs.ts` `formatHead`).
   */
  compare: (repo: RepoRef, base?: string, head?: string) =>
    base === undefined || head === undefined
      ? `${repositoryPath(repo)}/compare`
      : `${repositoryPath(repo)}/compare/${encodePathSegments(base)}...${encodePathSegments(head)}`,
  /** `/compare/head`: against the repository's default branch, whatever it is called. */
  compareHead: (repo: RepoRef, head: string) =>
    `${repositoryPath(repo)}/compare/${encodePathSegments(head)}`,

  issues: (repo: RepoRef) => `${repositoryPath(repo)}/issues`,
  issue: (repo: RepoRef, number: number) => `${repositoryPath(repo)}/issues/${number}`,
  newIssue: (repo: RepoRef) => `${repositoryPath(repo)}/issues/new`,
  ci: (repo: RepoRef) => `${repositoryPath(repo)}/ci`,
  /**
   * The Infrastructure tab. Not `/terraform`: that prefix is the state
   * backend's (`terraformStatePath` in the contract).
   */
  infrastructure: (repo: RepoRef) => `${repositoryPath(repo)}/infrastructure`,
  repoSettings: (repo: RepoRef, section?: string) =>
    `${repositoryPath(repo)}/settings${section === undefined ? "" : `/${seg(section)}`}`,

  /** The issue list with its search box filled (`is:open label:bug`). */
  issueSearch: (repo: RepoRef, q?: string) => `${repositoryPath(repo)}/issues${search({ q })}`,
  /** Under `/issues` so the Issues tab stays the active one. */
  labels: (repo: RepoRef) => `${repositoryPath(repo)}/issues/labels`,
  milestones: (repo: RepoRef) => `${repositoryPath(repo)}/issues/milestones`,
  milestone: (repo: RepoRef, number: number) =>
    `${repositoryPath(repo)}/issues/milestones/${number}`,
  ciRuns: (repo: RepoRef, query: { branch?: string; status?: string } = {}) =>
    `${repositoryPath(repo)}/ci${search(query)}`,
  ciRun: (repo: RepoRef, runId: string, job?: string) =>
    `${repositoryPath(repo)}/ci/runs/${seg(runId)}${search({ job })}`,
  workspace: (repo: RepoRef, workspace: string, tab?: "state" | "resources" | "settings") =>
    `${repositoryPath(repo)}/infrastructure/${seg(workspace)}${tab === undefined ? "" : `/${tab}`}`,
  terraformRun: (repo: RepoRef, workspace: string, runId: string) =>
    `${repositoryPath(repo)}/infrastructure/${seg(workspace)}/runs/${seg(runId)}`,
};

export type { RepoRef };
