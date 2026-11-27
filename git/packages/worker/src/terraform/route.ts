/**
 * The Terraform routes the front Worker serves outside the JSON API:
 *
 * | Route                                                        | For                              |
 * | ------------------------------------------------------------ | -------------------------------- |
 * | `/:owner/:repo/terraform/:workspace/state[/lock\|/unlock]`    | Terraform's `http` backend       |
 * | `POST /:owner/:repo/terraform/:workspace/runs/:runId/plan`    | a run's job posting its plan     |
 * | `GET  /:owner/:repo/terraform/:workspace/runs/:runId/plan`    | the app pricing that plan (once) |
 *
 * The Worker decides who is asking and the workspace's Durable Object does
 * the rest (`state-serve.ts`). Who gets what:
 *
 * - **No valid credential: 401** with a Basic challenge, whatever the path
 *   names, so repositories and workspaces are not probed.
 * - **A credential that may not: 403.** A missing repository, a missing
 *   workspace and a reader of a public repository all get the same answer.
 *   It is never 404 or 204: Terraform reads both on a `GET` as "no state
 *   yet" and plans to create everything.
 * - **Reading and writing take `admin`** on the repository (a state holds
 *   every secret its workspace manages, and every member of an organisation
 *   has `write`). A personal access token works for an administrator and
 *   needs `repo:write`; a job token works when it names this workspace and
 *   its run is live, a plan's to read and lock, an apply's to write as well.
 *   Deleting the state and unlocking without the lock's id take `admin` too,
 *   and no personal access token administers (`access.ts` has the table).
 * - **Tokens only.** The session cookie is never read here: Terraform sends
 *   none, and a page elsewhere must not be able to use one.
 *
 * Everything that touches Postgres is behind {@link TerraformDirectory}, as
 * the Git transports' is, so the tests run these routes with the real
 * `terraform` and no database.
 */
import {
  type PlanPricingInputs,
  type PlanSummary,
  type StateAuth,
  type StateRoute,
  PlanFormatError,
  planPricingInputs,
  summarizePlan,
} from "@infrawrench/git-terraform";
import type { Principal } from "../auth/principal";
import type { Bucket } from "../repo/do/platform";
import type { HttpAuthentication, RequestLike } from "../transport/directory";
import type { StateClient } from "./client";
import { STATE_HEAD_HEADER, type StateHeadReport, decodeHeader } from "./state-serve";
import { workspacePrefix } from "./state-store";

export interface ResolvedWorkspace {
  readonly id: string;
  /** What the principal may do to its state. All false: a 403. */
  readonly auth: StateAuth;
}

export type PlanAccess =
  /** The job of this run, while it is live: it may post the run's plan. */
  | { readonly kind: "job"; readonly ciRunId: string }
  /** The app, reading what it will price. */
  | { readonly kind: "service" }
  | { readonly kind: "none" };

export interface TerraformDirectory {
  authenticate(request: RequestLike): Promise<HttpAuthentication>;
  /** The workspace at `owner/repo` named `name`, and what `principal` may do. Null when there is none. */
  workspace(
    owner: string,
    repo: string,
    name: string,
    principal: Principal,
  ): Promise<ResolvedWorkspace | null>;
  /** Mirrors the state's head onto Postgres after a change. */
  recordHead(workspaceId: string, report: StateHeadReport, principal: Principal): Promise<void>;
  /** What `principal` is to this run's plan. */
  planAccess(workspaceId: string, runId: string, principal: Principal): Promise<PlanAccess>;
  /** Stores a plan's summary on its run. False when the run is not this job's, or is over. */
  recordPlan(input: {
    readonly workspaceId: string;
    readonly runId: string;
    readonly ciRunId: string;
    readonly summary: PlanSummary;
  }): Promise<boolean>;
}

export interface TerraformRouteDeps {
  readonly directory: TerraformDirectory;
  readonly client: (workspaceId: string) => StateClient;
  /** Where a plan's pricing inputs wait for the app, beside the workspace's state. */
  readonly bucket: Bucket;
}

export interface StateRouteInput {
  readonly owner: string;
  readonly repo: string;
  readonly workspace: string;
  /** The segments after `state`. */
  readonly rest: readonly string[];
}

export interface PlanRouteInput {
  readonly owner: string;
  readonly repo: string;
  readonly workspace: string;
  readonly runId: string;
}

/**
 * The most a posted plan may be. A plan of a few thousand resources is a few
 * megabytes, and the document is parsed here, in the front Worker, where its
 * parsed form is several times its size in a 128 MB isolate.
 */
export const MAX_PLAN_BYTES = 16 * 1024 * 1024;

const CHALLENGE = 'Basic realm="git.infrawrench.com", charset="UTF-8"';

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });

const unauthorized = (): Response =>
  json(
    401,
    { error: "Sign in with a personal access token or a CI job token." },
    { "www-authenticate": CHALLENGE },
  );

const forbidden = (): Response =>
  json(403, {
    error: "This credential may not use this workspace, or there is no such workspace.",
  });

/** The key a run's pricing inputs wait under. */
export const planInputsKey = (workspaceId: string, runId: string): string =>
  `${workspacePrefix(workspaceId)}plans/${runId}.json`;

