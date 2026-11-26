/**
 * What `src/index.ts` wires for Terraform: the state backend and the plan
 * route, over Postgres and the workspaces' Durable Objects.
 */
import type { Env } from "../env";
import type { Ctx, Route } from "../http/router";
import type { Bucket } from "../repo/do/platform";
import { stateClient } from "./client";
import { terraformDirectory } from "./directory-db";
import { type TerraformRouteDeps, terraformPlan, terraformState } from "./route";

const deps = (env: Env, ctx: Ctx): TerraformRouteDeps => ({
  directory: terraformDirectory(env, ctx),
  client: (workspaceId) => stateClient(env, workspaceId),
  bucket: env.OBJECTS as unknown as Bucket,
});

export const stateFetch = (
  request: Request,
  env: Env,
  ctx: Ctx,
  route: Extract<Route, { kind: "terraform-state" }>,
): Promise<Response> => terraformState(request, route, deps(env, ctx));

export const planFetch = (
  request: Request,
  env: Env,
  ctx: Ctx,
  route: Extract<Route, { kind: "terraform-plan" }>,
): Promise<Response> => terraformPlan(request, route, deps(env, ctx));
