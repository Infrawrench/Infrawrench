/**
 * The CI proxy (`app/packages/ci-proxy`), which places runs on the runner
 * pool and holds secrets and variables. Configured by `CI_PROXY_URL` and
 * `CI_PROXY_KEY`; without them CI stays off.
 */

import type { ProxyDownload } from "./downloads.js";
import type { ProxyProgress } from "./job-checks.js";

/**
 * What a finished run is billed: the runner's own totals for the run. They
 * cover every job that ran, on whichever runner (a run can be split across
 * runners; the one that has it reports for all of them), so nothing is
 * added here for a job marked `remote` and nothing is read from anywhere
 * else.
 */
export function runUsage(run: ProxyRun): { vcpuSeconds: number; memoryGibSeconds: number } {
  return {
    vcpuSeconds: run.result?.usage?.vcpu_seconds ?? 0,
    memoryGibSeconds: run.result?.usage?.memory_gib_seconds ?? 0,
  };
}

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
  /**
   * `error` is a run the runner could not start or finish (a clone it was
   * refused, a pipeline it could not read), with `error` saying why. Read
   * any state but `running` and `finished` as that, so a state a newer
   * runner adds is never mistaken for a run that passed or ran nothing.
   */
  state: "running" | "finished" | "error" | (string & {});
  error?: string;
  /** While it runs (runner 0.3.1 and later): each pipeline's jobs and their states so far. */
  progress?: ProxyProgress;
  result?: {
    /** The runner's id for the run, which its downloads are stored under. */
    run_id?: string;
    passed?: boolean;
    /** Something in it was cancelled (runners from the release with cancelling). */
    cancelled?: boolean;
    /**
     * What the run is billed for: every job that ran, the ones another
     * runner of a split run ran for it included (`remote` below). A
     * helper's own run reports no usage, so this is the whole bill.
     */
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
          /** What it kept with `downloads:`; absent from runners before it. */
          downloads?: ProxyDownload[];
          /** What it was lent, by name (runners from 0.3.16). */
          access?: {
            connections?: unknown;
            "ssh-keys"?: unknown;
            resources?: unknown;
            "env-from"?: unknown;
          };
          /** A cloud job's block and what ran it (runners from 0.3.16). */
          cloud?: Record<string, unknown>;
          /**
           * The runner that ran it, when the run was split and another
           * runner took the job. It is in the run's `usage` like the rest.
           */
          remote?: string;
          /** The memory it reserved, in MiB, wherever it ran. */
          memory_mib?: number;
        }>;
      };
    }>;
  };
}
