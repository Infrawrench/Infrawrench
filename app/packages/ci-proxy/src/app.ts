// Routes and the per-minute scheduler, written against small interfaces
// (`Pool`, `ScheduleStore`) so tests drive them without Cloudflare.
//
// | Route | Does |
// |-------|------|
// | `GET /healthz` | `200 ok`, unauthenticated |
// | `GET /v1/artifacts/{owner}/{repo-id}/{run}/{object}?n=&e=&s=` | a job's download, by a link the app signed (no bearer key); see `artifacts.ts` |
// | `GET`, `PUT /v1/runners` | the runners runs go to (`{ "runners": [{ "name", "url" }] }`, replaced whole) |
// | `GET /v1/capacity` | every runner's slots, job memory and platforms, and the pool's total slots |
// | `POST /v1/runs[?wait=true]` | runs a request on the runner where it is expected to finish soonest, among those with every platform its `platforms` names when any is up (`takePlatforms`, never sent on), and offers it to the others as helpers (`placeRun`); a manual run (`"event": "manual"`, `pipeline-file`, `inputs`) passes through like a push |
// | `GET /v1/runs/{id}` and `/v1/runs/{id}/logs` | from the runner that has the run; logs stream through |
// | `POST /v1/runs/{id}/cancel` | cancels the run, or some of its pipelines, on the runner that has it |
// | `GET /v1/runs/{id}/jobs[/{job}]` | a run's cloud jobs and their state, from the runner that has it |
// | `POST /v1/runs/{id}/jobs/{job}/claim`, `/log`, `/finish` | the executor's side of a cloud job, on the runner that has it |
// | `GET /v1/runs/{id}/jobs/{job}/inputs?claim=`, `PUT .../artifacts?claim=` | a cloud job's artifacts, for its machine: the claim token, no bearer key |
// | `POST /v1/concurrency` | a request's pipelines and their concurrency groups, from any runner; runs nothing |
// | `POST /v1/prepare` | warms a runner for a request, placed like a run (`platforms` included) |
// | `GET /v1/storage/{owner}`, `GET /v1/usage/{owner}` | from any runner (they share the store) |
// | `DELETE /v1/storage/{owner}/{repo-id}` | clears a repository's caches, on any runner |
// | `POST /v1/schedules/read` | a branch's `on.schedule` pipelines and its `on.manual` ones (`manual`), from any runner; stores nothing (the app's schedules and manual runs) |
// | `PUT /v1/schedules` | registers a repository's `on.schedule` pipelines |
// | `GET /v1/schedules/{owner}` | an owner's registered schedules |
// | `DELETE /v1/schedules/{owner}/{repo-id}` | stops a repository's scheduled runs |
// | `GET /v1/orgs/{owner}[/repos/{repo-id}]/secrets` | secret names and when each was set |
// | `PUT`, `DELETE /v1/orgs/{owner}[/repos/{repo-id}]/secrets/{name}` | sets (`{ "value": ... }`) or removes one |
// | `GET`, `PUT`, `DELETE` the same under `/vars` | variables, values included |

import { serveDownload, type Downloads } from "./artifacts";
import { authorised } from "./auth";
import { ciCronDue } from "@infrawrench/client-core";
import { identify, isId } from "./identity";
import {
  expectedSeconds,
  isRunnerName,
  isRunnerUrl,
  parseRunId,
  runCores,
  type Capacity,
  type Placed,
  type Pool,
  type RunnerEntry,
} from "./pool";
import type { RunnerList } from "./runners";
import type { ScheduleRow, ScheduledPipeline, ScheduleStore } from "./store";
import {
  forRun,
  isName,
  MAX_PER_SCOPE,
  MAX_VALUE_BYTES,
  seal,
  type Kind,
  type SecretsKey,
  type ValueStore,
} from "./values";

/** The most runners the proxy keeps. */
const MAX_RUNNERS = 64;

export interface Deps {
  pool: Pool;
  /** The stored runner list, which `pool` was built from when it has any. */
  runnerList: RunnerList;
  values: ValueStore;
  /** From SECRETS_KEY; without it, secrets cannot be set or read. */
  secretsKey: SecretsKey | null;
  store: ScheduleStore;
  proxyKey: string;
  /** Unix seconds; injectable so tests control time. */
  now: () => number;
  /** The runners' bucket and the key download links are signed with. */
  downloads?: Downloads;
  /**
   * Keeps work going after the response is sent (the Worker's
   * `waitUntil`). Without it that work is awaited.
   */
  background?: (work: Promise<unknown>) => void;
}

