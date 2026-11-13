/**
 * Which method+path a renderer may ask the cloud transport for
 * (`cloud-transport.ts`, the `CloudHttp` and `CloudHttpBytes` RPCs), and
 * which request headers it may send there. Anything else is refused before a
 * request leaves the main process: the renderer holds no token, so this list
 * is the whole of what a compromised page could do with the user's session.
 *
 * Two surfaces make it up:
 *
 * - **The authenticated, buffered endpoints of every contract domain in
 *   `DESKTOP_CLOUD_APIS`** (`shared/cloud-apis.ts`), matched by Effect's
 *   router (`FindMyWay`, the one the server routes with) on the endpoint's
 *   own method and path template. An endpoint is on it when it runs the
 *   contract's `OrgAuth` or `SessionAuth` middleware, because the transport
 *   attaches the user's bearer token to every request, and a route that does
 *   not authenticate (an inbound webhook keyed by a token in its path, a
 *   public status page) has no business receiving it. A route that
 *   authenticates inside its handler instead is listed by hand in
 *   {@link HANDLER_AUTHENTICATED}, with the reason. A streaming answer (SSE,
 *   NDJSON, an upgrade) is never on it, listed or not: the transport buffers
 *   the whole body, so a stream would hang until the server closed it. A
 *   migrated area extends this by adding its domain there; nothing here
 *   changes.
 * - **The Settings tab's surface**, the {@link SETTINGS_RULES} below. The
 *   shared settings sections (`@infrawrench/ui/settings`) speak the same
 *   `/api/...` paths the web app fetches through `SettingsApi.get(path)`,
 *   ~60 endpoints across team, roles, keys, billing, notification routing and
 *   the personal profile, with no endpoint definition at the call site, so
 *   their surface is written out by hand. A new endpoint a section calls is
 *   added here in the same change (CLAUDE.md "Settings").
 */
import { FindMyWay } from "effect/http";
import { DESKTOP_CLOUD_APIS, type DesktopCloudApiName } from "../shared/cloud-apis";

const ORG = "^/api/org/[^/]+";

