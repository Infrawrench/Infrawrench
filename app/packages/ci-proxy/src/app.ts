// Routes and the per-minute scheduler, written against small interfaces
// (`Pool`, `ScheduleStore`) so tests drive them without Cloudflare.
//
// | Route | Does |
// |-------|------|
// | `GET /healthz` | `200 ok`, unauthenticated |
// | `GET`, `PUT /v1/runners` | the runners runs go to (`{ "runners": [{ "name", "url" }] }`, replaced whole) |
// | `GET /v1/capacity` | every runner's slots, and the pool's total |
// | `POST /v1/runs[?wait=true]` | runs a request on the runner with the most free slots |
// | `GET /v1/runs/{id}` and `/v1/runs/{id}/logs` | from the runner that has the run; logs stream through |
// | `POST /v1/prepare` | warms a runner for a request |
// | `GET /v1/storage/{owner}`, `GET /v1/usage/{owner}` | from any runner (they share the store) |
// | `DELETE /v1/storage/{owner}/{repo-id}` | clears a repository's caches, on any runner |
// | `PUT /v1/schedules` | registers a repository's `on.schedule` pipelines |
// | `GET /v1/schedules/{owner}` | an owner's registered schedules |
// | `DELETE /v1/schedules/{owner}/{repo-id}` | stops a repository's scheduled runs |
// | `GET /v1/orgs/{owner}[/repos/{repo-id}]/secrets` | secret names and when each was set |
// | `PUT`, `DELETE /v1/orgs/{owner}[/repos/{repo-id}]/secrets/{name}` | sets (`{ "value": ... }`) or removes one |
// | `GET`, `PUT`, `DELETE` the same under `/vars` | variables, values included |

import { authorised } from "./auth";
import { anyDue } from "./cron";
import { identify, isId } from "./identity";
import { isRunnerName, isRunnerUrl, parseRunId, type Pool, type RunnerEntry } from "./pool";
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

export async function handle(request: Request, deps: Deps): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");
  const parts = path.split("/").filter((p) => p.length > 0);
  const [, , third = "", fourth = ""] = parts;
  const method = request.method;

  if (method === "GET" && path === "/healthz") return new Response("ok");
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
    if (path === "/v1/runs") {
      const withValues = await withStoredValues(deps, body.value);
      if (withValues instanceof Response) return withValues;
      text = JSON.stringify(withValues);
    } else if ("trusted" in body.value) {
      const { trusted: _, ...rest } = body.value;
      text = JSON.stringify(rest);
    }
    const placed = await deps.pool.place(`${path}${url.search}`, text);
    if (!placed) return full();
    return relay(placed.runner, placed.response);
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
 * carries itself win. `trusted` is the proxy's and is not passed on.
 */
async function withStoredValues(
  deps: Deps,
  body: Record<string, unknown>,
): Promise<Record<string, unknown> | Response> {
  const { trusted, ...rest } = body;
  const { owner, repoId } = identify(rest);
  if (!isId(owner) || !isId(repoId)) return rest;
  const event = typeof rest.event === "string" ? rest.event : "push";
  const withSecrets = event !== "pull-request" || trusted === true;
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
    row.pipelines.filter((p) => anyDue(p.cron, date)).map((pipeline) => ({ row, pipeline })),
  );
  await Promise.all(
    fires.map(async ({ row, pipeline }) => {
      const label = `${row.owner}/${row.repoId}/${pipeline.file}`;
      if (!(await deps.store.claimFire(row.owner, row.repoId, pipeline.file, minute))) return;
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
      const placed = await deps.pool.place("/v1/runs", JSON.stringify(withValues));
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
