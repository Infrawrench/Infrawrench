/**
 * git.infrawrench.com: the composition root. Routing, auth, the API, the
 * queue consumer and (when they exist) the Durable Objects live in their own
 * modules; this file only wires them together.
 *
 * The server code is loaded on first use, not at start-up: evaluating the
 * API's layers and server-core's schema is not work a Worker's start-up
 * budget covers (KNOWLEDGE.md "Edge/gateway split").
 */
import type {
  ExecutionContext,
  MessageBatch,
  ScheduledController,
  Socket,
} from "@cloudflare/workers-types/index";
import { type Env, type GitEvent, siteOrigin } from "./env";
import { type Ctx, type Routes, serve } from "./http/router";

const lazy = <T>(load: () => Promise<T>): (() => Promise<T>) => {
  let loaded: Promise<T> | undefined;
  return () => (loaded ??= load());
};

const api = lazy(async () => (await import("./api/server")).makeGitApi());
const transport = lazy(() => import("./transport/mount"));

/** Smart HTTP and the raw and archive routes: `transport/http/routes.ts` matches them again itself. */
const git = async (request: Request, env: Env, ctx: Ctx): Promise<Response> =>
  (await (await transport()).gitFetch(request, env, ctx)) ??
  new Response("Not Found", { status: 404 });
const database = lazy(() => import("./db/client"));
const terraform = lazy(() => import("./terraform/mount"));

const routes: Routes = {
  api: async (request, env, ctx) => {
    const [{ withDb }, handler] = await Promise.all([database(), api()]);
    return withDb(env, ctx, () => handler.handle(request, env, ctx));
  },

  auth: async (request, env, ctx, route) => {
    const signIn = await import("./auth/sign-in");
    if (route.action === "sign-in") return signIn.handleSignIn(request, env);
    if (route.action === "sign-out") return signIn.handleSignOut(request, env);
    // A T3 Code environment's OAuth redirect (`t3/callback.ts`).
    if (route.action === "t3-callback") {
      return (await import("./t3/callback")).handleT3Callback(request, env);
    }
    const [{ withDb }, { provisionSignedInUser }] = await Promise.all([
      database(),
      import("./db/users"),
    ]);
    return withDb(env, ctx, () =>
      signIn.handleCallback(request, env, { provision: provisionSignedInUser }),
    );
  },

  smartHttp: git,
  raw: git,
  archive: git,

  // Terraform's `http` backend and a run's plan (`terraform/mount.ts`).
  terraformState: async (request, env, ctx, route) =>
    (await terraform()).stateFetch(request, env, ctx, route),
  terraformPlan: async (request, env, ctx, route) =>
    (await terraform()).planFetch(request, env, ctx, route),

  // An image from another site, fetched so its host never sees the reader (`images/proxy.ts`).
  imageProxy: async (request, env) => {
    const { proxyImage } = await import("./images/proxy");
    return proxyImage(request, {
      fetch: (input, init) => fetch(input, init),
      siteHosts: [new URL(request.url).hostname, new URL(siteOrigin(env)).hostname],
    });
  },
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

  /** The cron trigger (`wrangler.jsonc`): versions whose thirty days are up (`review/prune.ts`). */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const [{ withDb }, { pruneVersions }] = await Promise.all([
      database(),
      import("./review/prune"),
    ]);
    await withDb(env, ctx, async () => {
      await pruneVersions(env);
    });
  },

  /** Git over SSH: inbound TCP, through Spectrum in production (git/README.md "Transports"). */
  async connect(socket: Socket, env: Env, ctx: ExecutionContext): Promise<void> {
    await (await transport()).gitConnect(socket, env, ctx);
  },
};

// One Durable Object per repository: refs, the pack catalogue, and the git protocol itself.
export { RepoDO } from "./repo/do/repo-do";

// One Durable Object per Terraform workspace: the state's lock, its current version and its catalogue.
export { TerraformStateDO } from "./terraform/state-do";
