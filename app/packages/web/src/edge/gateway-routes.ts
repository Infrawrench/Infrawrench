/**
 * Which requests the edge Worker (`edge/worker.ts`) hands straight to Node
 * instead of running the Hono API itself, and which of the two Node tiers
 * gets them.
 *
 * The edge can run every route; the question is only whether it is worth
 * trying. These lists are the routes where trying would be wasted or wrong:
 *
 * - **Always the session gateway** (`tier: "session"`): anything that needs a
 *   long-lived process. WebSockets, the in-process registries (bastion agents,
 *   shared consoles, Linux app sessions, agent VMs, the cross-replica relay),
 *   SSE streams that outlive a request budget, and uploads past what a Lambda
 *   request can carry.
 * - **Always Node** (`tier: "node"`): routes that exist to drive a socket
 *   driver, SSH or plugin code, but finish within the request. These go to the
 *   Lambda gateway when one is configured and to the session gateway when not.
 * - **Mutations on Node**: routes whose writes commonly reach a Node-only path
 *   (saving a workflow compiles it; adding an account tests its connection).
 *   Their reads are ordinary and stay on the edge.
 *
 * Everything else runs on the edge, and the edge still falls back: a GET that
 * reaches a gateway-only path is replayed on Node, and an account whose work
 * does gets flagged so later requests about it skip the edge entirely
 * (`runtime/account-runtime.ts`). The Lambda gateway falls back the same way
 * one tier further up, for the process-local state it lacks. Missing a route
 * here costs latency, not correctness, for reads; for writes it costs the user
 * a retry, and the edge logs the path so it can be added.
 */

const ORG = String.raw`^/api/org/[^/]+`;

const SESSION_ROUTES: readonly RegExp[] = [
  // The WebSocket endpoints `server.ts` upgrades itself, matched by path as
  // well as by the Upgrade header so a request that loses the header on the
  // way still reaches the only process that can answer it.
  /^\/api\/(ws|apps)$/,
  /^\/api\/bastions\/agent$/,
  // Node HTTP handler, not part of the Hono app; its app tools reach Linux
  // app sessions through the cross-replica relay, which needs a pod address.
  /^\/api\/mcp(\/|$)/,
  // Agent VM bootstrap and the cross-replica relay: process-local state.
  /^\/api\/agent(\/|$)/,
  /^\/api\/internal(\/|$)/,
  // SSE whose turns can outlast a Lambda invocation, with tools that drive
  // drivers, SSH and bastion-bound accounts mid-stream. Gemini also signs in
  // with the session gateway's GKE Workload Identity.
  new RegExp(`${ORG}/chat(/|$)`),
  new RegExp(
    `${ORG}/(` +
      [
        // In-process registries and live sessions.
        "bastions",
        "shared-consoles",
        "apps",
        "agents",
        "ssh-tunnels",
        // Deploys stream over the WebSocket and hosted builds run for up to
        // 20 minutes, past Lambda's 15.
        "deployments",
        // Object storage and SFTP: uploads larger than a Lambda request
        // carries, staged on local disk.
        "storage",
        "v1/storage",
        "v1/sftp",
      ].join("|") +
      ")(/|$)",
  ),
];

const NODE_ROUTES: readonly RegExp[] = [
  // Paging-provider webhooks: the signature check is plugin code, which the
  // web Worker does not carry, and a provider retries a failed delivery
  // rather than replaying it somewhere else.
  /^\/api\/paging-webhooks\//,
  // Slack slash commands and button actions answer Slack at once and do the
  // work afterwards (through `keepAlive`), often through plugin code; a
  // gateway-only miss there happens after the response and cannot be replayed.
  /^\/api\/slack\/(commands|interactions)$/,
  // Provider OAuth: both halves may run plugin hooks the web Worker does not
  // carry (authorize: `registerOAuthClient`, `buildOAuthAuthorizeUrl`;
  // callback: `exchangeOAuthCode`, `completeOAuthConnection`).
  /^\/api\/provider-oauth\/[^/]+\/callback$/,
  // The org grade reads the posture and backup feeds, which bind plugin
  // functions the edge registry only stubs: every attempt there would replay.
  // Its history (`/scorecards/org/history`) is Postgres only and stays.
  new RegExp(`${ORG}/scorecards/org$`),
  new RegExp(
    `${ORG}/(` +
      [
        // SSH that finishes within the request.
        "ssh-fanout",
        "connect",
        "session-recordings",
        "ssh-host-keys",
        // Provider OAuth authorize: plugin client registration and URL hooks.
        "provider-oauth",
        // Connection features: socket drivers by definition.
        "sql",
        "kv",
        "kv-browser",
        "docker",
      ].join("|") +
      ")(/|$)",
  ),
];

