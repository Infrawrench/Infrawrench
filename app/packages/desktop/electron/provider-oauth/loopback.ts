/**
 * The desktop's half of a native-app OAuth flow (RFC 8252): a one-shot HTTP
 * listener on the loopback interface that receives the provider's redirect.
 *
 * Pure Node (no Electron): the caller supplies how to open the browser, so
 * the flow is testable without a window. It listens only on loopback
 * addresses, accepts exactly one well-formed callback whose `state` matches,
 * gives up after a timeout or an abort, and always closes the server.
 */
import http from "node:http";
import crypto from "node:crypto";
import {
  DESKTOP_OAUTH_LOOPBACK_PATH,
  DESKTOP_OAUTH_LOOPBACK_PORT,
  buildOAuthAuthorizeUrl,
  createPkcePair,
  desktopOAuthRedirectUri,
  randomOAuthToken,
  type OAuthAuthorizeUrlParams,
  type OAuthDeclaration,
} from "@infrawrench/plugin-base";

export const LOOPBACK_TIMEOUT_MS = 5 * 60 * 1000;

/** What the caller does with the code before the browser tab is answered. */
/** The client the flow runs as. `clientId` is empty for `clientRegistration: "none"`. */
export interface LoopbackClient {
  clientId: string;
  clientSecret?: string;
}

export interface LoopbackCodeHandlerArgs {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  client: LoopbackClient;
}

export interface LoopbackFlowOptions<T> {
  declaration: OAuthDeclaration;
  /**
   * The client: fixed (a build-time id, or none), or obtained once the
   * redirect URI is known (dynamic client registration, which runs after the
   * listener is up and before the authorize URL is built).
   */
  client: LoopbackClient | ((redirectUri: string) => Promise<LoopbackClient>);
  /** The plugin's own authorize URL builder, when it has one. */
  buildAuthorizeUrl?: (params: OAuthAuthorizeUrlParams) => string;
  /** Open the authorize URL in the user's browser. */
  openExternal: (url: string) => void | Promise<void>;
  /** Exchange the code (and anything else); its outcome decides the page the user sees. */
  onCode: (args: LoopbackCodeHandlerArgs) => Promise<T>;
  /** Provider name for the result page. */
  providerName: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Override for tests; production always uses the fixed registered port. */
  port?: number;
}

