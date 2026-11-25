import { bytesEqual, toBase64 } from "../util/bytes.js";
import { md5 } from "../util/md5.js";
import { lockState, purgeState, readState, unlockState, writeState } from "./backend.js";
import { DEFAULT_MAX_STATE_BYTES } from "./document.js";
import { parseLockInfo } from "./lock.js";
import type { HeldLock, StateStore, StateVersion } from "./types.js";

/**
 * Terraform's `http` backend, server side: one function from a request to the
 * answer the client in `internal/backend/remote-state/http` expects.
 *
 * | Request                                  | Answer                                              |
 * | ---------------------------------------- | --------------------------------------------------- |
 * | `GET state`                              | `200` and the state, `404` when there is none        |
 * | `POST state[?ID=<lock id>]` (or `PUT`)   | `200`; `423` and the lock when another holds it;     |
 * |                                          | `409` when the lock named is gone or the serial or   |
 * |                                          | lineage does not follow the stored state             |
 * | `DELETE state`                           | `200`; `423` while locked                            |
 * | `LOCK state`, `POST lock`                | `200`; `423` and the holder's lock info when taken   |
 * | `UNLOCK state`, `DELETE lock`,           | `200`; `409` and the holder's lock info when the id  |
 * | `POST unlock`                            | names another lock                                   |
 *
 * `LOCK` and `UNLOCK` are the client's default methods, on `lock_address` and
 * `unlock_address`. A proxy that drops WebDAV methods is why `lock_method` and
 * `unlock_method` exist, so both spellings are served: the default methods on
 * any of the three paths, and `POST`/`DELETE` on `lock`, `POST` on `unlock`.
 *
 * Terraform reads `404` and `204` on a `GET` as "no state yet" and plans to
 * create everything, so those are only ever answered for a workspace that is
 * truly empty. Someone who may not read gets `403`, and a broken store throws.
 */

/** Which of the workspace's three addresses a request came to. */
export type StateRoute = "state" | "lock" | "unlock";

/** Who is asking, resolved by the host before the handler runs. */
export interface StateAuth {
  /**
   * The authenticated principal, as it is recorded on versions and locks
   * (`user:<id>`, `token:<id>`, `ci:<run id>`), or null when the request
   * carried no valid credential.
   */
  readonly principal: string | null;
  /** May read the state: it holds every secret the workspace manages. */
  readonly canRead: boolean;
  /** May lock, unlock with the lock's id, and write. */
  readonly canWrite: boolean;
  /** May delete the state, and unlock without naming the lock. */
  readonly canAdmin: boolean;
}

export interface StateHandlerOptions {
  /** The address the request came to. Default: read from the path's last segment. */
  readonly route?: StateRoute | undefined;
  readonly now?: (() => Date) | undefined;
  readonly maxBytes?: number | undefined;
  /** The realm of the `WWW-Authenticate` challenge. */
  readonly realm?: string | undefined;
  /** Called after a write stored a new version, with what the host records and announces. */
  readonly onVersion?: ((version: StateVersion) => void | Promise<void>) | undefined;
}

const JSON_TYPE = "application/json";
const LOCK_INFO_MAX_BYTES = 64 * 1024;

function json(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": JSON_TYPE, "cache-control": "no-store", ...headers },
  });
}

function problem(status: number, error: string, headers?: Record<string, string>): Response {
  return json(status, { error }, headers);
}

function empty(status: number): Response {
  return new Response(null, { status, headers: { "cache-control": "no-store" } });
}

/** The holder's lock info, which Terraform parses to print who has the lock. */
function lockAnswer(status: 409 | 423, lock: HeldLock): Response {
  return json(status, lock.info);
}

function routeOf(url: URL): StateRoute {
  const last = url.pathname.replace(/\/+$/, "").split("/").pop();
  return last === "lock" || last === "unlock" ? last : "state";
}

type Operation = "read" | "write" | "purge" | "lock" | "unlock";

const ALLOWED: Record<StateRoute, string> = {
  state: "GET, HEAD, POST, PUT, DELETE, LOCK, UNLOCK",
  lock: "POST, PUT, LOCK, DELETE, UNLOCK",
  unlock: "POST, PUT, DELETE, UNLOCK",
};

function operationOf(route: StateRoute, method: string): Operation | null {
  if (method === "LOCK") return route === "unlock" ? null : "lock";
  if (method === "UNLOCK") return "unlock";
  switch (route) {
    case "state":
      if (method === "GET" || method === "HEAD") return "read";
      if (method === "POST" || method === "PUT") return "write";
      return method === "DELETE" ? "purge" : null;
    case "lock":
      if (method === "POST" || method === "PUT") return "lock";
      return method === "DELETE" ? "unlock" : null;
    case "unlock":
      return method === "POST" || method === "PUT" || method === "DELETE" ? "unlock" : null;
  }
}

type Body =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly response: Response };

/** The request body, refused as soon as it is known to be past `limit`. */
async function readBody(request: Request, limit: number): Promise<Body> {
  const tooLarge: Body = {
    ok: false,
    response: problem(413, `The body is larger than ${limit} bytes.`),
  };
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > limit) return tooLarge;
  if (!request.body) return { ok: true, bytes: new Uint8Array(0) };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      return tooLarge;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { ok: true, bytes };
}