/** Bodies are a run request, maybe with a pipeline file: small. */
const MAX_BODY = 1 << 20;
/** A registered repository's pipelines are read again after this long. */
export const REFRESH_SECS = 600;
/** Schedules re-read per minute at most, so one tick stays short. */
const REFRESHES_PER_TICK = 20;
const RETRY_AFTER_SECS = "10";

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/** A number JSON can carry: `null` for none and for `Infinity`. */
function finite(value: number | null): number | null {
  return value !== null && Number.isFinite(value) ? Math.round(value) : null;
}

function error(status: number, message: string): Response {
  return json(status, { error: message });
}

function full(): Response {
  return json(
    429,
    { error: "every runner is at capacity; retry later" },
    { "Retry-After": RETRY_AFTER_SECS },
  );
}

/** The most platforms a request may name, and the longest name. */
const MAX_PLATFORMS = 8;
const MAX_PLATFORM_CHARS = 32;

/**
 * Takes `platforms` out of a run or prepare request: the platforms other
 * than `wasm` its jobs run on (`linux` today), which the app reads from
 * `/v1/concurrency`. The proxy places by it and never sends it on, since a
 * runner refuses a request with a field it does not know. Names are not
 * checked against a list, so a platform added to the runners needs no
 * change here; a runner that does not list it is simply not preferred.
 * Absent means none; anything but up to 8 strings of 1 to 32 characters is
 * a 400.
 */
export function takePlatforms(request: Record<string, unknown>): string[] | Response {
  const value = request.platforms;
  delete request.platforms;
  if (value === undefined || value === null) return [];
  if (
    !Array.isArray(value) ||
    value.length > MAX_PLATFORMS ||
    !value.every((p) => typeof p === "string" && p.length > 0 && p.length <= MAX_PLATFORM_CHARS)
  ) {
    return error(
      400,
      `\`platforms\` is a list of up to ${MAX_PLATFORMS} platform names, each up to ${MAX_PLATFORM_CHARS} characters`,
    );
  }
  return [...new Set(value as string[])];
}

/**
 * The platforms a registered schedule's pipeline needs, as the runner read
 * it: the names it lists other than `wasm`, as `takePlatforms` would take
 * them. A row stored before runners said has none.
 */
export function schedulePlatforms(pipeline: ScheduledPipeline): string[] {
  const value = pipeline.platforms;
  if (!Array.isArray(value)) return [];
  const names = value.filter(
    (p): p is string =>
      typeof p === "string" && p.length > 0 && p.length <= MAX_PLATFORM_CHARS && p !== "wasm",
  );
  return [...new Set(names)].slice(0, MAX_PLATFORMS);
}

/** The most runners a run is offered to as helpers. */
export const MAX_HELPERS = 3;
/** How long a runner gets to answer an offer to help. */
const HELP_TIMEOUT_MS = 5000;

/**
 * Places a run and shares it with the other runners.
 *
 * A runner that says `split` in its capacity can share a run: it gets
 * `"split": { "runner": <its name> }` in the request, and every other such
 * runner (up to `MAX_HELPERS`) is then sent the same request, without its
 * `secrets` and `lent`, with
 * `"split": { "of": <the run's id there>, "runner": <its name> }`. An
 * offer sits on a runner for the whole of a run it may never be asked to
 * help, so it carries no secret: a helper that joins gets them sealed to
 * a key of its own (below), and never runs a job that is lent anything.
 * The `token` stays, since a helper fetches the commit, which it does as
 * soon as it is offered one the request names. That is an offer, not a run: the runner that has the run asks for help
 * through the store they share when its queue backs up, and a helper
 * takes jobs only while it has slots and memory its own runs do not
 * want. So the proxy offers every time and decides nothing: it cannot
 * see which jobs a pipeline has, how long a run's queue is, or what a
 * helper will have free a minute from now, and both runners can. Every
 * pipeline may be shared, but a run stays on its runner while that runner
 * has room; a helper that joins is sent the run's secrets by the runner
 * that has it, sealed through the store, never through an offer.
 *
 * Nothing is kept about the run: a helper that refuses, is down or
 * answers late is one helper fewer, and cancelling, status and logs go to
 * the runner that has the run, which ends its helpers itself.
 *
 * A run a caller waits for (`?wait=true`) is not shared: its id is only
 * known when it is over. A caller's own `split` is dropped; how a run is
 * shared is the proxy's to say.
 *
 * `platforms` (from `takePlatforms`) narrows where the run is placed, not
 * who is offered it: which jobs a helper may take is the runners' to say.
 */
