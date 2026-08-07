/**
 * The Domains surface — every zone and every record across every provider in
 * one view, with each record's target classified against the rest of the
 * workspace.
 *
 * Same declaration-over-synced-state contract as `orphanRule`, `expiryFields`
 * and `postureChecks`: plugins mark their zone/record types with `dnsRole` and
 * their service namespaces with `dnsServiceHosts` (both in
 * `@infrawrench/plugin-base`), and this module turns stored rows + those
 * declarations into the inventory every surface renders. Rows in, records out:
 * no plugin client, no credentials, no provider API calls, and — the point of
 * the whole thing — **no DNS resolution**. A record's target is judged against
 * what we already synced, never against what the internet currently says.
 *
 * ## Classifying a target
 *
 * `owned` — the target value is an identity of some synced resource. This is
 * the same question `dependency-inference` asks, over the same identity keys
 * (imported, not re-listed), with the same uniqueness rule: a value claimed by
 * two resources is ambiguous and settles nothing.
 *
 * `dangling` — the target falls inside a provider namespace some plugin
 * declared (`*.vercel.app`, `*.s3.amazonaws.com`) and **nothing in the
 * workspace claims it**. That is the subdomain-takeover signature: the name
 * still points at the provider, the provider no longer holds it for you, and
 * whoever registers it next serves content on your domain.
 *
 * `external` — the target points somewhere we have no declaration for. A
 * third-party SaaS, someone else's nameserver, an IP we never synced. Not a
 * finding: we have nothing to compare it against.
 *
 * `not-analysed` — the record type carries no host target we reason about
 * (TXT, SOA, CAA, MX…). Listed, never judged.
 *
 * ## Why `dangling` is deliberately hard to reach
 *
 * The tempting version of this check flags any A record whose IP no longer
 * matches a synced resource — which is most A records, because most targets
 * are things you legitimately don't manage here. A takeover check that cries
 * wolf gets muted, and a muted check finds nothing. So a namespace is only
 * evaluated when the org has a synced account for the declaring plugin **and**
 * at least one synced resource of a type declaring that namespace. Without a
 * connected AWS account we cannot tell your bucket from a stranger's, and
 * without a single synced bucket we cannot tell an empty account from a lister
 * that lacks `s3:ListAllMyBuckets`. Both cases are missing data, and missing
 * data must not alarm — they are reported through `skippedNamespaces` so the
 * silence is visible rather than mysterious.
 *
 * The residual false positive is real and worth stating plainly: a bucket that
 * lives in an AWS account you have *not* connected reads as dangling, because
 * from here it is indistinguishable from one that was deleted. The finding's
 * text says so.
 */
import type {
  DnsRecordRole,
  DnsRoleDeclaration,
  DnsServiceHostRule,
} from "@infrawrench/plugin-base";

import { IDENTITY_FIELD_KEYS } from "./dependency-inference";
import type { CloudFetch } from "./fetch";

export type {
  DnsRecordRole,
  DnsRoleDeclaration,
  DnsServiceHostRule,
  DnsZoneRole,
} from "@infrawrench/plugin-base";

/** What we can say about one target value of one record. See the module doc. */
export type DnsTargetClassification = "owned" | "dangling" | "external" | "not-analysed";

/** Ranked worst-first, so a record's status is the worst of its targets. */
const CLASSIFICATION_RANK: Record<DnsTargetClassification, number> = {
  dangling: 0,
  external: 1,
  owned: 2,
  "not-analysed": 3,
};

/** Human labels for the classification buckets, shared by every surface. */
export const DNS_CLASSIFICATION_LABELS: Record<DnsTargetClassification, string> = {
  owned: "Resolves to a synced resource",
  dangling: "Dangling",
  external: "External",
  "not-analysed": "Not analysed",
};

/** The synced resource a target was matched to. */
export interface DnsTargetResource {
  resourceId: string;
  displayName: string;
  pluginId: string;
  resourceTypeId: string;
  resourceTypeName: string;
  accountId: string;
}

