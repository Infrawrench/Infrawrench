import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { FastlyLoggingEndpoint } from "./logging.js";
import { destinationOf, loggingTypeLabel } from "./logging.js";
import { productLabel } from "./products.js";

/** Wire shapes, only the fields the plugin reads. */
export interface FastlyVersion {
  number?: number;
  active?: boolean;
  locked?: boolean;
  comment?: string;
  service_id?: string;
  created_at?: string;
  updated_at?: string;
}

export interface FastlyServiceSummary {
  id?: string;
  name?: string;
  type?: string;
  comment?: string;
  version?: number;
  customer_id?: string;
  created_at?: string;
  updated_at?: string;
  versions?: FastlyVersion[];
}

export interface FastlyDomain {
  name?: string;
  comment?: string;
  version?: number;
  service_id?: string;
}

export interface FastlyBackend {
  name?: string;
  address?: string;
  hostname?: string;
  ipv4?: string;
  ipv6?: string;
  port?: number;
  use_ssl?: boolean;
  ssl_check_cert?: boolean;
  ssl_cert_hostname?: string;
  ssl_sni_hostname?: string;
  override_host?: string;
  shield?: string;
  healthcheck?: string;
  connect_timeout?: number;
  first_byte_timeout?: number;
  between_bytes_timeout?: number;
  max_conn?: number;
  weight?: number;
  auto_loadbalance?: boolean;
  min_tls_version?: string;
  comment?: string;
  version?: number;
}

export interface FastlyVersionDetail extends FastlyVersion {
  domains?: FastlyDomain[];
  backends?: FastlyBackend[];
}

/**
 * `GET /service/{id}/details`. Unlike the list, `version` here is the newest
 * version's full detail rather than a number.
 */
export interface FastlyServiceDetail extends Omit<FastlyServiceSummary, "version"> {
  paused?: boolean;
  active_version?: FastlyVersionDetail | null;
  version?: number | FastlyVersionDetail | null;
}

/** What the child mappers need from either a service summary or its details. */
export type ServiceLike = Pick<FastlyServiceSummary, "id" | "name" | "versions">;

export interface FastlyDictionary {
  id?: string;
  name?: string;
  write_only?: boolean;
  version?: number;
  updated_at?: string;
}

export interface FastlyStore {
  id?: string;
  name?: string;
  created_at?: string;
  updated_at?: string;
}

export interface JsonApiResource<A> {
  id?: string;
  type?: string;
  attributes?: A;
  relationships?: Record<
    string,
    { data?: { id?: string; type?: string } | Array<{ id?: string; type?: string }> | null }
  >;
}

export interface TlsCertificateAttrs {
  name?: string;
  issued_to?: string;
  issuer?: string;
  serial_number?: string;
  signature_algorithm?: string;
  not_after?: string;
  not_before?: string;
  replace?: boolean;
  created_at?: string;
}

export interface TlsSubscriptionAttrs {
  state?: string;
  certificate_authority?: string;
  has_active_order?: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface FastlyToken {
  id?: string;
  name?: string;
  scope?: string;
  services?: string[];
  created_at?: string;
  last_used_at?: string;
  expires_at?: string;
  ip?: string;
}

const s = (v: unknown): string => (v === undefined || v === null ? "" : String(v));

function base(
  accountId: string,
  typeId: string,
  externalId: string,
  displayName: string,
  fields: Record<string, string | number | boolean | undefined | null>,
  extra: Partial<ResourceInstance> = {},
): ResourceInstance {
  const clean: ResourceInstance["fields"] = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null || v === "") continue;
    clean[k] = v;
  }
  return {
    id: `${accountId}:${typeId}:${externalId}`,
    pluginId: "fastly",
    resourceTypeId: typeId,
    accountId,
    displayName: displayName || externalId,
    fields: clean,
    resolvedOutputs: {},
    secretStates: [],
    externalId,
    createdAt: s(extra.createdAt) || new Date(0).toISOString(),
    updatedAt: s(extra.updatedAt) || s(extra.createdAt) || new Date(0).toISOString(),
    ...(extra.parentResourceId ? { parentResourceId: extra.parentResourceId } : {}),
  };
}

export function serviceResourceId(accountId: string, serviceId: string): string {
  return `${accountId}:service:${serviceId}`;
}

/** The version a service's children are read from: active, else the newest. */
export function liveVersionOf(svc: FastlyServiceSummary | FastlyServiceDetail): number | undefined {
  const versions = svc.versions ?? [];
  const active = versions.find((v) => v.active)?.number;
  if (active !== undefined) return active;
  if (typeof svc.version === "number" && svc.version > 0) return svc.version;
  if (svc.version && typeof svc.version === "object" && svc.version.number) {
    return svc.version.number;
  }
  const numbers = versions.map((v) => v.number ?? 0).filter((n) => n > 0);
  return numbers.length > 0 ? Math.max(...numbers) : undefined;
}

