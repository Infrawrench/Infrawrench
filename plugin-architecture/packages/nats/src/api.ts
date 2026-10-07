import type { HttpHostServices } from "@infrawrench/plugin-base";
import { utf8ToBase64 } from "@infrawrench/plugin-base";

/**
 * A nats-server's HTTP monitoring endpoint (`http_port`, 8222 by default):
 * `/varz`, `/connz`, `/routez`, `/gatewayz`, `/leafz`, `/subsz`,
 * `/accountz`, `/accstatz`, `/jsz` and `/healthz`, all read only. The
 * server itself has no auth on this port; basic or bearer auth is offered for
 * a reverse proxy in front of it.
 *
 * Reference: https://docs.nats.io/running-a-nats-service/nats_admin/monitoring
 * (nats.docs master, read 2026-10) and live responses from demo.nats.io
 * (nats-server 2.15).
 */
export interface NatsContext {
  baseUrl: string;
  headers: Record<string, string>;
  caCert?: string;
  http?: HttpHostServices;
}

export class NatsApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "NatsApiError";
    this.status = status;
  }
}

export function statusOf(err: unknown): number {
  return err instanceof NatsApiError ? err.status : 0;
}

/** `nats.internal:8222/varz` → `http://nats.internal:8222`; keeps an `http_base_path` prefix. */
export function normaliseUrl(raw: string): string {
  let value = raw.trim();
  if (!value) return "";
  if (!/^https?:\/\//i.test(value)) {
    value = `${/:8222(\/|$)/.test(value) || /^(localhost|127\.)/.test(value) ? "http" : "https"}://${value}`;
  }
  return value
    .replace(/[#?].*$/, "")
    .replace(/\/+$/, "")
    .replace(/\/(varz|connz|routez|gatewayz|leafz|subsz|accountz|accstatz|jsz|healthz)$/i, "")
    .replace(/\/+$/, "");
}

export function buildContext(
  credentials: Record<string, string>,
  http?: HttpHostServices,
): NatsContext {
  const baseUrl = normaliseUrl(credentials["url"] ?? "");
  if (!baseUrl) throw new Error("NATS plugin: missing the monitoring URL");
  const token = (credentials["token"] ?? "").trim();
  const username = (credentials["username"] ?? "").trim();
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  else if (username)
    headers["Authorization"] =
      `Basic ${utf8ToBase64(`${username}:${credentials["password"] ?? ""}`)}`;
  const caCert = credentials["caCert"] ?? "";
  return { baseUrl, headers, ...(caCert.trim() ? { caCert } : {}), ...(http ? { http } : {}) };
}

export type Query = Record<string, string | number | boolean | undefined>;

export async function natsFetch<T>(ctx: NatsContext, path: string, query: Query = {}): Promise<T> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query))
    if (v !== undefined && v !== "") params.set(k, String(v));
  const qs = params.toString();
  const url = `${ctx.baseUrl}${path}${qs ? `?${qs}` : ""}`;
  const headers = { Accept: "application/json", ...ctx.headers };
  let status: number;
  let text: string;
  if (ctx.http) {
    const res = await ctx.http.request({
      url,
      method: "GET",
      headers,
      ...(ctx.caCert ? { caCert: ctx.caCert } : {}),
    });
    status = res.status;
    text = res.body;
  } else {
    const res = await fetch(url, { headers });
    status = res.status;
    text = await res.text();
  }
  if (status < 200 || status >= 300) {
    let detail = text.trim().slice(0, 500);
    try {
      const p = JSON.parse(text) as { error?: string | { description?: string } };
      if (typeof p.error === "string") detail = p.error;
      else if (p.error?.description) detail = p.error.description;
    } catch {
      // Not JSON.
    }
    throw new NatsApiError(status, `NATS monitoring error ${status} for ${path}: ${detail}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new NatsApiError(
      502,
      `NATS plugin: ${path} did not answer JSON; is this the monitoring port (8222), not the client port (4222)?`,
    );
  }
}

export function joinId(...parts: string[]): string {
  return parts.map((p) => encodeURIComponent(p)).join("/");
}

export function splitId(id: string, count: number): string[] {
  const parts = id.split("/").map((p) => decodeURIComponent(p));
  if (parts.length < count) throw new NatsApiError(400, `NATS plugin: malformed id "${id}"`);
  return parts;
}

/** Go durations arrive as nanoseconds. */
export const nsToSeconds = (ns: unknown): number | undefined =>
  typeof ns === "number" && ns > 0 ? Math.round(ns / 1e6) / 1000 : undefined;