async function placeRun(
  deps: Deps,
  search: string,
  request: Record<string, unknown>,
  platforms: readonly string[] = [],
): Promise<Placed | null> {
  // `platforms` is the proxy's alone: no runner is ever sent it.
  const { split: _split, platforms: _platforms, ...rest } = request;
  // What a helper is sent: nothing secret but the token to fetch with.
  const { secrets: _secrets, lent: _lent, ...offer } = rest;
  const waits = new URLSearchParams(search).get("wait") === "true";
  const helpers = (runner: Capacity, others: Capacity[]) =>
    waits || !runner.split ? [] : others.filter((o) => o.split).slice(0, MAX_HELPERS);
  const placed = await deps.pool.place(
    `/v1/runs${search}`,
    (runner, others) =>
      JSON.stringify(
        helpers(runner, others).length > 0 ? { ...rest, split: { runner: runner.name } } : rest,
      ),
    platforms,
  );
  if (!placed?.response.ok) return placed;
  const offered = helpers(placed.capacity, placed.others);
  if (offered.length === 0) return placed;
  const started = (await placed.response
    .clone()
    .json()
    .catch(() => ({}))) as { id?: unknown };
  const id = started.id;
  if (typeof id !== "string" || !/^[0-9a-f]{32}$/.test(id)) return placed;
  const offers = Promise.allSettled(
    offered.map(async (helper) => {
      const response = await deps.pool.call(helper.name, "/v1/runs", {
        method: "POST",
        body: JSON.stringify({ ...offer, split: { of: id, runner: helper.name } }),
        signal: AbortSignal.timeout(HELP_TIMEOUT_MS),
      });
      await response.body?.cancel();
    }),
  );
  if (deps.background) deps.background(offers);
  else await offers;
  return placed;
}

/** Reads a JSON object body, refusing anything large or malformed. */
async function readBody(
  request: Request,
): Promise<{ text: string; value: Record<string, unknown> } | Response> {
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > MAX_BODY) return error(413, `the body is over ${MAX_BODY} bytes`);
  const text = await request.text();
  if (text.length > MAX_BODY) return error(413, `the body is over ${MAX_BODY} bytes`);
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return error(400, "the body is a JSON object");
    return { text, value: value as Record<string, unknown> };
  } catch {
    return error(400, "the body is not JSON");
  }
}

/** Passes a runner's response on, body streamed, with run ids rewritten. */
async function relay(runner: string, response: Response): Promise<Response> {
  const type = response.headers.get("Content-Type") ?? "";
  if (!type.includes("application/json")) {
    return new Response(response.body, { status: response.status, headers: response.headers });
  }
  const body = (await response.json()) as Record<string, unknown>;
  if (typeof body.id === "string") {
    body.id = `${runner}.${body.id}`;
    if (typeof body.url === "string") body.url = `/v1/runs/${body.id}`;
  }
  const headers: Record<string, string> = {};
  const retry = response.headers.get("Retry-After");
  if (retry) headers["Retry-After"] = retry;
  return json(response.status, body, headers);
}

function summary(row: ScheduleRow): Record<string, unknown> {
  return {
    owner: row.owner,
    "repo-id": row.repoId,
    repo: row.repo,
    branch: row.branch,
    commit: row.commit,
    pipelines: row.pipelines.map((p) => ({ file: p.file, name: p.name, cron: p.cron })),
    error: row.error,
    "refreshed-at": row.refreshedAt,
  };
}

interface ReadReply {
  owner: string;
  "repo-id": string;
  branch: string;
  commit: string;
  pipelines: ScheduledPipeline[];
  problems: string[];
}

/** Asks a runner what a repository's default branch schedules. */
async function readSchedules(
  deps: Deps,
  request: Record<string, unknown>,
): Promise<{ reply: ReadReply } | { status: number; message: string }> {
  const response = await deps.pool.any("/v1/schedules/read", {
    method: "POST",
    body: JSON.stringify(request),
  });
  if (!response) return { status: 503, message: "no runner answered" };
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    return { status: response.status, message: body.error ?? `runner answered ${response.status}` };
  }
  return { reply: (await response.json()) as ReadReply };
}

/** A run's id on the proxy (`<runner>.<id>`) in its runner's URLs. */
function proxiedUrl(value: unknown, runner: string, id: string): unknown {
  const prefix = `/v1/runs/${id}/`;
  return typeof value === "string" && value.startsWith(prefix)
    ? `/v1/runs/${runner}.${id}/${value.slice(prefix.length)}`
    : value;
}

/** A job id as one percent-encoded path segment, as the runner takes it. */
function isJobSegment(segment: string): boolean {
  return /^[A-Za-z0-9%._~-]{1,512}$/.test(segment);
}

/** A cloud job's claim token: what the runner hands out, 32 hex digits. */
function isClaimToken(token: string | null): token is string {
  return token !== null && /^[0-9a-f]{32}$/.test(token);
}

/**
 * The cloud job routes of a run (`/v1/runs/{id}/jobs...`), on the runner
 * that has it. The claim's URLs are rewritten to the proxy's run id, so the
 * app can hand them to the job's machine as they are.
 */
