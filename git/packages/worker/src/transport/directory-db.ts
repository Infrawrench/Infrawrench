/**
 * `GitDirectory` over Postgres: `src/auth` for credentials and access,
 * `src/db` for repositories and protected branches.
 *
 * Each call opens its own database client (`withDb`) and closes it when it
 * returns. An SSH connection lives for minutes and asks a handful of
 * questions; holding a connection open for all of it would spend one of
 * Hyperdrive's for nothing.
 */
import { hasAccess } from "../auth/access";
import { authenticateRequest, authenticateSshKey } from "../auth/authenticate";
import { verifyJobToken } from "../auth/job-token";
import type { Principal } from "../auth/principal";
import { repoAccess } from "../auth/repo-access";
import { type WaitUntil, withDb } from "../db/client";
import { listProtectedBranches } from "../db/policy";
import { getRepository, getRepositoryById, toRepoForAccess } from "../db/repositories";
import { userRefs } from "../db/users";
import type { Env } from "../env";
import type { PushPolicy } from "../repo/do/policy";
import type { GitDirectory } from "./directory";

export function databaseDirectory(env: Env, ctx: WaitUntil): GitDirectory {
  const run = <T>(fn: () => Promise<T>): Promise<T> => withDb(env, ctx, fn);
  return {
    authenticate: (request) =>
      run(async () => {
        const { principal, refused } = await authenticateRequest(request, env);
        return { principal, refused };
      }),

    authenticateArchiveToken: async (token, commit) => {
      const claims = await verifyJobToken(env.GIT_JOB_TOKEN_KEY, token, undefined, commit);
      if (!claims) return null;
      return {
        kind: "job",
        repositoryId: claims.repositoryId,
        write: claims.write,
        runId: claims.runId,
      };
    },

    authenticateKey: (key, verified) => run(() => authenticateSshKey(key, { markUsed: verified })),

    describe: (principal) =>
      run(async () => {
        if (principal.kind === "user") {
          const user = (await userRefs([principal.userId])).get(principal.userId);
          return user?.username ?? "there";
        }
        if (principal.kind === "deploy-key") {
          const found = await getRepositoryById(principal.repositoryId);
          return found ? `${found.owner.slug}/${found.repository.name}` : "there";
        }
        return "there";
      }),

    resolveRepository: (owner, name, principal) =>
      run(async () => {
        const found = await getRepository(owner, name);
        if (!found) return null;
        const access = await repoAccess(principal, toRepoForAccess(found));
        const id = found.repository.id;
        return {
          id,
          owner: found.owner.slug,
          name: found.repository.name,
          archived: found.repository.archived,
          access,
          pushPolicy: () =>
            run(async (): Promise<PushPolicy> => ({
              rules: await listProtectedBranches(id),
              userId: userIdOf(principal),
              admin: hasAccess(access, "admin"),
            })),
        };
      }),
  };
}

/** The person a protected branch's pusher list is checked against. Only a person acting as themselves. */
const userIdOf = (principal: Principal): string | null =>
  principal.kind === "user" ? principal.userId : null;
