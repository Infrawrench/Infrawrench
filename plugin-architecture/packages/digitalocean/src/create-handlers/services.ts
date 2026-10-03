/**
 * Create handlers for DigitalOcean's networking and platform services: load
 * balancers, Cloud Firewalls, certificates, CDN endpoints, Uptime checks, VPC
 * NAT gateways and VPC peerings. Every id the API wants (Droplets, VPCs,
 * certificates, tags, Spaces origins) comes from a picker.
 *
 * Request bodies verified against digitalocean/openapi
 * (`specification/resources/<product>/models/*_create.yml`).
 */
import type {
  CreateFieldConfig,
  CreateResourceConfig,
  ResourceInstance,
} from "@infrawrench/plugin-base";
import { regionDisplay } from "../constants.js";
import {
  mapCdnEndpoint,
  mapCertificate,
  mapFirewall,
  mapLoadBalancer,
  mapUptimeCheck,
  mapVpcNatGateway,
  mapVpcPeering,
} from "../service-listers.js";
import { buildProjectField, type DoCreateArgs, type DoCreateContext } from "./shared.js";

type Json = Record<string, unknown>;
type Option = { id: string; label: string };

const JSON_HEADERS = { "Content-Type": "application/json" };

/** Probe regions DO Uptime runs checks from (`check_updatable.regions`). */
export const UPTIME_REGIONS: Option[] = [
  { id: "us_east", label: "US East" },
  { id: "us_west", label: "US West" },
  { id: "eu_west", label: "EU West" },
  { id: "se_asia", label: "Southeast Asia" },
];

/** The five TTLs DO's CDN accepts (`cdn_endpoint.ttl` enum). */
export const CDN_TTL_OPTIONS: Option[] = [
  { id: "60", label: "1 minute" },
  { id: "600", label: "10 minutes" },
  { id: "3600", label: "1 hour" },
  { id: "86400", label: "1 day" },
  { id: "604800", label: "1 week" },
];

async function regionOptions(ctx: DoCreateContext) {
  const data = await ctx.fetch<{
    regions: Array<{ slug: string; name: string; available: boolean }>;
  }>("/regions");
  return (data.regions ?? [])
    .filter((r) => r.available)
    .map((r) => {
      const info = regionDisplay(r.slug);
      return {
        id: r.slug,
        label: r.name,
        ...(info ? { location: info.location, flag: info.flag } : {}),
      };
    });
}

