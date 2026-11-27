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
import { type Env, type GitEvent, type GitReviewMessage, siteOrigin, sshEnabled } from "./env";
import { type Ctx, type Routes, serve } from "./http/router";

/** The review queue's name (`wrangler.jsonc`). Spelled here so nothing is imported to route a batch. */
const REVIEW_QUEUE = "infrawrench-git-reviews";

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
const mcp = lazy(() => import("./mcp/mount"));
const og = lazy(() => import("./og/mount"));

/** The cron expression of the instruction sweep, as `wrangler.jsonc` spells it. */
const INSTRUCTIONS_CRON = "*/2 * * * *";

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
    // A T3 Code environment's OAuth redirect (`t3/callback.ts`): the session says whose sign-in it is.
    if (route.action === "t3-callback") {
      const [{ handleT3Callback }, { authenticateRequest }] = await Promise.all([
        import("./t3/callback"),
        import("./auth/authenticate"),
      ]);
      return withDb(env, ctx, () =>
        handleT3Callback(request, env, { authenticate: authenticateRequest }),
      );
    }
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

  // The MCP server agents connect to. Its tools call the API above, in this process (`mcp/mount.ts`).
  mcp: async (request, env, ctx) => {
    const [{ mcpFetch }, handler] = await Promise.all([mcp(), api()]);
    return mcpFetch(request, env, ctx, handler);
  },
  // The authorization server MCP clients sign in through, and where they find it (`mcp/oauth/`).
  oauth: async (request, env, ctx, route) =>
    (await mcp()).oauthFetch(request, env, ctx, route.action),
  wellKnown: async (request, env) => (await mcp()).wellKnownFetch(request, env),

  // An image from another site, fetched so its host never sees the reader (`images/proxy.ts`).
  imageProxy: async (request, env) => {
    const { proxyImage } = await import("./images/proxy");
    return proxyImage(request, {
      fetch: (input, init) => fetch(input, init),
      siteHosts: [new URL(request.url).hostname, new URL(siteOrigin(env)).hostname],
    });
  },

  // Link previews, as a signed-out visitor sees the page: the tags in a page's
  // shell, and the image they name (`og/mount.ts`).
  page: async (request, env, ctx, shell) => (await og()).pageFetch(request, env, ctx, shell),
  ogImage: async (request, env, ctx) => (await og()).ogImageFetch(request, env, ctx),
};

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return serve(request, env, ctx, routes);
  },

  /**
   * `infrawrench-git-events`: what a push leaves behind (`events/consumer.ts`).
   * `infrawrench-git-reviews`: a review run (`review/queue.ts`).
   */
  async queue(
    batch: MessageBatch<GitEvent | GitReviewMessage>,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    if (batch.queue === REVIEW_QUEUE) {
      const { consumeReviewRuns } = await import("./review/queue");
      await consumeReviewRuns(batch as MessageBatch<GitReviewMessage>, env, ctx);
      return;
    }
    const { consumeGitEvents } = await import("./events/consumer");
    await consumeGitEvents(batch as MessageBatch<GitEvent>, env, ctx);
  },

  /**
   * The cron triggers (`wrangler.jsonc`). Hourly: the refs of versions whose thirty days
   * are up and traces no push claimed (`review/prune.ts`), and review runs nothing finished
   * (`review/queue.ts`). Every two minutes: instructions still waiting for an
   * agent the forge can tell itself (`review/instructions.ts`).
   */
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const { withDb } = await database();
    if (event.cron === INSTRUCTIONS_CRON) {
      const { sweepInstructions } = await import("./review/instructions");
      await withDb(env, ctx, async () => {
        await sweepInstructions(env);
      });
      return;
    }
    const [{ pruneVersions, pruneStaleTraces }, { sweepReviewRuns }] = await Promise.all([
      import("./review/prune"),
      import("./review/queue"),
    ]);
    await withDb(env, ctx, async () => {
      await pruneVersions(env);
      await sweepReviewRuns(env);
      await pruneStaleTraces();
    });
  },

  /** Git over SSH: inbound TCP, through Spectrum in production (git/README.md "Transports"). */
  async connect(socket: Socket, env: Env, ctx: ExecutionContext): Promise<void> {
    // Turned off (`SSH_ENABLED`): nothing is read from the connection.
    if (!sshEnabled(env)) {
      await socket.close();
      return;
    }
    await (await transport()).gitConnect(socket, env, ctx);
  },
};

// One Durable Object per repository: refs, the pack catalogue, and the git protocol itself.
export { RepoDO } from "./repo/do/repo-do";

// One Durable Object per Terraform workspace: the state's lock, its current version and its catalogue.
export { TerraformStateDO } from "./terraform/state-do";