/** The Settings tab's method+path surface (see the module comment). */
const SETTINGS_RULES: Array<{ methods: string[]; pattern: RegExp }> = [
  // Personal account (profile, MFA, sessions, deletion).
  { methods: ["GET", "POST", "PATCH", "DELETE"], pattern: /^\/api\/profile(\/|$)/ },
  // The caller's own push devices.
  { methods: ["GET", "DELETE"], pattern: /^\/api\/push\/devices(\/|$)/ },
  // Org settings resources, one alternation per sidebar section.
  {
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    pattern: new RegExp(
      `${ORG}/(team|api-keys|agent-registrations|agent-links|ssh-keys|ssh-host-keys|session-recordings|access-requests|jit-access|credential-hygiene|bastions|change-freezes|tag-policy|tag-keys|currency|cost-centres|cost-visibility|sharing|billing-rules|virtual-tags|cost-exports|ai-attribution|custom-cost-sources|config|twilio|msteams|event-subscriptions|slack|push|digest|alert-rules|on-call|paging-providers|jira|linear|github-issues|pr-checks)(\\/|$|\\?)`,
    ),
  },
  { methods: ["GET"], pattern: new RegExp(`${ORG}/audit-logs(\\?|$)`) },
  // SSH Keys: which keys are lent to CI jobs, and lending one's own (also on
  // the `ci` domain's derived surface; listed so the section's calls are
  // written out here like the rest).
  { methods: ["GET"], pattern: new RegExp(`${ORG}/ci/access$`) },
  { methods: ["PUT"], pattern: new RegExp(`${ORG}/ci/access/ssh-keys/[^/]+$`) },
  {
    methods: ["GET", "POST"],
    pattern: new RegExp(`${ORG}/billing/(status|checkout|portal|capacity\\/checkout)$`),
  },
  // Metric pickers for the Virtual Tags section's metric splits (read-only;
  // business metrics are managed on the unit-costs page, not in Settings).
  { methods: ["GET"], pattern: new RegExp(`${ORG}/business-metrics(\\/|$|\\?)`) },
  // Allocation-rule pickers on the Tag Policy page, and the tag key
  // suggestions on Cost Exports.
  { methods: ["GET"], pattern: new RegExp(`${ORG}/costs/dimensions(\\?|$)`) },
  // Drift/expiry alert settings cards on the Notifications page.
  { methods: ["GET", "PUT"], pattern: new RegExp(`${ORG}/changes/alert-settings$`) },
  { methods: ["GET", "PUT"], pattern: new RegExp(`${ORG}/expiring/settings$`) },
  { methods: ["GET", "PUT"], pattern: new RegExp(`${ORG}/extended-support/settings$`) },
  // Saved-filter picker on the Cost Visibility page.
  { methods: ["GET"], pattern: new RegExp(`${ORG}/saved-cost-filters$`) },
  // Customer picker on the Billing Rules page (tiered and expression rules).
  { methods: ["GET"], pattern: new RegExp(`${ORG}/managed-accounts$`) },
  // The Email connection pane on the Notifications page: the external-address
  // policy and lifting an unsubscribe. The picker options read (`/alert-email`
  // itself) goes through the costs IPC instead.
  { methods: ["GET", "PUT"], pattern: new RegExp(`${ORG}/alert-email/settings$`) },
  { methods: ["DELETE"], pattern: new RegExp(`${ORG}/alert-email/suppressions/[^/?]+$`) },
  // Default dashboard per role on the Roles page: the dashboard picker (read
  // only) and the role defaults themselves.
  { methods: ["GET"], pattern: new RegExp(`${ORG}/dashboards$`) },
  { methods: ["GET"], pattern: new RegExp(`${ORG}/dashboards/role-defaults$`) },
  { methods: ["PUT", "DELETE"], pattern: new RegExp(`${ORG}/dashboards/role-defaults/[^/?]+$`) },
  // Drift scope picker (read-only account list).
  { methods: ["GET"], pattern: new RegExp(`${ORG}/accounts$`) },
  // Settings > Apps: which apps each plugin can serve, to count the
  // connections that were made without an app that is on.
  { methods: ["GET"], pattern: new RegExp(`${ORG}/accounts/plugins$`) },
  // GitHub issues page: the repository picker, the connect link and the IaC
  // state scope picker (all reads; connecting happens in the browser).
  { methods: ["GET"], pattern: new RegExp(`${ORG}/github/(status|repos|install-url)(\\?|$)`) },
  { methods: ["GET"], pattern: new RegExp(`${ORG}/iac/states$`) },
  // The Apps section: which apps the organization has turned off.
  { methods: ["GET", "PUT"], pattern: new RegExp(`${ORG}/products$`) },
];

/**
 * Contract endpoints that authenticate in their handler rather than through
 * the `OrgAuth`/`SessionAuth` middleware, by `<registry name>.<group>.<endpoint>`.
 * Each is on the allowlist although its definition runs no auth middleware.
 * `cloud-transport.test.ts` holds every entry to a registered endpoint that
 * still lacks the middleware, so an entry goes once the contract catches up.
 */
const HANDLER_AUTHENTICATED: ReadonlySet<string> =
  new Set<`${DesktopCloudApiName}.${string}.${string}`>([
    // The chat agent: every handler authenticates first with
    // `asOrgRequestCaller` and its own `chat:read`/`chat:write` scope (web's
    // `http/domains/chat/index.ts`), which the group middleware cannot express.
    // `sendMessage` is the SSE turn stream and stays refused as a stream.
    "chat.chat.listConversations",
    "chat.chat.createConversation",
    "chat.chat.updateConversation",
    "chat.chat.getConversation",
    "chat.chat.archiveConversation",
    "chat.chat.spend",
    "chat.chat.decidePending",
    "chat.chat.answerQuestion",
    "chat.chat.submitSecretRequest",
  ]);

/** For the test that keeps {@link HANDLER_AUTHENTICATED} honest. */
export const handlerAuthenticatedEndpoints: ReadonlySet<string> = HANDLER_AUTHENTICATED;

/**
 * The allowlist matches the path as text, but `fetch` resolves dot segments
 * (and some servers decode `%2F`/`%2E` before routing), so
 * `/api/profile/../org/x/billing/...` would match the profile rule and then
 * reach a route outside the surface. Refuse a path whose URL-normalized form
 * differs from what was matched; `strict` also refuses an encoded dot, slash
 * or backslash in the part being matched (the Settings rules, which are
 * regexes over text and have no notion of a parameter).
 */
