// `infrawrench login | logout | whoami` — cloud session management. The CLI
// shares the desktop app's session (same encrypted token rows in SQLite), so
// signing in from either side signs in both.
import { shell } from "electron";
import http from "node:http";
import crypto from "node:crypto";
import {
  createPkceChallenge,
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  getAuthStatus,
  clearStoredTokens,
  fetchCloudOrgs,
} from "../../cloud-tokens";
import { CliError, type CliContext } from "../context";
import { c, println, printJson } from "../output";

// Loopback redirect port for the PKCE callback. Must be whitelisted as
// http://127.0.0.1:43117/callback on the WorkOS application.
const LOGIN_PORT = 43117;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

const CALLBACK_HTML = `<!doctype html><meta charset="utf-8"><title>Infrawrench</title>
<body style="font-family:system-ui;display:grid;place-items:center;height:90vh;background:#0b0e14;color:#e6e6e6">
<div style="text-align:center"><h2>Signed in to Infrawrench</h2><p>You can close this tab and return to your terminal.</p></div>`;

export async function cmdLogin(ctx: CliContext): Promise<void> {
  if (ctx.guiRunning) {
    throw new CliError(
      "The Infrawrench desktop app is running — sign in from the app instead; the CLI shares its session.",
    );
  }
  const status = await getAuthStatus();
  if (status.authenticated) {
    println(
      `Already signed in as ${c.bold(status.email ?? "unknown")}. Run \`infrawrench logout\` first to switch accounts.`,
    );
    return;
  }

  const challenge = createPkceChallenge();
  const redirectUri = `http://127.0.0.1:${LOGIN_PORT}/callback`;
  const authorizeUrl = buildAuthorizeUrl(challenge, redirectUri);

  const email = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
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
          server.close();
          resolve(result.email);
        })
        .catch((e: unknown) => {
          res.writeHead(500, { "Content-Type": "text/plain" }).end("Token exchange failed.");
          server.close();
          reject(e instanceof Error ? e : new Error(String(e)));
        });
    });
    server.on("error", (e) => {
      reject(
        new CliError(
          `Couldn't listen on 127.0.0.1:${LOGIN_PORT} (${e.message}). Is another login in progress?`,
        ),
      );
    });
    server.listen(LOGIN_PORT, "127.0.0.1", () => {
      println(`Opening your browser to sign in…`);
      println(c.dim(`If it doesn't open, visit:\n  ${authorizeUrl}`));
      void shell.openExternal(authorizeUrl);
    });
    setTimeout(() => {
      server.close();
      reject(new CliError("Sign-in timed out after 5 minutes."));
    }, LOGIN_TIMEOUT_MS).unref();
  });

  println(`${c.green("✓")} Signed in as ${c.bold(email)}`);
}

export async function cmdLogout(ctx: CliContext): Promise<void> {
  if (ctx.guiRunning) {
    throw new CliError(
      "The Infrawrench desktop app is running — sign out from the app instead (the CLI shares its session).",
    );
  }
  const status = await getAuthStatus();
  await clearStoredTokens();
  if (ctx.flags.output === "json") {
    printJson({ signedOut: status.authenticated });
    return;
  }
  println(
    status.authenticated
      ? `${c.green("✓")} Signed out${status.email ? ` (${status.email})` : ""}.`
      : "Not signed in.",
  );
}

export async function cmdWhoami(ctx: CliContext): Promise<void> {
  const status = await getAuthStatus();
  if (ctx.flags.output === "json") {
    const orgs = status.authenticated ? await fetchCloudOrgs() : [];
    printJson({ ...status, orgs });
    return;
  }
  if (!status.authenticated) {
    println("Not signed in. Run `infrawrench login`, or sign in from the desktop app.");
    return;
  }
  println(`Signed in as ${c.bold(status.email ?? "unknown")}`);
  const orgs = await fetchCloudOrgs();
  if (orgs.length > 0) {
    println(c.dim(`Organizations: ${orgs.map((o) => o.displayName).join(", ")}`));
  }
}
