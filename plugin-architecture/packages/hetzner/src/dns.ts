import type { CreateResourceConfig, ResourceInstance } from "@infrawrench/plugin-base";
import { errorText, trailingId, type HetznerApi } from "./api.js";

/**
 * Hetzner DNS, which moved into the Cloud API (`/zones`, same project token)
 * and went GA on 2025-11-10; the standalone dns.hetzner.com API is retired.
 *
 * Records are RRSets: one object per name+type holding every value, addressed
 * as `/zones/{zone}/rrsets/{name}/{type}`. The `dns-record` type mirrors that
 * shape, with the values comma-joined into `content`.
 */

export interface HetznerZone {
  id: number;
  name: string;
  created?: string;
  mode?: "primary" | "secondary";
  ttl?: number;
  status?: string;
  record_count?: number;
  registrar?: string;
  protection?: { delete?: boolean };
  authoritative_nameservers?: {
    assigned?: string[];
    delegated?: string[];
    delegation_status?: string;
  };
}

export interface HetznerRrset {
  id?: string;
  name: string;
  type: string;
  ttl?: number | null;
  records?: Array<{ value: string; comment?: string | null }>;
  protection?: { change?: boolean };
  zone?: number;
}

/** Record types the RRSet API accepts, minus SOA (managed by Hetzner). */
export const DNS_RECORD_TYPES = [
  "A",
  "AAAA",
  "CAA",
  "CNAME",
  "DS",
  "HINFO",
  "HTTPS",
  "MX",
  "NS",
  "PTR",
  "RP",
  "SRV",
  "SVCB",
  "TLSA",
  "TXT",
];

export function mapZone(z: HetznerZone, accountId: string): ResourceInstance {
  const nameservers = (z.authoritative_nameservers?.assigned ?? []).join(", ");
  const created = z.created ?? new Date().toISOString();
  return {
    id: `${accountId}:dns-zone:${z.id}`,
    pluginId: "hetzner",
    resourceTypeId: "dns-zone",
    accountId,
    displayName: z.name,
    fields: {
      name: z.name,
      mode: z.mode ?? "primary",
      ttl: z.ttl ?? 3600,
      status: z.status ?? "",
      recordCount: z.record_count ?? 0,
      registrar: z.registrar ?? "",
      delegationStatus: z.authoritative_nameservers?.delegation_status ?? "",
      nameservers,
      deleteProtection: z.protection?.delete ?? false,
    },
    resolvedOutputs: { nameservers, zoneId: String(z.id) },
    secretStates: [],
    externalId: String(z.id),
    createdAt: created,
    updatedAt: created,
  };
}

export function mapRrset(r: HetznerRrset, zone: HetznerZone, accountId: string): ResourceInstance {
  const externalId = `${zone.id}/${r.name}/${r.type}`;
  const fqdn = r.name === "@" ? zone.name : `${r.name}.${zone.name}`;
  const now = new Date().toISOString();
  return {
    id: `${accountId}:dns-record:${externalId}`,
    pluginId: "hetzner",
    resourceTypeId: "dns-record",
    accountId,
    displayName: `${r.type} ${fqdn}`,
    fields: {
      name: r.name,
      type: r.type,
      content: (r.records ?? []).map((rec) => rec.value).join(", "),
      // null = the zone's default; stored as "" so the edit form shows it empty.
      ...(r.ttl != null ? { ttl: r.ttl } : { ttl: "" }),
      zoneName: zone.name,
      zoneId: String(zone.id),
      changeProtection: r.protection?.change ?? false,
    },
    resolvedOutputs: {},
    secretStates: [],
    externalId,
    parentResourceId: `${accountId}:dns-zone:${zone.id}`,
    createdAt: zone.created ?? now,
    updatedAt: now,
  };
}

/**
 * Split user-entered record values on newlines and on commas outside double
 * quotes, so a quoted TXT value containing a comma survives intact.
 */
