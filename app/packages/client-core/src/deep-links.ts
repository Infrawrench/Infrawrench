/**
 * Links into Infrawrench from outside it: the web app's URLs and the desktop
 * app's `infrawrench://` protocol. The editor extension and the Raycast
 * extension build them; the desktop main process parses the protocol half.
 *
 * Both sides live here so the format has one definition. A link names the org
 * it belongs to, because a resource id means nothing in another org and the
 * desktop has to refuse rather than open the wrong thing.
 */

/** The desktop app's registered protocol (`desktop/env*.ts` `PROTOCOL`). */
export const DESKTOP_PROTOCOL = "infrawrench";

export interface DeepLinkResource {
  accountId: string;
  pluginId: string;
  resourceTypeId: string;
  /** Infrawrench resource id; may contain slashes. */
  resourceId: string;
}

/** What a desktop deep link asks the app to open. */
export type DesktopDeepLink =
  | ({ kind: "resource"; orgId: string } & DeepLinkResource)
  | { kind: "incident"; orgId: string; incidentId: string }
  | { kind: "service"; orgId: string; serviceId: string }
  | { kind: "vulnerabilities"; orgId: string };

function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function orgBase(baseUrl: string, orgId: string): string {
  return `${trimBase(baseUrl)}/org/${encodeURIComponent(orgId)}`;
}

/** The resource's detail page in the web app. */
export function webResourceUrl(baseUrl: string, orgId: string, r: DeepLinkResource): string {
  const path = [r.pluginId, r.resourceTypeId, r.resourceId].map(encodeURIComponent).join("/");
  return `${orgBase(baseUrl, orgId)}/resources/${path}?accountId=${encodeURIComponent(r.accountId)}`;
}

export function webIncidentUrl(baseUrl: string, orgId: string, incidentId?: string): string {
  const base = `${orgBase(baseUrl, orgId)}/incidents`;
  return incidentId ? `${base}/${encodeURIComponent(incidentId)}` : base;
}

export function webServiceUrl(baseUrl: string, orgId: string, serviceId?: string): string {
  const base = `${orgBase(baseUrl, orgId)}/services`;
  return serviceId ? `${base}/${encodeURIComponent(serviceId)}` : base;
}

export function webWorkflowUrl(baseUrl: string, orgId: string, workflowId: string): string {
  return `${orgBase(baseUrl, orgId)}/workflows/${encodeURIComponent(workflowId)}`;
}

export function webOnCallUrl(baseUrl: string, orgId: string): string {
  return `${orgBase(baseUrl, orgId)}/settings/on-call`;
}

export function webIacUrl(baseUrl: string, orgId: string): string {
  return `${orgBase(baseUrl, orgId)}/iac`;
}

export function webPostureUrl(baseUrl: string, orgId: string): string {
  return `${orgBase(baseUrl, orgId)}/posture`;
}

export function webVulnerabilitiesUrl(baseUrl: string, orgId: string): string {
  return `${orgBase(baseUrl, orgId)}/vulnerabilities`;
}

/** `infrawrench://open/<kind>?org=…`: opened by the desktop app. */
export function desktopDeepLink(link: DesktopDeepLink): string {
  const params = new URLSearchParams({ org: link.orgId });
  switch (link.kind) {
    case "resource":
      params.set("account", link.accountId);
      params.set("plugin", link.pluginId);
      params.set("type", link.resourceTypeId);
      params.set("id", link.resourceId);
      break;
    case "incident":
      params.set("id", link.incidentId);
      break;
    case "service":
      params.set("id", link.serviceId);
      break;
    case "vulnerabilities":
      break;
  }
  return `${DESKTOP_PROTOCOL}://open/${link.kind}?${params.toString()}`;
}

/**
 * Parse an `infrawrench://open/…` URL. Null for anything else, including the
 * OAuth callback (`infrawrench://callback`) and links missing a field: a
 * half-formed link opens nothing rather than a guess.
 */
export function parseDesktopDeepLink(url: string): DesktopDeepLink | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${DESKTOP_PROTOCOL}:` || parsed.hostname !== "open") return null;
  const q = parsed.searchParams;
  const orgId = q.get("org");
  if (!orgId) return null;
  const kind = parsed.pathname.replace(/^\/+|\/+$/g, "");
  // The org-wide tabs name nothing else.
  if (kind === "vulnerabilities") return { kind, orgId };
  const id = q.get("id");
  if (!id) return null;
  switch (kind) {
    case "resource": {
      const accountId = q.get("account");
      const pluginId = q.get("plugin");
      const resourceTypeId = q.get("type");
      if (!accountId || !pluginId || !resourceTypeId) return null;
      return { kind: "resource", orgId, accountId, pluginId, resourceTypeId, resourceId: id };
    }
    case "incident":
      return { kind: "incident", orgId, incidentId: id };
    case "service":
      return { kind: "service", orgId, serviceId: id };
    default:
      return null;
  }
}

/**
 * Read an organization id out of what someone pastes: the bare id, or any
 * Infrawrench web address inside the org (`…/org/<id>/settings/api-keys`),
 * which is the easier thing to copy. An API key is bound to one org and the
 * org listing does not accept keys, so key-based clients ask for this.
 */
export function parseOrgIdInput(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  const fromUrl = /\/org\/([^/?#\s]+)/.exec(text);
  if (fromUrl) {
    try {
      return decodeURIComponent(fromUrl[1]!);
    } catch {
      return fromUrl[1]!;
    }
  }
  return /^[A-Za-z0-9_-]{4,100}$/.test(text) ? text : null;
}
