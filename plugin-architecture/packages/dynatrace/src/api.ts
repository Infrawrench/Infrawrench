import type { HttpHostServices } from "@infrawrench/plugin-base";
import { jsonRestFetch } from "@infrawrench/plugin-base";

/**
 * Everything a Dynatrace request needs. Split out of the client so the cost
 * collector, the DQL runner and the preflight probe can be tested without one.
 */
export interface DynatraceContext {
  /** Environment API base, e.g. `https://abc12345.live.dynatrace.com` or `https://host/e/<env>`. */
  envUrl: string;
  /** Platform (Grail) base, e.g. `https://abc12345.apps.dynatrace.com`. Empty for Managed. */
  platformUrl: string;
  /** The environment id: the first label of a SaaS host, the `/e/<id>` segment on Managed. */
  environmentId: string;
  /** Classic access token (`dt0c01.…`). */
  apiToken: string;
  /** Optional platform token (`dt0s16.…`) for Grail / DQL. */
  platformToken: string;
  caCert?: string;
  http?: HttpHostServices;
}

/** Thrown for any non-2xx answer, carrying the status callers branch on. */
export class DynatraceApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "DynatraceApiError";
    this.status = status;
  }
}

const STATUS_IN_MESSAGE = /Dynatrace(?: [A-Za-z]+)* API error (\d{3})/;

export type Query = Record<string, string | number | boolean | undefined>;

export function withQuery(url: string, query: Query | undefined): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== "") params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${url}${url.includes("?") ? "&" : "?"}${qs}` : url;
}

/**
 * Normalise whatever the user pasted into the two bases the plugin needs.
 *
 * - `https://abc12345.live.dynatrace.com` (SaaS environment) stays as is; the
 *   platform base is the same host on `apps.dynatrace.com`.
 * - `https://abc12345.apps.dynatrace.com` (the new UI's address, which is what
 *   most people copy from the browser) is turned around the other way.
 * - Sprint and dev hosts (`<id>.sprint.dynatracelabs.com`) put `apps` after
 *   the stage label.
 * - Anything else is a Managed cluster or an Environment ActiveGate
 *   (`https://host/e/<env-id>` or `https://host:9999/e/<env-id>`): no Grail.
 */
export function resolveUrls(raw: string): {
  envUrl: string;
  platformUrl: string;
  environmentId: string;
} {
  let input = raw.trim();
  if (!input) return { envUrl: "", platformUrl: "", environmentId: "" };
  if (!/^https?:\/\//i.test(input)) input = `https://${input}`;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { envUrl: input.replace(/\/+$/, ""), platformUrl: "", environmentId: "" };
  }
  const managed = /\/e\/([^/]+)/.exec(url.pathname);
  if (managed?.[1]) {
    return {
      envUrl: `${url.origin}/e/${managed[1]}`,
      platformUrl: "",
      environmentId: managed[1],
    };
  }
  const host = url.hostname.toLowerCase();
  // Production: <id>.live.dynatrace.com / <id>.apps.dynatrace.com.
  // Sprint and dev: <id>.sprint.dynatracelabs.com / <id>.sprint.apps.dynatracelabs.com.
  const prod = /^([a-z0-9-]+)\.(?:live|apps)\.dynatrace\.com$/.exec(host);
  if (prod?.[1]) {
    return {
      envUrl: `https://${prod[1]}.live.dynatrace.com`,
      platformUrl: `https://${prod[1]}.apps.dynatrace.com`,
      environmentId: prod[1],
    };
  }
  const labs = /^([a-z0-9-]+)\.(sprint|dev)\.(?:apps\.)?dynatracelabs\.com$/.exec(host);
  if (labs?.[1] && labs[2]) {
    return {
      envUrl: `https://${labs[1]}.${labs[2]}.dynatracelabs.com`,
      platformUrl: `https://${labs[1]}.${labs[2]}.apps.dynatracelabs.com`,
      environmentId: labs[1],
    };
  }
  return { envUrl: url.origin, platformUrl: "", environmentId: host.split(".")[0] ?? "" };
}

