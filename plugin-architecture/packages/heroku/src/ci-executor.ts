/**
 * CI jobs on Heroku: a one-off dyno on a throwaway app per job.
 *
 * A dyno needs an app with a release, so each job gets an app of its own
 * (`iwci-<key>`), a slug holding only the job's script, a release of that
 * slug, and one detached one-off dyno that runs it. Teardown deletes the app,
 * which takes the slug, the release and any dyno with it.
 *
 * **Wire shapes verified against the Platform API reference and its JSON
 * schema (`GET https://api.heroku.com/schema`), and the Dev Center articles
 * "Creating Slugs from Scratch", "One-Off Dynos", "Limits", "Dyno Types" and
 * "Account Verification", November 2026:**
 * - `POST /apps` (`name`, `region`, `stack`) and `POST /teams/apps` (`name`,
 *   `team`, `region`, `stack`) for a team's app. Names match
 *   `^[a-z][a-z0-9-]{1,28}[a-z0-9]$` in one namespace for everyone; there
 *   are no tags, so the name is the mark and the tags ride in a config var.
 * - `PATCH /apps/{app}/config-vars` with a plain object.
 * - `POST /apps/{app}/slugs` (`process_types` required, `stack`), answered
 *   with `blob.{method, url}`; the gzipped tar of `./app/` is `PUT` there
 *   with no `Content-Type`. `POST /apps/{app}/releases` with the slug id;
 *   release `status` is `pending`, `succeeded`, `failed` or `expired`.
 * - `POST /apps/{app}/dynos` (`command`, `type: "run"`, `size`,
 *   `time_to_live`: "seconds until dyno expires, after which it will soon
 *   be killed, max 86400"). `GET /apps/{app}/dynos[/{id}]` reads `state`
 *   (`crashed`, `down`, `idle`, `starting`, `up`). A one-off dyno never
 *   restarts.
 * - `DELETE /apps/{app}`; `GET /account` (`verified`).
 *
 * The backstop is the dyno's `time_to_live`: a detached one-off dyno has no
 * time limit of its own. Nothing secret is set on the app: its only config
 * var is the tags, and a dyno gets no Heroku credential.
 */
import {
  CI_JOB_TAG,
  ciComputeKey,
  type CiComputeStatus,
  type CiExecutorDeclaration,
  type CiExecutorKind,
  type CiHandle,
  type CiPreflightResult,
  type CiStartSpec,
  type CiTaggedCompute,
  type HostServices,
} from "@infrawrench/plugin-base";
import type { HerokuApi } from "./api.js";
import { slugArchive } from "./ci-slug.js";
import { HerokuApiError, enc } from "./kit.js";

export const CI_DEFAULT_SIZE = "standard-1X";
export const CI_DEFAULT_STACK = "heroku-24";
export const CI_DEFAULT_REGION = "us";
/** The config var that keeps the tags as sent. It is not secret. */
export const CI_TAGS_VAR = "INFRAWRENCH_CI_TAGS";
const APP_PREFIX = "iwci-";
/** The job's script in the slug, run from `/app`. */
const SCRIPT = "iwci-job.sh";
/** Heroku's largest `time_to_live`. */
const MAX_TTL = 86_400;

export const HEROKU_CI_EXECUTOR = {
  kinds: [
    {
      kind: "container",
      label: "One-off dyno on a throwaway app",
      defaults: { machine: CI_DEFAULT_SIZE, image: CI_DEFAULT_STACK, region: CI_DEFAULT_REGION },
      // An app, a slug, a release and a dyno: a few calls, then a dyno boot.
      typicalStartSeconds: 20,
      machineSuggestions: [
        "basic",
        "standard-1X",
        "standard-2X",
        "performance-M",
        "performance-L",
        "performance-L-RAM",
        "performance-XL",
        "performance-2XL",
      ],
    },
  ],
  helpLink: {
    label: "Use a verified account's API key with the global scope",
    url: "https://devcenter.heroku.com/articles/account-verification",
  },
} as const satisfies CiExecutorDeclaration;

function requireKind(kind: CiExecutorKind): void {
  if (kind !== "container") {
    throw new Error(`Heroku runs CI jobs of kind \`container\` (a one-off dyno), not \`${kind}\`.`);
  }
}

/** The job's app name: 30 characters, the most Heroku allows. */
export function appName(spec: Pick<CiStartSpec, "tags" | "name">): string {
  return `${APP_PREFIX}${ciComputeKey(spec).slice(0, 25)}`;
}

function statusOf(err: unknown): number {
  return err instanceof HerokuApiError ? err.status : 0;
}

/** Context the executor needs beyond the transport. */
export interface HerokuCiContext {
  api: HerokuApi;
  /** The account's team, when it is limited to one: apps are made there. */
  team: string;
  services: HostServices | undefined;
}

