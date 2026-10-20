// First, so tls distrusts the compromised eMudhra intermediates before anything connects.
import "kill-emudhra";
import { getPreferenceValues } from "@raycast/api";
import {
  createCloudFetch,
  parseOrgIdInput,
  staticAccessToken,
  type CloudFetch,
} from "@infrawrench/client-core";

/**
 * The extension's preferences (the manifest declares them). Typed here rather
 * than through the generated `raycast-env.d.ts`, which is build output and is
 * not checked in.
 */
interface Preferences {
  apiKey: string;
  organization: string;
  cloudUrl?: string;
  openIn?: "web" | "desktop";
}

export interface Client {
  api: CloudFetch;
  orgId: string;
  cloudUrl: string;
  openIn: "web" | "desktop";
}

/**
 * The Bearer client every command uses. An `iwk_` API key belongs to one
 * organization, so the org comes from a preference (a pasted web address or
 * the id) rather than a picker: the org listing does not accept keys.
 */
export function getClient(): Client {
  const prefs = getPreferenceValues<Preferences>();
  const orgId = parseOrgIdInput(prefs.organization);
  if (!orgId) {
    throw new Error(
      "The Organization preference should be an Infrawrench address inside your organization, or its id.",
    );
  }
  const cloudUrl = (prefs.cloudUrl?.trim() || "https://app.infrawrench.com").replace(/\/+$/, "");
  return {
    api: createCloudFetch({ tokens: staticAccessToken(prefs.apiKey.trim()), baseUrl: cloudUrl }),
    orgId,
    cloudUrl,
    openIn: prefs.openIn === "desktop" ? "desktop" : "web",
  };
}