function isCanonical(path: string, matched: string, strict: boolean): boolean {
  if (!path.startsWith("/") || path.startsWith("//")) return false;
  if (/\\/.test(matched)) return false;
  if (strict && /%2e|%2f|%5c/i.test(matched)) return false;
  let normalized: URL;
  try {
    normalized = new URL(path, "https://allowlist.invalid");
  } catch {
    return false;
  }
  if (normalized.origin !== "https://allowlist.invalid") return false;
  return `${normalized.pathname}${normalized.search}` === path;
}

/** Whether `method path` is on the Settings tab's surface (the whole path, query included). */
export function isAllowedSettingsRequest(method: string, path: string): boolean {
  if (!isCanonical(path, path, true)) return false;
  const upper = method.toUpperCase();
  return SETTINGS_RULES.some((rule) => rule.methods.includes(upper) && rule.pattern.test(path));
}

/** Whether a registered endpoint is on the allowlist (see the module comment). */
function isReachable(name: string, group: string, endpoint: string, authenticated: boolean) {
  return authenticated || HANDLER_AUTHENTICATED.has(`${name}.${group}.${endpoint}`);
}

/**
 * Every allowlisted endpoint of every registered contract domain, routed as
 * the server routes them, each carrying the request headers it declares.
 */
const contractRoutes = (() => {
  const router = FindMyWay.make<Set<string>>();
  const routes = new Map<string, Set<string>>();
  for (const [name, { endpoints }] of Object.entries(DESKTOP_CLOUD_APIS)) {
    for (const entry of endpoints) {
      const { endpoint } = entry;
      if (entry.answer === "stream") continue;
      if (!isReachable(name, entry.group, endpoint.identifier, entry.authenticated)) continue;
      // The router keys a route on its template with parameter names erased
      // (`/x/:id` and `/x/:probeId` are one route) and throws on a repeat, so
      // a repeat is registered once, with the headers either declares.
      const key = `${endpoint.method} ${endpoint.path.replace(/:\w+/g, ":")}`;
      const known = routes.get(key);
      if (known !== undefined) {
        for (const header of entry.headers) known.add(header);
        continue;
      }
      const headers = new Set(entry.headers);
      routes.set(key, headers);
      router.on(endpoint.method, `/${endpoint.path.replace(/^\//, "")}`, headers);
    }
  }
  return router;
})();

/**
 * The request headers `method path` may carry when it is an allowlisted
 * contract endpoint, else `undefined`.
 *
 * The path is held to the URL-normalization rule, but an encoded `/` or `\`
 * may sit inside a parameter value (a resource id that is an ARN or
 * `namespace/name`): the server routes on the raw path, as this router does,
 * and decodes the value only after the route is chosen, so it cannot change
 * the route. A parameter that is, or decodes to, `.` or `..` is still
 * refused, as the renderer's client refuses it before sending.
 */
export function contractRequestHeaders(
  method: string,
  path: string,
): ReadonlySet<string> | undefined {
  const [pathname = ""] = path.split("?", 1);
  if (!isCanonical(path, pathname, false)) return undefined;
  const found = contractRoutes.find(method.toUpperCase(), path);
  if (found === undefined) return undefined;
  for (const value of Object.values(found.params)) {
    if (value === "." || value === "..") return undefined;
  }
  return found.handler;
}

/** Whether `method path` is an allowlisted endpoint of a registered contract domain. */
export function isAllowedContractRequest(method: string, path: string): boolean {
  return contractRequestHeaders(method, path) !== undefined;
}

const NO_HEADERS: ReadonlySet<string> = new Set();

/**
 * The transport's allowlist: the request headers `method path` may carry when
 * it is a registered contract endpoint or on the Settings surface (which
 * declares none), else `undefined`.
 */
export function allowedCloudRequestHeaders(
  method: string,
  path: string,
): ReadonlySet<string> | undefined {
  return (
    contractRequestHeaders(method, path) ??
    (isAllowedSettingsRequest(method, path) ? NO_HEADERS : undefined)
  );
}
