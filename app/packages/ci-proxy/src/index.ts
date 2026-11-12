// The Worker entry: builds the dependencies from the environment and hands
// requests to `handle` and Cron Trigger invocations to `tick`.

import type {
  D1Database,
  R2Bucket,
  Request as WorkerRequest,
  ScheduledController,
} from "@cloudflare/workers-types/index";
import { handle, tick, type Deps } from "./app";
import { D1SweepState, sweepDownloads, type ArtifactBucket } from "./artifacts";
import { Pool, parseRunnerList } from "./pool";
import { D1RunnerList } from "./runners";
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
  /** The runners' bucket, where jobs' downloads are (an R2 binding). */
  ARTIFACTS?: R2Bucket;
  /** Signs download links, shared with the app's CI_ARTIFACT_SIGNING_KEY (a secret). */
  ARTIFACT_SIGNING_KEY?: string;
}

async function deps(env: Env): Promise<Deps> {
  const runnerList = new D1RunnerList(env.DB);
  const stored = await runnerList.list();
  const runners = stored.length > 0 ? stored : parseRunnerList(env.RUNNERS);
  return {
    pool: new Pool(runners, env.RUNNER_KEY, (input, init) => fetch(input, init)),
    runnerList,
    store: new D1Store(env.DB),
    values: new D1Values(env.DB),
    secretsKey: await secretsKey(env.SECRETS_KEY),
    proxyKey: env.PROXY_KEY,
    now: () => Math.floor(Date.now() / 1000),
    ...(env.ARTIFACTS
      ? {
          downloads: {
            // The binding has more overloads than downloads use; the
            // interface is the part of it they read.
            bucket: env.ARTIFACTS as unknown as ArtifactBucket,
            key: env.ARTIFACT_SIGNING_KEY ?? null,
            sweep: new D1SweepState(env.DB),
          },
        }
      : {}),
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
    const built = await deps(env);
    const now = Math.floor(controller.scheduledTime / 1000);
    // Schedules first; a sweep that fails never holds them up.
    const result = await tick(built, now);
    console.log(JSON.stringify({ event: "tick", cron: controller.cron, ...result }));
    if (built.downloads) {
      try {
        const swept = await sweepDownloads(built.downloads, now);
        if (!swept.skipped) console.log(JSON.stringify({ event: "sweep", ...swept }));
      } catch (e) {
        console.error(
          JSON.stringify({
            event: "sweep-error",
            message: e instanceof Error ? e.message : String(e),
          }),
        );
      }
    }
  },
};
