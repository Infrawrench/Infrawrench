// `infrawrench login | logout | whoami`: cloud session management. The CLI
// shares the desktop app's session (same encrypted token rows in SQLite), so
// signing in from either side signs in both.
import { shell } from "electron";
import http from "node:http";
import crypto from "node:crypto";
import { Effect } from "effect";
import { Command } from "effect/cli";
import {
  buildAuthorizeUrl,
  clearStoredTokens,
  createPkceChallenge,
  exchangeAuthorizationCode,
  type PkceChallenge,
} from "../../cloud-tokens";
import { CloudApi } from "../effect/cloud-api";
import { CliFailure } from "../effect/errors";
import * as Print from "../effect/print";
import { CliSession } from "../effect/session";
import { c, println } from "../output";

// Loopback redirect port for the PKCE callback. Must be whitelisted as
// http://127.0.0.1:43117/callback on the WorkOS application.
const LOGIN_PORT = 43117;

const CALLBACK_HTML = `<!doctype html><meta charset="utf-8"><title>Infrawrench</title>
<body style="font-family:system-ui;display:grid;place-items:center;height:90vh;background:#0b0e14;color:#e6e6e6">
<div style="text-align:center"><h2>Signed in to Infrawrench</h2><p>You can close this tab and return to your terminal.</p></div>`;

const loopbackServer = Effect.acquireRelease(
  Effect.sync(() => http.createServer()),
  (server) => Effect.sync(() => void server.close()),
);

/**
 * Listen on the loopback port, open the browser, and wait for the redirect.
 * Resolves with the signed-in email. A bad `state` is answered 400 and the
 * wait goes on; a failed token exchange is a defect (its stack is the only
 * useful thing to show).
 */
const awaitBrowserSignIn = (
  server: http.Server,
  challenge: PkceChallenge,
  authorizeUrl: string,
): Effect.Effect<string, CliFailure> =>
  Effect.callback<string, CliFailure>((resume) => {
    server.on("request", (req: http.IncomingMessage, res: http.ServerResponse) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${LOGIN_PORT}`);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (
        !code ||
        !state ||
        state.length !== challenge.state.length ||
        !crypto.timingSafeEqual(Buffer.from(state), Buffer.from(challenge.state))
      ) {
        res.writeHead(400, { "Content-Type": "text/plain" }).end("Sign-in rejected (bad state).");
        return;
      }
      exchangeAuthorizationCode(code, challenge.codeVerifier)
        .then((result) => {
          res.writeHead(200, { "Content-Type": "text/html" }).end(CALLBACK_HTML);
          resume(Effect.succeed(result.email));
        })
        .catch((e: unknown) => {
          res.writeHead(500, { "Content-Type": "text/plain" }).end("Token exchange failed.");
          resume(Effect.die(e));
        });
    });
    server.on("error", (e) => {
      resume(
        Effect.fail(
          new CliFailure({
            message: `Couldn't listen on 127.0.0.1:${LOGIN_PORT} (${e.message}). Is another login in progress?`,
          }),
        ),
      );
    });
    server.listen(LOGIN_PORT, "127.0.0.1", () => {
      println(`Opening your browser to sign in…`);
      println(c.dim(`If it doesn't open, visit:\n  ${authorizeUrl}`));
      void shell.openExternal(authorizeUrl);
    });
  });

export const login = Command.make(
  "login",
  {},
  Effect.fn("login")(function* () {
    const session = yield* CliSession;
    const api = yield* CloudApi;
    if (session.guiRunning) {
      return yield* new CliFailure({
        message:
          "The Infrawrench desktop app is running. Sign in from the app instead; the CLI shares its session.",
      });
    }
    const status = yield* api.authStatus;
    if (status.authenticated) {
      return yield* Print.line(
        `Already signed in as ${c.bold(status.email ?? "unknown")}. Run \`infrawrench logout\` first to switch accounts.`,
      );
    }

    const challenge = createPkceChallenge();
    const authorizeUrl = buildAuthorizeUrl(challenge, `http://127.0.0.1:${LOGIN_PORT}/callback`);
    const email = yield* Effect.scoped(
      Effect.flatMap(loopbackServer, (server) =>
        awaitBrowserSignIn(server, challenge, authorizeUrl),
      ),
    ).pipe(
      Effect.timeoutOrElse({
        duration: "5 minutes",
        orElse: () =>
          Effect.fail(new CliFailure({ message: "Sign-in timed out after 5 minutes." })),
      }),
    );
    yield* Print.line(`${c.green("✓")} Signed in as ${c.bold(email)}`);
  }),
).pipe(Command.withDescription("Sign in to Infrawrench Cloud (browser PKCE)"));

export const logout = Command.make(
  "logout",
  {},
  Effect.fn("logout")(function* () {
    const session = yield* CliSession;
    const api = yield* CloudApi;
    if (session.guiRunning) {
      return yield* new CliFailure({
        message:
          "The Infrawrench desktop app is running. Sign out from the app instead (the CLI shares its session).",
      });
    }
    const status = yield* api.authStatus;
    yield* Effect.promise(clearStoredTokens);
    if (session.output === "json") {
      return yield* Print.json({ signedOut: status.authenticated });
    }
    yield* Print.line(
      status.authenticated
        ? `${c.green("✓")} Signed out${status.email ? ` (${status.email})` : ""}.`
        : "Not signed in.",
    );
  }),
).pipe(Command.withDescription("Sign out"));

export const whoami = Command.make(
  "whoami",
  {},
  Effect.fn("whoami")(function* () {
    const session = yield* CliSession;
    const api = yield* CloudApi;
    const status = yield* api.authStatus;
    if (session.output === "json") {
      const orgs = status.authenticated ? yield* api.orgs : [];
      return yield* Print.json({ ...status, orgs });
    }
    if (!status.authenticated) {
      return yield* Print.line(
        "Not signed in. Run `infrawrench login`, or sign in from the desktop app.",
      );
    }
    yield* Print.line(`Signed in as ${c.bold(status.email ?? "unknown")}`);
    const orgs = yield* api.orgs;
    if (orgs.length > 0) {
      yield* Print.line(c.dim(`Organizations: ${orgs.map((o) => o.displayName).join(", ")}`));
    }
  }),
).pipe(Command.withDescription("Show the current session"));
