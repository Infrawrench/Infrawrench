/**
 * Which requests the edge Worker (`edge/worker.ts`) hands straight to the Node
 * gateway instead of running the Hono API itself.
 *
 * The edge can run every route; the question is only whether it is worth
 * trying. These lists are the routes where trying would be wasted or wrong:
 *
 * - **Always the gateway**: anything that holds state in a Node process (the
 *   bastion agent registry, shared consoles, Linux app sessions, SSH tunnels),
 *   streams over SSE or WebSocket, or exists only to drive a socket driver,
 *   SSH or kubectl.
 * - **Mutations on the gateway**: routes whose writes commonly reach a
 *   Node-only path (saving a workflow compiles it; adding an account tests
 *   its connection). Their reads are ordinary and stay on the edge.
 *
 * Everything else runs on the edge, and the edge still falls back: a GET that
 * reaches a gateway-only path is replayed on the gateway, and an account whose
 * work does gets flagged so later requests about it skip the edge entirely
 * (`runtime/account-runtime.ts`). Missing a route here costs latency, not
 * correctness, for reads; for writes it costs the user a retry, and the edge
 * logs the path so it can be added.
 */

const ORG = String.raw`^/api/org/[^/]+`;

const ALWAYS_GATEWAY: readonly RegExp[] = [
  // The WebSocket endpoints `server.ts` upgrades itself, matched by path as
  // well as by the Upgrade header so a request that loses the header on the
  // way still reaches the only process that can answer it.
  /^\/api\/(ws|apps)$/,
  /^\/api\/bastions\/agent$/,
  // Node HTTP handler, not part of the Hono app.
  /^\/api\/mcp(\/|$)/,
  // Agent VM bootstrap and the cross-replica relay: process-local state.
  /^\/api\/agent(\/|$)/,
  /^\/api\/internal(\/|$)/,
  // SSE, and tools that drive drivers and SSH mid-stream.
  new RegExp(`${ORG}/chat(/|$)`),
  new RegExp(
    `${ORG}/(` +
      [
        // In-process registries and live sessions.
        "bastions",
        "shared-consoles",
        "apps",
        "agents",
        "ssh-fanout",
        "ssh-tunnels",
        "connect",
        "deployments",
        "session-recordings",
        "ssh-host-keys",
        // Connection features: socket drivers by definition.
        "sql",
        "kv",
        "kv-browser",
        "docker",
        "storage",
        "v1/storage",
        "v1/sftp",
      ].join("|") +
      ")(/|$)",
  ),
];

const MUTATIONS_ON_GATEWAY: readonly RegExp[] = [
  // Git push webhook: runs the workflow.
  /^\/api\/workflows\/git\//,
  new RegExp(`${ORG}/(workflows|accounts|ssh-keys|resources)(/|$)`),
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

export type EdgeRoute =
  { target: "gateway"; reason: string } | { target: "edge"; accountId?: string };

export function routeRequest(method: string, pathname: string, upgrade: string | null): EdgeRoute {
  if (upgrade?.toLowerCase() === "websocket") return { target: "gateway", reason: "websocket" };
  for (const pattern of ALWAYS_GATEWAY) {
    if (pattern.test(pathname)) return { target: "gateway", reason: "route" };
  }
  if (!isSafeMethod(method)) {
    for (const pattern of MUTATIONS_ON_GATEWAY) {
      if (pattern.test(pathname)) return { target: "gateway", reason: "mutation" };
    }
  }
  const account = ACCOUNT_IN_PATH.exec(pathname)?.[1];
  if (account && !NOT_ACCOUNT_IDS.has(account)) {
    return { target: "edge", accountId: decodeURIComponent(account) };
  }
  return { target: "edge" };
}
