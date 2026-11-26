/**
 * `/oauth/authorize`: the one OAuth endpoint a person sees. A client sends
 * the browser here; the person signs in if they have not (the site's own
 * sign-in, and its session cookie), reads who is asking for what and where
 * the answer goes, and says yes or no.
 *
 * - **A request is checked in the order OAuth says** (RFC 6749 section
 *   4.1.2.1): until the client and its redirect URI are known to be good, a
 *   problem is shown on this page and nothing is sent anywhere; after that a
 *   problem goes back to the client as `error`. The browser is sent there by
 *   itself only when the address is this machine's, or once the person has
 *   pressed a button: a client registers itself, so an automatic redirect to
 *   whatever it registered would be an open one.
 * - **The person signs in before the client is looked at.** A client id can
 *   be the address of a document to fetch, and nothing is fetched for a
 *   visitor who has not signed in and cannot be counted.
 * - **The form carries the request sealed** (`sealed.ts`), with the person it
 *   was shown to: what is approved is exactly what was displayed, by the
 *   person it was displayed to, within ten minutes. The POST rides on the
 *   session cookie, so it must come from this page (`authenticateRequest`
 *   refuses a cookie on a write another origin sent), and the page cannot be
 *   framed (`frame-ancestors 'none'`, and `X-Frame-Options` from `serve`).
 * - **Consent is asked every time.** Nothing remembers that a client was
 *   approved before: a client id proves nothing about who presents it (any
 *   program on the machine can use another's loopback redirect), so the
 *   person's click is the check.
 * - **The page is its own document**, not a route of the UI: it loads no
 *   script and no asset, and its policy allows its one form to post here and
 *   be redirected to the client's address and nowhere else.
 */
import { signInPath } from "@infrawrench/git-contract";
import type { GitTokenScope } from "@infrawrench/server-core/db/schema";
import type { Authenticated } from "../../auth/authenticate";
import type { Principal } from "../../auth/principal";
import { randomBytes, toBase64Url } from "../../auth/encoding";
import { type OAuthClient, isLoopbackRedirect, redirectAllowed } from "./clients";
import { isCodeChallenge, issueCode } from "./grants";
import { isOurResource } from "./metadata";
import {
  OAUTH_LIFETIMES,
  type OAuthErrorCode,
  SCOPE_DESCRIPTIONS,
  parseScopes,
  readParameters,
  text,
} from "./protocol";
import { sealAs, unsealAs } from "./sealed";

export interface AuthorizeDeps {
  /** The site's origin: the issuer. */
  readonly origin: string;
  /** `WORKOS_COOKIE_PASSWORD`. */
  readonly password: string;
  readonly authenticate: (request: Request) => Promise<Authenticated>;
  readonly resolveClient: (clientId: string) => Promise<OAuthClient | null>;
  /** The signed-in person's username, for the page. Null before they have one. */
  readonly usernameOf: (userId: string) => Promise<string | null>;
  /**
   * Counts the page against the signed-in person. The 429, or null. Showing
   * the page can fetch a client's metadata document, so it has a budget.
   */
  readonly admit?: (principal: Principal) => Promise<Response | null>;
  readonly now?: number;
}

/** What the consent form carries back. */
interface ConsentRequest {
  /** The person the page was shown to. */
  readonly u: string;
  /** The client id. */
  readonly c: string;
  /** The client's name. */
  readonly n: string;
  /** The redirect URI. */
  readonly r: string;
  /** The PKCE challenge. */
  readonly k: string;
  readonly s: readonly GitTokenScope[];
  /** The client's `state`, returned as it came. */
  readonly t: string | null;
}

