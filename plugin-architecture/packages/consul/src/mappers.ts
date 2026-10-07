/**
 * Raw Consul API shapes (only what the plugin reads) and their mapping to
 * `ResourceInstance`s.
 */
import type { ResourceInstance } from "@infrawrench/plugin-base";
import { joinId } from "./api.js";

export const PLUGIN_ID = "consul";

export interface CatalogNode {
  ID?: string;
  Node?: string;
  Address?: string;
  Datacenter?: string;
  Partition?: string;
  Meta?: Record<string, string>;
}

export interface Check {
  Node?: string;
  CheckID?: string;
  Name?: string;
  Status?: string;
  Notes?: string;
  Output?: string;
  ServiceID?: string;
  ServiceName?: string;
  Type?: string;
  Namespace?: string;
}

export interface Intention {
  ID?: string;
  SourceName?: string;
  SourceNS?: string;
  SourcePartition?: string;
  SourcePeer?: string;
  DestinationName?: string;
  DestinationNS?: string;
  SourceType?: string;
  Action?: string;
  Permissions?: unknown[];
  Description?: string;
  Precedence?: number;
}

export interface ConfigEntry {
  Kind?: string;
  Name?: string;
  Namespace?: string;
  Partition?: string;
  ModifyIndex?: number;
  [k: string]: unknown;
}

export interface AclLink {
  ID?: string;
  Name?: string;
}

export interface AclPolicy {
  ID?: string;
  Name?: string;
  Description?: string;
  Rules?: string;
  Datacenters?: string[] | null;
}

export interface AclRole {
  ID?: string;
  Name?: string;
  Description?: string;
  Policies?: AclLink[] | null;
  ServiceIdentities?: Array<{ ServiceName?: string; Datacenters?: string[] }> | null;
  NodeIdentities?: Array<{ NodeName?: string; Datacenter?: string }> | null;
}

export interface AclToken extends AclRole {
  AccessorID?: string;
  SecretID?: string;
  Roles?: AclLink[] | null;
  Local?: boolean;
  AuthMethod?: string;
  CreateTime?: string;
  ExpirationTime?: string;
}

export interface Session {
  ID?: string;
  Name?: string;
  Node?: string;
  Behavior?: string;
  TTL?: string;
  LockDelay?: number;
  NodeChecks?: string[] | null;
  ServiceChecks?: Array<{ ID?: string }> | null;
  Checks?: string[] | null;
}

export interface Peering {
  Name?: string;
  State?: string;
  Partition?: string;
  PeerServerName?: string;
  PeerServerAddresses?: string[] | null;
  StreamStatus?: { ImportedServices?: string[] | null; ExportedServices?: string[] | null };
}

type FieldValue = string | number | boolean | undefined | null;

export function instance(
  accountId: string,
  typeId: string,
  externalId: string,
  displayName: string,
  fields: Record<string, FieldValue>,
  extra: Partial<ResourceInstance> = {},
): ResourceInstance {
  const now = new Date().toISOString();
  const clean: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null) clean[k] = v;
  return {
    id: `${accountId}:${typeId}:${externalId}`,
    pluginId: PLUGIN_ID,
    resourceTypeId: typeId,
    accountId,
    displayName: displayName || externalId,
    fields: clean,
    resolvedOutputs: {},
    secretStates: [],
    externalId,
    createdAt: now,
    updatedAt: now,
    ...extra,
  };
}