export function parseRecordValues(input: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  for (const ch of input) {
    if (ch === '"') quoted = !quoted;
    if (!quoted && (ch === "," || ch === "\n")) {
      if (current.trim()) out.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

export async function listZones(api: HetznerApi, accountId: string): Promise<ResourceInstance[]> {
  const zones = await api.fetchAll<HetznerZone>("/zones", "zones");
  return zones.map((z) => mapZone(z, accountId));
}

export async function listRrsets(api: HetznerApi, accountId: string): Promise<ResourceInstance[]> {
  const zones = await api.fetchAll<HetznerZone>("/zones", "zones");
  const perZone = await Promise.all(
    zones.map(async (zone) => {
      // Secondary zones are read-only copies of someone else's primary;
      // their records still list, so they are included.
      const rrsets = await api.fetchAll<HetznerRrset>(`/zones/${zone.id}/rrsets`, "rrsets");
      return rrsets.filter((r) => r.type !== "SOA").map((r) => mapRrset(r, zone, accountId));
    }),
  );
  return perZone.flat();
}

export async function zoneCreateConfig(): Promise<CreateResourceConfig> {
  return {
    fields: [
      {
        key: "name",
        label: "Domain",
        kind: "text",
        required: true,
        placeholder: "example.com",
        description: "The apex domain, lowercase, without a trailing dot",
      },
      {
        key: "ttl",
        label: "Default TTL",
        kind: "number",
        required: false,
        defaultValue: "3600",
        minValue: 60,
        description: "Seconds",
      },
    ],
  };
}

export async function recordCreateConfig(
  api: HetznerApi,
  parentResourceId?: string,
): Promise<CreateResourceConfig> {
  const fields: CreateResourceConfig["fields"] = [];
  if (!parentResourceId) {
    const zones = await api.fetchAll<HetznerZone>("/zones?mode=primary", "zones");
    const options = zones.map((z) => ({ id: String(z.id), label: z.name }));
    fields.push({
      key: "zoneId",
      label: "Zone",
      kind: "select",
      required: true,
      options,
      ...(options[0] ? { defaultValue: options[0].id } : {}),
    });
  }
  fields.push(
    {
      key: "type",
      label: "Record Type",
      kind: "select",
      required: true,
      options: DNS_RECORD_TYPES.map((t) => ({ id: t, label: t })),
      defaultValue: "A",
    },
    {
      key: "name",
      label: "Name",
      kind: "text",
      required: true,
      defaultValue: "@",
      description: "Relative to the zone, e.g. www; @ for the zone apex",
    },
    {
      key: "content",
      label: "Values",
      kind: "string-list",
      required: true,
      description:
        'One value per row, e.g. 203.0.113.1, or "10 mail.example.com." for MX. Quote TXT values',
    },
    {
      key: "ttl",
      label: "TTL",
      kind: "number",
      required: false,
      minValue: 60,
      description: "Seconds. Leave empty to use the zone's default TTL",
    },
  );
  return { fields };
}

export async function createZone(
  api: HetznerApi,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const ttl = fields["ttl"] ? Number(fields["ttl"]) : undefined;
  const data = await api.fetch<{ zone: HetznerZone }>("/zones", {
    method: "POST",
    body: JSON.stringify({
      name: (fields["name"] ?? "").trim().toLowerCase().replace(/\.$/, ""),
      mode: "primary",
      ...(ttl ? { ttl } : {}),
    }),
  });
  return mapZone(data.zone, accountId);
}

export async function createRrset(
  api: HetznerApi,
  accountId: string,
  fields: Record<string, string>,
  parentResourceId?: string,
): Promise<ResourceInstance> {
  const zoneId = fields["zoneId"] || (parentResourceId ? trailingId(parentResourceId) : "");
  if (!zoneId) throw new Error("Hetzner plugin: a zone is required to create a DNS record");
  const values = parseRecordValues(fields["content"] ?? "");
  if (values.length === 0) throw new Error("Hetzner plugin: a DNS record needs at least one value");
  const ttl = fields["ttl"] ? Number(fields["ttl"]) : undefined;
  const [zoneData, created] = await Promise.all([
    api.fetch<{ zone: HetznerZone }>(`/zones/${zoneId}`),
    api.fetch<{ rrset: HetznerRrset }>(`/zones/${zoneId}/rrsets`, {
      method: "POST",
      body: JSON.stringify({
        name: (fields["name"] || "@").trim().toLowerCase(),
        type: fields["type"] || "A",
        ...(ttl ? { ttl } : {}),
        records: values.map((value) => ({ value })),
      }),
    }),
  ]);
  return mapRrset(created.rrset, zoneData.zone, accountId);
}

/** externalId `{zoneId}/{name}/{type}` → its RRSet path. */
function rrsetPath(resourceId: string): string {
  const externalId = resourceId.split(":").slice(2).join(":");
  const [zoneId, name, type] = externalId.split("/");
  if (!zoneId || !name || !type) throw new Error(`Cannot parse DNS record ID "${resourceId}"`);
  return `/zones/${zoneId}/rrsets/${encodeURIComponent(name)}/${type}`;
}

export async function deleteRrset(api: HetznerApi, resourceId: string): Promise<void> {
  await api.fetch<unknown>(rrsetPath(resourceId), { method: "DELETE" });
}

export async function deleteZone(api: HetznerApi, resourceId: string): Promise<void> {
  await api.fetch<unknown>(`/zones/${trailingId(resourceId)}`, { method: "DELETE" });
}

/** Edit a zone's default TTL. */
export async function updateZone(
  api: HetznerApi,
  resourceId: string,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const zoneId = trailingId(resourceId);
  if (fields["ttl"] !== undefined && fields["ttl"] !== "") {
    await api.fetch<unknown>(`/zones/${zoneId}/actions/change_ttl`, {
      method: "POST",
      body: JSON.stringify({ ttl: Number(fields["ttl"]) }),
    });
  }
  const data = await api.fetch<{ zone: HetznerZone }>(`/zones/${zoneId}`);
  return mapZone(data.zone, accountId);
}

/**
 * Edit a record set: replace its values (`set_records`) and/or its TTL
 * (`change_ttl`; an emptied TTL resets to the zone default with `null`).
 */
export async function updateRrset(
  api: HetznerApi,
  resourceId: string,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const path = rrsetPath(resourceId);
  const failures: string[] = [];
  if (fields["content"] !== undefined) {
    const values = parseRecordValues(fields["content"]);
    if (values.length === 0) {
      failures.push("a DNS record needs at least one value");
    } else {
      try {
        await api.fetch<unknown>(`${path}/actions/set_records`, {
          method: "POST",
          body: JSON.stringify({ records: values.map((value) => ({ value })) }),
        });
      } catch (e) {
        failures.push(`set records failed: ${errorText(e)}`);
      }
    }
  }
  if (fields["ttl"] !== undefined) {
    try {
      await api.fetch<unknown>(`${path}/actions/change_ttl`, {
        method: "POST",
        body: JSON.stringify({ ttl: fields["ttl"] === "" ? null : Number(fields["ttl"]) }),
      });
    } catch (e) {
      failures.push(`change TTL failed: ${errorText(e)}`);
    }
  }
  if (failures.length > 0) throw new Error(`Hetzner DNS record update: ${failures.join("; ")}`);
  const zoneId = path.split("/")[2]!;
  const [zone, rrset] = await Promise.all([
    api.fetch<{ zone: HetznerZone }>(`/zones/${zoneId}`),
    api.fetch<{ rrset: HetznerRrset }>(path),
  ]);
  return mapRrset(rrset.rrset, zone.zone, accountId);
}
