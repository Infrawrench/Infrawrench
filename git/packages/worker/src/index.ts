/**
 * git.infrawrench.com: the composition root. Routing, auth, the API, the
 * queue consumer and (when they exist) the Durable Objects live in their own
 * modules; this file only wires them together.
 *
 * The server code is loaded on first use, not at start-up: evaluating the
 * API's layers and server-core's schema is not work a Worker's start-up
 * budget covers (KNOWLEDGE.md "Edge/gateway split").
 */
import type { ExecutionContext, MessageBatch } from "@cloudflare/workers-types/index";
import type { Env, GitEvent } from "./env";
import { type Routes, serve } from "./http/router";

const lazy = <T>(load: () => Promise<T>): (() => Promise<T>) => {
  let loaded: Promise<T> | undefined;
  return () => (loaded ??= load());
};

const api = lazy(async () => (await import("./api/server")).makeGitApi());
const database = lazy(() => import("./db/client"));

const routes: Routes = {
  api: async (request, env, ctx) => {
    const [{ withDb }, handler] = await Promise.all([database(), api()]);
    return withDb(env, ctx, () => handler.handle(request, env, ctx));
  },

  auth: async (request, env, ctx, route) => {
    const signIn = await import("./auth/sign-in");
    if (route.action === "sign-in") return signIn.handleSignIn(request, env);
    if (route.action === "sign-out") return signIn.handleSignOut(request, env);
    const [{ withDb }, { provisionSignedInUser }] = await Promise.all([
      database(),
      import("./db/users"),
    ]);
    return withDb(env, ctx, () =>
      signIn.handleCallback(request, env, { provision: provisionSignedInUser }),
    );
  },

  // INSERTION POINTS: the storage's routes. `http/router.ts` documents each
  // and answers 503 while it is absent.
  //
  //   smartHttp: (request, env, ctx, route) => ...,
  //   raw: (request, env, ctx, route) => ...,
  //   archive: (request, env, ctx, route) => ...,
  //   terraformState: (request, env, ctx, route) => ...,
};

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return serve(request, env, ctx, routes);
  },

  /** `infrawrench-git-events`: what a push leaves behind (`events/consumer.ts`). */
  async queue(batch: MessageBatch<GitEvent>, env: Env, ctx: ExecutionContext): Promise<void> {
    const { consumeGitEvents } = await import("./events/consumer");
    await consumeGitEvents(batch, env, ctx);
  },

  // INSERTION POINT (SSH): `connect(socket, env, ctx)`, the inbound TCP entry
  // that runs `@infrawrench/git-ssh` (git/README.md "Transports").
};

// INSERTION POINT (storage): `export { RepoDO } from "./repo/durable-object"`
// and `export { TerraformStateDO } from ...`, with the `durable_objects` and
// `migrations` blocks of wrangler.jsonc switched on in the same change.
