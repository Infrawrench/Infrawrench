/**
 * The two entry points `src/index.ts` wires in: `gitFetch` for the HTTP
 * routes (null when the request is not git's) and `gitConnect` for SSH.
 * Both resolve people and repositories from Postgres.
 */
import type { Socket } from "@cloudflare/workers-types/index";
import type { WaitUntil } from "../db/client";
import type { Env } from "../env";
import { databaseDirectory } from "./directory-db";
import { gitHttp } from "./http/routes";
import { sshConnect } from "./ssh/host";
import { cacheFailureLimiter, defaultCache } from "./ssh/rate-limit";

export function gitFetch(request: Request, env: Env, ctx: WaitUntil): Promise<Response | null> {
  return gitHttp(request, env, databaseDirectory(env, ctx));
}

export function gitConnect(socket: Socket, env: Env, ctx: WaitUntil): Promise<void> {
  return sshConnect(socket, env, {
    directory: databaseDirectory(env, ctx),
    limiter: cacheFailureLimiter(defaultCache()),
    log: (line) => console.log(line),
  });
}
