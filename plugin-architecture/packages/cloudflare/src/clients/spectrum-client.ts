import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./shared.js";
import { asRecord, collectPerZone } from "./shared.js";
import type { AppCreateParams, AppUpdateParams } from "cloudflare/resources/spectrum/apps";

/**
 * Values Spectrum accepts for `proxy_protocol` / `tls`
 * (cloudflare/resources/spectrum/apps.d.ts:441 and :445). Both are
 * string-literal unions in the SDK, but the resource's fields are free-text,
 * so narrow before sending.
 */
const PROXY_PROTOCOLS = ["off", "v1", "v2", "simple"] as const;
type ProxyProtocol = (typeof PROXY_PROTOCOLS)[number];
const proxyProtocol = (value: string | undefined): ProxyProtocol => {
  const isProxyProtocol = (v: string): v is ProxyProtocol =>
    (PROXY_PROTOCOLS as readonly string[]).includes(v);
  // `off` is Cloudflare's own default and what the lister reports for apps
  // that never set one, so it is the right fallback for an unknown value.
  return value !== undefined && isProxyProtocol(value) ? value : "off";
};

const TLS_MODES = ["off", "flexible", "full", "strict"] as const;
type TLSMode = (typeof TLS_MODES)[number];
const tlsMode = (value: string | undefined): TLSMode | null => {
  const isTLSMode = (v: string): v is TLSMode => (TLS_MODES as readonly string[]).includes(v);
  // Unlike proxy_protocol there is no safe default here — guessing could turn
  // a `strict` app into a `flexible` one. An unrecognized value is dropped so
  // Spectrum keeps whatever the application already has.
  return value !== undefined && isTLSMode(value) ? value : null;
};

function mapSpectrumApplication(
  app: Record<string, unknown>,
  accountId: string,
  zoneId: string,
): ResourceInstance {
  const id = String(app["id"] ?? "");
  const protocol = String(app["protocol"] ?? "");
  const dns = app["dns"] as Record<string, unknown> | undefined;
  const dnsName = String(dns?.["name"] ?? "");
  const originDirect = Array.isArray(app["origin_direct"])
    ? (app["origin_direct"] as string[]).join(", ")
    : "";
  const originDns = app["origin_dns"] as Record<string, unknown> | undefined;
  return {
    id: `${accountId}:spectrum-application:${zoneId}/${id}`,
    pluginId: "cloudflare",
    resourceTypeId: "spectrum-application",
    accountId,
    displayName: dnsName || `${protocol} ${id.slice(0, 8)}`,
    fields: {
      protocol,
      dns: dnsName,
      originDirect,
      originDns: String(originDns?.["name"] ?? ""),
      originPort: String(app["origin_port"] ?? ""),
      ipFirewall: Boolean(app["ip_firewall"]),
      proxyProtocol: String(app["proxy_protocol"] ?? "off"),
      tls: String(app["tls"] ?? ""),
      createdOn: String(app["created_on"] ?? ""),
      modifiedOn: String(app["modified_on"] ?? ""),
    },
    resolvedOutputs: {},
    secretStates: [],
    externalId: `${zoneId}/${id}`,
    parentResourceId: `${accountId}:zone:${zoneId}`,
    createdAt: String(app["created_on"] ?? new Date().toISOString()),
    updatedAt: String(app["modified_on"] ?? new Date().toISOString()),
  };
}

export async function listAllSpectrumApplications(
  api: CloudflareApi,
  accountId: string,
): Promise<ResourceInstance[]> {
  return collectPerZone(
    api,
    async (zoneId) => {
      const part: ResourceInstance[] = [];
      for await (const app of api.cf.spectrum.apps.list({ zone_id: zoneId })) {
        part.push(mapSpectrumApplication(asRecord(app), accountId, zoneId));
      }
      return part;
    },
    "Spectrum applications",
    "Zone · Spectrum:Read",
  );
}

export async function createSpectrumApplication(
  api: CloudflareApi,
  accountId: string,
  fields: Record<string, string>,
  parentExternalId: string,
): Promise<ResourceInstance> {
  const zoneId = fields["zoneId"] || parentExternalId;
  if (!zoneId)
    throw new Error("Cloudflare plugin: zoneId is required to create a spectrum application");
  const protocol = fields["protocol"] ?? "tcp/22";
  const dns = fields["dns"] ?? "";
  const originDirect = (fields["originDirect"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  // `ip_firewall` only exists on the full `SpectrumConfigAppConfig` member of
  // the create union (apps.d.ts:476), and that member requires `traffic_type`.
  // `direct` is the Cloudflare default and the only mode valid for the
  // non-HTTP protocols the picker offers, so state it explicitly.
  const body: AppCreateParams.SpectrumConfigAppConfig = {
    zone_id: zoneId,
    protocol,
    traffic_type: "direct",
    dns: { type: "CNAME", name: dns },
    origin_direct: originDirect,
    ip_firewall: fields["ipFirewall"] === "true",
  };
  const app = await api.cf.spectrum.apps.create(body);
  return mapSpectrumApplication(asRecord(app), accountId, zoneId);
}

export async function editSpectrumApplication(
  api: CloudflareApi,
  accountId: string,
  externalId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const [zoneId, appId] = externalId.split("/");
  if (!zoneId || !appId) throw new Error("Invalid spectrum application ID");
  // Spectrum's update is a full replace, so rebuild the body from the merged
  // (current + changed) field set.
  const originDirect = (fields["originDirect"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const tls = tlsMode(fields["tls"]);
  const body: AppUpdateParams.SpectrumConfigAppConfig = {
    zone_id: zoneId,
    protocol: fields["protocol"] || "tcp/22",
    // The resource type has no traffic_type field, so there is nothing to
    // merge and a full-replace PUT falls back to Cloudflare's default anyway.
    // Stating it makes the (pre-existing) reset to "direct" explicit.
    traffic_type: "direct",
    dns: { type: "CNAME", name: fields["dns"] ?? "" },
    origin_direct: originDirect,
    ip_firewall: fields["ipFirewall"] === "true",
    proxy_protocol: proxyProtocol(fields["proxyProtocol"]),
    ...(tls ? { tls } : {}),
  };
  const app = await api.cf.spectrum.apps.update(appId, body);
  return mapSpectrumApplication(asRecord(app), accountId, zoneId);
}

export async function deleteSpectrumApplication(
  api: CloudflareApi,
  externalId: string,
): Promise<void> {
  const [zoneId, appId] = externalId.split("/");
  if (!zoneId || !appId) throw new Error("Invalid spectrum application ID");
  await api.cf.spectrum.apps.delete(appId, { zone_id: zoneId });
}
