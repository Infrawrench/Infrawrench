/**
 * The Worker's Terraform routes on Node stand-ins, behind a loopback HTTP
 * server, so the real `terraform` can use them without workerd or Postgres:
 * `terraformState` and `terraformPlan` exactly as `src/index.ts` mounts them,
 * a `WorkspaceStateStore` per workspace over a memory bucket and
 * `node:sqlite`, and a fixture in place of the database.
 *
 * Access is still decided by `decideStateAuth`: the fixture only supplies the
 * facts Postgres would.
 */
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { type PlanSummary, SERVICE_TOKEN_PURPOSE } from "@infrawrench/git-terraform";
import type { RepoAccess } from "../../src/auth/access";
import { ANONYMOUS, type Principal } from "../../src/auth/principal";
import { decideStateAuth, isServiceToken } from "../../src/terraform/access";
import { type StateClient, localStateClient } from "../../src/terraform/client";
import {
  type TerraformDirectory,
  type TerraformRouteDeps,
  terraformPlan,
  terraformState,
} from "../../src/terraform/route";
import type { StateHeadReport } from "../../src/terraform/state-serve";
import { WorkspaceStateStore } from "../../src/terraform/state-store";
import { routeOf } from "../../src/http/router";
import { MemoryBucket, nodeStorage } from "./node-platform";

export const REPOSITORY_ID = "repo-1";
export const WORKSPACE_ID = "ws-1";
/** The CI run whose job token works, and the Terraform run it is. */
export const LIVE_CI_RUN = "ci-run-1";
export const LIVE_RUN = "tf-run-1";

const user = (userId: string, via: "session" | "token" = "session"): Principal => ({
  kind: "user",
  userId,
  via,
  scopes: via === "token" ? ["repo:write"] : null,
  credentialId: via === "token" ? `pat-${userId}` : null,
});
const job = (runId: string, write: boolean, repositoryId = REPOSITORY_ID): Principal => ({
  kind: "job",
  repositoryId,
  write,
  runId,
});

/** Passwords the fixture knows. Obviously fake, and in no real token format. */
export const PASSWORDS = {
  admin: "password-of-an-admin",
  writer: "password-of-a-writer",
  token: "password-of-a-personal-token",
  reader: "password-of-a-reader",
  job: "password-of-the-live-job",
  otherJob: "password-of-another-job",
  readJob: "password-of-a-read-only-job",
  foreignJob: "password-of-another-repository-job",
  service: "password-of-the-app",
} as const;

const PRINCIPALS: Record<string, Principal> = {
  [PASSWORDS.admin]: user("admin"),
  [PASSWORDS.writer]: user("writer"),
  [PASSWORDS.token]: user("writer", "token"),
  [PASSWORDS.reader]: user("reader"),
  [PASSWORDS.job]: job(LIVE_CI_RUN, true),
  [PASSWORDS.otherJob]: job("ci-run-9", true),
  [PASSWORDS.readJob]: job(LIVE_CI_RUN, false),
  [PASSWORDS.foreignJob]: job(LIVE_CI_RUN, true, "repo-2"),
  [PASSWORDS.service]: job(SERVICE_TOKEN_PURPOSE, false),
};

/** `repoAccess` for the fixture's people: the repository is public, so a stranger reads. */
const ACCESS: Record<string, RepoAccess> = { admin: "admin", writer: "write", reader: "read" };

export interface TerraformServer {
  /** `http://127.0.0.1:<port>/acme/infra/terraform/prod/state` */
  readonly stateUrl: string;
  readonly planUrl: string;
  readonly origin: string;
  readonly bucket: MemoryBucket;
  readonly store: WorkspaceStateStore;
  readonly client: StateClient;
  /** What the route mirrored, newest last. */
  readonly heads: Array<{ report: StateHeadReport; principal: Principal }>;
  /** Plans the route stored, as `recordPlan` got them. */
  readonly plans: Array<{ runId: string; ciRunId: string; summary: PlanSummary }>;
  /** Whether the live run is still live: a finished run's token stops working. */
  live: boolean;
  /** The repository is archived: nothing changes its state. */
  archived: boolean;
  close(): Promise<void>;
}

