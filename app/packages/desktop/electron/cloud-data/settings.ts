import { ipcMain } from "electron";
import { getAccessToken, forceRefreshAccessToken } from "../cloud-auth";
import { CLOUD_URL } from "../../env";

/**
 * Single authorized proxy for the cloud-mode Settings tab.
 *
 * The shared settings sections (in @infrawrench/ui) speak the same `/api/...`
 * paths the web app fetches — ~60 endpoints across team, roles, keys,
 * billing, notification routing and the personal profile. Giving each its own
 * IPC channel would triple the preload allowlist for one feature, so this one
 * channel proxies them all — but only them: the method+path allowlist below
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
      `${ORG}/(team|api-keys|ssh-keys|ssh-host-keys|bastions|change-freezes|tag-policy|cost-centres|twilio|msteams|slack|push|digest)(\\/|$|\\?)`,
    ),
  },
  { methods: ["GET"], pattern: new RegExp(`${ORG}/audit-logs(\\?|$)`) },
  { methods: ["GET", "POST"], pattern: new RegExp(`${ORG}/billing/(status|checkout|portal)$`) },
  // Allocation-rule pickers on the Tag Policy page.
  { methods: ["GET"], pattern: new RegExp(`${ORG}/costs/dimensions(\\?|$)`) },
  // Drift/expiry alert settings cards on the Notifications page.
  { methods: ["GET", "PUT"], pattern: new RegExp(`${ORG}/changes/alert-settings$`) },
  { methods: ["GET", "PUT"], pattern: new RegExp(`${ORG}/expiring/settings$`) },
  // Drift scope picker (read-only account list).
  { methods: ["GET"], pattern: new RegExp(`${ORG}/accounts$`) },
];

interface SettingsRequestArgs {
  method: string;
  path: string;
  body?: unknown;
}

export interface SettingsRequestResult {
  status: number;
  bodyText: string;
}

ipcMain.handle(
  "cloud_settings_request",
  async (_e, { method, path, body }: SettingsRequestArgs): Promise<SettingsRequestResult> => {
    const upper = method.toUpperCase();
    const allowed = ALLOWED.some((rule) => rule.methods.includes(upper) && rule.pattern.test(path));
    if (!allowed) {
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