async function cloudJobs(
  request: Request,
  deps: Deps,
  url: URL,
  parts: string[],
): Promise<Response> {
  const [, , third = "", , job, action, extra] = parts;
  if (extra !== undefined || (job !== undefined && !isJobSegment(job))) {
    return error(404, "no such route");
  }
  const run = parseRunId(third, deps.pool);
  if (!run) return error(404, "no such run");
  const method = request.method;
  const tail = parts.slice(3).join("/");
  const path = `/v1/runs/${run.id}/${tail}`;
  const call = async (init: RequestInit): Promise<Response> => {
    try {
      return await deps.pool.call(run.runner, `${path}${url.search}`, init);
    } catch {
      return error(502, "the runner with that run did not answer");
    }
  };
  if (method === "GET" && action === undefined) return relay(run.runner, await call({}));
  if (method === "POST" && job !== undefined && ["claim", "log", "finish"].includes(action ?? "")) {
    const body = await request.text();
    if (body.length > MAX_BODY) return error(413, `the body is over ${MAX_BODY} bytes`);
    const response = await call({ method: "POST", body: body.length > 0 ? body : "{}" });
    if (action !== "claim" || !response.ok) return relay(run.runner, response);
    const claim = (await response.json()) as Record<string, unknown>;
    claim.run = third;
    for (const key of ["inputs", "artifacts"]) {
      const value = claim[key];
      if (typeof value === "object" && value !== null) {
        const v = value as Record<string, unknown>;
        v.url = proxiedUrl(v.url, run.runner, run.id);
      }
    }
    return json(response.status, claim);
  }
  return error(404, "no such route for a cloud job");
}

/**
 * A cloud job's machine fetching its input artifacts or uploading its own,
 * with the claim's token instead of the proxy key: the runner checks the
 * token. Bodies stream through. `null` for anything else.
 */
async function cloudArtifacts(
  request: Request,
  deps: Deps,
  url: URL,
  parts: string[],
): Promise<Response | null> {
  const [v1, runs, third = "", jobs, job = "", action, extra] = parts;
  const shape =
    v1 === "v1" &&
    runs === "runs" &&
    jobs === "jobs" &&
    extra === undefined &&
    ((request.method === "GET" && action === "inputs") ||
      (request.method === "PUT" && action === "artifacts"));
  if (!shape) return null;
  const token = url.searchParams.get("claim");
  if (!isClaimToken(token)) return null;
  if (!isJobSegment(job)) return error(404, "no such route");
  const run = parseRunId(third, deps.pool);
  if (!run) return error(404, "no such run");
  const path = `/v1/runs/${run.id}/jobs/${job}/${action}?claim=${token}`;
  try {
    const response = await deps.pool.call(
      run.runner,
      path,
      request.method === "PUT"
        ? {
            method: "PUT",
            body: request.body,
            headers: { "Content-Type": "application/x-tar" },
          }
        : {},
    );
    return new Response(response.body, { status: response.status, headers: response.headers });
  } catch {
    return error(502, "the runner with that run did not answer");
  }
}