export async function startTerraformServer(): Promise<TerraformServer> {
  const bucket = new MemoryBucket();
  const store = new WorkspaceStateStore({ bucket, storage: nodeStorage() });
  const client = localStateClient(store, WORKSPACE_ID);
  const state = {
    live: true,
    archived: false,
    heads: [] as TerraformServer["heads"],
    plans: [] as TerraformServer["plans"],
  };

  const directory: TerraformDirectory = {
    authenticate: async (request) => {
      const header = request.headers.get("authorization");
      if (!header) return { principal: ANONYMOUS, refused: false };
      const decoded = header.startsWith("Basic ")
        ? Buffer.from(header.slice(6), "base64").toString("utf8")
        : header.replace(/^Bearer /, ":");
      const principal = PRINCIPALS[decoded.slice(decoded.indexOf(":") + 1)];
      return principal ? { principal, refused: false } : { principal: ANONYMOUS, refused: true };
    },
    workspace: async (owner, repo, name, principal) => {
      if (owner !== "acme" || repo !== "infra" || name !== "prod") return null;
      const level = principal.kind === "user" ? (ACCESS[principal.userId] ?? "none") : "none";
      // A personal token is capped at `write`, and an archived repository at `read`.
      const capped: RepoAccess =
        principal.kind === "user" && principal.via === "token" && level === "admin"
          ? "write"
          : level;
      const auth = decideStateAuth(principal, {
        repositoryId: REPOSITORY_ID,
        access:
          principal.kind === "job"
            ? null
            : { access: state.archived && capped !== "none" ? "read" : capped, unarchived: capped },
        liveRun:
          principal.kind === "job" && !isServiceToken(principal)
            ? state.live && principal.runId === LIVE_CI_RUN
            : false,
      });
      return { id: WORKSPACE_ID, auth };
    },
    recordHead: async (_workspaceId, report, principal) => {
      state.heads.push({ report, principal });
    },
    planAccess: async (_workspaceId, runId, principal) => {
      if (principal.kind !== "job" || principal.repositoryId !== REPOSITORY_ID) {
        return { kind: "none" };
      }
      if (isServiceToken(principal)) return { kind: "service" };
      return principal.write && state.live && principal.runId === LIVE_CI_RUN && runId === LIVE_RUN
        ? { kind: "job", ciRunId: LIVE_CI_RUN }
        : { kind: "none" };
    },
    recordPlan: async ({ runId, ciRunId, summary }) => {
      state.plans.push({ runId, ciRunId, summary });
      return true;
    },
  };
  const deps: TerraformRouteDeps = { directory, client: () => client, bucket };

  const server: Server = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      void (async () => {
        const method = incoming.method ?? "GET";
        const url = new URL(incoming.url ?? "/", `http://${incoming.headers.host}`);
        const body = Buffer.concat(chunks);
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (typeof value === "string") headers.set(name, value);
        }
        const hasBody = method !== "GET" && method !== "HEAD" && body.length > 0;
        const request = new Request(url, { method, headers, ...(hasBody ? { body } : {}) });
        // The Worker's own router decides which route this is.
        const route = routeOf(url.pathname);
        const response =
          route.kind === "terraform-state"
            ? await terraformState(request, route, deps)
            : route.kind === "terraform-plan"
              ? await terraformPlan(request, route, deps)
              : new Response("not a Terraform route", { status: 599 });
        const payload = Buffer.from(await response.arrayBuffer());
        outgoing.writeHead(response.status, Object.fromEntries(response.headers));
        outgoing.end(method === "HEAD" ? undefined : payload);
      })().catch((error: unknown) => {
        outgoing.writeHead(500);
        outgoing.end(String(error));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  const base = `${origin}/acme/infra/terraform/prod`;

  return {
    stateUrl: `${base}/state`,
    planUrl: `${base}/runs/${LIVE_RUN}/plan`,
    origin,
    bucket,
    store,
    client,
    heads: state.heads,
    plans: state.plans,
    get live() {
      return state.live;
    },
    set live(value: boolean) {
      state.live = value;
    },
    get archived() {
      return state.archived;
    },
    set archived(value: boolean) {
      state.archived = value;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
