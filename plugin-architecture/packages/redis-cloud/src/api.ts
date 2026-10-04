import type { HttpHostServices } from "@infrawrench/plugin-base";
import { jsonRestFetch } from "@infrawrench/plugin-base";

/**
 * Redis Cloud REST API (`https://api.redislabs.com/v1`, OpenAPI document at
 * `/v1/cloud-api-docs`; verified 2026-10).
 *
 * Every request carries two keys: `x-api-key` is the **account key** (one per
 * Redis Cloud account, created when the API is enabled) and
 * `x-api-secret-key` is a **user key**, which belongs to one team member and
 * carries that member's role. Cost reports need the Owner, Viewer or Billing
 * admin role; a Logs viewer key can list nothing but the system log.
 *
 * The documented limit is 400 requests a minute per key, answered with 429.
 */
export const REDIS_CLOUD_API = "https://api.redislabs.com/v1";

export interface RedisCloudContext {
  accountKey: string;
  userKey: string;
  http?: HttpHostServices;
  /** Overridable for tests; production always uses {@link REDIS_CLOUD_API}. */
  baseUrl?: string;
  /** Overridable for tests so task polling does not really sleep. */
  sleep?: (ms: number) => Promise<void>;
}

/** Thrown for any non-2xx answer, carrying the status callers branch on. */
export class RedisCloudApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "RedisCloudApiError";
    this.status = status;
  }
}

const STATUS_IN_MESSAGE = /Redis Cloud API error (\d{3})/;

/** JSON request against the Redis Cloud API, routed through the host when present. */
export async function rcFetch<T>(
  ctx: RedisCloudContext,
  method: string,
  path: string,
  body?: unknown,
  query?: Record<string, string | number | boolean | undefined>,
): Promise<T> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== "") params.set(k, String(v));
  }
  const qs = params.toString();
  try {
    return await jsonRestFetch<T>({
      vendor: "Redis Cloud",
      url: `${ctx.baseUrl ?? REDIS_CLOUD_API}${path}${qs ? `?${qs}` : ""}`,
      errorPath: path,
      headers: {
        Accept: "application/json",
        "x-api-key": ctx.accountKey,
        "x-api-secret-key": ctx.userKey,
      },
      init: {
        method,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      },
      ...(ctx.http ? { http: ctx.http } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = Number(STATUS_IN_MESSAGE.exec(message)?.[1] ?? 0);
    if (status) throw new RedisCloudApiError(status, friendlyError(status, message));
    throw err;
  }
}

/** Pull the API's own `description` out of an error body when it has one. */
function friendlyError(status: number, raw: string): string {
  const jsonStart = raw.indexOf("{");
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(raw.slice(jsonStart)) as { description?: string; error?: string };
      const detail = parsed.description ?? parsed.error;
      if (detail) return `Redis Cloud API error ${status}: ${detail}`;
    } catch {
      /* not JSON; keep the raw message */
    }
  }
  if (status === 401) {
    return `Redis Cloud API error 401: the account key or user key was rejected. Check both keys, that the API is enabled for the account, and that the user key's CIDR allow list includes this server.`;
  }
  return raw;
}

/** HTTP status of a failed call, or 0 for a transport error. */
export function statusOf(err: unknown): number {
  return err instanceof RedisCloudApiError ? err.status : 0;
}

/** Task states the API reports for an asynchronous operation. */
export type TaskStatus =
  | "initialized"
  | "received"
  | "processing-in-progress"
  | "processing-completed"
  | "processing-error";

export interface RcTask {
  taskId?: string;
  commandType?: string;
  status?: TaskStatus | string;
  description?: string;
  timestamp?: string;
  response?: {
    resourceId?: number;
    additionalResourceId?: number;
    resource?: unknown;
    error?: { type?: string; status?: string; description?: string } | string;
  };
}

const DONE: ReadonlySet<string> = new Set(["processing-completed", "processing-error"]);

/** True once a task has finished, successfully or not. */
export function taskFinished(task: RcTask): boolean {
  return DONE.has(String(task.status ?? ""));
}

/** The human explanation for a failed task. */
export function taskErrorText(task: RcTask): string {
  const err = task.response?.error;
  if (typeof err === "string") return err;
  if (err?.description) return err.description;
  if (err?.type) return err.type;
  return task.description ?? "the operation failed";
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Poll `GET /tasks/{taskId}` until the task finishes or `timeoutMs` passes.
 * Returns the last state seen either way: callers decide whether an
 * unfinished task is an error (a listing) or simply still running (a resize).
 */
export async function waitForTask(
  ctx: RedisCloudContext,
  initial: RcTask,
  timeoutMs = 20_000,
  intervalMs = 1_000,
): Promise<RcTask> {
  let task = initial;
  const sleep = ctx.sleep ?? defaultSleep;
  const deadline = Date.now() + timeoutMs;
  while (!taskFinished(task) && task.taskId && Date.now() < deadline) {
    await sleep(intervalMs);
    task = await rcFetch<RcTask>(ctx, "GET", `/tasks/${encodeURIComponent(task.taskId)}`);
  }
  return task;
}

/**
 * Several read endpoints (VPC peerings, Transit Gateways, Private Service
 * Connect) are themselves asynchronous: the GET answers with a task, and the
 * data arrives as that task's `response.resource`. Throws when the task fails
 * or does not finish in time.
 */
export async function readViaTask<T>(
  ctx: RedisCloudContext,
  path: string,
  timeoutMs = 15_000,
): Promise<T | undefined> {
  const started = await rcFetch<RcTask>(ctx, "GET", path);
  const task = await waitForTask(ctx, started, timeoutMs, 750);
  if (!taskFinished(task)) {
    throw new Error(`Redis Cloud is still preparing ${path}; refresh in a moment.`);
  }
  if (task.status === "processing-error") {
    throw new TaskFailedError(taskErrorText(task), task);
  }
  return task.response?.resource as T | undefined;
}

/** A finished task that reported `processing-error`. */
export class TaskFailedError extends Error {
  readonly task: RcTask;
  constructor(message: string, task: RcTask) {
    super(message);
    this.name = "TaskFailedError";
    this.task = task;
  }
}

/**
 * Submit a write and wait briefly for it. A task that is still running when
 * the wait ends is not a failure (a resize or an import routinely takes
 * minutes); the returned message says so. A task that fails throws with
 * Redis Cloud's own explanation.
 */
export async function submitTask(
  ctx: RedisCloudContext,
  method: string,
  path: string,
  body?: unknown,
  timeoutMs = 20_000,
): Promise<{ task: RcTask; finished: boolean }> {
  const started = await rcFetch<RcTask>(ctx, method, path, body);
  const task = await waitForTask(ctx, started ?? {}, timeoutMs);
  if (task.status === "processing-error") {
    throw new TaskFailedError(`Redis Cloud rejected the change: ${taskErrorText(task)}`, task);
  }
  return { task, finished: taskFinished(task) };
}