/** Droplets as `name (region)` options, sorted by label. */
export async function dropletOptions(ctx: DoCreateContext, region?: string): Promise<Option[]> {
  const data = await ctx
    .fetch<{ droplets?: Json[] | null }>("/droplets?per_page=200")
    .catch(() => ({ droplets: [] as Json[] }));
  return (data.droplets ?? [])
    .map((d) => {
      const slug = String((d["region"] as Json | undefined)?.["slug"] ?? "");
      const name = String(d["name"] ?? d["id"] ?? "");
      return { id: String(d["id"] ?? ""), label: slug ? `${name} (${slug})` : name, slug };
    })
    .filter((d) => !!d.id && (!region || d.slug === region))
    .map(({ id, label }) => ({ id, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export async function vpcOptions(ctx: DoCreateContext): Promise<Option[]> {
  const data = await ctx
    .fetch<{ vpcs?: Json[] | null }>("/vpcs?per_page=200")
    .catch(() => ({ vpcs: [] as Json[] }));
  return (data.vpcs ?? [])
    .map((v) => ({
      id: String(v["id"] ?? ""),
      label: `${String(v["name"] ?? v["id"])} (${String(v["region"] ?? "")}${v["default"] === true ? ", default" : ""})`,
    }))
    .filter((v) => !!v.id)
    .sort((a, b) => a.label.localeCompare(b.label));
}

export async function tagOptions(ctx: DoCreateContext): Promise<Option[]> {
  const data = await ctx
    .fetch<{ tags?: Json[] | null }>("/tags?per_page=200")
    .catch(() => ({ tags: [] as Json[] }));
  return (data.tags ?? [])
    .map((t) => String(t["name"] ?? ""))
    .filter(Boolean)
    .map((name) => ({ id: name, label: name }));
}

export async function certificateOptions(ctx: DoCreateContext): Promise<Option[]> {
  const data = await ctx
    .fetch<{ certificates?: Json[] | null }>("/certificates?per_page=200")
    .catch(() => ({ certificates: [] as Json[] }));
  return (data.certificates ?? [])
    .map((c) => {
      const names = Array.isArray(c["dns_names"]) ? (c["dns_names"] as unknown[]).join(", ") : "";
      return {
        id: String(c["id"] ?? ""),
        label: names ? `${String(c["name"] ?? "")} (${names})` : String(c["name"] ?? ""),
      };
    })
    .filter((c) => !!c.id);
}

/** Parse a policy-picker value (JSON array of ids) or a comma list. */
export function parseIdList(raw: string | undefined): string[] {
  const value = (raw ?? "").trim();
  if (!value) return [];
  if (value.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
    } catch {
      /* fall through to the comma split */
    }
  }
  return value
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function intOr(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && raw !== undefined && raw !== "" ? Math.trunc(n) : fallback;
}

const LB_ENTRY_PROTOCOLS: Option[] = [
  { id: "http", label: "HTTP" },
  { id: "https", label: "HTTPS" },
  { id: "http2", label: "HTTP/2" },
  { id: "http3", label: "HTTP/3" },
  { id: "tcp", label: "TCP" },
  { id: "udp", label: "UDP" },
];
const LB_TARGET_PROTOCOLS: Option[] = [
  { id: "http", label: "HTTP" },
  { id: "https", label: "HTTPS" },
  { id: "http2", label: "HTTP/2" },
  { id: "tcp", label: "TCP" },
  { id: "udp", label: "UDP" },
];
/** Entry protocols that terminate TLS and so need a certificate. */
const TLS_ENTRY = ["https", "http2", "http3"];

export async function servicesGetCreateConfig(
  ctx: DoCreateContext,
  typeId: string,
  parentResourceId?: string,
): Promise<CreateResourceConfig | null> {
  if (typeId === "load-balancer") {
    const [regions, droplets, tags, vpcs, certs, projectField] = await Promise.all([
      regionOptions(ctx),
      dropletOptions(ctx),
      tagOptions(ctx),
      vpcOptions(ctx),
      certificateOptions(ctx),
      buildProjectField(ctx, parentResourceId),
    ]);
    const firstRegion = regions[0]?.id;
    return {
      fields: [
        { key: "name", label: "Name", kind: "text", required: true },
        ...projectField,
        {
          key: "region",
          label: "Region",
          kind: "region-picker",
          required: true,
          regions,
          ...(firstRegion ? { defaultValue: firstRegion } : {}),
        },
        {
          key: "lbType",
          label: "Type",
          kind: "select",
          required: true,
          defaultValue: "REGIONAL",
          options: [
            { id: "REGIONAL", label: "Regional HTTP load balancer" },
            { id: "REGIONAL_NETWORK", label: "Regional network load balancer (TCP/UDP)" },
          ],
        },
        {
          key: "network",
          label: "Network",
          kind: "select",
          required: true,
          defaultValue: "EXTERNAL",
          options: [
            { id: "EXTERNAL", label: "External (public IP)" },
            { id: "INTERNAL", label: "Internal (VPC only, no public IP)" },
          ],
        },
        {
          key: "sizeUnit",
          label: "Nodes",
          kind: "number",
          required: true,
          defaultValue: "1",
          minValue: 1,
          maxValue: 100,
          description: "Each node adds connection capacity and is billed separately.",
        },
        {
          key: "targetMode",
          label: "Targets",
          kind: "select",
          required: true,
          defaultValue: "droplets",
          options: [
            { id: "droplets", label: "Specific Droplets" },
            { id: "tag", label: "Every Droplet with a tag" },
          ],
        },
        {
          key: "dropletIds",
          label: "Droplets",
          kind: "policy-picker",
          required: false,
          policies: droplets.map((d) => ({ ...d, category: "Droplets" })),
          showWhen: { fieldKey: "targetMode", fieldValue: "droplets" },
          description: "Droplets must be in the load balancer's region.",
        },
        {
          key: "tag",
          label: "Tag",
          kind: "select",
          required: false,
          options: tags,
          ...(tags[0] ? { defaultValue: tags[0].id } : {}),
          showWhen: { fieldKey: "targetMode", fieldValue: "tag" },
          description: "Droplets carrying this tag are added and removed automatically.",
        },
        {
          key: "entryProtocol",
          label: "Entry Protocol",
          kind: "select",
          required: true,
          defaultValue: "http",
          options: LB_ENTRY_PROTOCOLS,
        },
        {
          key: "entryPort",
          label: "Entry Port",
          kind: "number",
          required: true,
          defaultValue: "80",
          minValue: 1,
          maxValue: 65535,
        },
        {
          key: "targetProtocol",
          label: "Target Protocol",
          kind: "select",
          required: true,
          defaultValue: "http",
          options: LB_TARGET_PROTOCOLS,
        },
        {
          key: "targetPort",
          label: "Target Port",
          kind: "number",
          required: true,
          defaultValue: "80",
          minValue: 1,
          maxValue: 65535,
        },
        {
          key: "certificateId",
          label: "Certificate",
          kind: "select",
          required: false,
          options: certs,
          ...(certs[0] ? { defaultValue: certs[0].id } : {}),
          showWhen: { fieldKey: "entryProtocol", fieldValues: TLS_ENTRY },
          description:
            "Certificate used to terminate TLS. Create one under Certificates if the list is empty.",
        },
        {
          key: "healthCheckProtocol",
          label: "Health Check Protocol",
          kind: "select",
          required: false,
          defaultValue: "http",
          options: [
            { id: "http", label: "HTTP" },
            { id: "https", label: "HTTPS" },
            { id: "tcp", label: "TCP" },
          ],
        },
        {
          key: "healthCheckPort",
          label: "Health Check Port",
          kind: "number",
          required: false,
          defaultValue: "80",
          minValue: 1,
          maxValue: 65535,
        },
        {
          key: "healthCheckPath",
          label: "Health Check Path",
          kind: "text",
          required: false,
          defaultValue: "/",
          showWhen: { fieldKey: "healthCheckProtocol", fieldValues: ["http", "https"] },
        },
        {
          key: "redirectHttpToHttps",
          label: "Redirect HTTP to HTTPS",
          kind: "select",
          required: false,
          defaultValue: "false",
          options: [
            { id: "false", label: "No" },
            { id: "true", label: "Yes" },
          ],
        },
        {
          key: "vpcUuid",
          label: "VPC",
          kind: "select",
          required: false,
          options: vpcs,
          description: "Leave empty for the region's default VPC. Must be in the same region.",
        },
      ],
    };
  }

  if (typeId === "firewall") {
    const [droplets, tags] = await Promise.all([dropletOptions(ctx), tagOptions(ctx)]);
    return {
      fields: [
        {
          key: "name",
          label: "Name",
          kind: "text",
          required: true,
          description: "Letters, digits, periods and dashes; must start with a letter or digit.",
        },
        {
          key: "inboundRules",
          label: "Inbound Rules",
          kind: "key-value-list",
          required: false,
          entryKeyLabel: "Ports",
          entryKeyPlaceholder: "22, 8000-9000, or blank for all",
          entryKeyName: "ports",
          entryValueLabel: "Protocol",
          entryValueName: "protocol",
          entryValueOptions: [
            { id: "tcp", label: "TCP" },
            { id: "udp", label: "UDP" },
            { id: "icmp", label: "ICMP" },
          ],
          entryValueDefault: "tcp",
          defaultValue: JSON.stringify([{ ports: "22", protocol: "tcp" }]),
          addLabel: "+ Add inbound rule",
        },
        {
          key: "inboundSources",
          label: "Allow Inbound From",
          kind: "string-list",
          required: false,
          defaultValue: "0.0.0.0/0,::/0",
          description: "IPv4/IPv6 addresses or CIDRs the inbound rules accept traffic from.",
        },
        {
          key: "outbound",
          label: "Outbound Traffic",
          kind: "select",
          required: true,
          defaultValue: "all",
          options: [
            { id: "all", label: "Allow all outbound TCP, UDP and ICMP" },
            { id: "none", label: "Block all outbound" },
          ],
        },
        {
          key: "dropletIds",
          label: "Droplets",
          kind: "policy-picker",
          required: false,
          policies: droplets.map((d) => ({ ...d, category: "Droplets" })),
        },
        {
          key: "tags",
          label: "Tags",
          kind: "policy-picker",
          required: false,
          policies: tags.map((t) => ({ ...t, category: "Tags" })),
          description: "Every Droplet with one of these tags is protected, now and later.",
        },
      ],
    };
  }

  if (typeId === "certificate") {
    const domainsData = await ctx
      .fetch<{ domains?: Json[] | null }>("/domains?per_page=200")
      .catch(() => ({ domains: [] as Json[] }));
    const domains = (domainsData.domains ?? [])
      .map((d) => String(d["name"] ?? ""))
      .filter(Boolean)
      .map((name) => ({ id: name, label: name }));
    return {
      fields: [
        { key: "name", label: "Name", kind: "text", required: true },
        {
          key: "type",
          label: "Type",
          kind: "select",
          required: true,
          defaultValue: domains.length > 0 ? "lets_encrypt" : "custom",
          options: [
            { id: "lets_encrypt", label: "Let's Encrypt (issued and renewed by DigitalOcean)" },
            { id: "custom", label: "Upload my own certificate" },
          ],
        },
        {
          key: "domain",
          label: "Domain",
          kind: "select",
          required: false,
          options: domains,
          ...(domains[0] ? { defaultValue: domains[0].id } : {}),
          showWhen: { fieldKey: "type", fieldValue: "lets_encrypt" },
          description:
            "Only domains whose DNS DigitalOcean hosts can get a Let's Encrypt certificate.",
        },
        {
          key: "subdomains",
          label: "Also Cover",
          kind: "string-list",
          required: false,
          defaultValue: "www",
          showWhen: { fieldKey: "type", fieldValue: "lets_encrypt" },
          description: "Subdomains to include, e.g. www, api, or * for a wildcard.",
        },
        {
          key: "leafCertificate",
          label: "Certificate (PEM)",
          kind: "text",
          multiline: true,
          required: false,
          showWhen: { fieldKey: "type", fieldValue: "custom" },
        },
        {
          key: "privateKey",
          label: "Private Key (PEM)",
          kind: "text",
          multiline: true,
          required: false,
          showWhen: { fieldKey: "type", fieldValue: "custom" },
        },
        {
          key: "certificateChain",
          label: "Chain (PEM)",
          kind: "text",
          multiline: true,
          required: false,
          showWhen: { fieldKey: "type", fieldValue: "custom" },
          description: "Intermediate certificates, if your CA issued any.",
        },
      ],
    };
  }

  if (typeId === "cdn-endpoint") {
    const [origins, certs] = await Promise.all([
      ctx.listSpacesOrigins ? ctx.listSpacesOrigins().catch(() => []) : Promise.resolve([]),
      certificateOptions(ctx),
    ]);
    const originField: CreateFieldConfig =
      origins.length > 0
        ? {
            key: "origin",
            label: "Spaces Bucket",
            kind: "select",
            required: true,
            options: origins.map((o) => ({ id: o, label: o })),
            defaultValue: origins[0]!,
          }
        : {
            key: "origin",
            label: "Spaces Bucket Hostname",
            kind: "text",
            required: true,
            placeholder: "my-bucket.nyc3.digitaloceanspaces.com",
            description:
              "Add Spaces keys to this account to pick from your buckets instead of typing the hostname.",
          };
    return {
      fields: [
        originField,
        {
          key: "ttl",
          label: "Cache TTL",
          kind: "select",
          required: true,
          defaultValue: "3600",
          options: CDN_TTL_OPTIONS,
        },
        {
          key: "customDomain",
          label: "Custom Domain",
          kind: "text",
          required: false,
          placeholder: "assets.example.com",
          description: "Optional. Needs a certificate that covers it.",
        },
        {
          key: "certificateId",
          label: "Certificate",
          kind: "select",
          required: false,
          options: certs,
          description: "Required when a custom domain is set.",
        },
      ],
    };
  }

  if (typeId === "uptime-check") {
    return {
      fields: [
        { key: "name", label: "Name", kind: "text", required: true },
        {
          key: "type",
          label: "Type",
          kind: "select",
          required: true,
          defaultValue: "https",
          options: [
            { id: "https", label: "HTTPS" },
            { id: "http", label: "HTTP" },
            { id: "ping", label: "Ping" },
          ],
        },
        {
          key: "target",
          label: "Target",
          kind: "text",
          required: true,
          placeholder: "https://example.com/health",
          description: "URL for HTTP(S) checks, hostname or IP for ping.",
        },
        {
          key: "regions",
          label: "Regions",
          kind: "policy-picker",
          required: false,
          policies: UPTIME_REGIONS.map((r) => ({ ...r, category: "Probe regions" })),
          defaultValue: JSON.stringify(["us_east", "eu_west"]),
          description: "Where the check runs from.",
        },
      ],
    };
  }

  if (typeId === "vpc-nat-gateway") {
    const [regions, vpcs, projectField] = await Promise.all([
      regionOptions(ctx),
      vpcOptions(ctx),
      buildProjectField(ctx, parentResourceId),
    ]);
    const firstRegion = regions[0]?.id;
    return {
      fields: [
        { key: "name", label: "Name", kind: "text", required: true },
        ...projectField,
        {
          key: "region",
          label: "Region",
          kind: "region-picker",
          required: true,
          regions,
          ...(firstRegion ? { defaultValue: firstRegion } : {}),
        },
        {
          key: "vpcUuid",
          label: "VPC",
          kind: "select",
          required: true,
          options: vpcs,
          ...(vpcs[0] ? { defaultValue: vpcs[0].id } : {}),
          description: "The VPC whose Droplets egress through this gateway. Same region only.",
        },
        {
          key: "defaultGateway",
          label: "Default Route",
          kind: "select",
          required: true,
          defaultValue: "true",
          options: [
            { id: "true", label: "Route all VPC egress through this gateway" },
            { id: "false", label: "Only Droplets configured to use it" },
          ],
        },
        {
          key: "size",
          label: "Size",
          kind: "number",
          required: true,
          defaultValue: "1",
          minValue: 1,
          maxValue: 5,
          description: "Each unit is 2 Gbps of bandwidth with 100 GiB outbound transfer a month.",
        },
        {
          key: "tcpTimeoutSeconds",
          label: "TCP Timeout (s)",
          kind: "number",
          required: false,
          defaultValue: "30",
        },
        {
          key: "udpTimeoutSeconds",
          label: "UDP Timeout (s)",
          kind: "number",
          required: false,
          defaultValue: "30",
        },
        {
          key: "icmpTimeoutSeconds",
          label: "ICMP Timeout (s)",
          kind: "number",
          required: false,
          defaultValue: "30",
        },
      ],
    };
  }

  if (typeId === "vpc-peering") {
    const vpcs = await vpcOptions(ctx);
    return {
      fields: [
        {
          key: "name",
          label: "Name",
          kind: "text",
          required: true,
          description: "Letters, digits and dashes only.",
        },
        {
          key: "vpcA",
          label: "First VPC",
          kind: "select",
          required: true,
          options: vpcs,
          ...(vpcs[0] ? { defaultValue: vpcs[0].id } : {}),
        },
        {
          key: "vpcB",
          label: "Second VPC",
          kind: "select",
          required: true,
          options: vpcs,
          ...(vpcs[1] ? { defaultValue: vpcs[1].id } : {}),
          description: "The two VPCs' IP ranges must not overlap.",
        },
      ],
    };
  }

  return null;
}

/** Turn the firewall form's rule rows into DO `inbound_rules`. */
export function buildInboundRules(rowsJson: string | undefined, sourcesRaw: string | undefined) {
  let rows: Array<{ ports?: string; protocol?: string }> = [];
  try {
    const parsed: unknown = JSON.parse(rowsJson || "[]");
    if (Array.isArray(parsed)) rows = parsed as typeof rows;
  } catch {
    rows = [];
  }
  const addresses = parseIdList(sourcesRaw);
  const sources = { addresses: addresses.length > 0 ? addresses : ["0.0.0.0/0", "::/0"] };
  return rows
    .map((r) => {
      const protocol = String(r.protocol ?? "tcp");
      // DO uses "0" for "all ports"; ICMP has no ports and always reads "0".
      const ports = protocol === "icmp" ? "0" : String(r.ports ?? "").trim() || "0";
      return { protocol, ports, sources };
    })
    .filter((r) => ["tcp", "udp", "icmp"].includes(r.protocol));
}

/** Allow-all egress, the default DO's console applies to new firewalls. */
export const ALLOW_ALL_OUTBOUND = [
  { protocol: "tcp", ports: "0", destinations: { addresses: ["0.0.0.0/0", "::/0"] } },
  { protocol: "udp", ports: "0", destinations: { addresses: ["0.0.0.0/0", "::/0"] } },
  { protocol: "icmp", ports: "0", destinations: { addresses: ["0.0.0.0/0", "::/0"] } },
];

export async function servicesCreateResource(args: DoCreateArgs): Promise<ResourceInstance | null> {
  const { ctx, typeId, accountId, fields, parentExternalId } = args;

  if (typeId === "load-balancer") {
    const entryProtocol = fields["entryProtocol"] || "http";
    const rule: Json = {
      entry_protocol: entryProtocol,
      entry_port: intOr(fields["entryPort"], 80),
      target_protocol: fields["targetProtocol"] || "http",
      target_port: intOr(fields["targetPort"], 80),
    };
    if (TLS_ENTRY.includes(entryProtocol)) {
      if (!fields["certificateId"]) {
        throw new Error(
          `An ${entryProtocol.toUpperCase()} entry rule needs a certificate. Create one under Certificates first.`,
        );
      }
      rule["certificate_id"] = fields["certificateId"];
    }
    const healthProtocol = fields["healthCheckProtocol"] || "http";
    const body: Json = {
      name: fields["name"],
      region: fields["region"],
      type: fields["lbType"] || "REGIONAL",
      network: fields["network"] || "EXTERNAL",
      size_unit: intOr(fields["sizeUnit"], 1),
      forwarding_rules: [rule],
      health_check: {
        protocol: healthProtocol,
        port: intOr(fields["healthCheckPort"], 80),
        ...(healthProtocol === "tcp" ? {} : { path: fields["healthCheckPath"] || "/" }),
      },
      redirect_http_to_https: fields["redirectHttpToHttps"] === "true",
      ...(fields["vpcUuid"] ? { vpc_uuid: fields["vpcUuid"] } : {}),
      ...(parentExternalId ? { project_id: parentExternalId } : {}),
    };
    // droplet_ids and tag are mutually exclusive in the create schema.
    if (fields["targetMode"] === "tag") {
      if (!fields["tag"]) throw new Error("Pick the tag whose Droplets the load balancer targets.");
      body["tag"] = fields["tag"];
    } else {
      body["droplet_ids"] = parseIdList(fields["dropletIds"]).map(Number).filter(Number.isFinite);
    }
    const data = await ctx.fetch<{ load_balancer: Json }>("/load_balancers", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });
    return mapLoadBalancer(data.load_balancer ?? {}, accountId);
  }

  if (typeId === "firewall") {
    const body: Json = {
      name: fields["name"],
      inbound_rules: buildInboundRules(fields["inboundRules"], fields["inboundSources"]),
      outbound_rules: fields["outbound"] === "none" ? [] : ALLOW_ALL_OUTBOUND,
      droplet_ids: parseIdList(fields["dropletIds"]).map(Number).filter(Number.isFinite),
      tags: parseIdList(fields["tags"]),
    };
    const data = await ctx.fetch<{ firewall: Json }>("/firewalls", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });
    return mapFirewall(data.firewall ?? {}, accountId);
  }

  if (typeId === "certificate") {
    let body: Json;
    if (fields["type"] === "custom") {
      if (!fields["leafCertificate"] || !fields["privateKey"]) {
        throw new Error("A custom certificate needs both the certificate and its private key.");
      }
      body = {
        name: fields["name"],
        type: "custom",
        leaf_certificate: fields["leafCertificate"],
        private_key: fields["privateKey"],
        ...(fields["certificateChain"] ? { certificate_chain: fields["certificateChain"] } : {}),
      };
    } else {
      const domain = (fields["domain"] ?? "").trim();
      if (!domain) throw new Error("Pick the domain the certificate is for.");
      const extras = parseIdList(fields["subdomains"]).map((s) =>
        s.endsWith(`.${domain}`) || s === domain ? s : `${s}.${domain}`,
      );
      body = {
        name: fields["name"],
        type: "lets_encrypt",
        dns_names: [...new Set([domain, ...extras])],
      };
    }
    const data = await ctx.fetch<{ certificate: Json }>("/certificates", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });
    return mapCertificate(data.certificate ?? {}, accountId);
  }

  if (typeId === "cdn-endpoint") {
    const customDomain = (fields["customDomain"] ?? "").trim();
    if (customDomain && !fields["certificateId"]) {
      throw new Error("A custom domain needs a certificate that covers it.");
    }
    const body: Json = {
      origin: (fields["origin"] ?? "").trim(),
      ttl: intOr(fields["ttl"], 3600),
      ...(customDomain ? { custom_domain: customDomain } : {}),
      ...(customDomain && fields["certificateId"]
        ? { certificate_id: fields["certificateId"] }
        : {}),
    };
    const data = await ctx.fetch<{ endpoint: Json }>("/cdn/endpoints", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });
    return mapCdnEndpoint(data.endpoint ?? {}, accountId);
  }

  if (typeId === "uptime-check") {
    const regions = parseIdList(fields["regions"]);
    const body: Json = {
      name: fields["name"],
      type: fields["type"] || "https",
      target: (fields["target"] ?? "").trim(),
      regions: regions.length > 0 ? regions : ["us_east", "eu_west"],
      enabled: true,
    };
    const data = await ctx.fetch<{ check: Json }>("/uptime/checks", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });
    return mapUptimeCheck(data.check ?? {}, accountId);
  }

  if (typeId === "vpc-nat-gateway") {
    const body: Json = {
      name: fields["name"],
      type: "PUBLIC",
      region: fields["region"],
      size: intOr(fields["size"], 1),
      vpcs: [
        { vpc_uuid: fields["vpcUuid"], default_gateway: fields["defaultGateway"] !== "false" },
      ],
      udp_timeout_seconds: intOr(fields["udpTimeoutSeconds"], 30),
      icmp_timeout_seconds: intOr(fields["icmpTimeoutSeconds"], 30),
      tcp_timeout_seconds: intOr(fields["tcpTimeoutSeconds"], 30),
      ...(parentExternalId ? { project_id: parentExternalId } : {}),
    };
    const data = await ctx.fetch<{ vpc_nat_gateway: Json }>("/vpc_nat_gateways", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });
    return mapVpcNatGateway(data.vpc_nat_gateway ?? {}, accountId);
  }

  if (typeId === "vpc-peering") {
    const a = fields["vpcA"] ?? "";
    const b = fields["vpcB"] ?? "";
    if (!a || !b || a === b) throw new Error("Pick two different VPCs to peer.");
    const data = await ctx.fetch<{ vpc_peering: Json }>("/vpc_peerings", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: fields["name"], vpc_ids: [a, b] }),
    });
    return mapVpcPeering(data.vpc_peering ?? {}, accountId);
  }

  return null;
}