export async function handle(request: Request, deps: Deps): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");
  const parts = path.split("/").filter((p) => p.length > 0);
  const [, , third = "", fourth = ""] = parts;
  const method = request.method;

  if (method === "GET" && path === "/healthz") return new Response("ok");
  // A download is fetched by a browser, with a link the app signed instead
  // of the proxy's key.
  if (parts[0] === "v1" && parts[1] === "artifacts") {
    return serveDownload(request, url, parts.slice(2), deps.downloads, deps.now());
  }
  // A cloud job's machine, with its claim's token rather than the key.
  const artifacts = await cloudArtifacts(request, deps, url, parts);
  if (artifacts) return artifacts;
  if (!(await authorised(request, deps.proxyKey))) return error(401, "missing or wrong bearer key");

  if (method === "GET" && path === "/v1/capacity") {
    const runners = await deps.pool.capacity();
    const up = runners.filter((r) => r.up);
    return json(200, {
      runners: runners.map((r) => ({
        name: r.name,
        up: r.up,
        draining: r.draining,
        version: r.version,
        slots_total: r.slotsTotal,
        slots_free: r.slotsFree,
        runs_active: r.runsActive,
        cpus: r.cpus,
        memory_total: r.memoryTotal,
        memory_used: r.memoryUsed,
        memory_waiting: r.memoryWaiting,
        v8_lost_isolates: r.v8LostIsolates,
        v8_lost_heap: r.v8LostHeap,
        // Whether it can share a run or help one, and how many it helps.
        split: r.split,
        runs_helping: r.runsHelping,
        // What it runs jobs on (`wasm`, and `linux` with VMs).
        platforms: r.platforms,
        // What placement ranks by: the cores a new run could expect here,
        // and how long a typical pull request's run would then take.
        run_cores: r.up ? runCores(r) : null,
        expected_seconds: r.up ? finite(expectedSeconds(r)) : null,
      })),
      slots_total: up.reduce((n, r) => n + r.slotsTotal, 0),
      // A draining runner takes no new runs, so its free slots are not free.
      slots_free: up.filter((r) => !r.draining).reduce((n, r) => n + r.slotsFree, 0),
    });
  }

  if (method === "POST" && (path === "/v1/runs" || path === "/v1/prepare")) {
    const body = await readBody(request);
    if (body instanceof Response) return body;
    let text = body.text;
    const named = "platforms" in body.value;
    const platforms = takePlatforms(body.value);
    if (platforms instanceof Response) return platforms;
    if (path === "/v1/runs") {
      const withValues = await withStoredValues(deps, body.value);
      if (withValues instanceof Response) return withValues;
      const placed = await placeRun(deps, url.search, withValues, platforms);
      if (!placed) return full();
      return relay(placed.runner, placed.response);
    }
    if (named || "trusted" in body.value || "lent" in body.value) {
      // Preparing runs no job, so it needs neither `trusted` nor `lent`;
      // `platforms` was the proxy's and is already out.
      const { trusted: _, lent: _lent, ...rest } = body.value;
      text = JSON.stringify(rest);
    }
    const placed = await deps.pool.place(`${path}${url.search}`, text, platforms);
    if (!placed) return full();
    return relay(placed.runner, placed.response);
  }

  if (method === "POST" && (path === "/v1/concurrency" || path === "/v1/schedules/read")) {
    // What a run would hold, or which of a branch's pipelines have
    // `on.schedule`, worked out by a runner without running anything. The
    // app fires its repositories' schedules itself and reads them here with
    // an installation token, which passes through and is never stored (unlike
    // `PUT /v1/schedules`, which keeps what it reads). Concurrency groups may
    // read variables, never secrets, so only variables are added.
    const body = await readBody(request);
    if (body instanceof Response) return body;
    // They place nothing, so `platforms` is dropped too.
    const {
      trusted: _trusted,
      secrets: _secrets,
      lent: _lent,
      platforms: _platforms,
      ...rest
    } = body.value;
    const { owner, repoId } = identify(rest);
    if (isId(owner) && isId(repoId)) {
      const stored = await forRun(deps.values, deps.secretsKey, owner, repoId, false);
      const own = rest.vars;
      const vars = {
        ...stored.vars,
        ...(typeof own === "object" && own !== null && !Array.isArray(own) ? own : {}),
      };
      if (Object.keys(vars).length > 0) rest.vars = vars;
    }
    const response = await deps.pool.any(path, { method: "POST", body: JSON.stringify(rest) });
    return response
      ? new Response(response.body, { status: response.status, headers: response.headers })
      : error(503, "no runner answered");
  }

  if (parts[0] === "v1" && parts[1] === "runs" && parts[3] === "jobs") {
    return cloudJobs(request, deps, url, parts);
  }

  if (method === "POST" && parts[0] === "v1" && parts[1] === "runs" && parts.length === 4) {
    if (parts[3] !== "cancel") return error(404, "no such route");
    const run = parseRunId(third, deps.pool);
    if (!run) return error(404, "no such run");
    const body = await request.text();
    if (body.length > MAX_BODY) return error(413, `the body is over ${MAX_BODY} bytes`);
    try {
      const response = await deps.pool.call(run.runner, `/v1/runs/${run.id}/cancel`, {
        method: "POST",
        body: body.length > 0 ? body : "{}",
      });
      return relay(run.runner, response);
    } catch {
      return error(502, "the runner with that run did not answer");
    }
  }

  if (
    method === "GET" &&
    parts[0] === "v1" &&
    parts[1] === "runs" &&
    parts.length >= 3 &&
    parts.length <= 4
  ) {
    if (parts.length === 4 && parts[3] !== "logs") return error(404, "no such route");
    const run = parseRunId(third, deps.pool);
    if (!run) return error(404, "no such run");
    const tail = parts.length === 4 ? "/logs" : "";
    try {
      const response = await deps.pool.call(run.runner, `/v1/runs/${run.id}${tail}${url.search}`);
      return relay(run.runner, response);
    } catch {
      return error(502, "the runner with that run did not answer");
    }
  }

  if (
    method === "GET" &&
    parts[0] === "v1" &&
    (parts[1] === "storage" || parts[1] === "usage") &&
    parts.length === 3
  ) {
    const response = await deps.pool.any(`${path}${url.search}`);
    return response
      ? new Response(response.body, { status: response.status, headers: response.headers })
      : error(503, "no runner answered");
  }

  if (method === "DELETE" && parts[0] === "v1" && parts[1] === "storage" && parts.length === 4) {
    // The store is shared, so any runner clears it for all of them.
    if (!isId(third) || !isId(fourth)) {
      return error(400, "the owner and repository id must match [A-Za-z0-9._-]{1,128}");
    }
    const response = await deps.pool.any(path, { method: "DELETE" });
    return response
      ? new Response(response.body, { status: response.status, headers: response.headers })
      : error(503, "no runner answered");
  }

  if (method === "PUT" && path === "/v1/schedules") {
    const body = await readBody(request);
    if (body instanceof Response) return body;
    if (typeof body.value.repo !== "string") return error(400, "`repo` is required");
    if ("token" in body.value) {
      return error(
        400,
        "schedules do not store tokens; private repositories use the runners' IWCI_GIT_TOKEN",
      );
    }
    const read = await readSchedules(deps, body.value);
    if ("status" in read) return error(read.status, read.message);
    const quota = body.value["storage-quota"];
    const row: ScheduleRow = {
      owner: read.reply.owner,
      repoId: read.reply["repo-id"],
      repo: body.value.repo,
      branch: read.reply.branch,
      storageQuota: typeof quota === "number" ? quota : null,
      pipelines: read.reply.pipelines,
      commit: read.reply.commit,
      error: read.reply.problems.length > 0 ? read.reply.problems.join("; ") : null,
      refreshedAt: deps.now(),
      registeredAt: deps.now(),
    };
    await deps.store.put(row);
    return json(201, summary(row));
  }

  if (method === "GET" && parts[0] === "v1" && parts[1] === "schedules" && parts.length === 3) {
    return json(200, { owner: third, schedules: (await deps.store.forOwner(third)).map(summary) });
  }

  if (method === "DELETE" && parts[0] === "v1" && parts[1] === "schedules" && parts.length === 4) {
    const removed = await deps.store.remove(third, fourth);
    return removed ? json(200, { deleted: `${third}/${fourth}` }) : error(404, "no such schedule");
  }

  if (path === "/v1/runners") {
    if (method === "GET") {
      return json(200, { runners: await deps.runnerList.list() });
    }
    if (method !== "PUT") return error(405, "read with GET, replace with PUT");
    const body = await readBody(request);
    if (body instanceof Response) return body;
    const list = body.value.runners;
    if (!Array.isArray(list) || list.length > MAX_RUNNERS) {
      return error(400, `the body is { "runners": [{ "name", "url" }] }, up to ${MAX_RUNNERS}`);
    }
    const runners: RunnerEntry[] = [];
    for (const entry of list as unknown[]) {
      const e = entry as { name?: unknown; url?: unknown };
      if (typeof e.name !== "string" || !isRunnerName(e.name)) {
        return error(400, "runner names are lowercase letters, digits and `-`, up to 40");
      }
      if (typeof e.url !== "string" || !isRunnerUrl(e.url)) {
        return error(400, `runner ${e.name}: the url is an http(s) base URL without a path`);
      }
      if (runners.some((r) => r.name === e.name))
        return error(400, `runner ${e.name} is listed twice`);
      runners.push({ name: e.name, url: e.url.replace(/\/+$/, "") });
    }
    await deps.runnerList.replace(runners, deps.now());
    return json(200, { runners });
  }

  if (parts[0] === "v1" && parts[1] === "orgs") {
    return values(request, deps, parts.slice(2));
  }

  return error(404, `no route ${method} ${path}`);
}

