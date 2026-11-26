/**
 * The worker as the end-to-end tests run it in workerd: the real `RepoDO`,
 * the real smart HTTP routes and the real SSH host, with people and
 * repositories read from a fixture (`FIXTURE`, JSON) instead of Postgres.
 * Access is still decided by the worker's own rules (`decideRepoAccess`).
 *
 * The JSON API is the real one too (`./api.ts`), with its two gates
 * answered from the fixture, so its content routes run against the real
 * reader and the real `RepoDO`. Handlers that also read Postgres (people
 * behind commits, statuses) have no database here and cannot answer.
 *
 * The `/__test/*` routes exist only here.
 */
import type {
  ExecutionContext,
  MessageBatch,
  R2Bucket,
  Socket,
} from "@cloudflare/workers-types/index";
import { ObjectCache, lastCommitsForEntries, log } from "@infrawrench/git-ops";
import { decideRepoAccess, hasAccess } from "../../src/auth/access";
import { presentedCredential } from "../../src/auth/credentials";
import { verifyJobToken } from "../../src/auth/job-token";
import { ANONYMOUS, type Principal } from "../../src/auth/principal";
import type { ProtectedBranchRule } from "../../src/db/policy-rules";
import type { Env, GitEvent } from "../../src/env";
import { repoClient } from "../../src/repo/do/client";
import { RepoReaderError } from "../../src/repo/reader";
import { repoReaderFor } from "../../src/repo/select";
import type { GitDirectory } from "../../src/transport/directory";
import { gitHttp } from "../../src/transport/http/routes";
import { sshConnect } from "../../src/transport/ssh/host";
import { cacheFailureLimiter, defaultCache } from "../../src/transport/ssh/rate-limit";
import { routeOf } from "../../src/http/router";
import type { Bucket } from "../../src/repo/do/platform";
import {
  decidePlanAccess,
  decideStateAuth,
  isServiceToken,
  stateHolder,
} from "../../src/terraform/access";
import { stateClient } from "../../src/terraform/client";
import {
  type TerraformDirectory,
  type TerraformRouteDeps,
  terraformPlan,
  terraformState,
} from "../../src/terraform/route";

export { RepoDO } from "../../src/repo/do/repo-do";
export { TerraformStateDO } from "../../src/terraform/state-do";

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
  /** Terraform workspaces, with the CI run and Terraform run whose job token works for each. */
  readonly workspaces?: ReadonlyArray<{
    readonly id: string;
    readonly repositoryId: string;
    readonly name: string;
    readonly liveCiRun?: string;
    readonly liveRun?: string;
  }>;
}

interface TestEnv extends Env {
  readonly FIXTURE: string;
  readonly SSH_MAX_FAILURES?: string;
}

