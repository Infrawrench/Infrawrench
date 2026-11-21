/**
 * Environment files: cloud-mode only (references resolve against the org's
 * synced resources and secrets, and the file lives in a repository reached
 * through the org's GitHub App). Typed calls to the contract's `env-files`
 * domain, plus the organization secrets the `secret()` picker lists, over the
 * cloud transport (`./cloud-client.ts`).
 *
 * A failed call surfaces the server's own sentence, and the structured GitHub
 * 409 becomes `GithubPermissionRequiredClientError`, the error the web's
 * `apiFetch` throws for it, so the shared panel shows the grant prompt on both.
 */
import {
  GithubPermissionRequiredClientError,
  isGithubPermissionRequiredResponse,
  type InfraenvCommitResult,
  type InfraenvDescribeResponse,
  type InfraenvRepoFile,
  type InfraenvResolveResponse,
  type InfraenvSource,
} from "@infrawrench/client-core";
import type {
  EnvFilesCommitInput,
  EnvFilesRepoFileQuery,
  EnvFilesRepoList,
  EnvFilesSecret,
} from "@infrawrench/ui/env-files/types";
import { Effect, Option, Schema } from "effect";
import { cloudClient, CloudResponseError, withServerSentence } from "./cloud-client";
import type { DesktopRpcClient } from "./rpc/client";
import { runRpc } from "./rpc/client";

const envFiles = () => cloudClient("envFiles").envFiles;
const workflowSecrets = () => cloudClient("workflowSecrets").workflowSecrets;

const decodeJsonBody = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

/** The error a panel shows for a failed call. */
function panelError<E>(error: E): E | CloudResponseError | GithubPermissionRequiredClientError {
  if (error instanceof CloudResponseError && error.status === 409) {
    const parsed = Option.getOrUndefined(decodeJsonBody(error.body));
    if (isGithubPermissionRequiredResponse(parsed)) {
      return new GithubPermissionRequiredClientError(parsed);
    }
  }
  return withServerSentence(error);
}

function run<A, E>(call: Effect.Effect<A, E, DesktopRpcClient>): Promise<A> {
  return runRpc(call.pipe(Effect.mapError(panelError)));
}

export function describeCloudEnvFile(
  orgId: string,
  source: string,
): Promise<InfraenvDescribeResponse> {
  return run(envFiles().describe({ params: { orgId }, payload: { source } }));
}

export function resolveCloudEnvFile(
  orgId: string,
  input: { source: string; environment: string | null; sourceName?: string | undefined },
): Promise<InfraenvResolveResponse> {
  return run(
    envFiles().resolve({
      params: { orgId },
      payload: {
        source: input.source,
        environment: input.environment,
        ...(input.sourceName ? { sourceName: input.sourceName } : {}),
      },
    }),
  );
}

export async function listCloudEnvFileSources(
  orgId: string,
  query: string,
): Promise<InfraenvSource[]> {
  const { sources } = await run(
    envFiles().sources({ params: { orgId }, query: { ...(query ? { q: query } : {}), limit: 50 } }),
  );
  return sources;
}

export function listCloudEnvFileRepos(orgId: string): Promise<EnvFilesRepoList> {
  return run(envFiles().repos({ params: { orgId } }));
}

export function readCloudEnvFile(
  orgId: string,
  query: EnvFilesRepoFileQuery,
): Promise<InfraenvRepoFile> {
  return run(
    envFiles().readFile({
      params: { orgId },
      query: {
        installationId: query.installationId,
        repo: query.repo,
        path: query.path,
        ...(query.branch ? { branch: query.branch } : {}),
      },
    }),
  );
}

export function commitCloudEnvFile(
  orgId: string,
  input: EnvFilesCommitInput,
): Promise<InfraenvCommitResult> {
  return run(
    envFiles().commit({
      params: { orgId },
      payload: {
        installationId: input.installationId,
        repo: input.repo,
        path: input.path,
        content: input.content,
        sha: input.sha,
        mode: input.mode,
        ...(input.branch !== undefined ? { branch: input.branch } : {}),
        ...(input.message ? { message: input.message } : {}),
      },
    }),
  );
}

export async function listCloudEnvFileSecrets(orgId: string): Promise<EnvFilesSecret[]> {
  const rows = await run(workflowSecrets().list({ params: { orgId } }));
  return rows.map(({ id, name, hasValue }) => ({ id, name, hasValue }));
}

/** Create the secret, then write its value: the value has its own write-only endpoint. */
export function createCloudEnvFileSecret(
  orgId: string,
  name: string,
  value: string,
): Promise<EnvFilesSecret> {
  return run(
    Effect.gen(function* () {
      const created = yield* workflowSecrets().create({ params: { orgId }, payload: { name } });
      const written = yield* workflowSecrets().writeValue({
        params: { orgId, id: created.id },
        payload: { value },
      });
      return { id: written.id, name: written.name, hasValue: written.hasValue };
    }),
  );
}