interface HkCiApp {
  id?: string;
  name?: string;
  created_at?: string;
  region?: { name?: string };
}

interface HkCiDyno {
  id?: string;
  name?: string;
  state?: string;
  type?: string;
}

function handleOf(app: string, dyno: HkCiDyno, region: string): CiHandle {
  return {
    id: app,
    region,
    label: `heroku dyno ${dyno.name ?? "run"} on ${app}`,
    data: { app, ...(dyno.id ? { dyno: dyno.id } : {}) },
  };
}

function parseTags(raw: string | undefined): Record<string, string> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (e): e is [string, string] => typeof e[1] === "string",
      ),
    );
  } catch {
    return null;
  }
}

/** The dyno's command: the script from the slug, as the dyno's main process. */
export function dynoCommand(): string {
  return `sh /app/${SCRIPT}`;
}

/** The `POST /apps/{app}/dynos` body for a job. */
export function dynoBody(spec: CiStartSpec): Record<string, unknown> {
  return {
    command: dynoCommand(),
    type: "run",
    attach: false,
    size: spec.machine ?? CI_DEFAULT_SIZE,
    // The backstop: Heroku kills the dyno once the job's time is up.
    time_to_live: Math.min(MAX_TTL, Math.max(60, Math.ceil(spec.maxSeconds))),
  };
}

export async function herokuCiPreflight(
  ctx: HerokuCiContext,
  kind: CiExecutorKind,
  region?: string,
): Promise<CiPreflightResult> {
  requireKind(kind);
  const problems: string[] = [];
  // Heroku has no call that says what a key may do, so these are reads: the
  // account must be verified to create apps and run dynos, and listing apps
  // proves the key reaches them. A key made with a read scope fails at start.
  try {
    const account = await ctx.api.request<{ verified?: boolean }>("/account");
    if (account.verified === false) {
      problems.push(
        "This Heroku account is not verified, and Heroku only lets verified accounts create apps and run dynos. Add a payment method to the account.",
      );
    }
  } catch (err) {
    problems.push(
      statusOf(err) === 403
        ? "The API key cannot read its own account. Use a key with the global scope (the account's API key, or `heroku authorizations:create` with no scope)."
        : `Infrawrench could not read the Heroku account: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    await ctx.api.request(ctx.team ? `/teams/${enc(ctx.team)}/apps` : "/apps", {
      headers: { Range: "id ..; max=1;" },
    });
  } catch (err) {
    problems.push(
      `Infrawrench could not list this account's apps: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return {
    ok: problems.length === 0,
    missing: [],
    problems,
    region: region ?? CI_DEFAULT_REGION,
  };
}

/** The app, or null when there is none of that name the key can see. */
async function findApp(api: HerokuApi, name: string): Promise<HkCiApp | null> {
  try {
    return await api.request<HkCiApp>(`/apps/${enc(name)}`);
  } catch (err) {
    if (statusOf(err) === 404) return null;
    throw err;
  }
}

async function appTags(api: HerokuApi, name: string): Promise<Record<string, string> | null> {
  const vars = await api.request<Record<string, string | null>>(`/apps/${enc(name)}/config-vars`);
  return parseTags(vars?.[CI_TAGS_VAR] ?? undefined);
}

/** `PUT` the slug to the blob URL the API handed back, with no content type. */
async function uploadSlug(
  services: HostServices | undefined,
  url: string,
  bytes: Uint8Array,
): Promise<void> {
  const target = new URL(url);
  // Only ever an HTTPS object-store URL: the API's answer is not trusted further.
  if (target.protocol !== "https:" || !target.hostname.endsWith(".amazonaws.com")) {
    throw new Error(`Heroku handed back an unexpected slug upload URL (${target.hostname}).`);
  }
  const http = services?.http;
  const res = http
    ? await http.request({ url, method: "PUT", headers: {}, body: bytes })
    : await fetch(url, { method: "PUT", body: bytes as BodyInit }).then(async (r) => ({
        status: r.status,
        body: await r.text(),
      }));
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Uploading the job's slug failed with HTTP ${res.status}.`);
  }
}