/**
 * A run request with the owner's and repository's variables and, unless it
 * is a pull request the caller has not vouched for (`"trusted": true`: from
 * the repository itself, not a fork), their secrets. Values the request
 * carries itself win. An untrusted run's `lent` (connections, SSH keys and
 * resource outputs the app lends its jobs) is dropped. The runner trusts
 * anything but a pull request on its own, so `trusted` goes on only for a
 * vouched-for pull request, which is then lent what the request carries.
 */
async function withStoredValues(
  deps: Deps,
  body: Record<string, unknown>,
): Promise<Record<string, unknown> | Response> {
  const { trusted, ...rest } = body;
  const event = typeof rest.event === "string" ? rest.event : "push";
  const withSecrets = event !== "pull-request" || trusted === true;
  if (!withSecrets) delete rest.lent;
  if (event === "pull-request" && trusted === true) rest.trusted = true;
  const { owner, repoId } = identify(rest);
  if (!isId(owner) || !isId(repoId)) return rest;
  const stored = await forRun(deps.values, deps.secretsKey, owner, repoId, withSecrets);
  if (stored.unreadable.length > 0) {
    // A run that silently got an empty deploy token would be worse than
    // one that does not start.
    return error(
      500,
      `secrets ${stored.unreadable.join(", ")} could not be decrypted; was SECRETS_KEY changed? Set them again.`,
    );
  }
  const own = (key: string): Record<string, string> => {
    const value = rest[key];
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter((e): e is [string, string] => typeof e[1] === "string"),
    );
  };
  const vars = { ...stored.vars, ...own("vars") };
  const secrets = { ...stored.secrets, ...own("secrets") };
  if (Object.keys(vars).length > 0) rest.vars = vars;
  if (Object.keys(secrets).length > 0) rest.secrets = secrets;
  return rest;
}

