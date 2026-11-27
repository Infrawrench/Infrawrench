/**
 * What a workspace's Durable Object does with a request, apart from being a
 * Durable Object: Terraform's `http` backend over the workspace's store, and
 * the forge's own operations (restore, forced unlock).
 *
 * The front Worker resolved who is asking and sends that along
 * ({@link StateCall}); nothing here opens Postgres. Every answer to a change
 * carries the head as it is afterwards ({@link STATE_HEAD_HEADER}), which the
 * front Worker mirrors onto the workspace's row and takes off the response.
 */
import {
  type HeldLock,
  type StateAuth,
  type StateRoute,
  handleStateRequest,
  restoreVersion,
  unlockState,
} from "@infrawrench/git-terraform";
import type { StoredStateVersion, WorkspaceStateStore } from "./state-store";

/** Travels on the internal request, in {@link STATE_CALL_HEADER}. */
export interface StateCall {
  readonly workspaceId: string;
  readonly auth: StateAuth;
  readonly route: StateRoute;
}

export const STATE_CALL_HEADER = "x-infrawrench-terraform-call";
export const STATE_HEAD_HEADER = "x-infrawrench-terraform-head";

/** The state after a request, and the version it wrote when it wrote one. */
export interface StateHeadReport {
  readonly version: StoredStateVersion | null;
  readonly lock: HeldLock | null;
  readonly written: StoredStateVersion | null;
}

/** JSON in a header: lock info is the client's text, which a header cannot carry as it is. */
export const encodeHeader = (value: unknown): string => encodeURIComponent(JSON.stringify(value));

export const decodeHeader = <T>(value: string | null): T | null => {
  if (value === null) return null;
  try {
    return JSON.parse(decodeURIComponent(value)) as T;
  } catch {
    return null;
  }
};

const READS = new Set(["GET", "HEAD"]);

/** One request of Terraform's `http` backend, for the workspace the call names. */
export const serveStateCall = async (
  store: WorkspaceStateStore,
  request: Request,
  call: StateCall,
  options: { readonly now?: () => Date; readonly maxBytes?: number } = {},
): Promise<Response> => {
  store.open(call.workspaceId);
  let written: StoredStateVersion | null = null;
  const response = await handleStateRequest(request, store, call.auth, {
    route: call.route,
    realm: "git.infrawrench.com",
    now: options.now,
    maxBytes: options.maxBytes,
    onVersion: async (version) => {
      written = await store.version(version.id);
    },
  });
  if (READS.has(request.method.toUpperCase())) return response;
  const headers = new Headers(response.headers);
  const report: StateHeadReport = { ...store.headNow(), written };
  headers.set(STATE_HEAD_HEADER, encodeHeader(report));
  return new Response(response.body, { status: response.status, headers });
};

export type RestoreResult =
  | { readonly kind: "restored"; readonly head: StateHeadReport }
  | { readonly kind: "not-found" | "busy" }
  | { readonly kind: "locked"; readonly lock: HeldLock }
  | { readonly kind: "invalid"; readonly reason: string };

/** Makes an old version current again, as a new version (the forge's API; admin). */
export const restoreStateVersion = async (
  store: WorkspaceStateStore,
  workspaceId: string,
  versionId: string,
  actor: string,
): Promise<RestoreResult> => {
  store.open(workspaceId);
  const outcome = await restoreVersion(store, versionId, { actor });
  if (outcome.kind !== "restored") return outcome;
  const written = await store.version(outcome.version.id);
  return { kind: "restored", head: { ...store.headNow(), written } };
};

/** Releases whatever lock is held (the forge's API; admin). */
export const forceUnlockState = async (
  store: WorkspaceStateStore,
  workspaceId: string,
): Promise<StateHeadReport> => {
  store.open(workspaceId);
  await unlockState(store, { lockId: null, force: true });
  return { ...store.headNow(), written: null };
};