const isConsentRequest = (value: unknown): value is ConsentRequest => {
  if (typeof value !== "object" || value === null) return false;
  const request = value as Partial<ConsentRequest>;
  return (
    typeof request.u === "string" &&
    typeof request.c === "string" &&
    typeof request.n === "string" &&
    typeof request.r === "string" &&
    typeof request.k === "string" &&
    Array.isArray(request.s) &&
    (request.t === null || typeof request.t === "string")
  );
};

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const STYLE = `
:root { color-scheme: light dark; --bg: #fafafa; --panel: #fff; --text: #18181b; --muted: #52525b; --line: #e4e4e7; --accent: #18181b; --on-accent: #fff; --warn: #92400e; }
@media (prefers-color-scheme: dark) { :root { --bg: #0c0c0e; --panel: #151518; --text: #f4f4f5; --muted: #a1a1aa; --line: #27272a; --accent: #f4f4f5; --on-accent: #0c0c0e; --warn: #fbbf24; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; background: var(--bg); color: var(--text); font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
main { width: 100%; max-width: 440px; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 24px; }
h1 { margin: 0 0 4px; font-size: 18px; font-weight: 600; overflow-wrap: anywhere; }
p { margin: 0 0 12px; color: var(--muted); overflow-wrap: anywhere; }
ul { margin: 0 0 16px; padding: 0; list-style: none; border: 1px solid var(--line); border-radius: 8px; }
li { padding: 10px 12px; }
li + li { border-top: 1px solid var(--line); }
code { font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
dl { margin: 0 0 16px; display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; }
dt { color: var(--muted); }
dd { margin: 0; overflow-wrap: anywhere; }
.warn { color: var(--warn); }
.actions { display: flex; gap: 8px; justify-content: flex-end; }
button { font: inherit; font-weight: 500; padding: 7px 14px; border-radius: 6px; border: 1px solid var(--line); background: transparent; color: var(--text); cursor: pointer; }
button[value="allow"] { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
`;

const page = (
  title: string,
  body: string,
  options: { readonly status?: number; readonly formTarget?: string } = {},
): Response => {
  const nonce = toBase64Url(randomBytes(16));
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;
  return new Response(html, {
    status: options.status ?? 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      // The address holds the request: it goes to nobody.
      "referrer-policy": "no-referrer",
      "content-security-policy": [
        "default-src 'none'",
        `style-src 'nonce-${nonce}'`,
        // The form posts here and is then redirected to the client. Chromium
        // holds the redirect to this directive too.
        `form-action 'self'${options.formTarget ? ` ${options.formTarget}` : ""}`,
        "base-uri 'none'",
        "frame-ancestors 'none'",
      ].join("; "),
    },
  });
};

const problemPage = (message: string, status = 400): Response =>
  page(
    "Cannot authorize",
    `<h1>Cannot authorize</h1>\n<p>${escapeHtml(message)}</p>\n<p>Start again from the application that sent you here.</p>`,
    { status },
  );

/** The redirect URI with the answer's parameters, `iss` among them (RFC 9207). */
const answerUrl = (
  redirectUri: string,
  origin: string,
  parameters: Readonly<Record<string, string | null>>,
): string => {
  const url = new URL(redirectUri);
  for (const [name, value] of Object.entries(parameters)) {
    if (value !== null) url.searchParams.set(name, value);
  }
  url.searchParams.set("iss", origin);
  return url.href;
};

const redirect = (location: string, status: 302 | 303, cookies: readonly string[] = []) => {
  const headers = new Headers({ location, "cache-control": "no-store" });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(null, { status, headers });
};

const refuse = (
  redirectUri: string,
  origin: string,
  state: string | null,
  error: OAuthErrorCode,
  description: string,
  status: 302 | 303 = 302,
): Response =>
  redirect(
    answerUrl(redirectUri, origin, { error, error_description: description, state }),
    status,
  );

/** What a CSP `form-action` source for the client's address is: its origin, or its scheme. */
const formTargetOf = (redirectUri: string): string => {
  const url = new URL(redirectUri);
  return url.protocol === "http:" || url.protocol === "https:" ? url.origin : url.protocol;
};

/** Where the answer goes, as a person reads it: the host, or the app's scheme. */
const destinationOf = (redirectUri: string): string => {
  const url = new URL(redirectUri);
  return url.protocol === "http:" || url.protocol === "https:"
    ? url.host
    : `${url.protocol}//${url.host}${url.pathname}`;
};

