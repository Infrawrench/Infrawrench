import { ipcMain } from "electron";
import { getAccessToken, forceRefreshAccessToken } from "../cloud-auth";
import { CLOUD_URL } from "../../env";

/**
 * Single authorized proxy for the cloud-mode Settings tab.
 *
 * The shared settings sections (in @infrawrench/ui) speak the same `/api/...`
 * paths the web app fetches: ~60 endpoints across team, roles, keys,
 * billing, notification routing and the personal profile. Giving each its own
 * IPC channel would triple the preload allowlist for one feature, so this one
 * channel proxies them all, but only them: the method+path allowlist below
 * is the security boundary, and anything outside the settings surface is
 * rejected before a request leaves the main process. The channel name itself
 * stays fixed, so the renderer still cannot reach an arbitrary handler.
 *
 * Unlike `cloudFetch`, errors are returned as data (`status` + body text):
 * the sections need structured failures (seat limits, plan gates) that an IPC
 * rejection's flattened message would destroy. The renderer-side client
 * (src/lib/settings-client.ts) rebuilds the typed errors.
 */

const ORG = "^/api/org/[^/]+";

const ALLOWED: Array<{ methods: string[]; pattern: RegExp }> = [
  // Personal account (profile, MFA, sessions, deletion).
  { methods: ["GET", "POST", "PATCH", "DELETE"], pattern: /^\/api\/profile(\/|$)/ },
  // The caller's own push devices.
  { methods: ["GET", "DELETE"], pattern: /^\/api\/push\/devices(\/|$)/ },
  // Org settings resources, one alternation per sidebar section.
  {
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    pattern: new RegExp(
      `${ORG}/(team|api-keys|agent-registrations|ssh-keys|ssh-host-keys|session-recordings|access-requests|credential-hygiene|bastions|change-freezes|tag-policy|tag-keys|currency|cost-centres|cost-visibility|sharing|billing-rules|virtual-tags|cost-exports|ai-attribution|custom-cost-sources|config|twilio|msteams|slack|push|digest|alert-rules|on-call|jira|linear|github-issues)(\\/|$|\\?)`,
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
  // Saved-filter picker on the Cost Visibility page.
  { methods: ["GET"], pattern: new RegExp(`${ORG}/saved-cost-filters$`) },
  // Customer picker on the Billing Rules page (tiered and expression rules).
  { methods: ["GET"], pattern: new RegExp(`${ORG}/managed-accounts$`) },
  // Drift scope picker (read-only account list).
  { methods: ["GET"], pattern: new RegExp(`${ORG}/accounts$`) },
  // GitHub issues page: the repository picker, the connect link and the IaC
  // state scope picker (all reads; connecting happens in the browser).
  { methods: ["GET"], pattern: new RegExp(`${ORG}/github/(status|repos|install-url)(\\?|$)`) },
  { methods: ["GET"], pattern: new RegExp(`${ORG}/iac/states$`) },
];

interface SettingsRequestArgs {
  method: string;
  path: string;
  body?: unknown;
}

interface SettingsRequestResult {
  status: number;
  bodyText: string;
}

/**
 * The allowlist matches the path as text, but `fetch` resolves dot segments
 * (and some servers decode `%2F`/`%2E` before routing), so
 * `/api/profile/../org/x/billing/...` would match the profile rule and then
 * reach a route outside the surface. Refuse any path whose URL-normalized form
 * differs from what was matched, or that carries an encoded dot, slash or
 * backslash anywhere.
 */
export function isAllowedSettingsRequest(method: string, path: string): boolean {
  if (typeof method !== "string" || typeof path !== "string") return false;
  if (!path.startsWith("/") || path.startsWith("//")) return false;
  if (/%2e|%2f|%5c|\\/i.test(path)) return false;
  let normalized: URL;
  try {
    normalized = new URL(path, "https://settings.invalid");
  } catch {
    return false;
  }
  if (normalized.origin !== "https://settings.invalid") return false;
  if (`${normalized.pathname}${normalized.search}` !== path) return false;
  const upper = method.toUpperCase();
  return ALLOWED.some((rule) => rule.methods.includes(upper) && rule.pattern.test(path));
}

ipcMain.handle(
  "cloud_settings_request",
  async (_e, { method, path, body }: SettingsRequestArgs): Promise<SettingsRequestResult> => {
    const upper = String(method).toUpperCase();
    if (!isAllowedSettingsRequest(method, path)) {
      throw new Error(`Settings proxy: ${upper} ${path} is not on the settings API surface`);
    }

    let token = await getAccessToken();
    if (!token) throw new Error("Not authenticated to Infrawrench Cloud");
    const url = `${CLOUD_URL}${path}`;
    const buildInit = (t: string): RequestInit => ({
      method: upper,
      headers: {
        Authorization: `Bearer ${t}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    let res = await fetch(url, buildInit(token));
    if (res.status === 401) {
      const refreshed = await forceRefreshAccessToken();
      if (!refreshed) throw new Error("Authentication expired; please sign in again");
      token = refreshed;
      res = await fetch(url, buildInit(token));
    }
    const bodyText = await res.text().catch(() => "");
    return { status: res.status, bodyText };
  },
);
