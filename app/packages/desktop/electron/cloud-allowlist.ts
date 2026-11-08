/**
 * Which method+path a renderer may ask the cloud transport for
 * (`cloud-transport.ts`, the `CloudHttp` RPC). Anything else is refused
 * before a request leaves the main process: the renderer holds no token, so
 * this list is the whole of what a compromised page could do with the user's
 * session.
 *
 * Two surfaces make it up:
 *
 * - **Every endpoint of every contract domain in `DESKTOP_CLOUD_APIS`**
 *   (`shared/cloud-apis.ts`), matched by Effect's router (`FindMyWay`, the one
 *   the server routes with) on the endpoint's own method and path template. A
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
import { DESKTOP_CLOUD_APIS } from "../shared/cloud-apis";

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
  // GitHub issues page: the repository picker, the connect link and the IaC
  // state scope picker (all reads; connecting happens in the browser).
  { methods: ["GET"], pattern: new RegExp(`${ORG}/github/(status|repos|install-url)(\\?|$)`) },
  { methods: ["GET"], pattern: new RegExp(`${ORG}/iac/states$`) },
];

/**
 * The allowlist matches the path as text, but `fetch` resolves dot segments
 * (and some servers decode `%2F`/`%2E` before routing), so
 * `/api/profile/../org/x/billing/...` would match the profile rule and then
 * reach a route outside the surface. Refuse a path whose URL-normalized form
 * differs from what was matched, or that carries an encoded dot, slash or
 * backslash in the part being matched.
 */
function isCanonical(path: string, matched: string): boolean {
  if (!path.startsWith("/") || path.startsWith("//")) return false;
  if (/%2e|%2f|%5c|\\/i.test(matched)) return false;
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
  if (!isCanonical(path, path)) return false;
  const upper = method.toUpperCase();
  return SETTINGS_RULES.some((rule) => rule.methods.includes(upper) && rule.pattern.test(path));
}

/** Every endpoint of every registered contract domain, routed as the server routes them. */
const contractRoutes = (() => {
  const router = FindMyWay.make<true>();
  const seen = new Set<string>();
  for (const { endpoints } of Object.values(DESKTOP_CLOUD_APIS)) {
    for (const { endpoint } of endpoints) {
      // The router keys a route on its template with parameter names erased
      // (`/x/:id` and `/x/:probeId` are one route) and throws on a repeat.
      const key = `${endpoint.method} ${endpoint.path.replace(/:\w+/g, ":")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      router.on(endpoint.method, `/${endpoint.path.replace(/^\//, "")}`, true);
    }
  }
  return router;
})();

/**
 * Whether `method path` is an endpoint of a registered contract domain. Only
 * the path is held to the encoded-character rule here: a query value may
 * carry an encoded slash (a file path, a prefix) without changing the route.
 */
export function isAllowedContractRequest(method: string, path: string): boolean {
  const [pathname = ""] = path.split("?", 1);
  if (!isCanonical(path, pathname)) return false;
  return contractRoutes.find(method.toUpperCase(), path) !== undefined;
}

/** The transport's allowlist: a registered contract endpoint or the Settings surface. */
export function isAllowedCloudRequest(method: string, path: string): boolean {
  return isAllowedContractRequest(method, path) || isAllowedSettingsRequest(method, path);
}