export function mapService(
  accountId: string,
  svc: FastlyServiceDetail,
  products: string[] = [],
): ResourceInstance {
  const versions = svc.versions ?? [];
  const activeVersion =
    svc.active_version?.number ?? versions.find((v) => v.active)?.number ?? undefined;
  const latest = versions.reduce((m, v) => Math.max(m, v.number ?? 0), 0);
  const domains = (svc.active_version?.domains ?? []).map((d) => s(d.name)).filter(Boolean);
  const r = base(
    accountId,
    "service",
    s(svc.id),
    s(svc.name),
    {
      name: s(svc.name),
      comment: s(svc.comment),
      type: s(svc.type),
      activeVersion,
      latestVersion: latest || undefined,
      versionCount: versions.length || undefined,
      domains: domains.join(", "),
      backendCount: svc.active_version ? (svc.active_version.backends ?? []).length : undefined,
      products: products.map(productLabel).join(", "),
      paused: svc.paused,
      serviceId: s(svc.id),
      createdAt: s(svc.created_at),
      updatedAt: s(svc.updated_at),
    },
    { createdAt: s(svc.created_at), updatedAt: s(svc.updated_at) },
  );
  r.resolvedOutputs = { serviceId: s(svc.id), ...(domains[0] ? { domain: domains[0] } : {}) };
  return r;
}

export function mapVersion(
  accountId: string,
  svc: ServiceLike,
  v: FastlyVersion,
): ResourceInstance {
  const sid = s(svc.id);
  const num = v.number ?? 0;
  return base(
    accountId,
    "service-version",
    `${sid}/${num}`,
    `${s(svc.name) || sid} v${num}`,
    {
      comment: s(v.comment),
      number: num,
      active: v.active === true,
      locked: v.locked === true,
      serviceName: s(svc.name),
      serviceId: sid,
      createdAt: s(v.created_at),
      updatedAt: s(v.updated_at),
    },
    {
      createdAt: s(v.created_at),
      updatedAt: s(v.updated_at),
      parentResourceId: serviceResourceId(accountId, sid),
    },
  );
}

export function mapDomain(accountId: string, svc: ServiceLike, d: FastlyDomain): ResourceInstance {
  const sid = s(svc.id);
  const r = base(
    accountId,
    "domain",
    `${sid}/${s(d.name)}`,
    s(d.name),
    {
      name: s(d.name),
      comment: s(d.comment),
      serviceName: s(svc.name),
      serviceId: sid,
      version: d.version,
    },
    { parentResourceId: serviceResourceId(accountId, sid) },
  );
  r.resolvedOutputs = { name: s(d.name) };
  return r;
}

export function backendAddress(b: FastlyBackend): string {
  return s(b.address) || s(b.hostname) || s(b.ipv4) || s(b.ipv6);
}

export function mapBackend(
  accountId: string,
  svc: ServiceLike,
  b: FastlyBackend,
): ResourceInstance {
  const sid = s(svc.id);
  const address = backendAddress(b);
  const r = base(
    accountId,
    "backend",
    `${sid}/${s(b.name)}`,
    s(b.name),
    {
      name: s(b.name),
      address,
      port: b.port,
      useSsl: b.use_ssl === true,
      sslCheckCert: b.use_ssl === true ? b.ssl_check_cert !== false : undefined,
      sslCertHostname: s(b.ssl_cert_hostname),
      sslSniHostname: s(b.ssl_sni_hostname),
      overrideHost: s(b.override_host),
      shield: s(b.shield),
      healthcheck: s(b.healthcheck),
      connectTimeout: b.connect_timeout,
      firstByteTimeout: b.first_byte_timeout,
      betweenBytesTimeout: b.between_bytes_timeout,
      maxConn: b.max_conn,
      weight: b.weight,
      autoLoadbalance: b.auto_loadbalance,
      minTlsVersion: s(b.min_tls_version),
      serviceName: s(svc.name),
      serviceId: sid,
      version: b.version,
    },
    { parentResourceId: serviceResourceId(accountId, sid) },
  );
  r.resolvedOutputs = address ? { address } : {};
  return r;
}

export function mapLoggingEndpoint(
  accountId: string,
  svc: ServiceLike,
  version: number,
  type: string,
  e: FastlyLoggingEndpoint,
): ResourceInstance {
  const sid = s(svc.id);
  return base(
    accountId,
    "logging-endpoint",
    `${sid}/${type}/${s(e.name)}`,
    s(e.name),
    {
      name: s(e.name),
      kind: loggingTypeLabel(type),
      destination: destinationOf(type, e),
      format: s(e.format),
      formatVersion: s(e.format_version),
      placement: s(e.placement),
      responseCondition: s(e.response_condition),
      serviceName: s(svc.name),
      serviceId: sid,
      version,
    },
    {
      createdAt: s(e.created_at),
      updatedAt: s(e.updated_at),
      parentResourceId: serviceResourceId(accountId, sid),
    },
  );
}

