/**
 * The CI proxy (`app/packages/ci-proxy`), which places runs on the runner
 * pool and holds secrets and variables. Configured by `CI_PROXY_URL` and
 * `CI_PROXY_KEY`; without them CI stays off, whatever the feature flags say.
 */

import type { ProxyProgress } from "./job-checks.js";

export function ciProxyConfigured(): boolean {
  return Boolean(process.env["CI_PROXY_URL"] && process.env["CI_PROXY_KEY"]);
}

export class CiProxyError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "CiProxyError";
  }
}

/** A request to the proxy with its key. */
export async function proxyFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const base = process.env["CI_PROXY_URL"];
  const key = process.env["CI_PROXY_KEY"];
  if (!base || !key)
    throw new CiProxyError("CI is not configured (CI_PROXY_URL, CI_PROXY_KEY).", 503);
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${key}`);
  if (init.body !== undefined) headers.set("Content-Type", "application/json");
  return fetch(`${base.replace(/\/+$/, "")}${path}`, {
    ...init,
    headers,
    signal: init.signal ?? AbortSignal.timeout(20_000),
  });
}

export async function proxyJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await proxyFetch(path, init);
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const message =
      typeof body === "object" &&
      body !== null &&
      typeof (body as { error?: unknown }).error === "string"
        ? (body as { error: string }).error
        : `the CI proxy answered ${res.status}`;
    throw new CiProxyError(message, res.status);
  }
  return body as T;
}

/** What the runner reports for a run (the parts CI reads). */
export interface ProxyRun {
  id: string;
  state: "running" | "finished" | "failed";
  error?: string;
  /** While it runs (runner 0.3.1 and later): each pipeline's jobs and their states so far. */
  progress?: ProxyProgress;
  result?: {
    passed?: boolean;
    usage?: { vcpu_seconds?: number; memory_gib_seconds?: number };
    pipelines?: Array<{
      outcome?: string;
      file?: string;
      name?: string;
      errors?: string[];
      report?: {
        pipeline?: string;
        jobs?: Array<{
          id?: string;
          name?: string;
          status?: string;
          reason?: string;
          message?: string;
          duration_ms?: number;
          /** Not run: the runner's task cache stood in for a passing run. */
          cached?: boolean;
          /** The job keys it waited for (runner 0.3.1 and later). */
          needs?: string[];
          execution?: { stdout?: string; stderr?: string } | null;
        }>;
      };
    }>;
  };
}
