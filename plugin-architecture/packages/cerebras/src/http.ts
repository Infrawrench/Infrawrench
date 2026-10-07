/**
 * HTTP helpers for the Cerebras plugin.
 *
 * - `https://api.cerebras.ai/v1/…`: inference API (models, chat, batches,
 *   files) with the regular API key.
 * - `https://api.cerebras.ai/public/v1/models`: unauthenticated catalogue
 *   with pricing, limits and capabilities.
 * - `https://api.cerebras.ai/management/v1/…`: Dedicated Inference
 *   management API (Private Preview) with a separate management key.
 * - `https://cloud.cerebras.ai/api/v1/metrics/organizations/{org}`:
 *   Prometheus text for dedicated endpoints, regular API key.
 *
 * Everything goes through plugin-base's `jsonRestFetch` (host HTTP service
 * first, so bastions, custom CAs and desktop CORS work) and errors are
 * re-thrown with a numeric `status`.
 */
import type { HttpHostServices } from "@infrawrench/plugin-base";
import { jsonRestFetch } from "@infrawrench/plugin-base";

export const API_BASE = "https://api.cerebras.ai";
export const METRICS_BASE = "https://cloud.cerebras.ai/api/v1/metrics/organizations";

export interface CerebrasContext {
  caCert?: string;
  http?: HttpHostServices;
}

export type StatusError = Error & { status: number };

export function statusOf(err: unknown): number | undefined {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : undefined;
}

/** JSON request; `token` empty sends no Authorization header (public routes). */
export async function cerebrasFetch<T>(
  ctx: CerebrasContext,
  token: string,
  url: string,
  init?: RequestInit,
): Promise<T> {
  try {
    return await jsonRestFetch<T>({
      vendor: "Cerebras",
      url,
      errorPath: new URL(url).pathname,
      headers: {
        Accept: "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(init ? { init } : {}),
      ...(ctx.caCert ? { caCert: ctx.caCert } : {}),
      ...(ctx.http ? { http: ctx.http } : {}),
    });
  } catch (err) {
    throw withStatus(err);
  }
}

/** Plain-text GET (the Prometheus metrics route). */
export async function cerebrasText(
  ctx: CerebrasContext,
  token: string,
  url: string,
): Promise<string> {
  const headers = { Authorization: `Bearer ${token}`, Accept: "text/plain" };
  if (ctx.http) {
    const res = await ctx.http.request({
      url,
      method: "GET",
      headers,
      ...(ctx.caCert ? { caCert: ctx.caCert } : {}),
    });
    if (res.status < 200 || res.status >= 300) {
      throw Object.assign(
        new Error(
          `Cerebras API error ${res.status} for ${new URL(url).pathname}: ${res.body.slice(0, 300)}`,
        ),
        { status: res.status },
      );
    }
    return res.body;
  }
  const res = await fetch(url, { headers });
  const body = await res.text();
  if (!res.ok) {
    throw Object.assign(
      new Error(
        `Cerebras API error ${res.status} for ${new URL(url).pathname}: ${body.slice(0, 300)}`,
      ),
      { status: res.status },
    );
  }
  return body;
}

function withStatus(err: unknown): unknown {
  if (!(err instanceof Error)) return err;
  const match = /API error (\d{3})\b/.exec(err.message);
  if (!match) return err;
  const status = Number(match[1]);
  const hint =
    status === 401
      ? " Check the API key in the Cerebras Cloud console under API Keys."
      : status === 403
        ? " This feature is in Private Preview or not enabled for your organization."
        : "";
  return Object.assign(new Error(`${err.message}${hint}`), { status });
}

export const enc = encodeURIComponent;
