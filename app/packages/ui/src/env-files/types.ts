// The wire types come from `@infrawrench/client-core` (the shared pure half);
// this module only adds the client seam a host must provide.
import type {
  InfraenvCommitMode,
  InfraenvCommitResult,
  InfraenvDescribeResponse,
  InfraenvRepo,
  InfraenvRepoFile,
  InfraenvResolveResponse,
  InfraenvSource,
} from "@infrawrench/client-core";

/** An organization secret as the picker lists it: never its value. */
export interface EnvFilesSecret {
  id: string;
  name: string;
  hasValue: boolean;
}

export interface EnvFilesRepoList {
  /** False when the server has no GitHub App configured at all. */
  appConfigured: boolean;
  repos: readonly InfraenvRepo[];
}

export interface EnvFilesRepoFileQuery {
  installationId: number;
  repo: string;
  path: string;
  /** Omitted for the repository's default branch. */
  branch?: string | undefined;
}

export interface EnvFilesCommitInput {
  installationId: number;
  repo: string;
  path: string;
  branch?: string | null | undefined;
  content: string;
  /** The blob sha the file had when it was read; null for a new file. */
  sha: string | null;
  mode: InfraenvCommitMode;
  message?: string | undefined;
}

/**
 * What a host must provide for the environment files panel: the
 * `/api/org/:orgId/env-files` routes plus the organization secrets the
 * `secret()` picker lists. Errors are thrown as the host's transport throws
 * them, with the structured GitHub 409 as `GithubPermissionRequiredClientError`
 * (client-core) so the panel can show the grant prompt.
 */
export interface EnvFilesClient {
  describe(source: string): Promise<InfraenvDescribeResponse>;
  resolve(input: {
    source: string;
    environment: string | null;
    sourceName?: string | undefined;
  }): Promise<InfraenvResolveResponse>;
  /** Resources with outputs, matching `query` (name, id, type or account). */
  listSources(query: string): Promise<readonly InfraenvSource[]>;
  listRepos(): Promise<EnvFilesRepoList>;
  /** A repository's branch names. Optional: without it the branch is typed. */
  listBranches?(installationId: number, repo: string): Promise<readonly string[]>;
  readFile(query: EnvFilesRepoFileQuery): Promise<InfraenvRepoFile>;
  commit(input: EnvFilesCommitInput): Promise<InfraenvCommitResult>;
  listSecrets(): Promise<readonly EnvFilesSecret[]>;
  /** Create an organization secret and write its value. Absent: no "New secret". */
  createSecret?(name: string, value: string): Promise<EnvFilesSecret>;
}
