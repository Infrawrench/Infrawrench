/**
 * Orphan & idle resource aggregation — the host-side half of the declarative
 * `orphanRule` capability.
 *
 * {@link evaluateOrphanRule} answers "is this one resource flagged". This
 * module answers "what is flagged across a whole workspace", which is the
 * shape every surface actually renders. It lives in plugin-base rather than in
 * a host package because each host runs it over a different store — the web
 * server over the organization's synced rows, the desktop app and the
 * `infrawrench` CLI over the local SQLite workspace — and all of them must
 * agree on what counts as orphaned.
 *
 * Everything here is pure: rows in, groups out. No plugin client, no
 * credentials, no provider API calls. Cost annotation is layered on afterwards
 * by hosts that have billing data (see `costBasis`).
 */
import { evaluateOrphanRule, type OrphanRule } from "./resource.js";

/** Best-effort spend attributed to one flagged resource. */
export interface OrphanCostAnnotation {
  /** Spend over the trailing cost window, in `currency`. */
  amount: number;
  /** ISO 4217 code, e.g. "USD". */
  currency: string;
}

/**
 * Who owns a resource, in the compact form other features embed — a flagged
 * orphan row, an expiry item, an alert body.
 *
 * It lives here rather than in client-core (where the rest of the ownership
 * feature lives) for the same reason `OrphanCostAnnotation` does: this file
 * defines the shape hosts annotate, and client-core's plugin-base import is
 * type-only, so the dependency can only point this way. `client-core/ownership`
 * re-exports the name — there is one definition, not two.
 *
 * Note what an annotation means: it is only present when somebody can be
 * *named*. A resource with a recorded purpose but no owner annotates as null,
 * because the question the orphan finder asks is "who do I tell?".
 */
export interface ResourceOwnerAnnotation {
  /** Set when a routable org member owns it; null for a free-text owner. */
  userId: string | null;
  /** The name to print: the member's name, else the free-text owner. */
  displayName: string;
  /** True when `displayName` is free text — i.e. nobody to route an alert to. */
  isLabel: boolean;
  /** Link to the ticket that authorized the resource, when recorded. */
  ticketUrl: string | null;
  /** What the resource is for, when recorded. */
  purpose: string | null;
}

export interface OrphanedResource {
  /** Infrawrench resource id. */
  id: string;
  pluginId: string;
  resourceTypeId: string;
  /** Display name of the resource type, e.g. "EBS Volume". */
  resourceTypeName: string;
  displayName: string;
  /** Provider-native id, when known. */
  externalId: string | null;
  /** Plugin-authored explanation, e.g. "Volume is not attached to any Droplet". */
  reason: string;
  /**
   * Trailing spend matched against the org's collected cost rows, or null
   * when no per-resource cost rows exist for it (most providers) — and always
   * null when `costBasis` is `"unavailable"`. The flag itself never depends on
   * cost data.
   */
  cost: OrphanCostAnnotation | null;
  /**
   * Who to talk to about this row, or null when nobody has claimed it.
   *
   * Layered on afterwards by hosts that store ownership, exactly like `cost`:
   * `collectOrphanGroups` is pure over plugin rules and always emits null here.
   * A null owner is the finder's most actionable output — it is the set of
   * waste that has no one to send a list to.
   */
  owner: ResourceOwnerAnnotation | null;
  /** Last time this resource's state was synced from the provider, if ever. */
  lastSyncedAt: string | null;
}

export interface OrphanAccountGroup {
  accountId: string;
  accountName: string;
  pluginId: string;
  /** Plugin display name, e.g. "DigitalOcean". */
  pluginName: string;
  resources: OrphanedResource[];
}

/**
 * Whether the `cost` column means anything on this surface.
 *
 * - `"billing"` — the host tried to match each flagged resource against
 *   collected per-resource billing rows. A null `cost` means nothing matched.
 * - `"unavailable"` — the host has no billing data at all (local mode, which
 *   never talks to the cost warehouse), so every `cost` is null and the column
 *   carries no information. Surfaces drop it rather than print a row of
 *   dashes, and must never render it as zero.
 *
 * Absent is equivalent to `"billing"`: the cloud aggregate predates the field
 * and always attempts a match. The web API deliberately does not emit it —
 * it is a local-mode signal, so the HTTP response shape is unchanged.
 */
export type OrphanCostBasis = "billing" | "unavailable";

export interface OrphanListResponse {
  /** Groups sorted by account name; empty when nothing is flagged. */
  accounts: OrphanAccountGroup[];
  /** Total flagged resources across all groups. */
  totalCount: number;
  /**
   * Flagged resources with no owner annotation — the "nobody to ask" count.
   *
   * Always equal to `totalCount` on a host that stores no ownership (local
   * mode), which is honest: it has no ownership data, so it knows of no owner.
   * Surfaces should read it as "unattributed", not as "unowned in the cloud".
   */
  unownedCount: number;
  /** Days of trailing spend the cost annotations cover; 0 when there are none. */
  costWindowDays: number;
  /** See {@link OrphanCostBasis}. */
  costBasis?: OrphanCostBasis;
  generatedAt: string;
}

