// The Worker entry: builds the dependencies from the environment and hands
// requests to `handle` and Cron Trigger invocations to `tick`.

import type {
  D1Database,
  Request as WorkerRequest,
  ScheduledController,
} from "@cloudflare/workers-types/index";
import { handle, tick, type Deps } from "./app";
import { Pool } from "./pool";
import { D1Store } from "./store";
import { D1Values, secretsKey } from "./values";

export interface Env {
  DB: D1Database;
  /** Comma-separated runner base URLs (a var). */
  RUNNERS: string;
  /** The key callers send (a secret). */
  PROXY_KEY: string;
  /** The key the runners accept, their IWCI_SERVER_KEY (a secret). */
  RUNNER_KEY: string;
  /** 32 random bytes, base64: seals stored secrets (a secret; optional). */
  SECRETS_KEY?: string;
}

async function deps(env: Env): Promise<Deps> {
  return {
    pool: Pool.fromList(env.RUNNERS, env.RUNNER_KEY, (input, init) => fetch(input, init)),
    store: new D1Store(env.DB),
    values: new D1Values(env.DB),
    secretsKey: await secretsKey(env.SECRETS_KEY),
    proxyKey: env.PROXY_KEY,
    now: () => Math.floor(Date.now() / 1000),
  };
}

export default {
  async fetch(incoming: WorkerRequest, env: Env): Promise<Response> {
    // The runtime's Request and the global one are the same object; the
    // cast only reconciles the two type libraries (as web/edge/worker.ts).
    const request = incoming as unknown as Request;
    try {
      return await handle(request, await deps(env));
    } catch (e) {
      console.error(
        JSON.stringify({ event: "error", message: e instanceof Error ? e.message : String(e) }),
      );
      return new Response(JSON.stringify({ error: "the proxy failed; see its logs" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const result = await tick(await deps(env), Math.floor(controller.scheduledTime / 1000));
    console.log(JSON.stringify({ event: "tick", cron: controller.cron, ...result }));
  },
};
