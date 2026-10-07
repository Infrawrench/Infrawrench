/** Pure mappers from OpenStack payloads to fields. */

const GIB = 1024 ** 3;
export const gib = (bytes: unknown): number =>
  typeof bytes === "number" && Number.isFinite(bytes) ? Math.round((bytes / GIB) * 100) / 100 : 0;

export const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));

export interface NovaServer {
  id: string;
  name: string;
  status: string;
  description?: string | null;
  flavor?: { id?: string; original_name?: string; vcpus?: number; ram?: number; disk?: number };
  image?: { id?: string } | string;
  key_name?: string | null;
  "OS-EXT-AZ:availability_zone"?: string;
  addresses?: Record<string, Array<{ addr: string; version?: number; "OS-EXT-IPS:type"?: string }>>;
  security_groups?: Array<{ name: string }>;
  "os-extended-volumes:volumes_attached"?: Array<{ id: string }>;
  locked?: boolean;
  tags?: string[];
  created?: string;
}

export function serverAddresses(s: NovaServer): {
  fixed: string[];
  floating: string[];
  publicIp: string;
  privateIp: string;
} {
  const fixed: string[] = [];
  const floating: string[] = [];
  for (const list of Object.values(s.addresses ?? {})) {
    for (const a of list) {
      if (a["OS-EXT-IPS:type"] === "floating") floating.push(a.addr);
      else fixed.push(a.addr);
    }
  }
  const v4 = (l: string[]) => l.find((ip) => !ip.includes(":"));
  const privateIp = v4(fixed) ?? fixed[0] ?? "";
  const publicIp = v4(floating) ?? floating[0] ?? privateIp;
  return { fixed, floating, publicIp, privateIp };
}

export function mapServerFields(
  s: NovaServer,
  networkIdsByName: Map<string, string>,
): Record<string, string | number | boolean> {
  const addrs = serverAddresses(s);
  const netNames = Object.keys(s.addresses ?? {});
  const image = typeof s.image === "object" && s.image ? (s.image.id ?? "") : "";
  return {
    name: s.name,
    description: str(s.description),
    status: s.status,
    flavor: s.flavor?.original_name ?? s.flavor?.id ?? "",
    vcpus: s.flavor?.vcpus ?? 0,
    ramMb: s.flavor?.ram ?? 0,
    diskGb: s.flavor?.disk ?? 0,
    imageId: image,
    keyName: str(s.key_name),
    availabilityZone: s["OS-EXT-AZ:availability_zone"] ?? "",
    networkNames: netNames.join(", "),
    networkIds: netNames
      .map((n) => networkIdsByName.get(n) ?? "")
      .filter(Boolean)
      .join(", "),
    fixedIps: addrs.fixed.join(", "),
    floatingIps: addrs.floating.join(", "),
    securityGroups: [...new Set((s.security_groups ?? []).map((g) => g.name))].join(", "),
    volumeIds: (s["os-extended-volumes:volumes_attached"] ?? []).map((v) => v.id).join(", "),
    locked: !!s.locked,
    tags: (s.tags ?? []).join(", "),
    createdAt: str(s.created),
  };
}

export interface SgRule {
  id: string;
  direction: string;
  ethertype: string;
  protocol?: string | null;
  port_range_min?: number | null;
  port_range_max?: number | null;
  remote_ip_prefix?: string | null;
  remote_group_id?: string | null;
  description?: string | null;
  security_group_id: string;
}

export function mapRuleFields(r: SgRule): Record<string, string | number | boolean> {
  const fields: Record<string, string | number | boolean> = {
    direction: r.direction,
    ethertype: r.ethertype,
    protocol: str(r.protocol),
    remoteIpPrefix: str(r.remote_ip_prefix),
    remoteGroupId: str(r.remote_group_id),
    description: str(r.description),
    securityGroupId: r.security_group_id,
  };
  if (typeof r.port_range_min === "number") fields["portRangeMin"] = r.port_range_min;
  if (typeof r.port_range_max === "number") fields["portRangeMax"] = r.port_range_max;
  return fields;
}

export function describeRule(r: SgRule): string {
  const proto = r.protocol ?? "any";
  const ports =
    r.port_range_min == null
      ? ""
      : r.port_range_min === r.port_range_max
        ? `:${r.port_range_min}`
        : `:${r.port_range_min}-${r.port_range_max}`;
  const remote =
    r.remote_ip_prefix ?? (r.remote_group_id ? `group ${r.remote_group_id.slice(0, 8)}` : "any");
  return `${r.direction} ${r.ethertype} ${proto}${ports} ${r.direction === "ingress" ? "from" : "to"} ${remote}`;
}

/** Swift container read ACL considered public. */
export function isPublicReadAcl(acl: string | undefined): boolean {
  return !!acl && /(^|,)\s*\.r:\*/.test(acl);
}

/** Gnocchi measures `[[iso, granularity, value], ...]` to chart points. */
export function measuresToPoints(
  measures: Array<[string, number, number]>,
  scale = 1,
): Array<{ timestamp: number; value: number }> {
  return measures
    .map(([ts, , v]) => ({ timestamp: Date.parse(ts), value: v * scale }))
    .filter((p) => Number.isFinite(p.timestamp) && Number.isFinite(p.value));
}

export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await fn(items[i] as T);
      }
    }),
  );
  return results;
}