const withCookies = (response: Response, cookies: readonly string[]): Response => {
  if (cookies.length === 0) return response;
  const headers = new Headers(response.headers);
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(response.body, { status: response.status, headers });
};

const consentPage = (
  client: OAuthClient,
  redirectUri: string,
  scopes: readonly GitTokenScope[],
  person: string,
  sealed: string,
  site: string,
): Response => {
  const loopback = isLoopbackRedirect(redirectUri);
  const rows = [
    `<dt>Signed in as</dt><dd>${escapeHtml(person)}</dd>`,
    `<dt>Sends you back to</dt><dd><code>${escapeHtml(destinationOf(redirectUri))}</code></dd>`,
    ...(client.source === "document"
      ? [`<dt>Identified by</dt><dd><code>${escapeHtml(client.id)}</code></dd>`]
      : []),
  ];
  const body = `<h1>${escapeHtml(client.name)} wants access to ${escapeHtml(site)}</h1>
<p>It will be able to:</p>
<ul>
${scopes.map((scope) => `<li>${escapeHtml(SCOPE_DESCRIPTIONS[scope])}</li>`).join("\n")}
</ul>
<dl>
${rows.join("\n")}
</dl>
${
  loopback
    ? `<p class="warn">The answer goes to a program on this computer. The name above is what that program calls itself and is not verified: allow it only if you started this from an application you trust, just now.</p>`
    : ""
}
<p>You can end its access at any time under Settings, Tokens.</p>
<form method="post" action="">
<input type="hidden" name="request" value="${escapeHtml(sealed)}">
<div class="actions">
<button type="submit" name="decision" value="deny">Deny</button>
<button type="submit" name="decision" value="allow">Allow</button>
</div>
</form>`;
  return page(`Authorize ${client.name}`, body, { formTarget: formTargetOf(redirectUri) });
};

/**
 * A problem with the request itself, once the client and its address are
 * known. The client is told (`error` on its redirect URI), but the browser is
 * only sent there by itself when the address is this machine's: registering a
 * client costs nothing, so a redirect anyone could trigger with a link would
 * make this site a way to bounce a person to any address. For any other
 * address the person is shown the problem and the link.
 */
const refuseRequest = (
  client: OAuthClient,
  redirectUri: string,
  origin: string,
  state: string | null,
  error: OAuthErrorCode,
  description: string,
): Response => {
  if (isLoopbackRedirect(redirectUri)) {
    return refuse(redirectUri, origin, state, error, description);
  }
  const back = answerUrl(redirectUri, origin, { error, error_description: description, state });
  return page(
    "Cannot authorize",
    `<h1>Cannot authorize</h1>
<p>The request from ${escapeHtml(client.name)} is not valid: ${escapeHtml(description)}.</p>
<p><a href="${escapeHtml(back)}" rel="noreferrer">Return to <code>${escapeHtml(destinationOf(redirectUri))}</code></a></p>`,
    { status: 400 },
  );
};

