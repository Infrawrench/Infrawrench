/**
 * Environment diff — two accounts' inventories compared side by side.
 *
 * The question this answers is "why does staging work and prod doesn't":
 * which resource types exist in one account and not the other, how the counts
 * differ, and where two resources that clearly correspond disagree on a field
 * (instance class, engine version, a feature flag).
 *
 * It is the second caller of the change-timeline differ. `computeResourceChangeEvents`
 * in `resource-changes.ts` is already pure, provider-agnostic and unit-tested;
 * it compares one account against its own past by resource id. Feeding it two
 * *accounts* keyed by a name-derived pairing key instead of by id turns the
 * same comparison into an environment diff, and its `created` / `deleted` /
 * `updated` events fall out as "only in B" / "only in A" / "changed". Nothing
 * in here knows what a provider is.
 *
 * Pure and host-agnostic on purpose: the web API computes it over Postgres
 * rows, the desktop computes it over its SQLite workspace, and the CLI does
 * both. Rows in, diff out.
 */

import type { CloudFetch } from "./fetch";
import {
  computeResourceChangeEvents,
  type FetchedResourceSnapshot,
  type PriorResourceSnapshot,
  type ResourceFieldChange,
} from "./resource-changes";

/* ------------------------------------------------------------------ *
 * Wire shape
 * ------------------------------------------------------------------ */

/**
 * What happened to one pairing slot.
 *
 * Named for the two sides rather than for time: this is a comparison of peers,
 * not a history, and "added"/"removed" would imply one of them came first.
 */
export type EnvironmentDiffStatus = "only-in-a" | "only-in-b" | "changed";

/** One field the two sides disagree on. */
export interface EnvironmentDiffFieldChange {
  /** Field key; resolved-output keys are prefixed `outputs.`. */
  field: string;
  /** Value on side A. `null` when the key is absent there. */
  a: unknown;
  /** Value on side B. */
  b: unknown;
}

/** One side of a matched pair, as much of it as the diff renders. */
export interface EnvironmentDiffResourceRef {
  /** Infrawrench resource id, for linking through to the resource. */
  resourceId: string;
  accountId: string;
  displayName: string;
  externalId: string | null;
}

/** One pairing slot: a matched pair, or a resource with no counterpart. */
export interface EnvironmentDiffEntry {
  /**
   * The pairing key both sides matched on — the resource type plus the
   * environment-stripped name. Stable across runs, so a UI can key rows on it.
   */
  key: string;
  resourceTypeId: string;
  /** Plugin-declared type name ("Droplet"); falls back to the id. */
  resourceTypeName: string;
  status: EnvironmentDiffStatus;
  /** Null when the resource exists only on side B. */
  a: EnvironmentDiffResourceRef | null;
  /** Null when the resource exists only on side A. */
  b: EnvironmentDiffResourceRef | null;
  /** Field divergences, identity noise already removed. Empty unless `changed`. */
  changes: EnvironmentDiffFieldChange[];
  /** Divergences hidden by the identity filter (see {@link isIdentityChange}). */
  suppressedCount: number;
}

/** Per-resource-type roll-up — the "present in one and not the other" answer. */
export interface EnvironmentDiffTypeSummary {
  resourceTypeId: string;
  resourceTypeName: string;
  countA: number;
  countB: number;
  /** `countB - countA`. Negative means side B has fewer. */
  delta: number;
  /** Resources on side A with no counterpart on B. */
  onlyInA: number;
  onlyInB: number;
  /** Matched pairs that disagree on at least one visible field. */
  changed: number;
  /** Matched pairs with no visible divergence. */
  identical: number;
  /** True when the type exists on exactly one side — the loudest signal here. */
  missingFrom: "a" | "b" | null;
}

/** One side's identity in the response. */
export interface EnvironmentDiffSideSummary {
  accountId: string;
  accountName: string;
  resourceCount: number;
}

export interface EnvironmentDiffTotals {
  onlyInA: number;
  onlyInB: number;
  changed: number;
  identical: number;
  /** Resource types present on side A only (and vice versa). */
  typesOnlyInA: number;
  typesOnlyInB: number;
  /** Field divergences the identity filter hid across every pair. */
  suppressedFieldChanges: number;
}