/** `/v1/orgs/{owner}[/repos/{repo-id}]/{secrets|vars}[/{name}]`. */
async function values(request: Request, deps: Deps, parts: string[]): Promise<Response> {
  const [owner = "", ...rest] = parts;
  let repoId = "";
  let tail = rest;
  if (rest[0] === "repos") {
    repoId = rest[1] ?? "";
    tail = rest.slice(2);
    if (!isId(repoId)) return error(400, "the repository id must match [A-Za-z0-9._-]{1,128}");
  }
  if (!isId(owner)) return error(400, "the owner must match [A-Za-z0-9._-]{1,128}");
  const [plural = "", name, extra] = tail;
  const kind: Kind | null = plural === "secrets" ? "secret" : plural === "vars" ? "var" : null;
  if (kind === null || extra !== undefined) return error(404, "no such route");
  const scope = { owner, ...(repoId ? { "repo-id": repoId } : {}) };
  const method = request.method;

  if (name === undefined) {
    if (method !== "GET") return error(405, "list with GET; set or remove one by name");
    const listed = await deps.values.list(kind, owner, repoId);
    return json(200, {
      ...scope,
      [plural]: listed.map((v) =>
        kind === "var"
          ? { name: v.name, value: v.value, "updated-at": v.updatedAt }
          : { name: v.name, "updated-at": v.updatedAt },
      ),
    });
  }
  if (!isName(name)) {
    return error(400, "names are letters, digits and `_`, not starting with a digit, up to 128");
  }
  if (method === "DELETE") {
    return (await deps.values.remove(kind, owner, repoId, name))
      ? json(200, { ...scope, deleted: name })
      : error(404, `no ${kind} named ${name}`);
  }
  if (method !== "PUT") return error(405, "set with PUT, remove with DELETE");
  if (kind === "secret" && deps.secretsKey === null) {
    return error(
      503,
      "set SECRETS_KEY (32 random bytes, base64) on the proxy before storing secrets",
    );
  }
  const body = await readBody(request);
  if (body instanceof Response) return body;
  const value = body.value.value;
  if (typeof value !== "string") return error(400, 'the body is { "value": "..." }');
  if (new TextEncoder().encode(value).length > MAX_VALUE_BYTES || value.includes("\0")) {
    return error(400, `the value is over ${MAX_VALUE_BYTES >> 10} KiB or contains a NUL byte`);
  }
  const stored =
    kind === "secret" && deps.secretsKey !== null
      ? await seal(deps.secretsKey, owner, repoId, name, value)
      : value;
  if (!(await deps.values.put(kind, owner, repoId, name, stored, deps.now()))) {
    return error(409, `this scope already has ${MAX_PER_SCOPE} ${plural}`);
  }
  return json(200, { ...scope, name, "updated-at": deps.now() });
}

/** How far back a scheduled run is looked for as still holding its group. */
const GROUP_LOOKBACK_SECS = 6 * 3600;

/** A scheduled pipeline's concurrency group, lowercased (groups ignore case), or null. */
function groupOf(pipeline: ScheduledPipeline): string | null {
  const group = pipeline.concurrency?.group;
  return typeof group === "string" && group.length > 0 ? group.toLowerCase() : null;
}

/**
 * Frees `group` for a scheduled pipeline about to fire, among the proxy's own
 * scheduled runs of the repository (the app's runs are the app's to order):
 * a run of the group still going is cancelled when the pipeline says
 * `cancel-in-progress`, and otherwise this fire is skipped, as a full pool's
 * is, rather than queued. Returns the skip's outcome, or null to fire.
 */
async function makeRoom(
  deps: Deps,
  row: ScheduleRow,
  pipeline: ScheduledPipeline,
  group: string,
  minute: number,
): Promise<string | null> {
  const files = row.pipelines.filter((p) => groupOf(p) === group).map((p) => p.file);
  const started = await deps.store.startedFires(
    row.owner,
    row.repoId,
    files,
    minute - GROUP_LOOKBACK_SECS,
    5,
  );
  for (const fire of started) {
    const run = parseRunId(fire.runId, deps.pool);
    if (!run) continue;
    let state: unknown;
    try {
      const response = await deps.pool.call(
        run.runner,
        `/v1/runs/${run.id}?owner=${encodeURIComponent(row.owner)}`,
      );
      state = response.ok ? ((await response.json()) as { state?: unknown }).state : null;
    } catch {
      // A runner that does not answer has no run to wait for.
      state = null;
    }
    if (state !== "running") continue;
    if (pipeline.concurrency?.["cancel-in-progress"] !== true) {
      return `concurrency: waiting for ${fire.runId} in group ${group}`;
    }
    try {
      const response = await deps.pool.call(run.runner, `/v1/runs/${run.id}/cancel`, {
        method: "POST",
        body: "{}",
      });
      await response.body?.cancel();
    } catch {
      // Its runner went away, and the run with it.
    }
  }
  return null;
}