function decodeBase64(value: string): Uint8Array | null {
  try {
    const binary = atob(value.trim());
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

async function handleRead(request: Request, store: StateStore): Promise<Response> {
  const outcome = await readState(store);
  if (outcome.kind === "empty") return empty(404);
  const headers = {
    "content-type": JSON_TYPE,
    "cache-control": "no-store",
    "content-length": String(outcome.bytes.length),
    "content-md5": toBase64(md5(outcome.bytes)),
    "x-terraform-state-serial": String(outcome.version.serial),
  };
  // A copy over a plain ArrayBuffer: a view over a shared buffer is not a `BodyInit`.
  const body = request.method === "HEAD" ? null : new Uint8Array(outcome.bytes).buffer;
  return new Response(body, { status: 200, headers });
}

async function handleWrite(
  request: Request,
  url: URL,
  store: StateStore,
  principal: string,
  options: StateHandlerOptions,
): Promise<Response> {
  const limit = options.maxBytes ?? DEFAULT_MAX_STATE_BYTES;
  const body = await readBody(request, limit);
  if (!body.ok) return body.response;

  const declaredMd5 = request.headers.get("content-md5");
  if (declaredMd5 !== null) {
    const expected = decodeBase64(declaredMd5);
    if (!expected || !bytesEqual(expected, md5(body.bytes))) {
      return problem(400, "The body does not match its Content-MD5.");
    }
  }

  const lockId = url.searchParams.get("ID");
  const outcome = await writeState(store, body.bytes, {
    lockId: lockId === null || lockId === "" ? null : lockId,
    actor: principal,
    now: options.now,
    maxBytes: limit,
  });
  switch (outcome.kind) {
    case "written":
      await options.onVersion?.(outcome.version);
      return empty(200);
    case "unchanged":
      return empty(200);
    case "invalid":
      return problem(400, outcome.reason);
    case "too-large":
      return problem(413, `The state is larger than ${outcome.limit} bytes.`);
    case "locked":
      return lockAnswer(423, outcome.lock);
    case "lock-lost":
      return problem(409, "The lock this write names is no longer held. Lock the state again.");
    case "conflict":
      return json(409, {
        error: CONFLICTS[outcome.conflict],
        conflict: outcome.conflict,
        current: outcome.current
          ? { serial: outcome.current.serial, lineage: outcome.current.lineage }
          : null,
      });
  }
}

const CONFLICTS = {
  lineage:
    "This state has another lineage than the one stored: it belongs to a different state. Restore or delete the stored state first.",
  "serial-behind": "The stored state is newer than the one written.",
  "serial-reused": "Another write already stored a different state with this serial.",
  busy: "The state changed while this write was being stored. Try again.",
} as const;

async function handleLock(
  request: Request,
  store: StateStore,
  principal: string,
  options: StateHandlerOptions,
): Promise<Response> {
  const body = await readBody(request, LOCK_INFO_MAX_BYTES);
  if (!body.ok) return body.response;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body.bytes));
  } catch {
    return problem(400, "The lock info is not valid JSON.");
  }
  const info = parseLockInfo(parsed);
  if (!info.ok) return problem(400, info.reason);
  const outcome = await lockState(store, info.info, { actor: principal, now: options.now });
  return outcome.kind === "acquired" ? empty(200) : lockAnswer(423, outcome.lock);
}

async function handleUnlock(
  request: Request,
  store: StateStore,
  auth: StateAuth,
): Promise<Response> {
  const body = await readBody(request, LOCK_INFO_MAX_BYTES);
  if (!body.ok) return body.response;
  // A run sends the lock info it locked with. `terraform force-unlock <id>`
  // sends no body at all (seen with 1.15: the id it was given never reaches
  // the backend), so an unlock that names no lock is a forced one, and takes
  // admin access. A body with only an `ID` is taken too, for the forge's API.
  let lockId: string | null = null;
  if (body.bytes.length > 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(body.bytes));
    } catch {
      return problem(400, "The lock info is not valid JSON.");
    }
    const info = parseLockInfo(parsed);
    if (!info.ok) return problem(400, info.reason);
    lockId = info.info.ID;
  }
  const outcome = await unlockState(store, { lockId, force: auth.canAdmin });
  switch (outcome.kind) {
    case "released":
    case "not-locked":
      return empty(200);
    case "mismatch":
      return lockAnswer(409, outcome.lock);
    case "force-required":
      return problem(403, "Unlocking without the lock's id takes admin access to the repository.");
  }
}

/**
 * Serves one request of Terraform's `http` backend for one workspace. The host
 * has already found the workspace (and so the store) and resolved `auth`.
 */
export async function handleStateRequest(
  request: Request,
  store: StateStore,
  auth: StateAuth,
  options: StateHandlerOptions = {},
): Promise<Response> {
  if (auth.principal === null) {
    const realm = (options.realm ?? "Terraform state").replace(/["\\]/g, "");
    return problem(401, "Sign in with a personal access token or a CI job token.", {
      "www-authenticate": `Basic realm="${realm}", charset="UTF-8"`,
    });
  }
  const url = new URL(request.url);
  const route = options.route ?? routeOf(url);
  const operation = operationOf(route, request.method.toUpperCase());
  if (operation === null) {
    return problem(405, `${request.method} is not served here.`, { allow: ALLOWED[route] });
  }

  const allowed =
    operation === "read" ? auth.canRead : operation === "purge" ? auth.canAdmin : auth.canWrite;
  if (!allowed) return problem(403, "This credential may not do that to the workspace's state.");

  switch (operation) {
    case "read":
      return handleRead(request, store);
    case "write":
      return handleWrite(request, url, store, auth.principal, options);
    case "lock":
      return handleLock(request, store, auth.principal, options);
    case "unlock":
      return handleUnlock(request, store, auth);
    case "purge": {
      const outcome = await purgeState(store);
      if (outcome.kind === "locked") return lockAnswer(423, outcome.lock);
      if (outcome.kind === "busy") return problem(409, CONFLICTS.busy);
      return empty(200);
    }
  }
}