/** The part of a resource type definition the scan reads. */
export interface OrphanScanResourceType {
  id: string;
  displayName: string;
  orphanRule?: OrphanRule | undefined;
}

/** The part of a loaded plugin the scan reads. */
export interface OrphanScanPlugin {
  id: string;
  displayName: string;
  resourceTypes: readonly OrphanScanResourceType[];
}

/** The part of an account row the scan reads. */
export interface OrphanScanAccount {
  id: string;
  displayName: string;
  pluginId: string;
}

/**
 * The part of a stored resource row the scan reads. Hosts map their own store
 * onto this — Postgres jsonb columns, SQLite TEXT bags, whatever — so the
 * classification never learns which database it is looking at.
 */
export interface OrphanScanResource {
  id: string;
  pluginId: string;
  resourceTypeId: string;
  accountId: string;
  displayName: string;
  externalId: string | null;
  /** The instance's stored `fields` bag; a missing/!object bag flags nothing. */
  fields: unknown;
  /** ISO 8601, or null when the store never recorded a sync. */
  lastSyncedAt: string | null;
}

export interface OrphanScanInput {
  plugins: readonly OrphanScanPlugin[];
  accounts: readonly OrphanScanAccount[];
  resources: readonly OrphanScanResource[];
}

/**
 * Classify stored resources against each type's `orphanRule` and group the
 * matches by account.
 *
 * Groups come back sorted by account name and each group's resources by type
 * name then display name, so two hosts reading the same workspace render the
 * same order. Resources whose account is missing from `accounts` are skipped:
 * that is a soft-deleted account, not a flag worth showing.
 */
export function collectOrphanGroups({
  plugins,
  accounts,
  resources,
}: OrphanScanInput): OrphanAccountGroup[] {
  // pluginId → { pluginName, rules: typeId → { rule, typeName } }
  const ruleIndex = new Map<
    string,
    { pluginName: string; rules: Map<string, { rule: OrphanRule; typeName: string }> }
  >();
  for (const plugin of plugins) {
    const rules = new Map<string, { rule: OrphanRule; typeName: string }>();
    for (const type of plugin.resourceTypes) {
      if (type.orphanRule)
        rules.set(type.id, { rule: type.orphanRule, typeName: type.displayName });
    }
    if (rules.size > 0) ruleIndex.set(plugin.id, { pluginName: plugin.displayName, rules });
  }
  if (ruleIndex.size === 0) return [];

  const accountMap = new Map(accounts.map((a) => [a.id, a]));
  const groups = new Map<string, OrphanAccountGroup>();

  for (const r of resources) {
    const pluginEntry = ruleIndex.get(r.pluginId);
    const typeEntry = pluginEntry?.rules.get(r.resourceTypeId);
    if (!pluginEntry || !typeEntry) continue;
    const reason = evaluateOrphanRule(typeEntry.rule, asFields(r.fields));
    if (reason === null) continue;
    const account = accountMap.get(r.accountId);
    if (!account) continue;

    let group = groups.get(r.accountId);
    if (!group) {
      group = {
        accountId: r.accountId,
        accountName: account.displayName,
        pluginId: account.pluginId,
        pluginName: pluginEntry.pluginName,
        resources: [],
      };
      groups.set(r.accountId, group);
    }
    group.resources.push({
      id: r.id,
      pluginId: r.pluginId,
      resourceTypeId: r.resourceTypeId,
      resourceTypeName: typeEntry.typeName,
      displayName: r.displayName,
      externalId: r.externalId,
      reason,
      cost: null,
      // Both annotations are the host's job; the scan itself knows neither
      // billing nor ownership.
      owner: null,
      lastSyncedAt: r.lastSyncedAt,
    });
  }

  const grouped = [...groups.values()].sort((a, b) => a.accountName.localeCompare(b.accountName));
  for (const g of grouped) {
    g.resources.sort(
      (a, b) =>
        a.resourceTypeName.localeCompare(b.resourceTypeName) ||
        a.displayName.localeCompare(b.displayName),
    );
  }
  return grouped;
}

/** Total flagged resources across every group. */
export function countOrphans(groups: readonly OrphanAccountGroup[]): number {
  return groups.reduce((n, g) => n + g.resources.length, 0);
}

/**
 * Flagged resources with no owner annotation, across every group.
 *
 * Call this *after* a host has annotated ownership — on unannotated groups it
 * correctly returns `countOrphans`, since nothing is known to be owned.
 */
export function countUnownedOrphans(groups: readonly OrphanAccountGroup[]): number {
  return groups.reduce((n, g) => n + g.resources.filter((r) => r.owner === null).length, 0);
}

/**
 * View an untyped stored bag as the field map `evaluateOrphanRule` reads.
 *
 * Anything that isn't a plain object (a null column, a bag that failed to
 * parse) reads as "no fields", which only `empty` conditions can match — the
 * same outcome as a resource synced before the rule's field existed. Values
 * are passed through untouched, including the occasional nested object, so
 * that a present-but-structured value still counts as present.
 */
function asFields(raw: unknown): Record<string, string | number | boolean> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  return raw as Record<string, string | number | boolean>;
}
