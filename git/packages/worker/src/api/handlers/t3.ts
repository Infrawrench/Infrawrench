/**
 * A person's T3 Code environments (`git_t3_environments`), where the forge is
 * an OAuth client of the environment's MCP server.
 *
 * - **Adding one** stores its address and nothing else; it is `pending`
 *   until the person signs in to it. Through T3 Connect (`via:
 *   "t3-connect"`, what the form does first) the address has to be a T3
 *   Connect tunnel's (`t3/connect.ts`); typed as an address it has to be
 *   `https:` and on the public internet (`t3/http.ts`). This Worker cannot
 *   reach a machine's `localhost`, and says so, pointing at T3 Connect.
 * - **`beginOAuth`** discovers the environment's sign-in, registers this
 *   site with it and answers where to send the browser. The browser comes
 *   back to `AUTH_PATHS.t3Callback` (`t3/callback.ts`).
 * - **Tokens are sealed** (`t3/environments.ts`) and never part of an answer.
 * - **`listThreads`** asks the environment itself, for the picker that names
 *   the thread behind a branch, and **`listModels`** for the one that names
 *   the model a new thread runs. Given a repository, `listModels` also says
 *   the default of the environment's project for it; the name is only
 *   compared with the projects' remotes, so naming a repository the caller
 *   cannot read answers nothing about it.
 *
 * The group is session only (`middleware.ts` `SESSION_ONLY`), like the rest
 * of a person's credentials, and every row is read through its owner's id:
 * somebody else's environment is a 404.
 */
import { HttpApiBuilder } from "effect/http-api";
import {
  GitApi,
  type T3Environment,
  badRequest,
  conflict,
  notFound,
  ok,
  unauthorized,
  unprocessable,
} from "@infrawrench/git-contract";
import type { Cx } from "../context";
import { op } from "../context";
import { T3_SETTINGS_PATH } from "../../t3/callback";
import {
  type EnvironmentRow,
  MAX_ENVIRONMENTS,
  beginSignIn,
  createEnvironment,
  getEnvironment,
  listEnvironments,
  removeEnvironment,
  renameEnvironment,
  safeReturnTo,
  t3Deps,
} from "../../t3/environments";
import { connectOrigin } from "../../t3/connect";
import { T3Error, environmentOrigin } from "../../t3/http";
import { listModels, listThreads } from "../../t3/work";
import { iso, isoOrNull } from "../views/repositories";

const view = (row: EnvironmentRow): T3Environment => ({
  id: row.id,
  label: row.label,
  baseUrl: row.baseUrl,
  status: row.status,
  scopes: [...row.scopes],
  tokenExpiresAt: isoOrNull(row.tokenExpiresAt),
  lastError: row.lastError,
  lastUsedAt: isoOrNull(row.lastUsedAt),
  createdAt: iso(row.createdAt),
  updatedAt: iso(row.updatedAt),
});

const userOf = (cx: Cx): string => {
  if (cx.userId === null) throw unauthorized();
  return cx.userId;
};

const environmentOr404 = async (cx: Cx, environmentId: string): Promise<EnvironmentRow> => {
  const row = await getEnvironment(userOf(cx), environmentId);
  if (!row) throw notFound("No such environment");
  return row;
};

/**
 * An environment that did not do what was asked is the request's failure to
 * report, in the environment's own terms: 422 with the sentence.
 */
export const refuseT3 = (error: unknown): never => {
  if (error instanceof T3Error) throw unprocessable(error.message);
  throw error;
};

export const T3Handlers = HttpApiBuilder.group(GitApi, "t3", (handlers) =>
  handlers
    .handle(
      "list",
      op(async (cx) => ({ environments: (await listEnvironments(userOf(cx))).map(view) })),
    )
    .handle(
      "create",
      op(async (cx, { payload }) => {
        const userId = userOf(cx);
        const deps = t3Deps(cx.env, cx.request);
        let origin: string;
        try {
          origin =
            payload.via === "t3-connect"
              ? connectOrigin(payload.baseUrl, deps.siteHosts)
              : environmentOrigin(payload.baseUrl, deps.siteHosts);
        } catch (error) {
          throw badRequest(error instanceof T3Error ? error.message : "That is not an address");
        }
        if ((await listEnvironments(userId)).length >= MAX_ENVIRONMENTS) {
          throw unprocessable(`You can connect ${MAX_ENVIRONMENTS} environments at most`);
        }
        const row = await createEnvironment(userId, payload.label.trim(), origin);
        if (!row) throw conflict("You already have an environment at that address");
        return view(row);
      }),
    )
    .handle(
      "update",
      op(async (cx, { params, payload }) => {
        const row = await environmentOr404(cx, params.environmentId);
        const label = payload.label?.trim();
        if (label === undefined) return view(row);
        if (label === "") throw badRequest("Give the environment a name");
        return view(await renameEnvironment(row, label));
      }),
    )
    .handle(
      "remove",
      op(async (cx, { params }) => {
        const row = await environmentOr404(cx, params.environmentId);
        await removeEnvironment(t3Deps(cx.env, cx.request), row);
        return ok;
      }),
    )
    .handle(
      "beginOAuth",
      op(async (cx, { params, payload }) => {
        const row = await environmentOr404(cx, params.environmentId);
        try {
          return {
            authorizeUrl: await beginSignIn(
              t3Deps(cx.env, cx.request),
              row,
              safeReturnTo(payload.returnTo, T3_SETTINGS_PATH),
            ),
          };
        } catch (error) {
          return refuseT3(error);
        }
      }),
    )
    .handle(
      "listThreads",
      op(async (cx, { params, query }) => {
        const row = await environmentOr404(cx, params.environmentId);
        try {
          return { threads: await listThreads(t3Deps(cx.env, cx.request), row, query.q) };
        } catch (error) {
          return refuseT3(error);
        }
      }),
    )
    .handle(
      "listModels",
      op(async (cx, { params, query }) => {
        const row = await environmentOr404(cx, params.environmentId);
        const owner = query.owner?.trim() ?? "";
        const name = query.repo?.trim() ?? "";
        try {
          return await listModels(
            t3Deps(cx.env, cx.request),
            row,
            owner === "" || name === "" ? null : { owner, name },
          );
        } catch (error) {
          return refuseT3(error);
        }
      }),
    ),
);
