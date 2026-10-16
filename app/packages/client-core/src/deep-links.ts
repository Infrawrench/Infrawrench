/**
 * Links into Infrawrench from outside it: the web app's URLs and the desktop
 * app's `infrawrench://` protocol. The editor extension and the Raycast
 * extension build them; the desktop main process parses the protocol half.
 *
 * Both sides live here so the format has one definition. A link names the org
 * it belongs to, because a resource id means nothing in another org and the
 * desktop has to refuse rather than open the wrong thing.
 */

import { isSearchObjectKind, type SearchObjectKind } from "./search";

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
  | { kind: "vulnerabilities"; orgId: string }
  /**
   * A saved object from the command palette's index (a cost report, an SLO,
   * a runbook…), opened through the same kind-to-tab mapping the palette uses.
   */
  | { kind: "object"; orgId: string; objectKind: SearchObjectKind; objectId: string };

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

/**
 * Where a saved object from the palette's index opens in the web app. Kinds
 * with a page of their own link to it; kinds that live inside a larger page
 * (a budget on Costs, a virtual tag in Settings, a probe on Probes) link to
 * that page, which is where the web palette takes them too.
 */
export function webObjectUrl(
  baseUrl: string,
  orgId: string,
  kind: SearchObjectKind,
  objectId: string,
): string {
  const base = orgBase(baseUrl, orgId);
  const id = encodeURIComponent(objectId);
  switch (kind) {
    case "cost_report":
      return `${base}/cost-reports/${id}`;
    case "cost_report_folder":
      return `${base}/cost-reports`;
    case "dashboard":
      return `${base}/dashboard/${id}`;
    case "cost_canvas":
      return `${base}/cost-canvases/${id}`;
    case "budget":
    case "saved_cost_filter":
    case "business_metric":
    case "scenario_model":
      return `${base}/costs`;
    case "virtual_tag":
      return `${base}/settings/virtual-tags`;
    case "slo":
      return `${base}/slos/${id}`;
    case "service":
      return `${base}/services/${id}`;
    case "runbook":
      return `${base}/runbooks`;
    case "status_page":
      return `${base}/status-pages`;
    case "probe":
      return `${base}/probes`;
    case "log_query":
      return `${base}/logs`;
    case "query_monitor":
      return `${base}/query-monitors`;
  }
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
    case "object":
      params.set("type", link.objectKind);
      params.set("id", link.objectId);
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
    case "object": {
      const objectKind = q.get("type");
      if (!isSearchObjectKind(objectKind)) return null;
      return { kind: "object", orgId, objectKind, objectId: id };
    }
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