/** The provider namespace a dangling target fell into. */
export interface DnsTargetService {
  pluginId: string;
  pluginName: string;
  /** Declaring type's id, e.g. "s3-bucket". */
  resourceTypeId: string;
  /** `DnsServiceHostRule.id`, unique within the plugin. */
  ruleId: string;
  /** Human namespace name, e.g. "S3 bucket endpoint". */
  label: string;
  severity: "critical" | "high" | "medium" | "low";
  /** Plugin-authored explanation of what claiming the name gets an attacker. */
  reason: string;
  /** The capture-group-1 label the pattern pulled out, e.g. the bucket name. */
  claimLabel: string;
}

/** One target value of one record — records can carry several. */
export interface DnsRecordTarget {
  /** The value as stored, normalised: lowercased host, no trailing dot. */
  value: string;
  classification: DnsTargetClassification;
  /** Set only when `classification === "owned"`. */
  resource: DnsTargetResource | null;
  /** Set only when `classification === "dangling"`. */
  service: DnsTargetService | null;
}

export interface DnsRecordEntry {
  /** Infrawrench resource id of the record itself. */
  resourceId: string;
  pluginId: string;
  pluginName: string;
  resourceTypeId: string;
  resourceTypeName: string;
  accountId: string;
  accountName: string;
  /** Owning zone's resource id, or null when the record couldn't be attributed. */
  zoneResourceId: string | null;
  /** Owning zone's apex domain, or null as above. */
  zoneDomain: string | null;
  /** Fully-qualified, lowercased, no trailing dot. */
  name: string;
  /** Uppercased record type ("A", "CNAME"…). */
  type: string;
  ttl: number | null;
  priority: number | null;
  /** True when the provider proxies the record (Cloudflare's orange cloud). */
  proxied: boolean;
  targets: DnsRecordTarget[];
  /** Worst classification across `targets`; `"not-analysed"` when there are none. */
  status: DnsTargetClassification;
}

export interface DnsZoneEntry {
  resourceId: string;
  pluginId: string;
  pluginName: string;
  resourceTypeId: string;
  resourceTypeName: string;
  accountId: string;
  accountName: string;
  /** Apex domain, lowercased, no trailing dot. */
  domain: string;
  /** Provider status string, when the lister stores one. */
  status: string | null;
  /** Split-horizon/internal zone — listed, never analysed for takeover. */
  isPrivate: boolean;
  /** Records we synced into this zone. */
  recordCount: number;
  /**
   * The provider's own record count, when reported. May exceed `recordCount`
   * — several plugins list zones without listing their records.
   */
  providerRecordCount: number | null;
  /** Dangling targets across this zone's records. */
  danglingCount: number;
}

/**
 * A namespace that was declared but not evaluated, and why. Surfaced so the
 * conservative guard is visible: "we found nothing" and "we didn't look" are
 * different answers and must not render the same.
 */
export interface DnsSkippedNamespace {
  pluginId: string;
  pluginName: string;
  /** Namespace label, e.g. "Vercel deployment alias". */
  label: string;
  reason: string;
}

export interface DnsInventoryResponse {
  /** Sorted by domain, then account name. */
  zones: DnsZoneEntry[];
  /** Sorted worst-status first, then by name. */
  records: DnsRecordEntry[];
  counts: {
    zones: number;
    records: number;
    owned: number;
    dangling: number;
    external: number;
    notAnalysed: number;
  };
  skippedNamespaces: DnsSkippedNamespace[];
  generatedAt: string;
}

/** The part of a resource type definition the scan reads. */
export interface DnsScanResourceType {
  id: string;
  displayName: string;
  dnsRole?: DnsRoleDeclaration | undefined;
  dnsServiceHosts?: readonly DnsServiceHostRule[] | undefined;
}

/** The part of a loaded plugin the scan reads. */
export interface DnsScanPlugin {
  id: string;
  displayName: string;
  resourceTypes: readonly DnsScanResourceType[];
}

/** The part of an account row the scan reads. */
export interface DnsScanAccount {
  id: string;
  displayName: string;
  pluginId: string;
}

/**
 * The part of a stored resource row the scan reads. Hosts map their own store
 * onto this — Postgres jsonb, SQLite TEXT bags — so the computation never
 * learns which database it is looking at.
 */