export class LoopbackFlowError extends Error {
  constructor(
    message: string,
    readonly reason: "cancelled" | "timeout" | "denied" | "port-in-use" | "failed",
  ) {
    super(message);
    this.name = "LoopbackFlowError";
  }
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

/** The small page the browser tab shows once the flow is over. No script. */
export function resultPage(ok: boolean, title: string, detail: string): string {
  const color = ok ? "#16a34a" : "#dc2626";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Infrawrench</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;background:#f8fafc;color:#0f172a;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
main{max-width:28rem;padding:2rem;text-align:center}h1{font-size:1.25rem;color:${color};margin:0 0 .5rem}p{color:#475569;line-height:1.5}
@media (prefers-color-scheme:dark){body{background:#0b1120;color:#e2e8f0}p{color:#94a3b8}}</style></head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></main></body></html>`;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/** Loopback addresses to listen on for the declared redirect host. */
export function loopbackListenHosts(declaration: OAuthDeclaration): string[] {
  // `localhost` may resolve to either family in the browser; listen on both.
  return declaration.clients.desktop?.loopbackHost === "localhost"
    ? ["127.0.0.1", "::1"]
    : ["127.0.0.1"];
}

function listen(server: http.Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

/**
 * A flow cancelled a moment ago may still be releasing the port, so a busy
 * port gets a few short retries before it counts as taken.
 */
async function listenWithRetry(server: http.Server, host: string, port: number): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await listen(server, host, port);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE" || attempt >= 3) throw err;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
}

/**
 * Run the flow end to end: listen, open the browser, wait for the redirect,
 * hand the code to `onCode`, answer the tab, close. Resolves with `onCode`'s
 * result.
 */
export async function runLoopbackAuthorization<T>(options: LoopbackFlowOptions<T>): Promise<T> {
  const { declaration, providerName } = options;
  let client: LoopbackClient | null = typeof options.client === "function" ? null : options.client;
  const port = options.port ?? DESKTOP_OAUTH_LOOPBACK_PORT;
  const redirectUri =
    options.port === undefined
      ? desktopOAuthRedirectUri(declaration)
      : desktopOAuthRedirectUri(declaration).replace(
          `:${DESKTOP_OAUTH_LOOPBACK_PORT}/`,
          `:${options.port}/`,
        );
  const { verifier, challenge } = await createPkcePair();
  const state = randomOAuthToken();

  if (options.signal?.aborted) {
    throw new LoopbackFlowError("Connection cancelled.", "cancelled");
  }

  return new Promise<T>((resolve, reject) => {
    const servers: http.Server[] = [];
    let settled = false;
    let handling = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      for (const server of servers) {
        // Responses carry `Connection: close`, so this only drops idle sockets
        // and never cuts off the page being sent.
        server.close();
        server.closeIdleConnections();
      }
    };
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const onAbort = () =>
      finish(() => reject(new LoopbackFlowError("Connection cancelled.", "cancelled")));

    const handler: http.RequestListener = (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const send = (status: number, html: string) => {
        res.writeHead(status, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
          "Referrer-Policy": "no-referrer",
          Connection: "close",
        });
        res.end(html);
      };
      if (req.method !== "GET" || url.pathname !== DESKTOP_OAUTH_LOOPBACK_PATH) {
        res.writeHead(404, { "Content-Type": "text/plain", Connection: "close" });
        res.end("Not found");
        return;
      }
      const returnedState = url.searchParams.get("state") ?? "";
      if (settled || handling || !safeEqual(returnedState, state)) {
        // A stray or forged request: answer it but keep waiting for the real one.
        send(
          400,
          resultPage(
            false,
            "This sign-in link is not valid",
            "Start the connection again from Infrawrench.",
          ),
        );
        return;
      }
      const error = url.searchParams.get("error");
      if (error) {
        const description = url.searchParams.get("error_description") ?? error;
        send(
          400,
          resultPage(
            false,
            `${providerName} did not connect`,
            `${description}. You can close this tab and try again in Infrawrench.`,
          ),
        );
        finish(() =>
          reject(
            new LoopbackFlowError(
              error === "access_denied"
                ? `${providerName} access was not granted.`
                : `${providerName} returned an error: ${description}`,
              "denied",
            ),
          ),
        );
        return;
      }
      const code = url.searchParams.get("code");
      if (!code || !client) {
        send(400, resultPage(false, "Missing authorization code", "Try connecting again."));
        return;
      }
      handling = true;
      options.onCode({ code, codeVerifier: verifier, redirectUri, client }).then(
        (value) => {
          send(
            200,
            resultPage(
              true,
              `Connected to ${providerName}`,
              "You can close this tab and return to Infrawrench.",
            ),
          );
          finish(() => resolve(value));
        },
        (err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          send(500, resultPage(false, `${providerName} did not connect`, `${message}`));
          finish(() =>
            reject(err instanceof Error ? err : new LoopbackFlowError(message, "failed")),
          );
        },
      );
    };

    void (async () => {
      try {
        for (const [i, host] of loopbackListenHosts(declaration).entries()) {
          const server = http.createServer(handler);
          try {
            await listenWithRetry(server, host, port);
            servers.push(server);
          } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            // IPv6 loopback is a nice-to-have for `localhost`; the first host is required.
            if (i > 0 && (code === "EADDRNOTAVAIL" || code === "EAFNOSUPPORT")) continue;
            if (code === "EADDRINUSE") {
              throw new LoopbackFlowError(
                `Port ${port} is already in use, so Infrawrench cannot receive the ${providerName} sign-in. ` +
                  "Close whatever is using it (or another Connect window) and try again.",
                "port-in-use",
              );
            }
            throw err;
          }
        }
        if (settled) {
          cleanup();
          return;
        }
        timer = setTimeout(
          () =>
            finish(() =>
              reject(
                new LoopbackFlowError(
                  `Timed out waiting for ${providerName}. Start the connection again when you are ready.`,
                  "timeout",
                ),
              ),
            ),
          options.timeoutMs ?? LOOPBACK_TIMEOUT_MS,
        );
        if (typeof options.client === "function") client = await options.client(redirectUri);
        if (settled || !client) return;
        const params: OAuthAuthorizeUrlParams = {
          clientId: client.clientId,
          redirectUri,
          state,
          codeChallenge: challenge,
        };
        const authorizeUrl = options.buildAuthorizeUrl
          ? options.buildAuthorizeUrl(params)
          : buildOAuthAuthorizeUrl(declaration, params);
        await options.openExternal(authorizeUrl);
      } catch (err) {
        finish(() => reject(err));
      }
    })();

    options.signal?.addEventListener("abort", onAbort);
  });
}
