/**
 * How the rest of the worker talks to a workspace's Durable Object, with the
 * workspace id already bound. An interface, so the route and the API's
 * handlers run in tests against the same store without workerd
 * (`localStateClient`).
 */
import type { Env } from "../env";
import type { TerraformStateDO } from "./state-do";
import {
  type RestoreResult,
  STATE_CALL_HEADER,
  type StateCall,
  type StateHeadReport,
  encodeHeader,
  forceUnlockState,
  restoreStateVersion,
  serveStateCall,
} from "./state-serve";
import type { WorkspaceStateStore } from "./state-store";

export interface StateClient {
  /** One request of Terraform's `http` backend, as the caller `call.auth` says it is. */
  serve(request: Request, call: Omit<StateCall, "workspaceId">): Promise<Response>;
  head(): Promise<StateHeadReport>;
  restore(versionId: string, actor: string): Promise<RestoreResult>;
  forceUnlock(): Promise<StateHeadReport>;
  /** A stored version's bytes, or null. */
  readVersion(versionId: string): Promise<Response | null>;
  destroy(): Promise<{ deletedFiles: number }>;
}

export type StateClientFactory = (env: Env, workspaceId: string) => StateClient;

/** Must match `VERSION_URL` in `state-do.ts`, which this file cannot import (`cloudflare:workers`). */
const VERSION_URL = "https://terraform-state.internal/version";

type Rpc = { [K in keyof TerraformStateDO]: TerraformStateDO[K] };

export const stateClient: StateClientFactory = (env, workspaceId) => {
  const stub = env.TERRAFORM_STATE.get(env.TERRAFORM_STATE.idFromName(workspaceId));
  const rpc = stub as unknown as Rpc;
  const send = stub.fetch.bind(stub) as unknown as (
    url: string,
    init?: RequestInit & { duplex?: "half" },
  ) => Promise<Response>;
  return {
    serve: (request, call) => {
      const headers = new Headers(request.headers);
      // The object decides nothing about who is asking: the credential stays here.
      headers.delete("authorization");
      headers.delete("cookie");
      const sent: StateCall = { ...call, workspaceId };
      headers.set(STATE_CALL_HEADER, encodeHeader(sent));
      const hasBody = request.method !== "GET" && request.method !== "HEAD" && request.body;
      return send(request.url, {
        method: request.method,
        headers,
        ...(hasBody ? { body: request.body, duplex: "half" } : {}),
      });
    },
    head: () => rpc.head(workspaceId),
    restore: (versionId, actor) => rpc.restore(workspaceId, versionId, actor),
    forceUnlock: () => rpc.forceUnlock(workspaceId),
    readVersion: async (versionId) => {
      const response = await send(
        `${VERSION_URL}/${encodeURIComponent(workspaceId)}/${encodeURIComponent(versionId)}`,
      );
      return response.ok ? response : null;
    },
    destroy: () => rpc.destroy(workspaceId),
  };
};

/**
 * The same client over a store in this process: what the Durable Object does,
 * without one. Tests give each workspace its store.
 */
export const localStateClient = (store: WorkspaceStateStore, workspaceId: string): StateClient => ({
  serve: (request, call) => serveStateCall(store, request, { ...call, workspaceId }),
  head: async () => ({ ...store.open(workspaceId).headNow(), written: null }),
  restore: (versionId, actor) => restoreStateVersion(store, workspaceId, versionId, actor),
  forceUnlock: () => forceUnlockState(store, workspaceId),
  readVersion: async (versionId) => {
    const bytes = await store.open(workspaceId).read(versionId);
    return bytes ? new Response(new Uint8Array(bytes).buffer) : null;
  },
  destroy: () => store.open(workspaceId).destroy(),
});
