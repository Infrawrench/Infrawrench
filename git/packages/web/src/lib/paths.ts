/**
 * Every page's URL, in one place. Pages link with these (through `AppLink`),
 * never with a hand-built string, so a URL scheme changes here only.
 *
 * Refs and tree paths keep their slashes in the URL (`/tree/feature/x/src`),
 * the way every forge writes them; `lib/refs.ts` splits them back apart
 * against the repository's ref names.
 */
import { encodePathSegments, repositoryPath, type RepoRef } from "@infrawrench/git-contract";

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

export const paths = {
  home: () => "/",
  explore: (query: { q?: string; language?: string } = {}) => `/explore${search(query)}`,
  newRepository: (owner?: string) => `/new${search({ owner })}`,
  onboardingUsername: (returnTo?: string) => `/onboarding/username${search({ returnTo })}`,
  /** Personal settings: profile, SSH keys, tokens. */
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
  branches: (repo: RepoRef) => `${repositoryPath(repo)}/branches`,
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
  pulls: (repo: RepoRef) => `${repositoryPath(repo)}/pulls`,
  pull: (repo: RepoRef, number: number) => `${repositoryPath(repo)}/pulls/${number}`,
  newPull: (repo: RepoRef, query: { base?: string; head?: string } = {}) =>
    `${repositoryPath(repo)}/pulls/new${search(query)}`,
  /**
   * A pull request's page with a version and a diff picked: what the branch
   * page (the pull request, for someone in agent mode) keeps in its address.
   */
  branchPage: (
    repo: RepoRef,
    number: number,
    query: { v?: number; diff?: "whole" | "step" | "since" } = {},
  ) => `${repositoryPath(repo)}/pulls/${number}${search(query)}`,
  /** Under `/pulls` so the Pull requests tab stays the active one. */
  startWork: (repo: RepoRef) => `${repositoryPath(repo)}/pulls/start`,
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
  pullSearch: (repo: RepoRef, q?: string) => `${repositoryPath(repo)}/pulls${search({ q })}`,
  /** A pull request's other tabs; the conversation is `paths.pull`. */
  pullTab: (repo: RepoRef, number: number, tab: "commits" | "checks" | "files") =>
    `${repositoryPath(repo)}/pulls/${number}/${tab}`,
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