const showConsent = async (request: Request, deps: AuthorizeDeps): Promise<Response> => {
  const url = new URL(request.url);
  const parameter = (name: string): string | null => {
    const values = url.searchParams.getAll(name);
    // A parameter given twice is a malformed request.
    return values.length === 1 ? values[0]! : null;
  };

  const clientId = parameter("client_id");
  if (clientId === null) return problemPage("The request names no client.");

  // Who is asking comes first: a client id may be an address to fetch, and
  // nothing is fetched for a visitor nobody can name or count.
  const auth = await deps.authenticate(request);
  const principal = auth.principal;
  if (principal.kind !== "user" || principal.via !== "session") {
    // Back here, with the same request, once they have signed in.
    return redirect(signInPath(`${url.pathname}${url.search}`), 302, auth.setCookies);
  }
  const limited = (await deps.admit?.(principal)) ?? null;
  if (limited !== null) return withCookies(limited, auth.setCookies);
  const answer = (response: Response): Response => withCookies(response, auth.setCookies);

  const client = await deps.resolveClient(clientId);
  if (client === null) return answer(problemPage("This application is not known here."));

  const redirectUri =
    parameter("redirect_uri") ??
    (client.redirectUris.length === 1 && !url.searchParams.has("redirect_uri")
      ? client.redirectUris[0]!
      : null);
  if (redirectUri === null || !redirectAllowed(client, redirectUri)) {
    return answer(problemPage("The address to return to is not one this application registered."));
  }

  // From here a problem is the client's to hear about.
  const state = parameter("state");
  const invalid = (error: OAuthErrorCode, description: string, withState = state): Response =>
    answer(refuseRequest(client, redirectUri, deps.origin, withState, error, description));
  if (url.searchParams.has("state") && (state === null || state.length > 2048)) {
    return invalid("invalid_request", "state is malformed", null);
  }
  if (parameter("response_type") !== "code") {
    return invalid("unsupported_response_type", "response_type must be code");
  }
  const challenge = parameter("code_challenge");
  if (challenge === null || !isCodeChallenge(challenge)) {
    return invalid("invalid_request", "PKCE is required");
  }
  if (parameter("code_challenge_method") !== "S256") {
    return invalid("invalid_request", "code_challenge_method must be S256");
  }
  const resource = parameter("resource");
  if (
    url.searchParams.has("resource") &&
    (resource === null || !isOurResource(resource, deps.origin))
  ) {
    return invalid("invalid_target", "resource is not this server");
  }
  const scopes = parseScopes(parameter("scope"));

  const now = deps.now ?? Date.now();
  const sealed = await sealAs(
    "consent",
    {
      u: principal.userId,
      c: client.id,
      n: client.name,
      r: redirectUri,
      k: challenge,
      s: scopes,
      t: state,
    } satisfies ConsentRequest,
    deps.password,
    now + OAUTH_LIFETIMES.consentSeconds * 1000,
  );
  const person = (await deps.usernameOf(principal.userId)) ?? auth.email ?? "your account";
  return answer(
    consentPage(client, redirectUri, scopes, person, sealed, new URL(deps.origin).host),
  );
};

const decide = async (request: Request, deps: AuthorizeDeps): Promise<Response> => {
  const auth = await deps.authenticate(request);
  const principal = auth.principal;
  if (principal.kind !== "user" || principal.via !== "session") {
    return withCookies(
      problemPage("You are not signed in, or this did not come from the consent page.", 403),
      auth.setCookies,
    );
  }
  const form = await readParameters(request);
  const sealed = form === null ? null : text(form["request"]);
  const decision = form === null ? null : text(form["decision"]);
  if (sealed === null || (decision !== "allow" && decision !== "deny")) {
    return problemPage("The form was not understood.");
  }
  const consent = await unsealAs("consent", sealed, deps.password, deps.now ?? Date.now());
  if (!isConsentRequest(consent)) {
    return problemPage("This request has expired.");
  }
  // Approved by the person it was shown to, and nobody else.
  if (consent.u !== principal.userId) {
    return problemPage("This request was made while someone else was signed in.", 403);
  }
  if (decision === "deny") {
    return withCookies(
      refuse(consent.r, deps.origin, consent.t, "access_denied", "The request was denied", 303),
      auth.setCookies,
    );
  }
  const code = await issueCode(
    {
      userId: principal.userId,
      clientId: consent.c,
      clientName: consent.n,
      redirectUri: consent.r,
      codeChallenge: consent.k,
      scopes: consent.s,
    },
    deps,
  );
  return redirect(answerUrl(consent.r, deps.origin, { code, state: consent.t }), 303, [
    ...auth.setCookies,
  ]);
};

export const handleAuthorize = (request: Request, deps: AuthorizeDeps): Promise<Response> => {
  if (request.method === "GET" || request.method === "HEAD") return showConsent(request, deps);
  if (request.method === "POST") return decide(request, deps);
  return Promise.resolve(
    new Response("Method Not Allowed\n", { status: 405, headers: { allow: "GET, POST" } }),
  );
};
