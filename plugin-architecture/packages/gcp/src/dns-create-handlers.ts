import type { CreateResourceConfig, ResourceInstance } from "@infrawrench/plugin-base";
import type { GcpCreateContext } from "./create-context.js";

export const dnsCreateConfigHandlers: Record<
  string,
  (ctx: GcpCreateContext, parentResourceId?: string) => Promise<CreateResourceConfig>
> = {
  "cloud-dns-zone": async (ctx, parentResourceId) => {
    return {
      fields: [
        {
          key: "name",
          label: "Zone Name",
          kind: "text",
          required: true,
          description: "Internal name (letters, numbers, hyphens)",
        },
        {
          key: "dnsName",
          label: "DNS Name",
          kind: "text",
          required: true,
          description: "Domain name with trailing dot, e.g. example.com.",
        },
        {
          key: "description",
          label: "Description",
          kind: "text",
          required: false,
        },
      ],
    };
  },
  "cloud-dns-record-set": async (ctx, parentResourceId) => {
    const p = ctx.project;
    const hasParent = !!parentResourceId;
    const fields: CreateResourceConfig["fields"] = [];
    if (!hasParent) {
      const zones = await ctx.paginate<Record<string, unknown>>(
        `https://dns.googleapis.com/dns/v1/projects/${p}/managedZones`,
        "managedZones",
      );
      const zoneOptions = zones.map((z) => ({
        id: String(z["name"]),
        label: String(z["dnsName"] ?? z["name"]),
      }));
      fields.push({
        key: "managedZone",
        label: "Managed Zone",
        kind: "select",
        required: true,
        options: zoneOptions,
        ...(zoneOptions[0] ? { defaultValue: zoneOptions[0].id } : {}),
      });
    }
    fields.push(
      {
        key: "name",
        label: "Record Name",
        kind: "text",
        required: true,
        description: "Fully qualified domain name with trailing dot (e.g. www.example.com.)",
      },
      {
        key: "type",
        label: "Record Type",
        kind: "select",
        required: true,
        options: [
          { id: "A", label: "A" },
          { id: "AAAA", label: "AAAA" },
          { id: "CNAME", label: "CNAME" },
          { id: "MX", label: "MX" },
          { id: "TXT", label: "TXT" },
          { id: "NS", label: "NS" },
          { id: "SRV", label: "SRV" },
        ],
        defaultValue: "A",
      },
      {
        key: "ttl",
        label: "TTL (seconds)",
        kind: "number",
        required: false,
        defaultValue: "300",
        minValue: 1,
        maxValue: 86400,
      },
      {
        key: "rrdatas",
        label: "Data",
        kind: "text",
        required: true,
        description: "Comma-separated record data (e.g. 1.2.3.4)",
      },
    );
    return { fields };
  },
};

export const dnsCreateResourceHandlers: Record<
  string,
  (
    ctx: GcpCreateContext,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ) => Promise<ResourceInstance>
> = {
  "cloud-dns-zone": async (ctx, accountId, fields, parentResourceId) => {
    const p = ctx.project;
    const tok = await ctx.token();
    const name = fields["name"] ?? "";
    const dnsName = fields["dnsName"] ?? "";
    const description = fields["description"] ?? "";

    const res = await fetch(`https://dns.googleapis.com/dns/v1/projects/${p}/managedZones`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name, dnsName, description, visibility: "public" }),
    });
    if (!res.ok) throw new Error(`Cloud DNS API ${res.status}: ${await res.text()}`);
    const zone = (await res.json()) as Record<string, unknown>;
    const now = ctx.now();
    const ns = (zone["nameServers"] as string[]) ?? [];
    return {
      id: ctx.id(accountId, "cloud-dns-zone", name),
      pluginId: "gcp",
      resourceTypeId: "cloud-dns-zone",
      accountId,
      displayName: dnsName,
      fields: {
        name,
        dnsName,
        description,
        visibility: "public",
        nameservers: ns.join(", "),
        dnssecState: "",
        recordCount: 0,
      },
      resolvedOutputs: { nameservers: ns.join(", ") },
      secretStates: [],
      externalId: name,
      createdAt: String(zone["creationTime"] ?? now),
      updatedAt: now,
    };
  },
  "cloud-dns-record-set": async (ctx, accountId, fields, parentResourceId) => {
    const p = ctx.project;
    const tok = await ctx.token();
    const parentExternalId = parentResourceId ? parentResourceId.split(":").slice(2).join(":") : "";
    const managedZone = fields["managedZone"] || parentExternalId;
    if (!managedZone) throw new Error("Cloud DNS record set creation requires a managed zone");
    const name = fields["name"] ?? "";
    const type = fields["type"] ?? "A";
    const ttl = Number(fields["ttl"] || 300);
    const rrdatasStr = fields["rrdatas"] ?? "";
    const rrdatas = rrdatasStr
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const res = await fetch(
      `https://dns.googleapis.com/dns/v1/projects/${p}/managedZones/${managedZone}/changes`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          additions: [{ name, type, ttl, rrdatas }],
        }),
      },
    );
    if (!res.ok) throw new Error(`Cloud DNS API ${res.status}: ${await res.text()}`);
    const now = ctx.now();
    const shortName = name.replace(/\.$/, "");
    const recordKey = `${type}:${name}`;
    return {
      id: ctx.id(accountId, "cloud-dns-record-set", `${managedZone}/${recordKey}`),
      pluginId: "gcp",
      resourceTypeId: "cloud-dns-record-set",
      accountId,
      displayName: `${type} ${shortName}`,
      fields: {
        type,
        name: shortName,
        rrdatas: rrdatas.join(", "),
        ttl,
        zoneName: managedZone,
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: `${managedZone}/${recordKey}`,
      createdAt: now,
      updatedAt: now,
    };
  },
};
