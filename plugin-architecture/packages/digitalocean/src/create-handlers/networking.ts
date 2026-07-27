/** Create handlers for DigitalOcean domains and DNS records. */
import type { CreateResourceConfig, ResourceInstance } from "@infrawrench/plugin-base";
import { dnsContentField } from "@infrawrench/plugin-base";
import type { DoCreateArgs, DoCreateContext } from "./shared.js";

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

  return null;
}

/**
 * Create one of the types this module owns. Returns `null` when `typeId`
 * belongs to another module.
 */
export async function networkingCreateResource(
  args: DoCreateArgs,
): Promise<ResourceInstance | null> {
  const { ctx, typeId, accountId, fields, parentExternalId } = args;
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

  return null;
}
