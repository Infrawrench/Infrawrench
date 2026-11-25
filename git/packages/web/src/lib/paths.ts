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
  /** `/compare/base...head`; without refs, the page that picks them. */
  compare: (repo: RepoRef, base?: string, head?: string) =>
    base === undefined || head === undefined
      ? `${repositoryPath(repo)}/compare`
      : `${repositoryPath(repo)}/compare/${encodePathSegments(base)}...${encodePathSegments(head)}`,

  issues: (repo: RepoRef) => `${repositoryPath(repo)}/issues`,
  issue: (repo: RepoRef, number: number) => `${repositoryPath(repo)}/issues/${number}`,
  newIssue: (repo: RepoRef) => `${repositoryPath(repo)}/issues/new`,
  pulls: (repo: RepoRef) => `${repositoryPath(repo)}/pulls`,
  pull: (repo: RepoRef, number: number) => `${repositoryPath(repo)}/pulls/${number}`,
  newPull: (repo: RepoRef, query: { base?: string; head?: string } = {}) =>
    `${repositoryPath(repo)}/pulls/new${search(query)}`,
  ci: (repo: RepoRef) => `${repositoryPath(repo)}/ci`,
  /**
   * The Infrastructure tab. Not `/terraform`: that prefix is the state
   * backend's (`terraformStatePath` in the contract).
   */
  infrastructure: (repo: RepoRef) => `${repositoryPath(repo)}/infrastructure`,
  repoSettings: (repo: RepoRef, section?: string) =>
    `${repositoryPath(repo)}/settings${section === undefined ? "" : `/${seg(section)}`}`,
};

export type { RepoRef };