export interface TickResult {
  started: string[];
  skipped: string[];
  refreshed: number;
}

/**
 * Fires every scheduled pipeline due in the minute starting at
 * `minuteStart` (Unix seconds). Refreshes stale schedules first, a few per
 * tick. A pipeline is claimed for its minute before it is sent, so a
 * repeated tick for the same minute fires nothing twice; one that finds
 * every runner full is recorded as skipped, not retried.
 */
export async function tick(deps: Deps, minuteStart: number): Promise<TickResult> {
  const minute = Math.floor(minuteStart / 60) * 60;
  const date = new Date(minute * 1000);
  const result: TickResult = { started: [], skipped: [], refreshed: 0 };
  const rows = await deps.store.all();

  for (const row of rows) {
    if (result.refreshed >= REFRESHES_PER_TICK || row.refreshedAt + REFRESH_SECS > deps.now())
      continue;
    result.refreshed++;
    const read = await readSchedules(deps, {
      repo: row.repo,
      branch: row.branch,
      owner: row.owner,
      "repo-id": row.repoId,
    });
    if ("status" in read) {
      // Keep the last good pipelines; a runner outage should not stop
      // schedules that were read before it.
      row.error = read.message;
    } else {
      row.pipelines = read.reply.pipelines;
      row.commit = read.reply.commit;
      row.error = read.reply.problems.length > 0 ? read.reply.problems.join("; ") : null;
    }
    row.refreshedAt = deps.now();
    await deps.store.put(row);
  }

  const fires = rows.flatMap((row) =>
    row.pipelines.filter((p) => ciCronDue(p.cron, date)).map((pipeline) => ({ row, pipeline })),
  );
  // One fire per concurrency group of a repository in a minute: the last in
  // file order, as the newest of runs queued together would be.
  const lastOfGroup = new Map<string, number>();
  fires.forEach(({ row, pipeline }, i) => {
    const group = groupOf(pipeline);
    if (group !== null) lastOfGroup.set(`${row.owner}/${row.repoId}/${group}`, i);
  });
  await Promise.all(
    fires.map(async ({ row, pipeline }, i) => {
      const label = `${row.owner}/${row.repoId}/${pipeline.file}`;
      if (!(await deps.store.claimFire(row.owner, row.repoId, pipeline.file, minute))) return;
      const group = groupOf(pipeline);
      if (group !== null) {
        const outcome =
          lastOfGroup.get(`${row.owner}/${row.repoId}/${group}`) !== i
            ? `concurrency: a later pipeline of group ${group} fired this minute`
            : await makeRoom(deps, row, pipeline, group, minute);
        if (outcome !== null) {
          result.skipped.push(label);
          await deps.store.settleFire(row.owner, row.repoId, pipeline.file, minute, null, outcome);
          return;
        }
      }
      const request: Record<string, unknown> = {
        repo: row.repo,
        branch: row.branch,
        event: "schedule",
        owner: row.owner,
        "repo-id": row.repoId,
        "default-branch": row.branch,
        pipeline: pipeline.text,
      };
      if (row.storageQuota !== null) request["storage-quota"] = row.storageQuota;
      const withValues = await withStoredValues(deps, request);
      if (withValues instanceof Response) {
        result.skipped.push(label);
        const body = (await withValues.json().catch(() => ({}))) as { error?: string };
        await deps.store.settleFire(
          row.owner,
          row.repoId,
          pipeline.file,
          minute,
          null,
          `error: ${body.error ?? "secrets"}`,
        );
        return;
      }
      // Placed like a run the app sends, on a runner with the virtual
      // machines the pipeline's jobs run in.
      const placed = await placeRun(deps, "", withValues, schedulePlatforms(pipeline));
      if (!placed) {
        result.skipped.push(label);
        await deps.store.settleFire(
          row.owner,
          row.repoId,
          pipeline.file,
          minute,
          null,
          "no-capacity",
        );
        return;
      }
      const body = (await placed.response.json().catch(() => ({}))) as {
        id?: string;
        error?: string;
      };
      if (placed.response.ok && typeof body.id === "string") {
        const id = `${placed.runner}.${body.id}`;
        result.started.push(label);
        await deps.store.settleFire(row.owner, row.repoId, pipeline.file, minute, id, "started");
      } else {
        result.skipped.push(label);
        await deps.store.settleFire(
          row.owner,
          row.repoId,
          pipeline.file,
          minute,
          null,
          `error: ${body.error ?? placed.response.status}`,
        );
      }
    }),
  );
  return result;
}
