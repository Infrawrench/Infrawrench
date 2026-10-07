import type { HttpHostServices } from "@infrawrench/plugin-base";
import { jsonRestFetch } from "@infrawrench/plugin-base";

/**
 * Everything an Axiom request needs. Management calls go to
 * `https://api.axiom.co` (`/v1` and `/v2`); queries go to the edge
 * deployment the dataset lives in (`https://<edge>/v1/query/_apl`), which
 * only accepts API tokens, so a personal access token queries through the
 * older `api.axiom.co/v1/datasets/_apl` route instead.
 *
 * Auth is `Authorization: Bearer <token>`. A personal access token (`xapt-`)
 * also needs `x-axiom-org-id`; an API token (`xaat-`) is already org-scoped.
 * Axiom answers a bad token with 403, not 401.
 */
export interface AxiomContext {
  token: string;
  orgId?: string;
  caCert?: string;
  http?: HttpHostServices;
}

export const API_URL = "https://api.axiom.co";

/** Known edge deployments (base domains for ingest and query). */
export const EDGE_DEPLOYMENTS: Record<string, { label: string; host: string }> = {
  "cloud.us-east-1.aws": { label: "US East 1 (AWS)", host: "us-east-1.aws.edge.axiom.co" },
  "cloud.eu-central-1.aws": { label: "EU Central 1 (AWS)", host: "eu-central-1.aws.edge.axiom.co" },
};

/** Thrown for any non-2xx answer, carrying the status the callers branch on. */
export class AxiomApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "AxiomApiError";
    this.status = status;
  }
}

const STATUS_IN_MESSAGE = /Axiom API error (\d{3})/;

type Query = Record<string, string | number | boolean | undefined>;

export function isPersonalToken(token: string): boolean {
  return token.startsWith("xapt-");
}

function axiomMessage(raw: string, path: string): string {
  const prefix = `for ${path}: `;
  const i = raw.indexOf(prefix);
  const body = i >= 0 ? raw.slice(i + prefix.length) : raw;
  try {
    const parsed = JSON.parse(body) as { message?: string; error?: string; code?: number };
    return parsed.message ?? parsed.error ?? body;
  } catch {
    return body;
  }
}

/** JSON request against `api.axiom.co` (or another base, for edge queries). */
export async function axFetch<T>(
  ctx: AxiomContext,
  path: string,
  init?: RequestInit & { query?: Query; baseUrl?: string },
): Promise<T> {
  const { query, baseUrl, ...rest } = init ?? {};
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== "") params.set(k, String(v));
  }
  const qs = params.toString();
  const sep = path.includes("?") ? "&" : "?";
  try {
    return await jsonRestFetch<T>({
      vendor: "Axiom",
      url: `${baseUrl ?? API_URL}${path}${qs ? `${sep}${qs}` : ""}`,
      errorPath: path,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${ctx.token}`,
        ...(ctx.orgId ? { "x-axiom-org-id": ctx.orgId } : {}),
      },
      ...(Object.keys(rest).length > 0 ? { init: rest } : {}),
      ...(ctx.caCert ? { caCert: ctx.caCert } : {}),
      ...(ctx.http ? { http: ctx.http } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = Number(STATUS_IN_MESSAGE.exec(message)?.[1] ?? 0);
    if (status) {
      throw new AxiomApiError(
        status,
        `Axiom API error ${status} for ${path}: ${axiomMessage(message, path)}`,
      );
    }
    throw err;
  }
}

/** HTTP status of a failed call, or 0 for a transport error. */
export function statusOf(err: unknown): number {
  return err instanceof AxiomApiError ? err.status : 0;
}

/** Run `fn` over `items` with at most `limit` in flight, keeping order. */
export async function mapPooled<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return out;
}
