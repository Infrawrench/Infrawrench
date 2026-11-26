/**
 * A person's T3 Code environments (`git_t3_environments`), where the forge is
 * an OAuth client of the environment's MCP server.
 *
 * Not built yet: every endpoint answers 503 `not_implemented`, and so does
 * the browser's way back (`../../t3/callback.ts`, `AUTH_PATHS.t3Callback`).
 * What is already in place for whoever builds it:
 *
 * - **Tokens are encrypted at rest** with server-core's `encrypt` and
 *   `decrypt` under `ENCRYPTION_MASTER_KEY`, which this Worker already has.
 *   The client secret, the access and refresh tokens and the PKCE verifier
 *   of a sign-in in progress are one JSON object in `credentials_ciphertext`
 *   and `credentials_iv`, bound to the row with
 *   `buildAad("gitT3Environment", id, "credentials")`. Nothing here is ever
 *   sent to a client or logged.
 * - The group is session only (`middleware.ts` `SESSION_ONLY`), like the
 *   rest of a person's credentials.
 * - A base URL is somebody's address: fetch it only if it is public, the way
 *   `images/proxy.ts` does.
 * - Write handlers with `op` (`../context.ts`), as every other group does.
 */
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { GitApi, notImplemented } from "@infrawrench/git-contract";

/** Until an endpoint is built it answers the contract's 503 `not_implemented`, after its gates have run. */
const unbuilt = (what: string) => Effect.die(notImplemented(what));

export const T3Handlers = HttpApiBuilder.group(GitApi, "t3", (handlers) =>
  handlers
    .handle("list", () => unbuilt("T3 Code environments"))
    .handle("create", () => unbuilt("Adding a T3 Code environment"))
    .handle("update", () => unbuilt("T3 Code environments"))
    .handle("remove", () => unbuilt("T3 Code environments"))
    .handle("beginOAuth", () => unbuilt("Signing in to T3 Code"))
    .handle("listThreads", () => unbuilt("T3 Code threads")),
);