async function waitForRelease(api: HerokuApi, app: string, id: string): Promise<void> {
  for (let i = 0; i < 30; i++) {
    const release = await api.request<{ status?: string }>(`/apps/${enc(app)}/releases/${enc(id)}`);
    if (release.status === "succeeded") return;
    if (release.status === "failed" || release.status === "expired") {
      throw new Error(`Heroku could not release the job's slug (${release.status}).`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("Heroku did not finish releasing the job's slug within 30 seconds.");
}

export async function herokuCiStart(ctx: HerokuCiContext, spec: CiStartSpec): Promise<CiHandle> {
  requireKind(spec.kind);
  if (spec.gpu) throw new Error("Heroku dynos have no GPUs.");
  const { api } = ctx;
  const name = appName(spec);
  const region = spec.region ?? CI_DEFAULT_REGION;
  const stack = spec.image ?? CI_DEFAULT_STACK;
  const body = dynoBody(spec);

  let app = await findApp(api, name);
  if (app) {
    // A retry after a lost answer: only ever this job's app.
    const tags = await appTags(api, name);
    if (!tags || tags[CI_JOB_TAG] !== spec.tags[CI_JOB_TAG]) {
      throw new Error(`A Heroku app named ${name} already exists and is not this CI job's.`);
    }
    const dynos = await api.request<HkCiDyno[]>(`/apps/${enc(name)}/dynos`);
    const running = (dynos ?? []).find((d) => d.type === "run");
    if (running) return handleOf(name, running, app.region?.name ?? region);
  } else {
    app = await api.request<HkCiApp>(ctx.team ? "/teams/apps" : "/apps", {
      method: "POST",
      body: ctx.team ? { name, team: ctx.team, region, stack } : { name, region, stack },
    });
    // Before anything runs, so the reaper can always tell whose app it is.
    await api.request(`/apps/${enc(name)}/config-vars`, {
      method: "PATCH",
      body: { [CI_TAGS_VAR]: JSON.stringify(spec.tags) },
    });
  }

  const slug = await api.request<{ id?: string; blob?: { method?: string; url?: string } }>(
    `/apps/${enc(name)}/slugs`,
    { method: "POST", body: { process_types: { ci: dynoCommand() }, stack } },
  );
  if (!slug.id || !slug.blob?.url) throw new Error("Heroku did not return a slug to upload.");
  await uploadSlug(ctx.services, slug.blob.url, await slugArchive(SCRIPT, spec.bootstrap));
  const release = await api.request<{ id?: string; status?: string }>(
    `/apps/${enc(name)}/releases`,
    { method: "POST", body: { slug: slug.id, description: "Infrawrench CI job" } },
  );
  if (release.id && release.status !== "succeeded") await waitForRelease(api, name, release.id);
  const dyno = await api.request<HkCiDyno>(`/apps/${enc(name)}/dynos`, {
    method: "POST",
    body,
  });
  return handleOf(name, dyno, app.region?.name ?? region);
}

export async function herokuCiStatus(
  ctx: HerokuCiContext,
  handle: CiHandle,
): Promise<CiComputeStatus> {
  const app = handle.data?.["app"] ?? handle.id;
  const dynoId = handle.data?.["dyno"];
  if (dynoId) {
    try {
      const dyno = await ctx.api.request<HkCiDyno>(`/apps/${enc(app)}/dynos/${enc(dynoId)}`);
      if (dyno.state === "starting") return { state: "starting" };
      if (dyno.state === "up") return { state: "running" };
      return { state: "stopped", detail: `The dyno is ${dyno.state ?? "down"}.` };
    } catch (err) {
      if (statusOf(err) !== 404) throw err;
    }
  }
  // A one-off dyno that ended is no longer listed; the app says whether
  // anything is left.
  return (await findApp(ctx.api, app))
    ? { state: "stopped", detail: "The dyno has exited." }
    : { state: "gone" };
}

export async function herokuCiTeardown(ctx: HerokuCiContext, handle: CiHandle): Promise<void> {
  const app = handle.data?.["app"] ?? handle.id;
  try {
    await ctx.api.request(`/apps/${enc(app)}`, { method: "DELETE" });
  } catch (err) {
    if (statusOf(err) !== 404) throw err;
  }
}

export async function herokuCiListTagged(
  ctx: HerokuCiContext,
  tagKey: string,
): Promise<CiTaggedCompute[]> {
  const apps = await ctx.api.listAll<HkCiApp>(ctx.team ? `/teams/${enc(ctx.team)}/apps` : "/apps");
  const out: CiTaggedCompute[] = [];
  for (const app of apps) {
    const name = app.name ?? "";
    if (!name.startsWith(APP_PREFIX)) continue;
    let tags: Record<string, string> | null;
    let dynos: HkCiDyno[];
    try {
      tags = await appTags(ctx.api, name);
      if (!tags || !(tagKey in tags)) continue;
      dynos = (await ctx.api.request<HkCiDyno[]>(`/apps/${enc(name)}/dynos`)) ?? [];
    } catch (err) {
      // Deleted between the list and the read.
      if (statusOf(err) === 404) continue;
      throw err;
    }
    const dyno = dynos.find((d) => d.type === "run") ?? {};
    out.push({
      handle: handleOf(name, dyno, app.region?.name ?? CI_DEFAULT_REGION),
      tags,
      ...(app.created_at ? { createdAt: app.created_at } : {}),
      live: dynos.length > 0,
    });
  }
  return out;
}
