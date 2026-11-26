/**
 * `TerraformStateDO`: one Durable Object per Terraform workspace
 * (`idFromName(workspaceId)`). It serialises the lock and the serial and
 * lineage checks; the bytes are in R2 (`state-store.ts`).
 *
 * A thin shell, like `RepoDO`: `state-serve.ts` holds what it does, and this
 * file is what is Cloudflare about it. It never opens Postgres. Use
 * `stateClient` (`./client.ts`) rather than the stub.
 */
import { DurableObject } from "cloudflare:workers";
import type {
  Request as CfRequest,
  Response as CfResponse,
  DurableObjectState,
} from "@cloudflare/workers-types/index";
import type { Env } from "../env";
import type { Bucket, RepoStorage } from "../repo/do/platform";
import {
  type RestoreResult,
  STATE_CALL_HEADER,
  type StateCall,
  type StateHeadReport,
  decodeHeader,
  forceUnlockState,
  restoreStateVersion,
  serveStateCall,
} from "./state-serve";
import { WorkspaceStateStore } from "./state-store";

/** The internal URL a version's bytes are read from: `<this>/<workspaceId>/<versionId>`. */
export const VERSION_URL = "https://terraform-state.internal/version";

export class TerraformStateDO extends DurableObject<Env> {
  private readonly store: WorkspaceStateStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new WorkspaceStateStore({
      bucket: env.OBJECTS as unknown as Bucket,
      storage: ctx.storage as unknown as RepoStorage,
    });
  }

  /** The backend's requests, and a version's bytes for the forge's download. */
  override async fetch(request: CfRequest): Promise<CfResponse> {
    const incoming = request as unknown as Request;
    const answer = (response: Response) => response as unknown as CfResponse;
    if (incoming.url.startsWith(`${VERSION_URL}/`)) {
      const [workspaceId, versionId] = incoming.url
        .slice(VERSION_URL.length + 1)
        .split("/")
        .map(decodeURIComponent);
      const bytes = await this.store.open(workspaceId ?? "").read(versionId ?? "");
      if (!bytes) return answer(new Response(null, { status: 404 }));
      return answer(
        new Response(new Uint8Array(bytes).buffer, {
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        }),
      );
    }
    const call = decodeHeader<StateCall>(incoming.headers.get(STATE_CALL_HEADER));
    if (!call) return answer(new Response("Bad call", { status: 400 }));
    return answer(await serveStateCall(this.store, incoming, call));
  }

  async head(workspaceId: string): Promise<StateHeadReport> {
    return { ...this.store.open(workspaceId).headNow(), written: null };
  }

  async restore(workspaceId: string, versionId: string, actor: string): Promise<RestoreResult> {
    return restoreStateVersion(this.store, workspaceId, versionId, actor);
  }

  async forceUnlock(workspaceId: string): Promise<StateHeadReport> {
    return forceUnlockState(this.store, workspaceId);
  }

  /** Deletes every version's bytes and every row: the workspace was removed. */
  async destroy(workspaceId: string): Promise<{ deletedFiles: number }> {
    return this.store.open(workspaceId).destroy();
  }
}