function fixtureDirectory(
  env: TestEnv,
  options: { readonly workspaceTokens?: boolean } = {},
): GitDirectory {
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
        // As `authenticateRequest` does: only the Terraform routes take a workspace's token.
        const claims = await verifyJobToken(env.GIT_JOB_TOKEN_KEY, credential.secret, undefined, {
          workspace: options.workspaceTokens === true,
        });
        if (claims) {
          return {
            principal: {
              kind: "job",
              repositoryId: claims.repositoryId,
              write: claims.write,
              runId: claims.runId,
              workspaceId: claims.workspaceId,
            },
            refused: false,
          };
        }
      }
      return { principal: ANONYMOUS, refused: true };
    },
    authenticateArchiveToken: async (token, commit) => {
      const claims = await verifyJobToken(env.GIT_JOB_TOKEN_KEY, token, undefined, { commit });
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

/**
 * The Terraform routes' directory from the fixture. What Postgres would
 * record (the state's mirror, a run's plan) is kept in the bucket under
 * `__terraform/`, where `/__test/terraform` reads it back.
 */
function terraformFixture(env: TestEnv): TerraformDirectory {
  const fixture = JSON.parse(env.FIXTURE) as Fixture;
  const git = fixtureDirectory(env, { workspaceTokens: true });
  const bucket = env.OBJECTS as unknown as R2Bucket;
  const note = (kind: string, value: unknown) =>
    bucket.put(
      `__terraform/${kind}/${Date.now().toString().padStart(15, "0")}-${crypto.randomUUID()}`,
      JSON.stringify(value),
    );
  const live = (workspaceId: string, principal: Principal) => {
    const workspace = fixture.workspaces?.find((each) => each.id === workspaceId);
    return principal.kind === "job" && workspace?.liveCiRun !== undefined
      ? principal.runId === workspace.liveCiRun
      : false;
  };
  return {
    authenticate: (request) => git.authenticate(request),
    workspace: async (owner, repo, name, principal) => {
      const found = fixture.repositories.find(
        (each) =>
          each.owner.toLowerCase() === owner.toLowerCase() &&
          each.name.toLowerCase() === repo.toLowerCase(),
      );
      const workspace = fixture.workspaces?.find(
        (each) => each.repositoryId === found?.id && each.name === name,
      );
      if (!found || !workspace) return null;
      const decide = (who: Principal) =>
        decideRepoAccess(
          who,
          {
            id: found.id,
            visibility: found.visibility,
            archived: found.archived ?? false,
            owner: { kind: "user", userId: found.ownerUserId },
          },
          {
            orgPermissions: [],
            collaboratorRole:
              who.kind === "user" ? (found.collaborators?.[who.userId] ?? null) : null,
          },
        );
      return {
        id: workspace.id,
        auth: decideStateAuth(principal, {
          repositoryId: found.id,
          workspaceId: workspace.id,
          access: principal.kind === "job" ? null : decide(principal),
          holder: principal.kind === "job" ? null : decide(stateHolder(principal)),
          liveRun: !isServiceToken(principal) && live(workspace.id, principal),
        }),
      };
    },
    recordHead: async (workspaceId, report, principal) => {
      await note("heads", { workspaceId, report, principal });
    },
    planAccess: async (workspaceId, runId, principal) => {
      const workspace = fixture.workspaces?.find((each) => each.id === workspaceId);
      if (!workspace) return { kind: "none" };
      return decidePlanAccess(
        principal,
        {
          repositoryId: workspace.repositoryId,
          workspaceId,
          liveRunId: live(workspaceId, principal) ? (workspace.liveRun ?? null) : null,
        },
        runId,
      );
    },
    recordPlan: async (plan) => {
      await note("plans", plan);
      return true;
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
    // A `RepoReader` method, called the way the API and the queue consumer call it.
    if (url.pathname === "/__test/reader" && request.method === "POST") {
      const { locator, method, args } = (await request.json()) as {
        locator: { id: string; owner: string; name: string };
        method: string;
        args: unknown[];
      };
      const reader = repoReaderFor(env, locator) as unknown as Record<
        string,
        (...args: unknown[]) => Promise<unknown>
      >;
      const started = performance.now();
      try {
        const result = await reader[method]!(...args);
        return json({ ok: true, result, millis: performance.now() - started });
      } catch (error) {
        if (error instanceof RepoReaderError) {
          return json({ ok: false, code: error.code, error: error.message });
        }
        return json({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
    // The road not taken, for the measurement: the same walk run here in the Worker, every
    // object a call to the Durable Object, where the reader runs it inside the object.
    if (url.pathname === "/__test/worker-side" && request.method === "POST") {
      const { repoId, op, commit, path } = (await request.json()) as {
        repoId: string;
        op: "log" | "last-commits";
        commit: string;
        path?: string;
      };
      const client = repoClient(env, repoId);
      let reads = 0;
      const cache = new ObjectCache({
        read: (oid) => {
          reads++;
          return client.readObject(oid);
        },
        has: async (oid) => (await client.hasObjects([oid]))[0] === true,
      });
      const started = performance.now();
      if (op === "log") {
        await log(cache, commit, { limit: 30, ...(path !== undefined ? { path } : {}) });
      } else {
        const names = (await cache.tree((await cache.node(commit)).tree)).map((each) => each.name);
        await lastCommitsForEntries(cache, commit, "", names, { maxCommits: 300 });
      }
      return json({ millis: performance.now() - started, reads });
    }
    if (url.pathname.startsWith("/api/")) {
      const { apiFor } = await import("./api");
      const api = apiFor(JSON.parse(env.FIXTURE) as Fixture, url.pathname);
      if (api) return api.handle(request, env, { waitUntil: () => {} });
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
    if (url.pathname === "/__test/terraform") {
      // What the routes recorded, oldest first, and the state objects in the bucket.
      const bucket = env.OBJECTS as unknown as R2Bucket;
      const read = async (kind: string) => {
        const listed = await bucket.list({ prefix: `__terraform/${kind}/` });
        const keys = listed.objects.map((object) => object.key).sort();
        return Promise.all(keys.map(async (key) => (await bucket.get(key))!.json()));
      };
      const objects = (await bucket.list({ prefix: "terraform/" })).objects.map(
        (object) => object.key,
      );
      return json({ heads: await read("heads"), plans: await read("plans"), objects });
    }
    if (url.pathname === "/__test/terraform-rpc" && request.method === "POST") {
      const { workspaceId, method, args } = (await request.json()) as {
        workspaceId: string;
        method: "head" | "restore" | "forceUnlock" | "destroy";
        args: string[];
      };
      const client = stateClient(env, workspaceId) as unknown as Record<
        string,
        (...args: string[]) => Promise<unknown>
      >;
      try {
        return json({ ok: true, result: await client[method]!(...args) });
      } catch (error) {
        return json({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
    const route = routeOf(url.pathname);
    if (route.kind === "terraform-state" || route.kind === "terraform-plan") {
      const deps: TerraformRouteDeps = {
        directory: terraformFixture(env),
        client: (workspaceId) => stateClient(env, workspaceId),
        bucket: env.OBJECTS as unknown as Bucket,
      };
      return route.kind === "terraform-state"
        ? terraformState(request, route, deps)
        : terraformPlan(request, route, deps);
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
