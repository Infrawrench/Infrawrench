import type {
  PluginClient,
  ResourceInstance,
  DetailViewSchema,
  SidebarItemSchema,
  SectionNode,
  SchemaNode,
  BadgeNode,
} from "@infrawrench/plugin-base";

// ─── DNS record type badge colors ─────────────────────────────────────────────

const RECORD_TYPE_COLORS: Record<string, BadgeNode["color"]> = {
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

function recordTypeBadgeColor(type: string): BadgeNode["color"] {
  return RECORD_TYPE_COLORS[type] ?? "gray";
}

function formatTtl(ttl: number): string {
  if (ttl === 1) return "Auto";
  if (ttl < 60) return `${ttl}s`;
  if (ttl < 3600) return `${Math.round(ttl / 60)}m`;
  if (ttl < 86400) return `${Math.round(ttl / 3600)}h`;
  return `${Math.round(ttl / 86400)}d`;
}

function cfZoneStatus(status: string): "healthy" | "degraded" | "error" | "unknown" | "provisioning" {
  switch (status) {
    case "active": return "healthy";
    case "pending": return "provisioning";
    case "initializing": return "provisioning";
    case "moved": return "degraded";
    case "deleted": return "error";
    case "deactivated": return "error";
    default: return "unknown";
  }
}

// ─── Client ──────────────────────────────────────────────────────────────────

export class CloudflareClient implements PluginClient {
  private readonly apiToken: string;
  private readonly baseUrl = "https://api.cloudflare.com/client/v4";

  constructor(credentials: Record<string, string>) {
    const token = credentials["apiToken"];
    if (!token) throw new Error("Cloudflare plugin: missing apiToken credential");
    this.apiToken = token;
  }

  private async fetch<T>(path: string, options?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        "Content-Type": "application/json",
      },
      ...options,
    });
    if (!res.ok) {
      throw new Error(`Cloudflare API error ${res.status} for ${path}: ${await res.text()}`);
    }
    const json = await res.json() as { success: boolean; result: T; errors?: Array<{ message: string }> };
    if (!json.success) {
      const msgs = json.errors?.map((e) => e.message).join(", ") ?? "unknown error";
      throw new Error(`Cloudflare API error for ${path}: ${msgs}`);
    }
    return json.result;
  }

  /** Paginate through Cloudflare's v4 API (page-based) */
  private async paginate<T>(path: string, perPage = 50): Promise<T[]> {
    const results: T[] = [];
    let page = 1;
    for (;;) {
      const sep = path.includes("?") ? "&" : "?";
      const res = await fetch(`${this.baseUrl}${path}${sep}page=${page}&per_page=${perPage}`, {
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          "Content-Type": "application/json",
        },
      });
      if (!res.ok) throw new Error(`Cloudflare API error ${res.status}: ${await res.text()}`);
      const json = await res.json() as {
        success: boolean;
        result: T[];
        result_info?: { total_pages: number; page: number };
      };
      if (!json.success || !Array.isArray(json.result)) break;
      results.push(...json.result);
      const totalPages = json.result_info?.total_pages ?? 1;
      if (page >= totalPages) break;
      page++;
    }
    return results;
  }

  // ─── Core interface ─────────────────────────────────────────────────────────

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "zone": return this.listZones(accountId);
      case "dns-record": return this.listAllDnsRecords(accountId);
      case "worker": return this.listWorkers(accountId);
      default:
        throw new Error(`Cloudflare plugin: unknown resource type "${typeId}"`);
    }
  }

  async getResource(typeId: string, resourceId: string, accountId: string): Promise<ResourceInstance> {
    if (typeId === "zone") {
      const externalId = resourceId.split(":").slice(2).join(":");
      const zone = await this.fetch<Record<string, unknown>>(`/zones/${externalId}`);
      return this.mapZone(zone, accountId);
    }
    if (typeId === "dns-record") {
      // dns-record ID format: {accountId}:dns-record:{zoneId}/{recordId}
      const externalId = resourceId.split(":").slice(2).join(":");
      const [zoneId, recordId] = externalId.split("/");
      if (!zoneId || !recordId) throw new Error("Invalid DNS record ID");
      const record = await this.fetch<Record<string, unknown>>(`/zones/${zoneId}/dns_records/${recordId}`);
      return this.mapDnsRecord(record, accountId, zoneId);
    }
    const all = await this.listResources(typeId, accountId);
    const found = all.find((r) => r.id === resourceId);
    if (!found) throw new Error(`Cloudflare plugin: resource ${typeId}/${resourceId} not found`);
    return found;
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    if (typeId === "zone") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      if (outputKey === "zoneId") return resource.externalId ?? "";
      if (outputKey === "nameservers") return String(resource.fields["nameservers"] ?? "");
    }
    throw new Error(`Cloudflare plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    if (resource.resourceTypeId === "zone") {
      return this.renderZoneDetail(resource);
    }
    if (resource.resourceTypeId === "dns-record") {
      return this.renderDnsRecordDetail(resource);
    }
    return this.renderGenericDetail(resource);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    if (resource.resourceTypeId === "dns-record") {
      const type = String(resource.fields["type"] ?? "");
      const name = String(resource.fields["name"] ?? "");
      const shortName = name.length > 30 ? `${name.slice(0, 27)}...` : name;
      return {
        id: resource.id,
        label: `${type}  ${shortName}`,
        ...(resource.fields["proxied"]
          ? { status: { kind: "status-dot" as const, status: "healthy" as const, label: "Proxied" } }
          : {}),
      };
    }
    if (resource.resourceTypeId === "zone") {
      const status = String(resource.fields["status"] ?? "");
      return {
        id: resource.id,
        label: resource.displayName,
        status: { kind: "status-dot", status: cfZoneStatus(status), label: status },
      };
    }
    return {
      id: resource.id,
      label: resource.displayName,
      status: { kind: "status-dot", status: "unknown" },
    };
  }

  // ─── Zone detail — the nice DNS view ────────────────────────────────────────

  private renderZoneDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const status = String(fields["status"] ?? "");
    const nameservers = String(fields["nameservers"] ?? "");
    const nsList = nameservers.split(", ").filter(Boolean);

    const sections: SectionNode[] = [
      {
        kind: "section",
        title: "Zone Info",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Domain", value: String(fields["name"] ?? "") },
              { key: "Status", value: status },
              { key: "Plan", value: String(fields["plan"] ?? "Free") },
              { key: "Type", value: String(fields["type"] ?? "full") },
              ...(fields["paused"] ? [{ key: "Paused", value: "Yes" }] : []),
            ],
          },
        ],
      },
    ];

    if (nsList.length > 0) {
      sections.push({
        kind: "section",
        title: "Nameservers",
        children: [
          {
            kind: "key-value-list",
            items: nsList.map((ns, i) => ({
              key: `NS ${i + 1}`,
              value: ns,
              copyable: true,
            })),
          },
          {
            kind: "text",
            content: "Point your domain registrar to these nameservers to activate Cloudflare.",
            variant: "muted",
          },
        ],
      });
    }

    // DNS records are loaded as children — we populate a summary section
    // from the resolvedOutputs where we stash a record count
    const recordCount = resource.resolvedOutputs["__recordCount__"];
    if (recordCount) {
      sections.push({
        kind: "section",
        title: "DNS Records",
        children: [
          {
            kind: "text",
            content: `${recordCount} records in this zone. Expand this zone in the sidebar to browse individual records.`,
            variant: "muted",
          },
        ],
      });
    }

    return {
      title: resource.displayName,
      subtitle: `Zone \u00B7 ${String(fields["plan"] ?? "Free")}`,
      status: {
        kind: "status-dot",
        status: cfZoneStatus(status),
        label: status,
      },
      sections,
      headerActions: [
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
        {
          kind: "action",
          label: "Open in Cloudflare",
          action: { type: "open-url", url: `https://dash.cloudflare.com/${resource.externalId ?? ""}` },
        },
      ],
    };
  }

  // ─── DNS record detail — rich per-record view ──────────────────────────────

  private renderDnsRecordDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const type = String(fields["type"] ?? "");
    const name = String(fields["name"] ?? "");
    const content = String(fields["content"] ?? "");
    const ttl = Number(fields["ttl"] ?? 0);
    const proxied = Boolean(fields["proxied"]);
    const priority = fields["priority"] !== undefined ? Number(fields["priority"]) : null;
    const comment = String(fields["comment"] ?? "");
    const zoneName = String(fields["zoneName"] ?? "");

    const infoItems: Array<{ key: string; value: string; copyable?: boolean }> = [
      { key: "Type", value: type },
      { key: "Name", value: name, copyable: true },
      { key: "Content", value: content, copyable: true },
      { key: "TTL", value: formatTtl(ttl) },
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

    const badges: SchemaNode[] = [
      { kind: "badge", label: type, color: recordTypeBadgeColor(type) },
    ];
    if (proxied) {
      badges.push({ kind: "badge", label: "Proxied", color: "green" });
    } else if (["A", "AAAA", "CNAME"].includes(type)) {
      badges.push({ kind: "badge", label: "DNS Only", color: "gray" });
    }

    const sections: SectionNode[] = [
      {
        kind: "section",
        title: "Record Details",
        children: [
          ...badges,
          { kind: "key-value-list", items: infoItems },
        ],
      },
    ];

    // For proxied records, show Cloudflare proxy info
    if (proxied) {
      sections.push({
        kind: "section",
        title: "Cloudflare Proxy",
        children: [
          {
            kind: "text",
            content: "Traffic to this record is routed through Cloudflare's network, providing DDoS protection, SSL, and caching.",
            variant: "muted",
          },
        ],
      });
    }

    return {
      title: name,
      subtitle: `${type} \u2192 ${content.length > 50 ? `${content.slice(0, 47)}...` : content}`,
      status: {
        kind: "status-dot",
        status: proxied ? "healthy" : "unknown",
        label: proxied ? "Proxied" : "DNS Only",
      },
      sections,
      headerActions: [
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
      ],
    };
  }

  // ─── Generic detail (Workers, etc.) ────────────────────────────────────────

  private renderGenericDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    return {
      title: resource.displayName,
      subtitle: resource.resourceTypeId,
      status: { kind: "status-dot", status: "unknown" },
      sections: [
        {
          kind: "section",
          title: "Details",
          children: [
            {
              kind: "key-value-list",
              items: Object.entries(fields)
                .filter(([, v]) => v !== "" && v !== undefined)
                .map(([key, value]) => ({ key, value: String(value) })),
            },
          ],
        },
      ],
      headerActions: [
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
      ],
    };
  }

  // ─── List helpers ──────────────────────────────────────────────────────────

  private async listZones(accountId: string): Promise<ResourceInstance[]> {
    const zones = await this.paginate<Record<string, unknown>>("/zones");
    return zones.map((z) => this.mapZone(z, accountId));
  }

  private mapZone(z: Record<string, unknown>, accountId: string): ResourceInstance {
    const nameservers = Array.isArray(z["name_servers"])
      ? (z["name_servers"] as string[]).join(", ")
      : "";
    const plan = z["plan"] as Record<string, unknown> | undefined;
    return {
      id: `${accountId}:zone:${String(z["id"])}`,
      pluginId: "cloudflare",
      resourceTypeId: "zone",
      accountId,
      displayName: String(z["name"]),
      fields: {
        name: String(z["name"]),
        status: String(z["status"] ?? ""),
        plan: String(plan?.["name"] ?? "Free"),
        nameservers,
        type: String(z["type"] ?? "full"),
        paused: Boolean(z["paused"]),
      },
      resolvedOutputs: {
        zoneId: String(z["id"]),
        nameservers,
      },
      secretStates: [],
      externalId: String(z["id"]),
      createdAt: String(z["created_on"] ?? new Date().toISOString()),
      updatedAt: String(z["modified_on"] ?? new Date().toISOString()),
    };
  }

  private async listAllDnsRecords(accountId: string): Promise<ResourceInstance[]> {
    // List all zones first, then fetch records for each
    const zones = await this.paginate<Record<string, unknown>>("/zones");
    const results: ResourceInstance[] = [];
    for (const zone of zones) {
      const zoneId = String(zone["id"]);
      const records = await this.paginate<Record<string, unknown>>(`/zones/${zoneId}/dns_records`);
      for (const r of records) {
        results.push(this.mapDnsRecord(r, accountId, zoneId));
      }
    }
    return results;
  }

  /** List DNS records for a specific zone */
  async listDnsRecordsForZone(zoneId: string, accountId: string): Promise<ResourceInstance[]> {
    const records = await this.paginate<Record<string, unknown>>(`/zones/${zoneId}/dns_records`);
    return records.map((r) => this.mapDnsRecord(r, accountId, zoneId));
  }

  private mapDnsRecord(
    r: Record<string, unknown>,
    accountId: string,
    zoneId: string,
  ): ResourceInstance {
    const type = String(r["type"] ?? "");
    const name = String(r["name"] ?? "");
    const content = String(r["content"] ?? "");
    return {
      id: `${accountId}:dns-record:${zoneId}/${String(r["id"])}`,
      pluginId: "cloudflare",
      resourceTypeId: "dns-record",
      accountId,
      displayName: `${type} ${name}`,
      fields: {
        type,
        name,
        content,
        ttl: Number(r["ttl"] ?? 1),
        proxied: Boolean(r["proxied"]),
        ...(r["priority"] !== undefined ? { priority: Number(r["priority"]) } : {}),
        zoneName: String(r["zone_name"] ?? ""),
        ...(r["comment"] ? { comment: String(r["comment"]) } : {}),
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: `${zoneId}/${String(r["id"])}`,
      parentResourceId: `${accountId}:zone:${zoneId}`,
      createdAt: String(r["created_on"] ?? new Date().toISOString()),
      updatedAt: String(r["modified_on"] ?? new Date().toISOString()),
    };
  }

  private async listWorkers(accountId: string): Promise<ResourceInstance[]> {
    // Workers API requires account ID from Cloudflare — try to get it from /user/tokens/verify
    // then list scripts. If unavailable, return empty.
    try {
      const verify = await this.fetch<Record<string, unknown>>("/user/tokens/verify");
      const accountIdCf = String((verify as unknown as { id: string })?.id ?? "");
      if (!accountIdCf) return [];

      // Get account ID from zones (more reliable)
      const zones = await this.paginate<Record<string, unknown>>("/zones");
      const firstZone = zones[0];
      if (!firstZone) return [];
      const account = firstZone["account"] as Record<string, unknown> | undefined;
      const cfAccountId = String(account?.["id"] ?? "");
      if (!cfAccountId) return [];

      const scripts = await this.fetch<Array<Record<string, unknown>>>(
        `/accounts/${cfAccountId}/workers/scripts`,
      );
      return (scripts ?? []).map((s) => ({
        id: `${accountId}:worker:${String(s["id"] ?? s["script_name"] ?? "")}`,
        pluginId: "cloudflare",
        resourceTypeId: "worker",
        accountId,
        displayName: String(s["id"] ?? s["script_name"] ?? ""),
        fields: {
          name: String(s["id"] ?? s["script_name"] ?? ""),
          createdOn: String(s["created_on"] ?? ""),
          modifiedOn: String(s["modified_on"] ?? ""),
          compatibilityDate: String(s["compatibility_date"] ?? ""),
          routes: "",
        },
        resolvedOutputs: {},
        secretStates: [],
        externalId: String(s["id"] ?? s["script_name"] ?? ""),
        createdAt: String(s["created_on"] ?? new Date().toISOString()),
        updatedAt: String(s["modified_on"] ?? new Date().toISOString()),
      }));
    } catch {
      return [];
    }
  }
}