const MUTATIONS_ON_GATEWAY: readonly RegExp[] = [
  // Git push webhook: runs the workflow.
  /^\/api\/workflows\/git\//,
  new RegExp(`${ORG}/(workflows|accounts|ssh-keys|resources)(/|$)`),
  // Removing a seat calls the plugin's removeSeat.
  new RegExp(`${ORG}/seats/[^/]+/remove$`),
  // Registering a provider webhook and acknowledging a provider incident both
  // call plugin code, the first after it has already written a settings row.
  new RegExp(`${ORG}/(paging-providers|paging-incidents)(/|$)`),
  // Just-in-time access: approving grants upstream and revoking removes the
  // grant, both plugin code; a request resolves the requester's principal
  // through the plugin too. Policy writes do not, but share the prefix.
  new RegExp(`${ORG}/jit-access(/|$)`),
  // Event subscriptions: saving vets the webhook host through the Node egress
  // guard, and Send test event delivers inline, through plugin code for a
  // publish destination. Reads (the list, the delivery log) stay on the edge.
  new RegExp(`${ORG}/event-subscriptions(/|$)`),
  // Leaked credentials: scanning, rotating and closing a finding upstream all
  // call plugin code (the scanner, the issuer's reroll). Reads stay on the edge.
  new RegExp(`${ORG}/leaked-secrets/(scan|[^/]+/(rotate|mark-rotated|dismiss|reopen))$`),
  // A pull request check preview prices Terraform through plugin estimators
  // and reads the pull request from GitHub: the github-watcher's work, on
  // demand.
  new RegExp(`${ORG}/pr-checks/preview$`),
  // Evaluating a scorecard runs the org-wide posture, orphan and backup scans,
  // which bind plugin remediation functions the edge registry only stubs.
  new RegExp(`${ORG}/scorecards/[^/]+/evaluate$`),
];

const ACCOUNT_IN_PATH = new RegExp(`${ORG}/accounts/([^/]+)`);

/** Account-collection paths whose next segment is not an account id. */
const NOT_ACCOUNT_IDS = new Set(["plugins", "preflight", "credential-options"]);

/**
 * Paths the Hono API answers; everything else is the SPA (static assets with
 * an index.html fallback). Mirrors what `api/index.ts` mounts outside `/api`.
 */
export function isApiPath(pathname: string): boolean {
  return (
    pathname.startsWith("/api/") ||
    pathname === "/api" ||
    pathname.startsWith("/callback") ||
    pathname.startsWith("/.well-known/") ||
    pathname === "/auth.md" ||
    pathname === "/openapi.json" ||
    pathname === "/docs"
  );
}

export function isSafeMethod(method: string): boolean {
  return method === "GET" || method === "HEAD" || method === "OPTIONS";
}

/**
 * The two Node runtimes behind the edge. `session` is the long-lived gateway
 * (the Node server, `server.ts`); `node` is any Node runtime, which means the
 * Lambda gateway when one is configured.
 */
export type GatewayTier = "session" | "node";

/**
 * `accountId` is set when the path names one, so the Worker can look it up:
 * on the edge to skip accounts that need Node, and for `node` routes to send
 * a bastion-bound account to the session gateway, which holds its agent.
 */
export type EdgeRoute =
  | { target: "gateway"; tier: GatewayTier; reason: string; accountId?: string }
  | { target: "edge"; accountId?: string };

function accountInPath(pathname: string): string | undefined {
  const account = ACCOUNT_IN_PATH.exec(pathname)?.[1];
  return account && !NOT_ACCOUNT_IDS.has(account) ? decodeURIComponent(account) : undefined;
}

export function routeRequest(method: string, pathname: string, upgrade: string | null): EdgeRoute {
  if (upgrade?.toLowerCase() === "websocket") {
    return { target: "gateway", tier: "session", reason: "websocket" };
  }
  for (const pattern of SESSION_ROUTES) {
    if (pattern.test(pathname)) return { target: "gateway", tier: "session", reason: "route" };
  }
  const accountId = accountInPath(pathname);
  const withAccount = accountId ? { accountId } : {};
  for (const pattern of NODE_ROUTES) {
    if (pattern.test(pathname)) {
      return { target: "gateway", tier: "node", reason: "route", ...withAccount };
    }
  }
  if (!isSafeMethod(method)) {
    for (const pattern of MUTATIONS_ON_GATEWAY) {
      if (pattern.test(pathname)) {
        return { target: "gateway", tier: "node", reason: "mutation", ...withAccount };
      }
    }
  }
  return { target: "edge", ...withAccount };
}
