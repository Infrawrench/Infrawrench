/**
 * The worker as the end-to-end tests run it in workerd: the real `RepoDO`,
 * the real smart HTTP routes and the real SSH host, with people and
 * repositories read from a fixture (`FIXTURE`, JSON) instead of Postgres.
 * Access is still decided by the worker's own rules (`decideRepoAccess`).
 *
 * The `/__test/*` routes exist only here.
 */
import type {
  ExecutionContext,
  MessageBatch,
  R2Bucket,
  Socket,
} from "@cloudflare/workers-types/index";
import { decideRepoAccess, hasAccess } from "../../src/auth/access";
import { presentedCredential } from "../../src/auth/credentials";
import { verifyJobToken } from "../../src/auth/job-token";
import { ANONYMOUS, type Principal } from "../../src/auth/principal";
import type { ProtectedBranchRule } from "../../src/db/policy-rules";
import type { Env, GitEvent } from "../../src/env";
import { repoClient } from "../../src/repo/do/client";
import type { GitDirectory } from "../../src/transport/directory";
import { gitHttp } from "../../src/transport/http/routes";
import { sshConnect } from "../../src/transport/ssh/host";
import { cacheFailureLimiter, defaultCache } from "../../src/transport/ssh/rate-limit";

export { RepoDO } from "../../src/repo/do/repo-do";

export interface Fixture {
  /** Personal access tokens: the secret, and whose it is. */
  readonly tokens: Record<string, { userId: string; scopes: Array<"repo:read" | "repo:write"> }>;
  /** SSH keys by `SHA256:` fingerprint. */
  readonly keys: Record<string, { userId: string } | { deployKeyFor: string; readOnly: boolean }>;
  /** Usernames by user id. */
  readonly users: Record<string, string>;
  readonly repositories: ReadonlyArray<{
    readonly id: string;
    readonly owner: string;
    readonly name: string;
    readonly ownerUserId: string;
    readonly visibility: "public" | "private";
    readonly archived?: boolean;
    readonly collaborators?: Record<string, "read" | "triage" | "write" | "admin">;
    readonly rules?: readonly ProtectedBranchRule[];
  }>;
}

interface TestEnv extends Env {
  readonly FIXTURE: string;
  readonly SSH_MAX_FAILURES?: string;
}

function fixtureDirectory(env: TestEnv): GitDirectory {
  const fixture = JSON.parse(env.FIXTURE) as Fixture;
  return {
    authenticate: async (request) => {
      const header = request.headers.get("authorization");
      if (header === null || header.trim() === "") return { principal: ANONYMOUS, refused: false };
      const credential = presentedCredential(header);
      if (credential?.kind === "access-token") {
        const token = fixture.tokens[credential.secret];
        if (token) {
          return {
            principal: {
              kind: "user",
              userId: token.userId,
              via: "token",
              scopes: token.scopes,
              credentialId: "token-1",
            },
            refused: false,
          };
        }
      }
      if (credential?.kind === "job-token") {
        const claims = await verifyJobToken(env.GIT_JOB_TOKEN_KEY, credential.secret);
        if (claims) {
          return {
            principal: {
              kind: "job",
              repositoryId: claims.repositoryId,
              write: claims.write,
              runId: claims.runId,
            },
            refused: false,
          };
        }
      }
      return { principal: ANONYMOUS, refused: true };
    },
    authenticateArchiveToken: async (token, commit) => {
      const claims = await verifyJobToken(env.GIT_JOB_TOKEN_KEY, token, undefined, commit);
      return claims
        ? {
            kind: "job",
            repositoryId: claims.repositoryId,
            write: claims.write,
            runId: claims.runId,
          }
        : null;
    },
    authenticateKey: async (key) => {
      const owner = fixture.keys[key.fingerprint];
      if (!owner) return null;
      return "userId" in owner
        ? {
            kind: "user",
            userId: owner.userId,
            via: "ssh-key",
            scopes: null,
            credentialId: "key-1",
          }
        : {
            kind: "deploy-key",
            keyId: "deploy-1",
            repositoryId: owner.deployKeyFor,
            readOnly: owner.readOnly,
          };
    },
    describe: async (principal) =>
      principal.kind === "user" ? (fixture.users[principal.userId] ?? "there") : "there",
    resolveRepository: async (owner, name, principal: Principal) => {
      const found = fixture.repositories.find(
        (each) =>
          each.owner.toLowerCase() === owner.toLowerCase() &&
          each.name.toLowerCase() === name.toLowerCase(),
      );
      if (!found) return null;
      const { access } = decideRepoAccess(
        principal,
        {
          id: found.id,
          visibility: found.visibility,
          archived: found.archived ?? false,
          owner: { kind: "user", userId: found.ownerUserId },
        },
        {
          orgPermissions: [],
          collaboratorRole:
            principal.kind === "user" ? (found.collaborators?.[principal.userId] ?? null) : null,
        },
      );
      return {
        id: found.id,
        owner: found.owner,
        name: found.name,
        archived: found.archived ?? false,
        access,
        pushPolicy: async () => ({
          rules: found.rules ?? [],
          userId: principal.kind === "user" ? principal.userId : null,
          admin: hasAccess(access, "admin"),
        }),
      };
    },
  };
}

const json = (value: unknown): Response =>
  new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });

export default {
  async fetch(request: Request, env: TestEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/__test/rpc" && request.method === "POST") {
      const { repoId, method, args } = (await request.json()) as {
        repoId: string;
        method: string;
        args: unknown[];
      };
      const client = repoClient(env, repoId) as unknown as Record<
        string,
        (...args: unknown[]) => Promise<unknown>
      >;
      try {
        return json({ ok: true, result: await client[method]!(...args) });
      } catch (error) {
        return json({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (url.pathname === "/__test/events") {
      const bucket = env.OBJECTS as unknown as R2Bucket;
      const listed = await bucket.list({ prefix: "__events/" });
      const events: GitEvent[] = [];
      for (const object of listed.objects) {
        const body = await bucket.get(object.key);
        if (body) events.push((await body.json()) as GitEvent);
      }
      return json(events.sort((a, b) => a.at - b.at));
    }
    const git = await gitHttp(request, env, fixtureDirectory(env));
    return git ?? new Response("Not Found", { status: 404 });
  },

  connect(socket: Socket, env: TestEnv): Promise<void> {
    const maxFailures = Number(env.SSH_MAX_FAILURES ?? "0");
    return sshConnect(socket, env, {
      directory: fixtureDirectory(env),
      limiter: cacheFailureLimiter(
        defaultCache(),
        maxFailures > 0 ? { maxFailures, windowSeconds: 600 } : undefined,
      ),
    });
  },

  /** The events queue's consumer here only writes each event down, for the tests to read. */
  async queue(batch: MessageBatch<GitEvent>, env: TestEnv, _ctx: ExecutionContext): Promise<void> {
    const bucket = env.OBJECTS as unknown as R2Bucket;
    for (const message of batch.messages) {
      await bucket.put(
        `__events/${message.body.at}-${message.id}.json`,
        JSON.stringify(message.body),
      );
      message.ack();
    }
  },
};