const stateRouteOf = (rest: readonly string[]): StateRoute | null => {
  if (rest.length === 0) return "state";
  if (rest.length === 1 && (rest[0] === "lock" || rest[0] === "unlock")) return rest[0];
  return null;
};

/** The request as authentication sees it here: its `Authorization`, never its cookie. */
const withoutCookie = (request: Request): RequestLike => ({
  url: request.url,
  method: request.method,
  headers: {
    get: (name) => (name.toLowerCase() === "cookie" ? null : request.headers.get(name)),
  },
});

type Resolved =
  | { readonly ok: true; readonly principal: Principal; readonly workspace: ResolvedWorkspace }
  | { readonly ok: false; readonly response: Response };

const resolve = async (
  request: Request,
  input: { readonly owner: string; readonly repo: string; readonly workspace: string },
  directory: TerraformDirectory,
): Promise<Resolved> => {
  const { principal, refused } = await directory.authenticate(withoutCookie(request));
  if (refused || principal.kind === "anonymous") return { ok: false, response: unauthorized() };
  const workspace = await directory.workspace(input.owner, input.repo, input.workspace, principal);
  if (!workspace) return { ok: false, response: forbidden() };
  return { ok: true, principal, workspace };
};

/** Terraform's `http` backend for one workspace. */
export const terraformState = async (
  request: Request,
  input: StateRouteInput,
  deps: TerraformRouteDeps,
): Promise<Response> => {
  const route = stateRouteOf(input.rest);
  const resolved = await resolve(request, input, deps.directory);
  if (!resolved.ok) return resolved.response;
  // After the credential, so an unknown path says nothing to a stranger.
  if (route === null) return json(400, { error: "There is no such state address." });
  const { principal, workspace } = resolved;
  const { auth } = workspace;
  if (!auth.canRead && !auth.canLock && !auth.canWrite && !auth.canAdmin) return forbidden();

  const response = await deps.client(workspace.id).serve(request, { auth, route });
  const report = decodeHeader<StateHeadReport>(response.headers.get(STATE_HEAD_HEADER));
  if (!report) return response;
  try {
    await deps.directory.recordHead(workspace.id, report, principal);
  } catch (error) {
    // The object is the truth and has answered: the mirror catches up with the next change.
    console.error(`[terraform] could not mirror the state of workspace ${workspace.id}:`, error);
  }
  const headers = new Headers(response.headers);
  headers.delete(STATE_HEAD_HEADER);
  return new Response(response.body, { status: response.status, headers });
};

type Body =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly response: Response };

const readBody = async (request: Request, limit: number): Promise<Body> => {
  const tooLarge: Body = {
    ok: false,
    response: json(413, { error: `A plan is at most ${limit} bytes.` }),
  };
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > limit) return tooLarge;
  if (!request.body) return { ok: true, bytes: new Uint8Array(0) };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      return tooLarge;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { ok: true, bytes };
};

/**
 * A run's plan. The job posts `terraform show -json <planfile>`; its summary
 * (names, never values) is stored on the run and the document is dropped. It
 * is never logged and never stored: it has every sensitive value in the clear.
 *
 * What pricing needs of it (`planPricingInputs`: types and plain, unmarked
 * scalar attributes) waits in the bucket beside the state until the app reads
 * it, once, with `GET`.
 */
export const terraformPlan = async (
  request: Request,
  input: PlanRouteInput,
  deps: TerraformRouteDeps,
): Promise<Response> => {
  const resolved = await resolve(request, input, deps.directory);
  if (!resolved.ok) return resolved.response;
  const { principal, workspace } = resolved;
  const access = await deps.directory.planAccess(workspace.id, input.runId, principal);
  const key = planInputsKey(workspace.id, input.runId);
  const method = request.method.toUpperCase();

  if (method === "GET") {
    if (access.kind !== "service") return forbidden();
    const stored = await deps.bucket.get(key);
    if (!stored) return json(404, { error: "No plan waits to be priced for this run." });
    const bytes = await stored.arrayBuffer();
    // Read once: nothing with values in it outlives its use.
    await deps.bucket.delete(key);
    return new Response(bytes, {
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }
  if (method !== "POST") {
    return json(405, { error: `${request.method} is not served here.` }, { allow: "GET, POST" });
  }
  if (access.kind !== "job") return forbidden();

  const body = await readBody(request, MAX_PLAN_BYTES);
  if (!body.ok) return body.response;
  let summary: PlanSummary;
  let pricing: PlanPricingInputs;
  try {
    const document: unknown = JSON.parse(new TextDecoder().decode(body.bytes));
    summary = summarizePlan(document);
    pricing = planPricingInputs(document);
  } catch (error) {
    if (error instanceof PlanFormatError) return json(400, { error: error.message });
    if (error instanceof SyntaxError) return json(400, { error: "The plan is not valid JSON." });
    throw error;
  }
  const stored = await deps.directory.recordPlan({
    workspaceId: workspace.id,
    runId: input.runId,
    ciRunId: access.ciRunId,
    summary,
  });
  if (!stored) return json(409, { error: "This run is over, or is not this job's." });
  if (pricing.changes.length > 0) {
    await deps.bucket.put(key, new TextEncoder().encode(JSON.stringify(pricing)));
  }
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
};
