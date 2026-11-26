/**
 * Serving the JSON API: `@infrawrench/git-contract`'s `GitApi` with every
 * group's handlers and the three middlewares, as one `fetch`-shaped handler
 * over `/api`.
 *
 * Call {@link GitApiHandler.handle} inside `withDb` (`db/client.ts`): the
 * request scope it opened is captured here, synchronously, and carried on the
 * fiber for every query a handler makes (`./context.ts`).
 */
import { Context, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import {
  type Authentication,
  GitApi,
  type RepositoryAccess,
  type RequestErrors,
} from "@infrawrench/git-contract";
import { currentRequestScope } from "@infrawrench/server-core/runtime/request-scope";
import { type Authenticated, apiAcceptsRefTokens, authenticateRequest } from "../auth/authenticate";
import { type Admit, admissionFor } from "../http/admission";
import type { Env } from "../env";
import { type RepoReaderFactory, repoReaderFor } from "../repo/select";
import { type Invocation, InvocationRef } from "./context";
import { json } from "./errors";
import { AgentsHandlers, ReviewSettingsHandlers } from "./handlers/agents";
import { CiHandlers, StatusesHandlers, TerraformHandlers } from "./handlers/automation";
import { ContentsHandlers } from "./handlers/contents";
import { FindingsHandlers } from "./handlers/findings";
import { InstructionsHandlers } from "./handlers/instructions";
import { IssuesHandlers, LabelsHandlers, MilestonesHandlers } from "./handlers/issues";
import { PullsHandlers } from "./handlers/pulls";
import { RepositoriesHandlers, RepositoryListsHandlers } from "./handlers/repositories";
import { NamespacesHandlers, SessionHandlers } from "./handlers/session";
import {
  AccountHandlers,
  CollaboratorsHandlers,
  DeployKeysHandlers,
  ProtectedBranchesHandlers,
} from "./handlers/settings";
import { T3Handlers } from "./handlers/t3";
import { TracesHandlers } from "./handlers/traces";
import { ReviewHandlers, VersionsHandlers } from "./handlers/versions";
import { WorkspaceHandlers } from "./handlers/workspace";
import { MiddlewareLive } from "./middleware";

/** Every group's handlers. A group added to `GitApi` without one here does not typecheck. */
export const HandlersLive = Layer.mergeAll(
  SessionHandlers,
  NamespacesHandlers,
  RepositoryListsHandlers,
  RepositoriesHandlers,
  ContentsHandlers,
  IssuesHandlers,
  PullsHandlers,
  VersionsHandlers,
  TracesHandlers,
  FindingsHandlers,
  InstructionsHandlers,
  AgentsHandlers,
  ReviewSettingsHandlers,
  ReviewHandlers,
  WorkspaceHandlers,
  T3Handlers,
  LabelsHandlers,
  MilestonesHandlers,
  CollaboratorsHandlers,
  ProtectedBranchesHandlers,
  DeployKeysHandlers,
  AccountHandlers,
  StatusesHandlers,
  CiHandlers,
  TerraformHandlers,
);

/** An `/api` path no endpoint routes: the API's own 404, never the SPA's shell. */
const Unmatched = HttpRouter.add("*", "/api/*", json({ error: "Not found" }, 404));

export interface GitApiOptions {
  /** Resolves a request's credential. Tests pass a fixed caller. */
  readonly authenticate?: (request: Request, env: Env) => Promise<Authenticated>;
  /**
   * Counts a request against the caller it authenticated as. The Worker's
   * own admission unless a test passes another.
   */
  readonly admit?: Admit;
  /** Makes a repository's reader. Tests pass a fake. */
  readonly readers?: RepoReaderFactory;
  /**
   * The middleware implementations. Tests that run handlers as a fixed
   * caller on a fixed repository, without a database, pass their own.
   */
  readonly middleware?: Layer.Layer<Authentication | RepositoryAccess | RequestErrors>;
}

export interface GitApiHandler {
  handle(
    request: Request,
    env: Env,
    ctx: { waitUntil(promise: Promise<unknown>): void },
  ): Promise<Response>;
}

export const makeGitApi = (options: GitApiOptions = {}): GitApiHandler => {
  const App = Layer.mergeAll(
    HttpApiBuilder.layer(GitApi).pipe(Layer.provide(HandlersLive)),
    Unmatched,
  ).pipe(
    Layer.provide(options.middleware ?? MiddlewareLive),
    Layer.provide(HttpServer.layerServices),
  );
  // Built on first use: evaluating every group's layer is not start-up work.
  let web: ReturnType<typeof build> | undefined;
  const build = () => HttpRouter.toWebHandler(App, { disableLogger: true });

  return {
    async handle(request, env, ctx) {
      web ??= build();
      const invocation: Invocation = {
        env,
        request,
        waitUntil: (promise) => ctx.waitUntil(promise),
        scope: currentRequestScope(),
        readers: options.readers ?? repoReaderFor,
        // A job token bound to a branch is taken only on its trace and
        // instructions paths; `JOB_GROUPS` (middleware.ts) still applies.
        authenticate:
          options.authenticate ??
          ((incoming, environment) =>
            authenticateRequest(incoming, environment, {
              refTokens: apiAcceptsRefTokens(new URL(incoming.url).pathname),
            })),
        admit:
          options.admit ?? ((counted, principal) => admissionFor(env).admit(counted, principal)),
        cookies: [],
      };
      // HEAD is the GET route without its body.
      const head = request.method === "HEAD";
      // Detached from the client's abort signal: a handler that has started a
      // write runs to its end rather than stopping between two steps of it.
      const routed = new Request(request, { ...(head ? { method: "GET" } : {}), signal: null });
      const response = await web.handler(routed, Context.make(InvocationRef, invocation));
      const headers = new Headers(response.headers);
      for (const cookie of invocation.cookies) headers.append("set-cookie", cookie);
      // Every answer depends on who asked: no cache between the browser and
      // us keeps one, and no page elsewhere may load one as a subresource.
      headers.set("cache-control", "private, no-store");
      headers.set("cross-origin-resource-policy", "same-origin");
      if (head) await response.body?.cancel();
      return new Response(head ? null : response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    },
  };
};
