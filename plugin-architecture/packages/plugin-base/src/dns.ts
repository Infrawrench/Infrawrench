/**
 * Shared DNS record rendering helpers.
 *
 * Plugins that expose DNS records can import these to avoid duplicating
 * badge-color mapping, TTL formatting, and detail-view generation logic.
 */

import type {
  BadgeNode,
  SectionNode,
  SchemaNode,
  DetailViewSchema,
  SidebarItemSchema,
  ResourceStatus,
} from "./schema.js";
import type { ResourceInstance } from "./instance.js";

const DNS_RECORD_TYPE_COLORS: Record<string, BadgeNode["color"]> = {
  A: "blue",
  AAAA: "blue",
  CNAME: "green",
  MX: "yellow",
  TXT: "gray",
  NS: "gray",
  SRV: "yellow",
  CAA: "red",
  PTR: "green",
  SOA: "gray",
  DNSKEY: "red",
  DS: "red",
  HTTPS: "green",
  SVCB: "green",
  TLSA: "red",
  LOC: "gray",
  NAPTR: "yellow",
  CERT: "red",
  URI: "green",
  SMIMEA: "red",
  SSHFP: "red",
};

/**
 * Map a DNS record type string (e.g. "A", "MX") to a badge color.
 * Falls back to "gray" for unknown types.
 */
export function dnsRecordBadgeColor(type: string): BadgeNode["color"] {
  return DNS_RECORD_TYPE_COLORS[type] ?? "gray";
}

/**
 * Format a TTL value (in seconds) into a human-readable string.
 * Returns "Auto" for TTL=1 (Cloudflare convention) and "Default" for TTL<=0.
 */
export function formatDnsTtl(ttl: number): string {
  if (ttl <= 0) return "Default";
  if (ttl === 1) return "Auto";
  if (ttl < 60) return `${ttl}s`;
  if (ttl < 3600) return `${Math.round(ttl / 60)}m`;
  if (ttl < 86400) return `${Math.round(ttl / 3600)}h`;
  return `${Math.round(ttl / 86400)}d`;
}

/**
 * Map a zone/domain status string to a ResourceStatus for the status dot.
 * Covers common statuses across Cloudflare ("active", "pending", "moved")
 * and DigitalOcean ("active"). Plugins can override for provider-specific values.
 */
export function dnsZoneStatus(status: string): ResourceStatus {
  switch (status) {
    case "active":
      return "healthy";
    case "pending":
      return "provisioning";
    case "initializing":
      return "provisioning";
    case "moved":
      return "degraded";
    case "deleted":
      return "error";
    case "deactivated":
      return "error";
    default:
      return "info";
  }
}

/** Options for rendering a DNS record detail view. */
export interface DnsRecordDetailOptions {
  /** Provider-specific extra info items appended to the record details section. */
  extraInfoItems?: Array<{ key: string; value: string; copyable?: boolean }>;
  /** Provider-specific extra sections appended after the main record section. */
  extraSections?: SectionNode[];
}

/**
 * Render a standard DNS record detail view from a ResourceInstance.
 *
 * Expects the resource's fields to contain at least:
 *   type, name, content, ttl
 * Optionally: proxied, priority, comment, zoneName
 */
export function renderDnsRecordDetail(
  resource: ResourceInstance,
  options?: DnsRecordDetailOptions,
): DetailViewSchema {
  const fields = resource.fields;
  const type = String(fields["type"] ?? "");
  const name = String(fields["name"] ?? "");
  const content = String(fields["content"] ?? fields["data"] ?? "");
  const ttl = Number(fields["ttl"] ?? 0);
  const proxied = Boolean(fields["proxied"]);
  const priority = fields["priority"] !== undefined ? Number(fields["priority"]) : null;
  const comment = String(fields["comment"] ?? "");
  const zoneName = String(fields["zoneName"] ?? fields["domainName"] ?? "");

  const infoItems: Array<{ key: string; value: string; copyable?: boolean }> = [
    { key: "Type", value: type },
    { key: "Name", value: name, copyable: true },
    { key: "Content", value: content, copyable: true },
    { key: "TTL", value: formatDnsTtl(ttl) },
  ];
  if (priority !== null) {
    infoItems.push({ key: "Priority", value: String(priority) });
  }
  if (comment) {
    infoItems.push({ key: "Comment", value: comment });
  }
  if (zoneName) {
    infoItems.push({ key: "Zone", value: zoneName });
  }
  if (options?.extraInfoItems) {
    infoItems.push(...options.extraInfoItems);
  }

  const badges: SchemaNode[] = [{ kind: "badge", label: type, color: dnsRecordBadgeColor(type) }];
  if (proxied) {
    badges.push({ kind: "badge", label: "Proxied", color: "green" });
  } else if (["A", "AAAA", "CNAME"].includes(type)) {
    badges.push({ kind: "badge", label: "DNS Only", color: "gray" });
  }

  const sections: SectionNode[] = [
    {
      kind: "section",
      title: "Record Details",
      children: [...badges, { kind: "key-value-list", items: infoItems }],
    },
  ];

  if (proxied) {
    sections.push({
      kind: "section",
      title: "Cloudflare Proxy",
      children: [
        {
          kind: "text",
          content:
            "Traffic to this record is routed through Cloudflare's network, providing DDoS protection, SSL, and caching.",
          variant: "muted",
        },
      ],
    });
  }

  if (options?.extraSections) {
    sections.push(...options.extraSections);
  }

  return {
    title: name,
    subtitle: `${type} → ${content.length > 50 ? `${content.slice(0, 47)}...` : content}`,
    status: {
      kind: "status-dot",
      status: proxied ? "healthy" : "info",
      label: proxied ? "Proxied" : "DNS Only",
    },
    sections,
    headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
  };
}

/**
 * Render a sidebar item for a DNS record.
 */
export function renderDnsRecordSidebar(resource: ResourceInstance): SidebarItemSchema {
  const type = String(resource.fields["type"] ?? "");
  const name = String(resource.fields["name"] ?? "");
  const shortName = name.length > 30 ? `${name.slice(0, 27)}...` : name;
  const proxied = Boolean(resource.fields["proxied"]);

  return {
    id: resource.id,
    label: `${type}  ${shortName}`,
    ...(proxied
      ? { status: { kind: "status-dot" as const, status: "healthy" as const, label: "Proxied" } }
      : {}),
  };
}