/** A resource type that could not be compared, and why. */
export interface EnvironmentDiffUnavailableType {
  resourceTypeId: string;
  resourceTypeName: string;
  /** The provider's complaint, as the lister reported it. */
  message: string;
}

/** Wire shape of `GET /api/org/{orgId}/environment-diff` and the local assembly. */
export interface EnvironmentDiffResponse {
  a: EnvironmentDiffSideSummary;
  b: EnvironmentDiffSideSummary;
  /** Both accounts' plugin — comparing across providers is refused upstream. */
  pluginId: string;
  pluginName: string;
  /** Every type present on either side, most-divergent first. */
  types: EnvironmentDiffTypeSummary[];
  /** Only the slots that differ; identical pairs are counted, not listed. */
  entries: EnvironmentDiffEntry[];
  totals: EnvironmentDiffTotals;
  /**
   * Resource types that could not be listed on at least one side. They are
   * excluded from the comparison rather than reported as missing — "we
   * couldn't ask" and "prod doesn't have one" are opposite answers.
   *
   * Only hosts that list live populate this (the desktop's local mode, and
   * `infrawrench diff --local`). The cloud reads already-synced rows, which
   * cannot half-fail, so it always returns an empty list.
   */
  unavailableTypes: EnvironmentDiffUnavailableType[];
  /** True when identity/timestamp fields were compared rather than filtered out. */
  includeIdentityFields: boolean;
  generatedAt: string;
}

/* ------------------------------------------------------------------ *
 * Input shape
 * ------------------------------------------------------------------ */

/**
 * The part of a stored resource row the diff reads. Hosts map their own store
 * onto this — Postgres jsonb, SQLite TEXT bags — so the computation never
 * learns which database it is looking at.
 */
export interface EnvironmentDiffResource {
  id: string;
  resourceTypeId: string;
  displayName: string;
  externalId: string | null;
  /** The stored `fields` bag; a missing or non-object bag reads as empty. */
  fields: unknown;
  /** The stored resolved-outputs bag, if the host keeps one. */
  outputs?: unknown;
}

export interface EnvironmentDiffSide {
  accountId: string;
  accountName: string;
  pluginId: string;
  resources: readonly EnvironmentDiffResource[];
}

export interface EnvironmentDiffInput {
  /** The baseline — the environment that works, by convention. */
  a: EnvironmentDiffSide;
  /** The environment being explained. */
  b: EnvironmentDiffSide;
  /** Plugin display name for the response header; falls back to the id. */
  pluginName?: string | undefined;
  /** `resourceTypeId` → display name, from the plugin manifest. */
  resourceTypeNames?: Readonly<Record<string, string>> | undefined;
  /** Compare one resource type only. Omitted, every type is compared. */
  resourceTypeId?: string | undefined;
  /**
   * Types the host failed to list. Their resources are dropped from both sides
   * so a failed list never reads as an absence, and the list is passed through
   * to the response for the host to report.
   */
  unavailableTypes?: readonly EnvironmentDiffUnavailableType[] | undefined;
  /**
   * Compare identity and timestamp fields too. Off by default: every resource
   * in prod has a different id, address and creation time than its staging
   * twin, and listing those buries the one field that actually diverged.
   */
  includeIdentityFields?: boolean | undefined;
  /** Clock for `generatedAt`; defaults to now. */
  now?: number | undefined;
}

/* ------------------------------------------------------------------ *
 * Name normalization — how two resources are recognized as counterparts
 * ------------------------------------------------------------------ */

/**
 * Words that name an environment rather than a thing. Stripped from resource
 * names before pairing, so `api-staging` in one account lines up with
 * `api-prod` in the other.
 *
 * Deliberately a fixed vocabulary plus the two account names' own words (see
 * {@link environmentTokens}): a user who calls their accounts "Acme Blue" and
 * "Acme Green" gets `acme`, `blue` and `green` stripped without configuring
 * anything, and nobody has to learn a naming convention to use the feature.
 */
export const ENVIRONMENT_NAME_TOKENS: readonly string[] = [
  "prod",
  "production",
  "prd",
  "live",
  "stg",
  "stage",
  "staging",
  "dev",
  "devel",
  "development",
  "test",
  "testing",
  "qa",
  "uat",
  "sandbox",
  "sbx",
  "preview",
  "preprod",
  "demo",
  "canary",
  "beta",
  "alpha",
  "local",
];