export const metaText = (m: Record<string, string> | null | undefined): string =>
  Object.entries(m ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");

export function parseMeta(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (raw ?? "").split(/[,\n]/)) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export const names = (links: AclLink[] | null | undefined): string =>
  (links ?? []).map((l) => l.Name ?? l.ID ?? "").join(", ");

export type CheckCounts = { passing: number; warning: number; critical: number };

export function countChecks(checks: Check[]): CheckCounts {
  const c = { passing: 0, warning: 0, critical: 0 };
  for (const ch of checks)
    if (ch.Status === "passing" || ch.Status === "warning" || ch.Status === "critical")
      c[ch.Status]++;
  return c;
}

export function mapNode(
  accountId: string,
  n: CatalogNode,
  checks: Check[],
  services?: number,
): ResourceInstance {
  const name = n.Node ?? "";
  const r = instance(accountId, "consul-node", joinId(name), name, {
    name,
    address: n.Address,
    datacenter: n.Datacenter,
    partition: n.Partition,
    meta: metaText(n.Meta),
    services,
    ...countChecks(checks),
  });
  r.resolvedOutputs = { address: n.Address ?? "" };
  return r;
}

export function mapService(
  accountId: string,
  name: string,
  tags: string[],
  checks: Check[],
  extra: { instances?: number; kind?: string; namespace?: string } = {},
): ResourceInstance {
  const ns = extra.namespace;
  const r = instance(
    accountId,
    "consul-service",
    ns && ns !== "default" ? joinId(name, ns) : joinId(name),
    name,
    {
      name,
      namespace: ns,
      tags: [...new Set(tags)].join(", "),
      instances: extra.instances,
      kind: extra.kind,
      ...countChecks(checks),
    },
  );
  r.resolvedOutputs = { name, dnsName: `${name}.service.consul` };
  return r;
}

export function mapCheck(accountId: string, c: Check): ResourceInstance {
  return instance(
    accountId,
    "consul-check",
    joinId(c.Node ?? "", c.CheckID ?? ""),
    `${c.Name ?? c.CheckID ?? ""} (${c.Node ?? ""})`,
    {
      name: c.Name,
      checkId: c.CheckID,
      status: c.Status,
      node: c.Node,
      serviceName: c.ServiceName || undefined,
      serviceId: c.ServiceID || undefined,
      type: c.Type,
      output: (c.Output ?? "").slice(0, 2000),
      notes: c.Notes,
    },
  );
}

export function intentionId(i: Intention): string {
  return joinId(
    i.SourcePeer ? `peer:${i.SourcePeer}/${i.SourceName ?? ""}` : (i.SourceName ?? ""),
    i.DestinationName ?? "",
  );
}

export function mapIntention(accountId: string, i: Intention): ResourceInstance {
  const src = i.SourcePeer ? `${i.SourcePeer}/${i.SourceName ?? ""}` : (i.SourceName ?? "");
  return instance(
    accountId,
    "consul-intention",
    intentionId(i),
    `${src} → ${i.DestinationName ?? ""}`,
    {
      source: i.SourceName,
      destination: i.DestinationName,
      action: i.Action || undefined,
      description: i.Description,
      permissions: i.Permissions?.length ? JSON.stringify(i.Permissions) : undefined,
      sourceType: i.SourceType,
      precedence: i.Precedence,
    },
  );
}

/** One short line about a config entry, so lists say more than kind and name. */
export function configSummary(e: ConfigEntry): string {
  switch (e.Kind) {
    case "service-defaults":
      return [
        e["Protocol"] ? `protocol ${String(e["Protocol"])}` : "",
        e["MutualTLSMode"] ? `mTLS ${String(e["MutualTLSMode"])}` : "",
      ]
        .filter(Boolean)
        .join(", ");
    case "service-intentions":
      return `${(e["Sources"] as unknown[] | undefined)?.length ?? 0} sources`;
    case "service-router":
      return `${(e["Routes"] as unknown[] | undefined)?.length ?? 0} routes`;
    case "service-splitter":
      return (
        (e["Splits"] as
          Array<{ Weight?: number; ServiceSubset?: string; Service?: string }> | undefined) ?? []
      )
        .map((s) => `${s.Weight ?? 0}% ${s.ServiceSubset || s.Service || ""}`.trim())
        .join(", ");
    case "exported-services":
      return `${(e["Services"] as unknown[] | undefined)?.length ?? 0} services`;
    case "ingress-gateway":
    case "api-gateway":
      return `${(e["Listeners"] as unknown[] | undefined)?.length ?? 0} listeners`;
    default:
      return "";
  }
}

export function configId(e: ConfigEntry): string {
  return e.Namespace && e.Namespace !== "default"
    ? joinId(e.Kind ?? "", e.Name ?? "", e.Namespace)
    : joinId(e.Kind ?? "", e.Name ?? "");
}

/** The entry without Kind, Name, scope and Raft indexes: what Terraform's `config_json` takes. */
export function configBody(e: ConfigEntry): Record<string, unknown> {
  const {
    Kind: _k,
    Name: _n,
    Namespace: _ns,
    Partition: _p,
    CreateIndex: _c,
    ModifyIndex: _m,
    Hash: _h,
    ...rest
  } = e as ConfigEntry & {
    CreateIndex?: number;
    Hash?: string;
  };
  return rest;
}

export function mapConfigEntry(accountId: string, e: ConfigEntry): ResourceInstance {
  const r = instance(
    accountId,
    "consul-config-entry",
    configId(e),
    `${e.Kind ?? ""}/${e.Name ?? ""}`,
    {
      kind: e.Kind,
      name: e.Name,
      namespace: e.Namespace,
      partition: e.Partition,
      summary: configSummary(e) || undefined,
      modifyIndex: e.ModifyIndex,
    },
  );
  r.resolvedOutputs = { config: JSON.stringify(configBody(e)) };
  return r;
}

export function mapPolicy(accountId: string, p: AclPolicy): ResourceInstance {
  const r = instance(accountId, "consul-acl-policy", p.ID ?? "", p.Name ?? p.ID ?? "", {
    name: p.Name,
    description: p.Description,
    datacenters: (p.Datacenters ?? []).join(", "),
    builtIn:
      p.ID === "00000000-0000-0000-0000-000000000001" ||
      p.Name === "global-management" ||
      p.Name === "builtin/global-read-only",
  });
  r.resolvedOutputs = { id: p.ID ?? "", ...(p.Rules !== undefined ? { rules: p.Rules } : {}) };
  return r;
}

export function mapRole(accountId: string, r: AclRole): ResourceInstance {
  const res = instance(accountId, "consul-acl-role", r.ID ?? "", r.Name ?? r.ID ?? "", {
    name: r.Name,
    description: r.Description,
    policies: names(r.Policies),
    serviceIdentities: (r.ServiceIdentities ?? []).map((s) => s.ServiceName).join(", "),
    nodeIdentities: (r.NodeIdentities ?? []).map((s) => `${s.NodeName}@${s.Datacenter}`).join(", "),
  });
  res.resolvedOutputs = { id: r.ID ?? "" };
  return res;
}

export function mapToken(accountId: string, t: AclToken): ResourceInstance {
  return instance(
    accountId,
    "consul-acl-token",
    t.AccessorID ?? "",
    t.Description || t.AccessorID || "",
    {
      accessorId: t.AccessorID,
      description: t.Description,
      policies: names(t.Policies),
      roles: names(t.Roles),
      serviceIdentities: (t.ServiceIdentities ?? []).map((s) => s.ServiceName).join(", "),
      nodeIdentities: (t.NodeIdentities ?? [])
        .map((s) => `${s.NodeName}@${s.Datacenter}`)
        .join(", "),
      local: t.Local,
      authMethod: t.AuthMethod,
      createTime: t.CreateTime,
      expirationTime: t.ExpirationTime,
      management: (t.Policies ?? []).some(
        (p) => p.Name === "global-management" || p.ID === "00000000-0000-0000-0000-000000000001",
      ),
    },
  );
}

export function mapSession(accountId: string, s: Session): ResourceInstance {
  const checks = [
    ...(s.NodeChecks ?? []),
    ...(s.ServiceChecks ?? []).map((c) => c.ID ?? ""),
    ...(s.Checks ?? []),
  ];
  return instance(accountId, "consul-session", s.ID ?? "", s.Name || s.ID || "", {
    id: s.ID,
    name: s.Name,
    node: s.Node,
    behavior: s.Behavior,
    ttl: s.TTL,
    lockDelay: typeof s.LockDelay === "number" ? `${Math.round(s.LockDelay / 1e9)}s` : undefined,
    checks: [...new Set(checks)].filter(Boolean).join(", "),
  });
}

export function mapPeering(accountId: string, p: Peering): ResourceInstance {
  return instance(accountId, "consul-peering", joinId(p.Name ?? ""), p.Name ?? "", {
    name: p.Name,
    state: p.State,
    peerServerName: p.PeerServerName,
    peerServerAddresses: (p.PeerServerAddresses ?? []).join(", "),
    importedServices: p.StreamStatus ? (p.StreamStatus.ImportedServices ?? []).length : undefined,
    exportedServices: p.StreamStatus ? (p.StreamStatus.ExportedServices ?? []).length : undefined,
    partition: p.Partition,
  });
}