export interface DnsScanResource {
  id: string;
  pluginId: string;
  resourceTypeId: string;
  accountId: string;
  displayName: string;
  externalId: string | null;
  /** Written by the sync path for child resources; the primary zone link. */
  parentResourceId: string | null;
  /** The instance's stored `fields` bag; a missing/!object bag reads as empty. */
  fields: unknown;
}

export interface DnsScanInput {
  plugins: readonly DnsScanPlugin[];
  accounts: readonly DnsScanAccount[];
  resources: readonly DnsScanResource[];
}

export interface DnsScanOptions {
  /** Scan instant for `generatedAt`; defaults to `Date.now()`. */
  now?: number;
}

/**
 * Record types whose content is a host or address worth judging. TXT, SOA,
 * CAA, SRV and MX are listed but never classified: their content is either
 * free-form or carries priority/port prefixes that would need per-type parsing
 * to yield a bare host, and a half-parsed target is worse than an unjudged
 * one.
 */
const ANALYSED_RECORD_TYPES = new Set(["A", "AAAA", "CNAME", "ALIAS", "ANAME", "NS"]);

/** Record types whose content is an address rather than a name. */
const ADDRESS_RECORD_TYPES = new Set(["A", "AAAA"]);

const TRUE_WORDS = new Set(["true", "1", "yes", "enabled"]);

/** Strictly an IPv4 dotted quad — `1.2.3.4.5` and `1.2.3` must not qualify. */
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
/** Loose on purpose: anything with two colons and only hex/colon/dot is IPv6. */
const IPV6 = /^[0-9a-f:]*:[0-9a-f:]*:[0-9a-f.:]*$/;

function asFields(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return raw as Record<string, unknown>;
}

function readString(fields: Record<string, unknown>, key: string | undefined): string {
  if (!key) return "";
  const raw = fields[key];
  if (raw == null || typeof raw === "object") return "";
  return String(raw).trim();
}