export function mapDictionary(
  accountId: string,
  svc: ServiceLike,
  d: FastlyDictionary,
  itemCount?: number,
): ResourceInstance {
  const sid = s(svc.id);
  const r = base(
    accountId,
    "dictionary",
    `${sid}/${s(d.id)}`,
    s(d.name),
    {
      name: s(d.name),
      writeOnly: d.write_only === true,
      itemCount,
      serviceName: s(svc.name),
      serviceId: sid,
      dictionaryId: s(d.id),
      version: d.version,
      updatedAt: s(d.updated_at),
    },
    { updatedAt: s(d.updated_at), parentResourceId: serviceResourceId(accountId, sid) },
  );
  r.resolvedOutputs = { dictionaryId: s(d.id) };
  return r;
}

export function mapStore(
  accountId: string,
  typeId: "kv-store" | "config-store" | "secret-store",
  st: FastlyStore,
  extra: { itemCount?: number; services?: string } = {},
): ResourceInstance {
  const r = base(
    accountId,
    typeId,
    s(st.id),
    s(st.name),
    {
      name: s(st.name),
      storeId: s(st.id),
      createdAt: s(st.created_at),
      ...(typeId !== "secret-store" ? { updatedAt: s(st.updated_at) } : {}),
      ...(typeId === "config-store"
        ? { itemCount: extra.itemCount, services: extra.services ?? "" }
        : {}),
    },
    { createdAt: s(st.created_at), updatedAt: s(st.updated_at) },
  );
  r.resolvedOutputs = { storeId: s(st.id) };
  return r;
}

function relIds(rel: JsonApiResource<unknown>["relationships"], key: string): string[] {
  const data = rel?.[key]?.data;
  if (!data) return [];
  return (Array.isArray(data) ? data : [data]).map((d) => s(d.id)).filter(Boolean);
}

export function mapTlsCertificate(
  accountId: string,
  c: JsonApiResource<TlsCertificateAttrs>,
): ResourceInstance {
  const a = c.attributes ?? {};
  const domains = relIds(c.relationships, "tls_domains");
  const r = base(
    accountId,
    "tls-certificate",
    s(c.id),
    s(a.name) || s(a.issued_to) || s(c.id),
    {
      name: s(a.name),
      issuedTo: s(a.issued_to),
      issuer: s(a.issuer),
      domains: domains.join(", "),
      notBefore: s(a.not_before),
      notAfter: s(a.not_after),
      serialNumber: s(a.serial_number),
      signatureAlgorithm: s(a.signature_algorithm),
      replace: a.replace === true,
      createdAt: s(a.created_at),
    },
    { createdAt: s(a.created_at) },
  );
  r.resolvedOutputs = { certificateId: s(c.id) };
  return r;
}

/**
 * The expiry of the certificate a subscription currently serves: the latest
 * `not_after` among its included `tls_certificates` (a renewal briefly leaves
 * the old one attached too).
 */
export function mapTlsSubscription(
  accountId: string,
  sub: JsonApiResource<TlsSubscriptionAttrs>,
  certificates: Map<string, TlsCertificateAttrs>,
): ResourceInstance {
  const a = sub.attributes ?? {};
  const domains = relIds(sub.relationships, "tls_domains");
  const commonName = relIds(sub.relationships, "common_name")[0] ?? domains[0] ?? "";
  let notAfter = "";
  for (const id of relIds(sub.relationships, "tls_certificates")) {
    const na = s(certificates.get(id)?.not_after);
    if (na && (!notAfter || Date.parse(na) > Date.parse(notAfter))) notAfter = na;
  }
  const r = base(
    accountId,
    "tls-subscription",
    s(sub.id),
    commonName || s(sub.id),
    {
      commonName,
      domains: domains.join(", "),
      certificateAuthority: s(a.certificate_authority),
      state: s(a.state),
      hasActiveOrder: a.has_active_order === true,
      notAfter,
      createdAt: s(a.created_at),
      updatedAt: s(a.updated_at),
    },
    { createdAt: s(a.created_at), updatedAt: s(a.updated_at) },
  );
  r.resolvedOutputs = { subscriptionId: s(sub.id) };
  return r;
}

export function mapToken(
  accountId: string,
  t: FastlyToken,
  currentTokenId: string,
  serviceNames: Map<string, string>,
): ResourceInstance {
  const r = base(
    accountId,
    "api-token",
    s(t.id),
    s(t.name) || s(t.id),
    {
      name: s(t.name),
      scope: s(t.scope),
      services: (t.services ?? []).map((id) => serviceNames.get(id) ?? id).join(", "),
      createdAt: s(t.created_at),
      lastUsedAt: s(t.last_used_at),
      expiresAt: s(t.expires_at),
      lastIp: s(t.ip),
      current: currentTokenId !== "" && s(t.id) === currentTokenId,
    },
    { createdAt: s(t.created_at) },
  );
  r.resolvedOutputs = { tokenId: s(t.id) };
  return r;
}
