/** Create handlers for DigitalOcean domains, DNS records, VPCs and reserved IPs. */
import type { CreateResourceConfig, ResourceInstance } from "@infrawrench/plugin-base";
import { dnsContentField } from "@infrawrench/plugin-base";
import { regionDisplay } from "../constants.js";
import { buildProjectField, type DoCreateArgs, type DoCreateContext } from "./shared.js";

/**
 * Build the create form for the types this module owns. Returns `null` when
 * `typeId` belongs to another module so the dispatcher can try the next one.
 */
export async function networkingGetCreateConfig(
  ctx: DoCreateContext,
  typeId: string,
  parentResourceId?: string,
): Promise<CreateResourceConfig | null> {
  if (typeId === "domain") {
    return {
      fields: [
        {
          key: "name",
          label: "Domain Name",
          kind: "text",
          required: true,
          description: "Root domain name, e.g. example.com",
        },
      ],
    };
  }

  if (typeId === "dns-record") {
    const hasParent = !!parentResourceId;
    const fields: CreateResourceConfig["fields"] = [];
    if (!hasParent) {
      const domains = await ctx.fetch<{ domains: Array<Record<string, unknown>> }>("/domains");
      const domainOptions = (domains.domains ?? []).map((d) => ({
        id: String(d["name"]),
        label: String(d["name"]),
      }));
      fields.push({
        key: "domainName",
        label: "Domain",
        kind: "select",
        required: true,
        options: domainOptions,
        ...(domainOptions[0] ? { defaultValue: domainOptions[0].id } : {}),
      });
    }
    fields.push(
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
          { id: "CAA", label: "CAA" },
        ],
        defaultValue: "A",
      },
      {
        key: "name",
        label: "Hostname",
        kind: "text",
        required: true,
        description: "e.g. www or @ for the root",
      },
      ...dnsContentField({
        key: "data",
        label: "Value",
        placeholder: "e.g. 192.168.1.1 for A records",
      }),
      {
        key: "ttl",
        label: "TTL",
        kind: "number",
        required: false,
        defaultValue: "1800",
        minValue: 30,
        description: "Time to live in seconds",
      },
      {
        key: "priority",
        label: "Priority",
        kind: "number",
        required: false,
        showWhen: { fieldKey: "type", fieldValue: "MX" },
        description: "Priority for MX records",
      },
    );
    return { fields };
  }

  if (typeId === "vpc") {
    // POST /v2/vpcs requires `name` + `region`; `description` and `ip_range`
    // are optional (DO generates a non-conflicting /20 when ip_range is
    // omitted). Verified against DigitalOcean's published OpenAPI spec.
    const regionsData = await ctx.fetch<{
      regions: Array<{ slug: string; name: string; available: boolean }>;
    }>("/regions");
    const regions = regionsData.regions
      .filter((r) => r.available)
      .map((r) => {
        const info = regionDisplay(r.slug);
        return {
          id: r.slug,
          label: r.name,
          ...(info ? { location: info.location, flag: info.flag } : {}),
        };
      });
    const firstRegion = regions[0]?.id;
    return {
      fields: [
        {
          key: "name",
          label: "Name",
          kind: "text",
          required: true,
          description: "Alphanumeric characters, dashes and periods only. Unique per account.",
        },
        {
          key: "region",
          label: "Region",
          kind: "region-picker",
          required: true,
          regions,
          ...(firstRegion ? { defaultValue: firstRegion } : {}),
        },
        {
          key: "ipRange",
          label: "IP Range",
          kind: "text",
          required: false,
          placeholder: "10.10.10.0/24",
          description:
            "Private CIDR block (RFC1918), between /28 and /16. Leave blank to let DigitalOcean pick a free /20.",
        },
        {
          key: "description",
          label: "Description",
          kind: "text",
          required: false,
          description: "Free-form note, up to 255 characters.",
        },
      ],
    };
  }

  if (typeId === "reserved-ip") {
    // `POST /v2/reserved_ips` takes *either* `droplet_id` (assign on
    // creation, region inferred from the Droplet) *or* `region` (+ optional
    // `project_id`) — the two are mutually exclusive in DO's schema. The form
    // makes that a mode toggle so the user never has to know which key the
    // API wants, and both branches are pickers rather than free-text ids.
    const [regionsData, dropletsData, projectField] = await Promise.all([
      ctx.fetch<{ regions: Array<{ slug: string; name: string; available: boolean }> }>("/regions"),
      ctx
        .fetch<{
          droplets?: Array<Record<string, unknown>> | null;
        }>("/droplets?per_page=200")
        .catch(() => ({ droplets: [] })),
      buildProjectField(ctx, parentResourceId),
    ]);
    const regions = regionsData.regions
      .filter((r) => r.available)
      .map((r) => {
        const info = regionDisplay(r.slug);
        return {
          id: r.slug,
          label: r.name,
          ...(info ? { location: info.location, flag: info.flag } : {}),
        };
      });
    const firstRegion = regions[0]?.id;
    const droplets = (dropletsData.droplets ?? [])
      .map((d) => {
        const slug = String((d["region"] as Record<string, unknown>)?.["slug"] ?? "");
        const name = String(d["name"] ?? d["id"] ?? "");
        return { id: String(d["id"] ?? ""), label: slug ? `${name} (${slug})` : name };
      })
      .filter((d) => !!d.id)
      .sort((a, b) => a.label.localeCompare(b.label));
    return {
      fields: [
        {
          key: "assignmentMode",
          label: "Reserve for",
          kind: "select",
          required: true,
          defaultValue: droplets.length > 0 ? "droplet" : "region",
          options: [
            { id: "droplet", label: "A Droplet (assign now — no charge)" },
            { id: "region", label: "A region (unassigned — billed monthly)" },
          ],
          description:
            "A reserved IP is free while it is assigned to a Droplet, and $5.00/month while it is only reserved to a region.",
        },
        {
          key: "dropletId",
          label: "Droplet",
          kind: "select",
          required: false,
          options: droplets,
          ...(droplets[0] ? { defaultValue: droplets[0].id } : {}),
          showWhen: { fieldKey: "assignmentMode", fieldValue: "droplet" },
          description:
            droplets.length > 0
              ? "The address is reserved in this Droplet's region and assigned to it immediately."
              : "No Droplets in this account — reserve to a region instead.",
        },
        {
          key: "region",
          label: "Region",
          kind: "region-picker",
          required: false,
          regions,
          ...(firstRegion ? { defaultValue: firstRegion } : {}),
          showWhen: { fieldKey: "assignmentMode", fieldValue: "region" },
        },
        ...projectField,
      ],
    };
  }

  return null;
}