function readNumber(fields: Record<string, unknown>, key: string | undefined): number | null {
  if (!key) return null;
  const raw = fields[key];
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function readBoolean(fields: Record<string, unknown>, key: string | undefined): boolean {
  if (!key) return false;
  const raw = fields[key];
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") return raw !== 0;
  return typeof raw === "string" && TRUE_WORDS.has(raw.trim().toLowerCase());
}

/**
 * Reduce a stored value to a bare hostname for comparison: lowercase, no
 * scheme, no path, no port, no trailing dot. Listers store the same endpoint
 * as `https://site.netlify.app/`, `site.netlify.app.` and `site.netlify.app`
 * depending on the provider, and all three name one host.
 */
export function normalizeDnsHost(value: string): string {
  let host = value.trim().toLowerCase();
  if (host === "") return "";
  const scheme = host.indexOf("://");
  if (scheme !== -1) host = host.slice(scheme + 3);
  const slash = host.indexOf("/");
  if (slash !== -1) host = host.slice(0, slash);
  const at = host.lastIndexOf("@");
  if (at !== -1) host = host.slice(at + 1);
  // Strip a port, but never mistake an IPv6 address's colons for one.
  if (!host.includes("::")) {
    const colon = host.lastIndexOf(":");
    if (colon !== -1 && /^\d+$/.test(host.slice(colon + 1))) host = host.slice(0, colon);
  }
  return host.replace(/\.+$/, "");
}

function isAddress(value: string): boolean {
  return IPV4.test(value) || IPV6.test(value);
}

/**
 * Fully qualify a record name against its zone. Providers disagree: Cloudflare
 * and Route 53 store the FQDN (Route 53 with a trailing dot), DigitalOcean
 * stores the relative label with `@` for the apex, Cloud DNS stores the FQDN
 * with a trailing dot. All four end up as one lowercased dotless-suffix name.
 */
function qualifyRecordName(rawName: string, zoneDomain: string | null): string {
  const name = rawName.trim().toLowerCase().replace(/\.+$/, "");
  if (!zoneDomain) return name;
  if (name === "" || name === "@") return zoneDomain;
  if (name === zoneDomain || name.endsWith(`.${zoneDomain}`)) return name;
  return `${name}.${zoneDomain}`;
}

interface IdentityClaim {
  resource: DnsTargetResource;
  /** Bumped past 1 when a second resource answers to the token — ambiguous. */
  claimants: number;
}

/**
 * Index every resource by the values that identify it, so a record's target
 * can be looked up in one step. Deliberately the same identity keys the
 * dependency canvas uses; a token claimed twice is dropped from consideration
 * rather than resolved arbitrarily (the canvas's "a wrong edge is worse than a
 * missing one" stance, which applies double when the output is a finding).
 */
function buildIdentityIndex(
  resources: readonly DnsScanResource[],
  typeNames: Map<string, string>,
): Map<string, IdentityClaim> {
  const index = new Map<string, IdentityClaim>();

  const claim = (rawToken: string, resource: DnsScanResource): void => {
    const token = rawToken.trim().toLowerCase();
    if (token.length < 3) return;
    const existing = index.get(token);
    if (existing) {
      if (existing.resource.resourceId !== resource.id) existing.claimants += 1;
      return;
    }
    index.set(token, {
      claimants: 1,
      resource: {
        resourceId: resource.id,
        displayName: resource.displayName,
        pluginId: resource.pluginId,
        resourceTypeId: resource.resourceTypeId,
        resourceTypeName: typeNames.get(typeKey(resource)) ?? resource.resourceTypeId,
        accountId: resource.accountId,
      },
    });
  };

  for (const resource of resources) {
    if (resource.externalId) claim(resource.externalId, resource);
    const fields = asFields(resource.fields);
    for (const [key, value] of Object.entries(fields)) {
      if (!IDENTITY_FIELD_KEYS.has(key.toLowerCase())) continue;
      if (value == null || typeof value === "object") continue;
      const text = String(value);
      // Plugins flatten lists into comma-joined strings; each element is its
      // own identity, and the joined whole is not one.
      for (const part of text.includes(",") ? text.split(",") : [text]) {
        claim(normalizeDnsHost(part), resource);
        claim(part, resource);
      }
    }
  }

  return index;
}

function typeKey(resource: { pluginId: string; resourceTypeId: string }): string {
  return `${resource.pluginId}:${resource.resourceTypeId}`;
}

/** A `dnsServiceHosts` rule that passed the has-data guard, ready to match. */
interface ActiveNamespace {
  pluginId: string;
  pluginName: string;
  resourceTypeId: string;
  rule: DnsServiceHostRule;
  pattern: RegExp;
  /** Hostname → the instance that answers to it (from `hostKeys`). */
  byHost: Map<string, DnsTargetResource>;
  /** Name/external id → the instance, used unless `labelIs: "opaque"`. */
  byName: Map<string, DnsTargetResource>;
}

/**
 * Compile every declared namespace, dropping the ones we have no standing to
 * judge. See the module doc for why the guard is this strict; the drops are
 * returned so the surface can say so out loud.
 */
function collectNamespaces(
  input: DnsScanInput,
  typeNames: Map<string, string>,
): { active: ActiveNamespace[]; skipped: DnsSkippedNamespace[] } {
  const active: ActiveNamespace[] = [];
  const skipped: DnsSkippedNamespace[] = [];

  const pluginHasAccount = new Set(input.accounts.map((a) => a.pluginId));
  const resourcesByType = new Map<string, DnsScanResource[]>();
  for (const resource of input.resources) {
    const key = typeKey(resource);
    const bucket = resourcesByType.get(key);
    if (bucket) bucket.push(resource);
    else resourcesByType.set(key, [resource]);
  }

  for (const plugin of input.plugins) {
    for (const type of plugin.resourceTypes) {
      for (const rule of type.dnsServiceHosts ?? []) {
        const claimants = resourcesByType.get(`${plugin.id}:${type.id}`) ?? [];
        if (!pluginHasAccount.has(plugin.id)) {
          skipped.push({
            pluginId: plugin.id,
            pluginName: plugin.displayName,
            label: rule.label,
            reason: `No ${plugin.displayName} account is connected, so a record pointing here can't be told apart from one you legitimately don't own.`,
          });
          continue;
        }
        if (claimants.length === 0) {
          skipped.push({
            pluginId: plugin.id,
            pluginName: plugin.displayName,
            label: rule.label,
            reason: `No ${type.displayName} has synced yet — an account with none is indistinguishable from one whose credentials can't list them.`,
          });
          continue;
        }

        let pattern: RegExp;
        try {
          pattern = new RegExp(`^(?:${rule.hostPattern})$`, "i");
        } catch {
          // The manifest schema rejects an uncompilable pattern, so this only
          // fires for a plugin loaded past validation. Skip it rather than
          // throw: one bad rule must not take the whole surface down.
          continue;
        }

        const byHost = new Map<string, DnsTargetResource>();
        const byName = new Map<string, DnsTargetResource>();
        for (const resource of claimants) {
          const target: DnsTargetResource = {
            resourceId: resource.id,
            displayName: resource.displayName,
            pluginId: resource.pluginId,
            resourceTypeId: resource.resourceTypeId,
            resourceTypeName: typeNames.get(typeKey(resource)) ?? resource.resourceTypeId,
            accountId: resource.accountId,
          };
          const fields = asFields(resource.fields);
          for (const key of rule.hostKeys ?? []) {
            const host = normalizeDnsHost(readString(fields, key));
            if (host) byHost.set(host, target);
          }
          for (const name of [
            resource.externalId,
            readString(fields, "name"),
            resource.displayName,
          ]) {
            const normalized = name?.trim().toLowerCase();
            if (normalized) byName.set(normalized, target);
          }
        }

        active.push({
          pluginId: plugin.id,
          pluginName: plugin.displayName,
          resourceTypeId: type.id,
          rule,
          pattern,
          byHost,
          byName,
        });
      }
    }
  }

  return { active, skipped };
}

/**
 * Compute the DNS inventory for a workspace: every declared zone, every
 * declared record, and each record target judged against the rest of the
 * synced rows.
 *
 * Pure and deterministic — two hosts reading the same rows render the same
 * inventory. Resources whose account is missing from `accounts` are skipped
 * (soft-deleted account, not a zone worth showing), as is any bag that isn't a
 * plain object.
 */
export function computeDnsInventory(
  input: DnsScanInput,
  options: DnsScanOptions = {},
): DnsInventoryResponse {
  const now = options.now ?? Date.now();

  const pluginNames = new Map<string, string>();
  const typeNames = new Map<string, string>();
  const roles = new Map<string, DnsRoleDeclaration>();
  for (const plugin of input.plugins) {
    pluginNames.set(plugin.id, plugin.displayName);
    for (const type of plugin.resourceTypes) {
      typeNames.set(`${plugin.id}:${type.id}`, type.displayName);
      if (type.dnsRole) roles.set(`${plugin.id}:${type.id}`, type.dnsRole);
    }
  }

  const accountMap = new Map(input.accounts.map((a) => [a.id, a]));
  const identity = buildIdentityIndex(input.resources, typeNames);
  const { active, skipped } = collectNamespaces(input, typeNames);

  // ---- zones -------------------------------------------------------------
  const zones: DnsZoneEntry[] = [];
  const zoneById = new Map<string, DnsZoneEntry>();
  /** `pluginId|value` → zone, for records that name their zone by id or domain. */
  const zoneByKey = new Map<string, DnsZoneEntry>();

  for (const resource of input.resources) {
    const role = roles.get(typeKey(resource));
    if (role?.role !== "zone") continue;
    const account = accountMap.get(resource.accountId);
    if (!account) continue;
    const fields = asFields(resource.fields);
    const domain =
      normalizeDnsHost(readString(fields, role.domainKey ?? "name")) ||
      normalizeDnsHost(resource.displayName);
    const privateRaw = readString(fields, role.privateKey);
    const isPrivate =
      role.isPrivate === true ||
      (role.privateValues
        ? role.privateValues.some((v) => v.toLowerCase() === privateRaw.toLowerCase())
        : readBoolean(fields, role.privateKey));

    const zone: DnsZoneEntry = {
      resourceId: resource.id,
      pluginId: resource.pluginId,
      pluginName: pluginNames.get(resource.pluginId) ?? resource.pluginId,
      resourceTypeId: resource.resourceTypeId,
      resourceTypeName: typeNames.get(typeKey(resource)) ?? resource.resourceTypeId,
      accountId: resource.accountId,
      accountName: account.displayName,
      domain,
      status: readString(fields, role.statusKey) || null,
      isPrivate,
      recordCount: 0,
      providerRecordCount: readNumber(fields, role.recordCountKey),
      danglingCount: 0,
    };
    zones.push(zone);
    zoneById.set(resource.id, zone);
    // Both keys point at the same zone: a record's `zoneKey` holds the id on
    // one provider and the domain on the next, and neither is worth a
    // per-plugin branch here.
    for (const key of [resource.externalId, domain]) {
      if (key) zoneByKey.set(`${resource.pluginId}|${key.trim().toLowerCase()}`, zone);
    }
  }

  // ---- records -----------------------------------------------------------
  const records: DnsRecordEntry[] = [];

  for (const resource of input.resources) {
    const role = roles.get(typeKey(resource));
    if (role?.role !== "record") continue;
    const account = accountMap.get(resource.accountId);
    if (!account) continue;
    const fields = asFields(resource.fields);

    const zone = resolveZone(resource, role, fields, zoneById, zoneByKey);
    const type = readString(fields, role.typeKey ?? "type").toUpperCase();
    const targets = classifyTargets({
      raw: readString(fields, role.contentKey ?? "content"),
      type,
      zone,
      identity,
      namespaces: active,
    });

    const entry: DnsRecordEntry = {
      resourceId: resource.id,
      pluginId: resource.pluginId,
      pluginName: pluginNames.get(resource.pluginId) ?? resource.pluginId,
      resourceTypeId: resource.resourceTypeId,
      resourceTypeName: typeNames.get(typeKey(resource)) ?? resource.resourceTypeId,
      accountId: resource.accountId,
      accountName: account.displayName,
      zoneResourceId: zone?.resourceId ?? null,
      zoneDomain: zone?.domain ?? null,
      name: qualifyRecordName(readString(fields, role.nameKey ?? "name"), zone?.domain ?? null),
      type,
      ttl: readNumber(fields, role.ttlKey ?? "ttl"),
      priority: readNumber(fields, role.priorityKey),
      proxied: readBoolean(fields, role.proxiedKey),
      targets,
      status: worstStatus(targets),
    };
    records.push(entry);

    if (zone) {
      zone.recordCount += 1;
      zone.danglingCount += targets.filter((t) => t.classification === "dangling").length;
    }
  }

  // ---- assemble ----------------------------------------------------------
  zones.sort(
    (a, b) => a.domain.localeCompare(b.domain) || a.accountName.localeCompare(b.accountName),
  );
  records.sort(
    (a, b) =>
      CLASSIFICATION_RANK[a.status] - CLASSIFICATION_RANK[b.status] ||
      a.name.localeCompare(b.name) ||
      a.type.localeCompare(b.type),
  );

  const counts = {
    zones: zones.length,
    records: records.length,
    owned: 0,
    dangling: 0,
    external: 0,
    notAnalysed: 0,
  };
  for (const record of records) {
    // Counted per record, not per target: "3 dangling records" is the number a
    // reader can act on, whereas a record with two dead targets is one problem.
    if (record.status === "owned") counts.owned += 1;
    else if (record.status === "dangling") counts.dangling += 1;
    else if (record.status === "external") counts.external += 1;
    else counts.notAnalysed += 1;
  }

  return {
    zones,
    records,
    counts,
    skippedNamespaces: dedupeSkipped(skipped),
    generatedAt: new Date(now).toISOString(),
  };
}

/**
 * Attribute a record to its zone. `parentResourceId` is written by the sync
 * path and needs no guessing, so it wins; the declared `zoneKey` is the
 * fallback for plugins whose listers don't set a parent.
 */
function resolveZone(
  resource: DnsScanResource,
  role: DnsRecordRole,
  fields: Record<string, unknown>,
  zoneById: Map<string, DnsZoneEntry>,
  zoneByKey: Map<string, DnsZoneEntry>,
): DnsZoneEntry | null {
  if (resource.parentResourceId) {
    const parent = zoneById.get(resource.parentResourceId);
    if (parent) return parent;
  }
  const named = readString(fields, role.zoneKey).trim().toLowerCase();
  if (!named) return null;
  return zoneByKey.get(`${resource.pluginId}|${named}`) ?? null;
}

function worstStatus(targets: readonly DnsRecordTarget[]): DnsTargetClassification {
  let worst: DnsTargetClassification = "not-analysed";
  for (const target of targets) {
    if (CLASSIFICATION_RANK[target.classification] < CLASSIFICATION_RANK[worst]) {
      worst = target.classification;
    }
  }
  return worst;
}

function classifyTargets(args: {
  raw: string;
  type: string;
  zone: DnsZoneEntry | null;
  identity: Map<string, IdentityClaim>;
  namespaces: readonly ActiveNamespace[];
}): DnsRecordTarget[] {
  const { raw, type, zone, identity, namespaces } = args;
  if (!raw) return [];
  // Route 53's `values` and Cloud DNS's `rrdatas` are comma-joined lists; a
  // round-robin A record's addresses each stand or fall on their own.
  const values = (raw.includes(",") ? raw.split(",") : [raw])
    .map((v) => normalizeDnsHost(v))
    .filter(Boolean);

  const analysed = ANALYSED_RECORD_TYPES.has(type);
  return values.map((value) => {
    if (!analysed)
      return { value, classification: "not-analysed" as const, resource: null, service: null };

    const claim = identity.get(value);
    if (claim && claim.claimants === 1) {
      return { value, classification: "owned" as const, resource: claim.resource, service: null };
    }

    // Addresses can't fall inside a provider *hostname* namespace, and a
    // private zone's names are never internet-reachable, so neither reaches
    // the takeover pass.
    if (!ADDRESS_RECORD_TYPES.has(type) && !isAddress(value) && !zone?.isPrivate) {
      for (const namespace of namespaces) {
        const match = namespace.pattern.exec(value);
        if (!match) continue;
        const claimLabel = (match[1] ?? "").toLowerCase();
        const claimant =
          namespace.byHost.get(value) ??
          (namespace.rule.labelIs === "opaque" ? undefined : namespace.byName.get(claimLabel));
        if (claimant) {
          return { value, classification: "owned" as const, resource: claimant, service: null };
        }
        return {
          value,
          classification: "dangling" as const,
          resource: null,
          service: {
            pluginId: namespace.pluginId,
            pluginName: namespace.pluginName,
            resourceTypeId: namespace.resourceTypeId,
            ruleId: namespace.rule.id,
            label: namespace.rule.label,
            severity: namespace.rule.severity ?? "high",
            reason: namespace.rule.reason,
            claimLabel,
          },
        };
      }
    }

    return { value, classification: "external" as const, resource: null, service: null };
  });
}

/** One line per (plugin, namespace); the same reason repeats across rules. */
function dedupeSkipped(skipped: readonly DnsSkippedNamespace[]): DnsSkippedNamespace[] {
  const seen = new Map<string, DnsSkippedNamespace>();
  for (const entry of skipped) {
    const key = `${entry.pluginId}|${entry.label}`;
    if (!seen.has(key)) seen.set(key, entry);
  }
  return [...seen.values()].sort(
    (a, b) => a.pluginName.localeCompare(b.pluginName) || a.label.localeCompare(b.label),
  );
}

/** Every record with at least one dangling target, worst first. */
export function danglingDnsRecords(inventory: DnsInventoryResponse): DnsRecordEntry[] {
  return inventory.records.filter((r) => r.status === "dangling");
}

const EMPTY_INVENTORY: Omit<DnsInventoryResponse, "generatedAt"> = {
  zones: [],
  records: [],
  counts: { zones: 0, records: 0, owned: 0, dangling: 0, external: 0, notAnalysed: 0 },
  skippedNamespaces: [],
};

/**
 * Read `GET /api/org/:orgId/dns` (permission `resources:read`).
 *
 * Cheap and side-effect free: the server computes the inventory over rows it
 * already synced and makes no provider API calls — and, as everywhere in this
 * module, resolves no DNS.
 */
export async function fetchDnsInventory(
  api: CloudFetch,
  orgId: string,
): Promise<DnsInventoryResponse> {
  const res = await api.org<DnsInventoryResponse>(orgId, "/dns");
  return res ?? { ...EMPTY_INVENTORY, generatedAt: new Date().toISOString() };
}