/**
 * Split a string into lowercase words across camelCase runs and separators.
 *
 * `splitDigits` additionally breaks letter↔digit boundaries, so `web1` and
 * `web-1` normalize alike and pair across two environments that spell their
 * ordinals differently. It is off for *field* names, where the digit is part
 * of the word the identity filter matches on (`ipv4`).
 */
function words(text: string, splitDigits = false): string[] {
  let spaced = text
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  if (splitDigits) {
    spaced = spaced.replace(/([A-Za-z])(\d)/g, "$1 $2").replace(/(\d)([A-Za-z])/g, "$1 $2");
  }
  return spaced
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

/** {@link words} as the name normalizer needs it. */
function nameWords(text: string): string[] {
  return words(text, true);
}

/**
 * The token set stripped from resource names for this comparison: the shared
 * vocabulary plus every word in either account's name.
 */
export function environmentTokens(accountNameA: string, accountNameB: string): Set<string> {
  const tokens = new Set(ENVIRONMENT_NAME_TOKENS);
  for (const word of [...nameWords(accountNameA), ...nameWords(accountNameB)]) tokens.add(word);
  return tokens;
}

/**
 * A resource name with its environment words removed, for pairing.
 *
 * Falls back to the plain lowercased words when stripping would leave nothing:
 * an account named "prod" holding a resource named "prod" must still pair with
 * its counterpart rather than collapsing to the empty key alongside everything
 * else that vanished.
 */
export function normalizeEnvironmentName(name: string, tokens: ReadonlySet<string>): string {
  const all = nameWords(name);
  const kept = all.filter((w) => !tokens.has(w));
  return (kept.length > 0 ? kept : all).join("-");
}

/* ------------------------------------------------------------------ *
 * The identity filter
 * ------------------------------------------------------------------ */

/**
 * Final field-name words that identify an instance rather than configure it.
 * Matched against the last word of the key, so `vpcId`, `vpc_id` and
 * `network.vpcId` all hit `id` while `valid` does not.
 */
const IDENTITY_WORDS = new Set([
  "id",
  "ids",
  "uuid",
  "guid",
  "arn",
  "arns",
  "urn",
  "url",
  "urls",
  "uri",
  "uris",
  "href",
  "link",
  "links",
  "endpoint",
  "endpoints",
  "host",
  "hostname",
  "hostnames",
  "address",
  "addresses",
  "ip",
  "ips",
  "ipv4",
  "ipv6",
  "fqdn",
  "dns",
  "etag",
  "fingerprint",
  "checksum",
  "digest",
  "hash",
]);

/** Final words whose numeric values are clocks, not configuration. */
const TIME_WORDS = new Set(["at", "time", "timestamp", "date", "since", "epoch"]);

/** ISO-8601-ish instant: a date, optionally with a time. */
const ISO_INSTANT_RE =
  /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;

function fieldWords(field: string): string[] {
  const last = field.includes(".") ? field.slice(field.lastIndexOf(".") + 1) : field;
  return words(last);
}

/**
 * Whether a divergence is an artefact of the two resources being two
 * resources, rather than a configuration difference worth reading.
 *
 * Three rules, all provider-agnostic:
 *
 * 1. The field's last word names an identifier, a link or a network address —
 *    every prod resource has a different one by construction.
 * 2. Both values are timestamps (ISO strings either side, or numbers under a
 *    key like `createdAt`). A creation time differing says nothing.
 * 3. The value on each side is that side's own provider id. Cross-references
 *    (`vpcId`, `imageId`) are mostly caught by rule 1; this catches the ones
 *    spelled without an `id` suffix.
 *
 * Everything else — instance class, engine version, replica count, a boolean
 * flag — is exactly what the diff exists to show, so the filter never guesses
 * at "probably fine". `--all` / the UI toggle turns it off entirely.
 */
export function isIdentityChange(
  change: ResourceFieldChange,
  refs: { a: EnvironmentDiffResourceRef | null; b: EnvironmentDiffResourceRef | null },
): boolean {
  const parts = fieldWords(change.field);
  const last = parts[parts.length - 1];
  if (last !== undefined && IDENTITY_WORDS.has(last)) return true;

  const isIsoInstant = (v: unknown) => typeof v === "string" && ISO_INSTANT_RE.test(v.trim());
  if (isIsoInstant(change.from) && isIsoInstant(change.to)) return true;
  if (
    last !== undefined &&
    TIME_WORDS.has(last) &&
    typeof change.from === "number" &&
    typeof change.to === "number"
  ) {
    return true;
  }

  const selfReference = (value: unknown, ref: EnvironmentDiffResourceRef | null) =>
    typeof value === "string" &&
    ref !== null &&
    (value === ref.externalId || value === ref.resourceId);
  if (selfReference(change.from, refs.a) && selfReference(change.to, refs.b)) return true;

  return false;
}

/* ------------------------------------------------------------------ *
 * The diff
 * ------------------------------------------------------------------ */

/** A resource bag that isn't a plain object contributes no fields. */
function bag(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

interface Slot {
  /** `${resourceTypeId}\0${normalizedName}#${ordinal}` — the synthetic diff id. */
  id: string;
  key: string;
  resource: EnvironmentDiffResource;
}

/**
 * Bucket one side's resources into pairing slots.
 *
 * Several resources can normalize to the same key — three volumes all called
 * `data`, or a name made entirely of environment words. They are ordered
 * deterministically (display name, then provider id, then resource id) and
 * given ordinals, so the two sides pair up to the overlap and the leftovers
 * read as only-in-one-side. That degrades gracefully instead of needing an
 * "ambiguous" concept nobody would know what to do with.
 */
function buildSlots(side: EnvironmentDiffSide, tokens: ReadonlySet<string>): Slot[] {
  const groups = new Map<string, EnvironmentDiffResource[]>();
  for (const r of side.resources) {
    const key = `${r.resourceTypeId}\0${normalizeEnvironmentName(r.displayName, tokens)}`;
    const existing = groups.get(key);
    if (existing) existing.push(r);
    else groups.set(key, [r]);
  }

  const slots: Slot[] = [];
  for (const [key, members] of groups) {
    members.sort(
      (x, y) =>
        x.displayName.localeCompare(y.displayName) ||
        (x.externalId ?? "").localeCompare(y.externalId ?? "") ||
        x.id.localeCompare(y.id),
    );
    members.forEach((resource, ordinal) => {
      slots.push({ id: `${key}#${ordinal}`, key, resource });
    });
  }
  return slots;
}

function refOf(
  side: EnvironmentDiffSide,
  resource: EnvironmentDiffResource,
): EnvironmentDiffResourceRef {
  return {
    resourceId: resource.id,
    accountId: side.accountId,
    displayName: resource.displayName,
    externalId: resource.externalId,
  };
}

const STATUS_RANK: Record<EnvironmentDiffStatus, number> = {
  "only-in-a": 0,
  "only-in-b": 1,
  changed: 2,
};

/**
 * Compare two accounts' inventories.
 *
 * Throws when the two sides belong to different plugins: a Droplet has no
 * counterpart in an AWS account, so every row would be "only in one side" and
 * the answer would be noise wearing a diff's clothes. Callers surface this as
 * a 400 / a one-line CLI error.
 */
export function computeEnvironmentDiff(input: EnvironmentDiffInput): EnvironmentDiffResponse {
  if (input.a.pluginId !== input.b.pluginId) {
    throw new EnvironmentDiffPluginMismatchError(input.a, input.b);
  }

  const typeFilter = input.resourceTypeId;
  const unavailable = new Set((input.unavailableTypes ?? []).map((t) => t.resourceTypeId));
  const keep = (r: EnvironmentDiffResource) =>
    (!typeFilter || r.resourceTypeId === typeFilter) && !unavailable.has(r.resourceTypeId);
  const a: EnvironmentDiffSide = { ...input.a, resources: input.a.resources.filter(keep) };
  const b: EnvironmentDiffSide = { ...input.b, resources: input.b.resources.filter(keep) };

  const tokens = environmentTokens(a.accountName, b.accountName);
  const slotsA = buildSlots(a, tokens);
  const slotsB = buildSlots(b, tokens);
  // Slot ids are unique within a side and *shared* across sides — that is the
  // whole trick, and why each side needs its own lookup.
  const aById = new Map(slotsA.map((slot) => [slot.id, slot]));
  const bById = new Map(slotsB.map((slot) => [slot.id, slot]));

  const toPrior = (slot: Slot): PriorResourceSnapshot => ({
    id: slot.id,
    pluginId: a.pluginId,
    resourceTypeId: slot.resource.resourceTypeId,
    displayName: slot.resource.displayName,
    fieldsJson: bag(slot.resource.fields),
    outputsJson: bag(slot.resource.outputs),
    deletedAt: null,
  });
  const toFetched = (slot: Slot): FetchedResourceSnapshot => ({
    id: slot.id,
    pluginId: b.pluginId,
    resourceTypeId: slot.resource.resourceTypeId,
    displayName: slot.resource.displayName,
    fields: bag(slot.resource.fields),
    resolvedOutputs: bag(slot.resource.outputs),
  });

  // Side A plays "prior", side B plays "fetched", and every type on side A is
  // deletable — an A-only resource is a real answer here, never the transient
  // list failure the parameter guards against during a sync.
  const events = computeResourceChangeEvents({
    prior: slotsA.map(toPrior),
    fetched: slotsB.map(toFetched),
    deletableTypeIds: slotsA.map((s) => s.resource.resourceTypeId),
  });

  const typeName = (id: string) => input.resourceTypeNames?.[id] ?? id;
  const entries: EnvironmentDiffEntry[] = [];
  let suppressedFieldChanges = 0;
  /** Slot ids that produced a visible entry, so identical pairs can be counted. */
  const reported = new Set<string>();

  for (const event of events) {
    const slotA = aById.get(event.resourceId) ?? null;
    const slotB = bById.get(event.resourceId) ?? null;
    const refA = slotA ? refOf(a, slotA.resource) : null;
    const refB = slotB ? refOf(b, slotB.resource) : null;
    const key = (slotA ?? slotB)!.key;
    const base = {
      key,
      resourceTypeId: event.resourceTypeId,
      resourceTypeName: typeName(event.resourceTypeId),
      a: refA,
      b: refB,
      suppressedCount: 0,
    };

    if (event.changeKind !== "updated") {
      reported.add(event.resourceId);
      entries.push({
        ...base,
        status: event.changeKind === "deleted" ? "only-in-a" : "only-in-b",
        changes: [],
      });
      continue;
    }

    // `displayName` always differs for a matched pair whose names carried the
    // environment word — that is what pairing normalized away — so it can
    // never be informative here and isn't counted as suppressed either.
    const candidates = event.diff.filter((d) => d.field !== "displayName");
    const visible = input.includeIdentityFields
      ? candidates
      : candidates.filter((d) => !isIdentityChange(d, { a: refA, b: refB }));
    const suppressed = candidates.length - visible.length;
    suppressedFieldChanges += suppressed;
    if (visible.length === 0) continue;

    reported.add(event.resourceId);
    entries.push({
      ...base,
      status: "changed",
      changes: visible.map((d) => ({ field: d.field, a: d.from, b: d.to })),
      suppressedCount: suppressed,
    });
  }

  entries.sort(
    (x, y) =>
      x.resourceTypeName.localeCompare(y.resourceTypeName) ||
      STATUS_RANK[x.status] - STATUS_RANK[y.status] ||
      (x.a?.displayName ?? x.b?.displayName ?? "").localeCompare(
        y.a?.displayName ?? y.b?.displayName ?? "",
      ),
  );

  /* Per-type roll-up. Built from the slot lists (not the events) so identical
   * pairs — the ones the differ is silent about — are counted too. */
  const summaries = new Map<string, EnvironmentDiffTypeSummary>();
  const summaryFor = (resourceTypeId: string): EnvironmentDiffTypeSummary => {
    let s = summaries.get(resourceTypeId);
    if (!s) {
      s = {
        resourceTypeId,
        resourceTypeName: typeName(resourceTypeId),
        countA: 0,
        countB: 0,
        delta: 0,
        onlyInA: 0,
        onlyInB: 0,
        changed: 0,
        identical: 0,
        missingFrom: null,
      };
      summaries.set(resourceTypeId, s);
    }
    return s;
  };
  for (const slot of slotsA) summaryFor(slot.resource.resourceTypeId).countA += 1;
  for (const slot of slotsB) summaryFor(slot.resource.resourceTypeId).countB += 1;
  for (const entry of entries) {
    const s = summaryFor(entry.resourceTypeId);
    if (entry.status === "only-in-a") s.onlyInA += 1;
    else if (entry.status === "only-in-b") s.onlyInB += 1;
    else s.changed += 1;
  }
  // Matched pairs are the overlap of the two slot id sets; the ones that never
  // produced an entry are identical (or identical once the filter ran).
  for (const slot of slotsA) {
    if (!bById.has(slot.id) || reported.has(slot.id)) continue;
    summaryFor(slot.resource.resourceTypeId).identical += 1;
  }

  const types = [...summaries.values()];
  for (const s of types) {
    s.delta = s.countB - s.countA;
    s.missingFrom = s.countA === 0 ? "a" : s.countB === 0 ? "b" : null;
  }
  const differences = (s: EnvironmentDiffTypeSummary) => s.onlyInA + s.onlyInB + s.changed;
  types.sort(
    (x, y) =>
      differences(y) - differences(x) || x.resourceTypeName.localeCompare(y.resourceTypeName),
  );

  const totals: EnvironmentDiffTotals = {
    onlyInA: entries.filter((e) => e.status === "only-in-a").length,
    onlyInB: entries.filter((e) => e.status === "only-in-b").length,
    changed: entries.filter((e) => e.status === "changed").length,
    identical: types.reduce((sum, s) => sum + s.identical, 0),
    typesOnlyInA: types.filter((s) => s.missingFrom === "b").length,
    typesOnlyInB: types.filter((s) => s.missingFrom === "a").length,
    suppressedFieldChanges,
  };

  return {
    a: { accountId: a.accountId, accountName: a.accountName, resourceCount: a.resources.length },
    b: { accountId: b.accountId, accountName: b.accountName, resourceCount: b.resources.length },
    pluginId: a.pluginId,
    pluginName: input.pluginName ?? a.pluginId,
    types,
    entries,
    totals,
    unavailableTypes: [...(input.unavailableTypes ?? [])],
    includeIdentityFields: input.includeIdentityFields === true,
    generatedAt: new Date(input.now ?? Date.now()).toISOString(),
  };
}

/**
 * Thrown when the two accounts belong to different plugins. Carries both sides
 * so hosts can name them: the web route turns it into a 400 and the CLI into a
 * one-line error, and neither should have to re-derive the message.
 */
export class EnvironmentDiffPluginMismatchError extends Error {
  readonly a: { accountName: string; pluginId: string };
  readonly b: { accountName: string; pluginId: string };

  constructor(
    a: { accountName: string; pluginId: string },
    b: { accountName: string; pluginId: string },
  ) {
    super(
      `"${a.accountName}" (${a.pluginId}) and "${b.accountName}" (${b.pluginId}) use different ` +
        `providers — an environment diff compares two accounts of the same provider.`,
    );
    this.name = "EnvironmentDiffPluginMismatchError";
    this.a = { accountName: a.accountName, pluginId: a.pluginId };
    this.b = { accountName: b.accountName, pluginId: b.pluginId };
  }
}

/* ------------------------------------------------------------------ *
 * Reading it from the cloud (Bearer hosts)
 * ------------------------------------------------------------------ */

export interface EnvironmentDiffRequest {
  /** Baseline account id. */
  a: string;
  /** Compared account id. */
  b: string;
  /** Compare one resource type only. */
  resourceTypeId?: string | undefined;
  /** Include the identity/timestamp fields the filter normally hides. */
  includeIdentityFields?: boolean | undefined;
}

export function environmentDiffSearchParams(request: EnvironmentDiffRequest): string {
  const params = new URLSearchParams({ a: request.a, b: request.b });
  if (request.resourceTypeId) params.set("resourceTypeId", request.resourceTypeId);
  if (request.includeIdentityFields) params.set("includeIdentityFields", "true");
  return params.toString();
}

/**
 * Read `GET /api/org/{orgId}/environment-diff` (permission `resources:read`).
 *
 * Cheap and side-effect free: the server compares rows it already synced and
 * makes no provider API calls, so the answer is as fresh as the last sync.
 */
export async function fetchEnvironmentDiff(
  api: CloudFetch,
  orgId: string,
  request: EnvironmentDiffRequest,
): Promise<EnvironmentDiffResponse | null> {
  return api.org<EnvironmentDiffResponse>(
    orgId,
    `/environment-diff?${environmentDiffSearchParams(request)}`,
  );
}