async function call<T>(
  vendor: string,
  url: string,
  authorization: string,
  init: (RequestInit & { query?: Query }) | undefined,
  ctx: { caCert?: string; http?: HttpHostServices },
  errorPath: string,
): Promise<T> {
  const { query, ...rest } = init ?? {};
  try {
    return await jsonRestFetch<T>({
      vendor,
      url: withQuery(url, query),
      errorPath,
      headers: { Accept: "application/json", Authorization: authorization },
      ...(Object.keys(rest).length > 0 ? { init: rest } : {}),
      ...(ctx.caCert ? { caCert: ctx.caCert } : {}),
      ...(ctx.http ? { http: ctx.http } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = Number(STATUS_IN_MESSAGE.exec(message)?.[1] ?? 0);
    if (status) throw new DynatraceApiError(status, friendly(status, message));
    throw err;
  }
}

/** Dynatrace error bodies are `{ error: { code, message, constraintViolations } }`. */
function friendly(status: number, message: string): string {
  const body = message.slice(message.indexOf(": ") + 2);
  try {
    const parsed = JSON.parse(body) as {
      error?: {
        message?: string;
        constraintViolations?: Array<{ path?: string; message?: string }>;
      };
    };
    const detail = parsed.error?.message;
    const violations = (parsed.error?.constraintViolations ?? [])
      .map((v) => [v.path, v.message].filter(Boolean).join(": "))
      .filter(Boolean);
    if (detail) {
      return `Dynatrace API error ${status}: ${detail}${violations.length ? ` (${violations.join("; ")})` : ""}`;
    }
  } catch {
    // Not JSON: keep the raw message.
  }
  return message;
}

/** A call against the Environment API (`/api/v1`, `/api/v2`) with the access token. */
export function envFetch<T>(
  ctx: DynatraceContext,
  path: string,
  init?: RequestInit & { query?: Query },
): Promise<T> {
  return call<T>("Dynatrace", `${ctx.envUrl}${path}`, `Api-Token ${ctx.apiToken}`, init, ctx, path);
}

/** A call against a platform service (`/platform/...`) with the platform token. */
export function platformFetch<T>(
  ctx: DynatraceContext,
  path: string,
  init?: RequestInit & { query?: Query },
): Promise<T> {
  if (!ctx.platformUrl) {
    throw new DynatraceApiError(
      400,
      "This environment has no Dynatrace platform (Grail) address. DQL needs a SaaS environment.",
    );
  }
  if (!ctx.platformToken) {
    throw new DynatraceApiError(
      401,
      "Add a platform token to this account (Edit credentials) to run DQL against Grail.",
    );
  }
  return call<T>(
    "Dynatrace platform",
    `${ctx.platformUrl}${path}`,
    `Bearer ${ctx.platformToken}`,
    init,
    ctx,
    path,
  );
}

/** HTTP status of a failed call, or 0 for a transport error. */
export function statusOf(err: unknown): number {
  if (err instanceof DynatraceApiError) return err.status;
  if (err && typeof err === "object" && "status" in err) {
    const s = (err as { status?: unknown }).status;
    if (typeof s === "number") return s;
  }
  return 0;
}

const MAX_PAGES = 20;

/**
 * Walk a `nextPageKey` list. Dynatrace rejects any other query parameter
 * alongside `nextPageKey` (the key already encodes the original query), so
 * follow-up pages send the key and nothing else.
 */
export async function pagedList<T>(
  ctx: DynatraceContext,
  path: string,
  itemsKey: string,
  query: Query,
  maxPages = MAX_PAGES,
): Promise<T[]> {
  const out: T[] = [];
  let next: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const res = await envFetch<Record<string, unknown>>(ctx, path, {
      query: next ? { nextPageKey: next } : query,
    });
    const items = res?.[itemsKey];
    if (Array.isArray(items)) out.push(...(items as T[]));
    next = typeof res?.["nextPageKey"] === "string" ? (res["nextPageKey"] as string) : undefined;
    if (!next) break;
  }
  return out;
}