/**
 * Create one of the types this module owns. Returns `null` when `typeId`
 * belongs to another module.
 */
export async function networkingCreateResource(
  args: DoCreateArgs,
): Promise<ResourceInstance | null> {
  const { ctx, typeId, accountId, fields, parentExternalId, effectiveParentId } = args;
  if (typeId === "domain") {
    const data = await ctx.fetch<{ domain: Record<string, unknown> }>("/domains", {
      method: "POST",
      body: JSON.stringify({ name: fields["name"] }),
    });
    const d = data.domain;
    return {
      id: `${accountId}:domain:${String(d["name"])}`,
      pluginId: "digitalocean",
      resourceTypeId: "domain",
      accountId,
      displayName: String(d["name"]),
      fields: {
        name: String(d["name"]),
        ttl: Number(d["ttl"] ?? 1800),
        zoneFile: String(d["zone_file"] ?? ""),
      },
      resolvedOutputs: {
        nameservers: "ns1.digitalocean.com, ns2.digitalocean.com, ns3.digitalocean.com",
      },
      secretStates: [],
      externalId: String(d["name"]),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  if (typeId === "dns-record") {
    // When created from a domain's detail page, the domain field is hidden
    // in the form — recover it from parentResourceId (domain externalId is
    // the domain name itself).
    const domainName = fields["domainName"] || parentExternalId;
    if (!domainName)
      throw new Error("DigitalOcean plugin: domainName is required to create a DNS record");
    const body: Record<string, unknown> = {
      type: fields["type"],
      name: fields["name"],
      data: fields["data"],
      ...(fields["ttl"] ? { ttl: Number(fields["ttl"]) } : {}),
      ...(fields["priority"] ? { priority: Number(fields["priority"]) } : {}),
    };
    const data = await ctx.fetch<{ domain_record: Record<string, unknown> }>(
      `/domains/${domainName}/records`,
      { method: "POST", body: JSON.stringify(body) },
    );
    const r = data.domain_record;
    const type = String(r["type"] ?? "");
    const name = String(r["name"] ?? "@");
    const displayName = name === "@" ? domainName : `${name}.${domainName}`;
    return {
      id: `${accountId}:dns-record:${domainName}/${String(r["id"])}`,
      pluginId: "digitalocean",
      resourceTypeId: "dns-record",
      accountId,
      displayName: `${type} ${displayName}`,
      fields: {
        type,
        name: displayName,
        data: String(r["data"] ?? ""),
        ttl: Number(r["ttl"] ?? 1800),
        ...(r["priority"] != null ? { priority: Number(r["priority"]) } : {}),
        domainName,
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: `${domainName}/${String(r["id"])}`,
      parentResourceId: `${accountId}:domain:${domainName}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  if (typeId === "vpc") {
    const data = await ctx.fetch<{ vpc: Record<string, unknown> }>("/vpcs", {
      method: "POST",
      body: JSON.stringify({
        name: fields["name"],
        region: fields["region"],
        ...(fields["ipRange"] ? { ip_range: fields["ipRange"] } : {}),
        ...(fields["description"] ? { description: fields["description"] } : {}),
      }),
    });
    const v = data.vpc;
    const id = String(v["id"] ?? "");
    const createdAt = String(v["created_at"] ?? new Date().toISOString());
    return {
      id: `${accountId}:vpc:${id}`,
      pluginId: "digitalocean",
      resourceTypeId: "vpc",
      accountId,
      displayName: String(v["name"] ?? id),
      fields: {
        name: String(v["name"] ?? ""),
        region: String(v["region"] ?? ""),
        ipRange: String(v["ip_range"] ?? ""),
        description: String(v["description"] ?? ""),
        isDefault: v["default"] === true,
        createdAt,
      },
      resolvedOutputs: { ...(id ? { vpcId: id } : {}) },
      secretStates: [],
      externalId: id,
      createdAt,
      updatedAt: createdAt,
    };
  }

  if (typeId === "reserved-ip") {
    // Mutually exclusive bodies (per `reserved_ip_create` in
    // digitalocean/openapi): `{ droplet_id }` or `{ region, project_id? }`.
    // Sending both is a 422, so branch on the form's mode toggle.
    const mode = fields["assignmentMode"] || (fields["dropletId"] ? "droplet" : "region");
    let body: Record<string, unknown>;
    if (mode === "droplet") {
      const dropletId = Number(fields["dropletId"]);
      if (!Number.isFinite(dropletId) || dropletId <= 0) {
        throw new Error("DigitalOcean plugin: pick a Droplet to assign the reserved IP to");
      }
      body = { droplet_id: dropletId };
    } else {
      const region = fields["region"];
      if (!region) {
        throw new Error("DigitalOcean plugin: a region is required to reserve an unassigned IP");
      }
      // `project_id` is only accepted on the region form; a Droplet-assigned
      // address inherits the Droplet's project.
      body = { region, ...(parentExternalId ? { project_id: parentExternalId } : {}) };
    }
    const data = await ctx.fetch<{ reserved_ip: Record<string, unknown> }>("/reserved_ips", {
      method: "POST",
      body: JSON.stringify(body),
    });
    const r = data.reserved_ip ?? {};
    const ip = String(r["ip"] ?? "");
    const droplet = (r["droplet"] ?? null) as Record<string, unknown> | null;
    const projectId = String(r["project_id"] ?? "") || parentExternalId;
    const createdAt = new Date().toISOString();
    const parentId = projectId ? `${accountId}:project:${projectId}` : effectiveParentId;
    return {
      id: `${accountId}:reserved-ip:${ip}`,
      pluginId: "digitalocean",
      resourceTypeId: "reserved-ip",
      accountId,
      displayName: ip,
      fields: {
        ip,
        region: String(
          (r["region"] as Record<string, unknown>)?.["slug"] ?? fields["region"] ?? "",
        ),
        dropletId: droplet?.["id"] != null ? String(droplet["id"]) : "",
        dropletName: droplet ? String(droplet["name"] ?? "") : "",
        locked: r["locked"] === true,
        projectId,
      },
      resolvedOutputs: { ...(ip ? { ip } : {}) },
      secretStates: [],
      externalId: ip,
      ...(parentId ? { parentResourceId: parentId } : {}),
      createdAt,
      updatedAt: createdAt,
    };
  }

  return null;
}
