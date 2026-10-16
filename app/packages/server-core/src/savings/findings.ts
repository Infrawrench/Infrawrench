/**
 * The savings findings workflow, server half: turn each finder's recomputed
 * feed into observations, remember them in `savings_finding_states`, and
 * carry each finding's lifecycle (Ready for review → In progress → Completed,
 * or Archived). Contract and vocabulary: `client-core/src/savings-findings.ts`.
 *
 * Two writers share {@link recordFindingObservations}:
 *
 * - the **savings scan** (poller, every six hours per org, unscoped), which
 *   computes every finder and may conclude a finding has **gone away**;
 * - `GET /savings/findings` (web, under the caller's cost scope), which only
 *   records what it observes: new findings get their detected date the first
 *   time anyone looks, and a returning finding reopens. It never concludes
 *   absence, because a scoped caller's feeds are narrowed (extended support
 *   and seats drop accounts the scope does not grant) and "this caller cannot
 *   see it" must never read as "it was fixed".
 *
 * The rule for automatic changes (pure, {@link planFindingObservations}):
 *
 * - **Gone** (scan only, and only for a finder that computed successfully that
 *   pass): `gone_at` is set; a Ready or In progress finding moves to
 *   Completed with `resolution: "resolved"` and no actor. Archived stays
 *   archived and a manual Completed keeps its manual resolution.
 * - **Back** (either writer): `gone_at` clears; a finding that had been
 *   resolved automatically reopens as Ready with a new detected date (it is a
 *   new occurrence, and its alert is pending again). Anything a person set
 *   (Archived, a manual Completed, In progress) is left as they set it.
 */
import { and, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import {
  extractRecordTags,
  SAVINGS_FINDING_STATUS_CHANGED,
  isOpenSavingsFindingStatus,
  isSavingsFindingKind,
  isSavingsFindingStatus,
  parseSavingsFindingKey,
  savingsFindingKey,
  type ExtendedSupportListResponse,
  type OrphanListResponse,
  type RightsizingListResponse,
  type SavingsFinding,
  type SavingsFindingKind,
  type SavingsFindingMoney,
  type SavingsFindingResolution,
  type SavingsFindingStatus,
  type SavingsFindingStatusChange,
  type SeatListResponse,
} from "@infrawrench/client-core";

import { db } from "../db/client.js";
import { resources, savingsEvents, savingsFindingStates, users } from "../db/schema.js";
import { publishEvent } from "../events/publish.js";

/* ------------------------------------------------------------------ *
 * Observations (pure)
 * ------------------------------------------------------------------ */

/** One finding as a finder reports it right now. */
export interface ObservedFinding {
  kind: SavingsFindingKind;
  sourceId: string;
  title: string;
  detail: string | null;
  pluginId: string | null;
  pluginName: string | null;
  accountId: string | null;
  accountName: string | null;
  region: string | null;
  resourceId: string | null;
  resourceName: string;
  resourceTypeId: string | null;
  resourceTypeName: string | null;
  tags: Record<string, string>;
  monthly: SavingsFindingMoney | null;
}

/** Tags and region of a synced resource, read from its stored fields. */
export interface ResourceContext {
  tags: Record<string, string>;
  region: string | null;
}

/** Field keys plugins use for a location, most specific last. */
const REGION_FIELD_KEYS = [
  "region",
  "regionId",
  "region_name",
  "regionName",
  "location",
  "zone",
  "availabilityZone",
  "availability_zone",
];

/**
 * Best-effort region from stored fields. Finders that know their resource's
 * region field (right-sizing, extended support) report it themselves; this is
 * for the orphan finder, whose rows carry none.
 */
export function regionFromFields(
  fields: Record<string, unknown> | null | undefined,
): string | null {
  if (!fields) return null;
  for (const key of REGION_FIELD_KEYS) {
    const v = fields[key];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return null;
}

export function resourceContextFromFields(
  fields: Record<string, unknown> | null | undefined,
): ResourceContext {
  return { tags: extractRecordTags(fields ?? null) ?? {}, region: regionFromFields(fields) };
}

type ContextLookup = (resourceId: string) => ResourceContext | undefined;

/** Orphans as observations. 30 days of trailing spend reads as monthly. */
export function observeOrphans(feed: OrphanListResponse, ctx: ContextLookup): ObservedFinding[] {
  const out: ObservedFinding[] = [];
  for (const group of feed.accounts) {
    for (const r of group.resources) {
      const c = ctx(r.id);
      out.push({
        kind: "orphan",
        sourceId: r.id,
        title: `${r.displayName} (${r.resourceTypeName}) looks orphaned`,
        detail: r.reason,
        pluginId: group.pluginId,
        pluginName: group.pluginName,
        accountId: group.accountId,
        accountName: group.accountName,
        region: c?.region ?? null,
        resourceId: r.id,
        resourceName: r.displayName,
        resourceTypeId: r.resourceTypeId,
        resourceTypeName: r.resourceTypeName,
        tags: c?.tags ?? {},
        monthly:
          r.cost && feed.costWindowDays > 0
            ? { amount: (r.cost.amount * 30) / feed.costWindowDays, currency: r.cost.currency }
            : null,
      });
    }
  }
  return out;
}

/** Oversized resources as observations. */
export function observeOversized(
  feed: RightsizingListResponse,
  ctx: ContextLookup,
): ObservedFinding[] {
  const out: ObservedFinding[] = [];
  for (const group of feed.accounts) {
    for (const r of group.resources) {
      const c = ctx(r.id);
      out.push({
        kind: "oversized",
        sourceId: r.id,
        title: `Right-size ${r.displayName} from ${r.currentSize.label} to ${r.recommendedSize.label}`,
        detail: `p95 CPU ${r.cpuP95}% over ${feed.windowDays} days`,
        pluginId: r.pluginId,
        pluginName: group.pluginName,
        accountId: group.accountId,
        accountName: group.accountName,
        region: r.region ?? c?.region ?? null,
        resourceId: r.id,
        resourceName: r.displayName,
        resourceTypeId: r.resourceTypeId,
        resourceTypeName: r.resourceTypeName,
        tags: c?.tags ?? {},
        monthly:
          r.monthlySaving !== null ? { amount: r.monthlySaving, currency: r.currency } : null,
      });
    }
  }
  return out;
}

/**
 * Extended support surcharges as observations. Keyed on resource and release,
 * so an upgrade that lands on another release still past support is a new
 * finding and the old one resolves.
 */
export function observeExtendedSupport(
  feed: ExtendedSupportListResponse,
  ctx: ContextLookup,
): ObservedFinding[] {
  return feed.findings.map((f) => {
    const c = ctx(f.resourceId);
    return {
      kind: "extended_support" as const,
      sourceId: `${f.resourceId}:${f.releaseId}`,
      title: `Upgrade ${f.displayName} from ${f.currentVersion} to ${f.targetVersion}`,
      detail: `${f.product} standard support ends ${f.standardSupportEnds}`,
      pluginId: f.pluginId,
      pluginName: f.pluginName,
      accountId: f.accountId,
      accountName: f.accountName,
      region: f.region ?? c?.region ?? null,
      resourceId: f.resourceId,
      resourceName: f.displayName,
      resourceTypeId: f.resourceTypeId,
      resourceTypeName: f.resourceTypeName,
      tags: c?.tags ?? {},
      monthly:
        f.monthlySurcharge !== null && f.currency
          ? { amount: f.monthlySurcharge, currency: f.currency }
          : null,
    };
  });
}

/** Unused, duplicate and downgradable seats as observations. */
export function observeSeats(feed: SeatListResponse): ObservedFinding[] {
  const seats = new Map(feed.seats.map((s) => [s.id, s]));
  const out: ObservedFinding[] = [];
  for (const f of feed.findings) {
    const seat = seats.get(f.seatId);
    if (!seat) continue;
    const holder = seat.name ?? seat.email ?? seat.login ?? seat.memberId;
    const title =
      f.kind === "inactive"
        ? `Unused ${seat.product} seat for ${holder}`
        : f.kind === "duplicate"
          ? `Duplicate ${seat.product} seat for ${holder}`
          : `Move ${holder} to ${f.targetSeatType ?? "a cheaper"} ${seat.product} seat`;
    out.push({
      kind: "seat",
      sourceId: `${f.kind}:${f.seatId}`,
      title,
      detail: f.reason ?? seat.activitySource,
      pluginId: seat.pluginId,
      pluginName: seat.pluginName,
      accountId: seat.accountId,
      accountName: seat.accountName,
      region: null,
      resourceId: null,
      resourceName: holder,
      resourceTypeId: null,
      resourceTypeName: seat.product,
      tags: {},
      monthly:
        f.monthlySaving !== null && f.currency
          ? { amount: f.monthlySaving, currency: f.currency }
          : null,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * The automatic lifecycle (pure)
 * ------------------------------------------------------------------ */

/** The stored columns the plan reads. */
export interface StoredFindingState {
  kind: SavingsFindingKind;
  sourceId: string;
  status: SavingsFindingStatus;
  resolution: SavingsFindingResolution | null;
  goneAt: Date | null;
}

export interface FindingStatusTransition {
  kind: SavingsFindingKind;
  sourceId: string;
  previousStatus: SavingsFindingStatus;
  status: SavingsFindingStatus;
  resolution: SavingsFindingResolution | null;
}

export interface FindingObservationPlan {
  /** Observed and never recorded: insert as Ready, detected now, alert pending. */
  fresh: ObservedFinding[];
  /** Observed and recorded: refresh the snapshot and `last_seen_at`. */
  seen: ObservedFinding[];
  /** Recorded as gone and observed again: clear `gone_at`. */
  returned: ObservedFinding[];
  /** Of `returned`, the ones resolved automatically: reopen as Ready. */
  reopened: ObservedFinding[];
  /** Recorded, not gone, and missing from a finder that computed: set `gone_at`. */
  gone: StoredFindingState[];
  /** Of `gone`, the open ones: complete as resolved. */
  resolved: StoredFindingState[];
  /** Every status change the plan makes, for events. */
  transitions: FindingStatusTransition[];
}

const pairKey = (kind: string, sourceId: string) => `${kind}\x00${sourceId}`;

/**
 * What one pass of observations changes. `scannedKinds` are the finders that
 * computed successfully this pass; absence is only concluded for those, and
 * only when `concludeAbsence` (the unscoped scan) is set.
 */
export function planFindingObservations(
  stored: readonly StoredFindingState[],
  observed: readonly ObservedFinding[],
  scannedKinds: ReadonlySet<SavingsFindingKind>,
  concludeAbsence: boolean,
): FindingObservationPlan {
  const byKey = new Map(stored.map((s) => [pairKey(s.kind, s.sourceId), s]));
  const plan: FindingObservationPlan = {
    fresh: [],
    seen: [],
    returned: [],
    reopened: [],
    gone: [],
    resolved: [],
    transitions: [],
  };
  const observedKeys = new Set<string>();
  for (const o of observed) {
    const k = pairKey(o.kind, o.sourceId);
    if (observedKeys.has(k)) continue;
    observedKeys.add(k);
    const s = byKey.get(k);
    if (!s) {
      plan.fresh.push(o);
      continue;
    }
    plan.seen.push(o);
    if (s.goneAt) {
      plan.returned.push(o);
      if (s.status === "completed" && s.resolution === "resolved") {
        plan.reopened.push(o);
        plan.transitions.push({
          kind: o.kind,
          sourceId: o.sourceId,
          previousStatus: "completed",
          status: "ready",
          resolution: null,
        });
      }
    }
  }
  if (concludeAbsence) {
    for (const s of stored) {
      if (s.goneAt || !scannedKinds.has(s.kind)) continue;
      if (observedKeys.has(pairKey(s.kind, s.sourceId))) continue;
      plan.gone.push(s);
      if (isOpenSavingsFindingStatus(s.status)) {
        plan.resolved.push(s);
        plan.transitions.push({
          kind: s.kind,
          sourceId: s.sourceId,
          previousStatus: s.status,
          status: "completed",
          resolution: "resolved",
        });
      }
    }
  }
  return plan;
}

/* ------------------------------------------------------------------ *
 * Persistence
 * ------------------------------------------------------------------ */

type StateRow = typeof savingsFindingStates.$inferSelect;

function snapshotColumns(o: ObservedFinding) {
  return {
    title: o.title,
    detail: o.detail,
    pluginId: o.pluginId,
    pluginName: o.pluginName,
    accountId: o.accountId,
    accountName: o.accountName,
    region: o.region,
    resourceId: o.resourceId,
    resourceName: o.resourceName,
    resourceTypeId: o.resourceTypeId,
    resourceTypeName: o.resourceTypeName,
    tags: o.tags,
    monthlyAmount: o.monthly?.amount ?? null,
    currency: o.monthly?.currency ?? null,
  };
}

/** Tags and region for the resources a set of feeds names, in one read. */
export async function loadResourceContexts(
  organizationId: string,
  resourceIds: readonly string[],
): Promise<Map<string, ResourceContext>> {
  const out = new Map<string, ResourceContext>();
  const ids = [...new Set(resourceIds)];
  for (let i = 0; i < ids.length; i += 500) {
    const rows = await db
      .select({ id: resources.id, fields: resources.fieldsJson })
      .from(resources)
      .where(
        and(
          eq(resources.organizationId, organizationId),
          inArray(resources.id, ids.slice(i, i + 500)),
        ),
      );
    for (const r of rows) out.set(r.id, resourceContextFromFields(r.fields));
  }
  return out;
}

export interface RecordObservationsOptions {
  /** Finders that computed successfully this pass. */
  scannedKinds: ReadonlySet<SavingsFindingKind>;
  /** Only the unscoped scan may conclude a finding went away. */
  concludeAbsence: boolean;
  /**
   * Overwrite stored snapshots (money, tags, names) with these observations.
   * False for a cost-scoped caller or one without `costs:read`, whose feeds
   * carry narrowed or blank cost figures: their reads still record new and
   * returning findings, but never erase the money an unscoped scan stored.
   */
  refreshSnapshots?: boolean | undefined;
  now?: Date | undefined;
  /** App URL for event envelopes. */
  url?: string | null | undefined;
}

/**
 * Record a pass of observations and apply the automatic lifecycle. Returns the
 * plan, so the scan can decide which fresh findings to raise. Status
 * transitions are published as `savings.finding.status_changed` events.
 */
export async function recordFindingObservations(
  organizationId: string,
  observed: readonly ObservedFinding[],
  opts: RecordObservationsOptions,
): Promise<FindingObservationPlan> {
  const now = opts.now ?? new Date();
  const kinds = [...opts.scannedKinds];
  const storedRows =
    kinds.length === 0
      ? []
      : await db
          .select({
            kind: savingsFindingStates.sourceKind,
            sourceId: savingsFindingStates.sourceId,
            status: savingsFindingStates.status,
            resolution: savingsFindingStates.resolution,
            goneAt: savingsFindingStates.goneAt,
          })
          .from(savingsFindingStates)
          .where(
            and(
              eq(savingsFindingStates.organizationId, organizationId),
              inArray(savingsFindingStates.sourceKind, kinds),
            ),
          );
  const stored: StoredFindingState[] = storedRows.flatMap((r) =>
    isSavingsFindingKind(r.kind) && isSavingsFindingStatus(r.status)
      ? [
          {
            kind: r.kind,
            sourceId: r.sourceId,
            status: r.status,
            resolution:
              r.resolution === "manual" || r.resolution === "resolved" ? r.resolution : null,
            goneAt: r.goneAt,
          },
        ]
      : [],
  );
  const plan = planFindingObservations(
    stored,
    observed.filter((o) => opts.scannedKinds.has(o.kind)),
    opts.scannedKinds,
    opts.concludeAbsence,
  );

  // Insert what is new and refresh what was seen, in one upsert per chunk:
  // a concurrent writer that inserted first turns our insert into a refresh.
  const refresh = opts.refreshSnapshots !== false;
  const upserts = refresh ? [...plan.fresh, ...plan.seen] : plan.fresh;
  for (let i = 0; i < upserts.length; i += 500) {
    const insert = db.insert(savingsFindingStates).values(
      upserts.slice(i, i + 500).map((o) => ({
        organizationId,
        sourceKind: o.kind,
        sourceId: o.sourceId,
        firstSeenAt: now,
        lastSeenAt: now,
        alertPending: true,
        ...snapshotColumns(o),
      })),
    );
    if (!refresh) {
      await insert.onConflictDoNothing();
      continue;
    }
    await insert.onConflictDoUpdate({
      target: [
        savingsFindingStates.organizationId,
        savingsFindingStates.sourceKind,
        savingsFindingStates.sourceId,
      ],
      set: {
        lastSeenAt: now,
        title: sql`excluded.title`,
        detail: sql`excluded.detail`,
        pluginId: sql`excluded.plugin_id`,
        pluginName: sql`excluded.plugin_name`,
        accountId: sql`excluded.account_id`,
        accountName: sql`excluded.account_name`,
        region: sql`excluded.region`,
        resourceId: sql`excluded.resource_id`,
        resourceName: sql`excluded.resource_name`,
        resourceTypeId: sql`excluded.resource_type_id`,
        resourceTypeName: sql`excluded.resource_type_name`,
        tags: sql`excluded.tags`,
        monthlyAmount: sql`excluded.monthly_amount`,
        currency: sql`excluded.currency`,
      },
    });
  }

  const reopened = new Set(plan.reopened.map((o) => pairKey(o.kind, o.sourceId)));
  for (const o of plan.returned) {
    const reopen = reopened.has(pairKey(o.kind, o.sourceId));
    await db
      .update(savingsFindingStates)
      .set({
        goneAt: null,
        ...(reopen
          ? {
              status: "ready",
              statusChangedAt: now,
              statusChangedByUserId: null,
              statusNote: null,
              resolution: null,
              firstSeenAt: now,
              alertPending: true,
            }
          : {}),
      })
      .where(
        and(
          eq(savingsFindingStates.organizationId, organizationId),
          eq(savingsFindingStates.sourceKind, o.kind),
          eq(savingsFindingStates.sourceId, o.sourceId),
          // Guard against a person reopening it in between.
          ...(reopen ? [eq(savingsFindingStates.status, "completed")] : []),
        ),
      );
  }

  const resolved = new Set(plan.resolved.map((s) => pairKey(s.kind, s.sourceId)));
  for (const kind of kinds) {
    const goneIds = plan.gone.filter((g) => g.kind === kind).map((g) => g.sourceId);
    for (let i = 0; i < goneIds.length; i += 500) {
      const chunk = goneIds.slice(i, i + 500);
      await db
        .update(savingsFindingStates)
        .set({ goneAt: now, alertPending: false })
        .where(
          and(
            eq(savingsFindingStates.organizationId, organizationId),
            eq(savingsFindingStates.sourceKind, kind),
            inArray(savingsFindingStates.sourceId, chunk),
          ),
        );
      const toResolve = chunk.filter((id) => resolved.has(pairKey(kind, id)));
      if (toResolve.length === 0) continue;
      await db
        .update(savingsFindingStates)
        .set({
          status: "completed",
          resolution: "resolved",
          statusChangedAt: now,
          statusChangedByUserId: null,
          statusNote: null,
        })
        .where(
          and(
            eq(savingsFindingStates.organizationId, organizationId),
            eq(savingsFindingStates.sourceKind, kind),
            inArray(savingsFindingStates.sourceId, toResolve),
            inArray(savingsFindingStates.status, ["ready", "in_progress"]),
          ),
        );
    }
  }

  if (plan.transitions.length > 0) {
    await publishTransitions(organizationId, plan.transitions, null, null, opts.url ?? null, now);
  }
  return plan;
}

/** Mark findings raised (or baselined): their alert is no longer pending. */
export async function clearFindingAlertPending(
  organizationId: string,
  findings: readonly { kind: SavingsFindingKind; sourceId: string }[],
): Promise<void> {
  const byKind = new Map<SavingsFindingKind, string[]>();
  for (const f of findings) byKind.set(f.kind, [...(byKind.get(f.kind) ?? []), f.sourceId]);
  for (const [kind, ids] of byKind) {
    for (let i = 0; i < ids.length; i += 500) {
      await db
        .update(savingsFindingStates)
        .set({ alertPending: false })
        .where(
          and(
            eq(savingsFindingStates.organizationId, organizationId),
            eq(savingsFindingStates.sourceKind, kind),
            inArray(savingsFindingStates.sourceId, ids.slice(i, i + 500)),
          ),
        );
    }
  }
}

/** Every recorded finding whose alert is pending, for the given kinds. */
export async function listAlertPendingFindings(
  organizationId: string,
  kinds: readonly SavingsFindingKind[],
): Promise<{ kind: SavingsFindingKind; sourceId: string }[]> {
  if (kinds.length === 0) return [];
  const rows = await db
    .select({ kind: savingsFindingStates.sourceKind, sourceId: savingsFindingStates.sourceId })
    .from(savingsFindingStates)
    .where(
      and(
        eq(savingsFindingStates.organizationId, organizationId),
        eq(savingsFindingStates.alertPending, true),
        isNull(savingsFindingStates.goneAt),
        inArray(savingsFindingStates.sourceKind, [...kinds]),
      ),
    );
  return rows.flatMap((r) =>
    isSavingsFindingKind(r.kind) ? [{ kind: r.kind, sourceId: r.sourceId }] : [],
  );
}

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

const REALIZED_KIND: Partial<Record<SavingsFindingKind, string>> = {
  orphan: "orphan_deletion",
  oversized: "rightsizing",
};

function toFinding(
  row: StateRow,
  names: Map<string, string | null>,
  realized: Map<string, { eventId: string; title: string }>,
): SavingsFinding | null {
  if (!isSavingsFindingKind(row.sourceKind) || !isSavingsFindingStatus(row.status)) return null;
  const changedBy = row.statusChangedByUserId;
  return {
    key: savingsFindingKey(row.sourceKind, row.sourceId),
    kind: row.sourceKind,
    sourceId: row.sourceId,
    title: row.title || row.resourceName || row.sourceId,
    detail: row.detail,
    pluginId: row.pluginId,
    pluginName: row.pluginName,
    accountId: row.accountId,
    accountName: row.accountName,
    region: row.region,
    resourceId: row.resourceId,
    resourceName: row.resourceName || row.sourceId,
    resourceTypeId: row.resourceTypeId,
    resourceTypeName: row.resourceTypeName,
    tags: row.tags ?? {},
    monthlySavings:
      row.monthlyAmount !== null && row.currency
        ? { amount: row.monthlyAmount, currency: row.currency }
        : null,
    status: row.status,
    statusChangedAt: row.statusChangedAt?.toISOString() ?? null,
    statusChangedBy: changedBy ? { userId: changedBy, name: names.get(changedBy) ?? null } : null,
    statusNote: row.statusNote,
    resolution:
      row.resolution === "manual" || row.resolution === "resolved" ? row.resolution : null,
    detectedAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    present: row.goneAt === null,
    realizedSavings: realized.get(pairKey(row.sourceKind, row.sourceId)) ?? null,
  };
}

async function userNames(ids: readonly string[]): Promise<Map<string, string | null>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({ id: users.id, name: users.displayName, email: users.email })
    .from(users)
    .where(inArray(users.id, unique));
  return new Map(rows.map((u) => [u.id, u.name || u.email || null]));
}

/**
 * The realized-savings entry recorded for each completed finding's fix: the
 * newest orphan deletion or rightsizing event on the same resource, on or
 * after the day the finding was detected. Seats and extended support are not
 * linked (their events carry no resource id, or do not exist yet).
 */
async function realizedLinks(
  organizationId: string,
  rows: readonly StateRow[],
): Promise<Map<string, { eventId: string; title: string }>> {
  const out = new Map<string, { eventId: string; title: string }>();
  const candidates = rows.filter(
    (r) =>
      r.status === "completed" && r.resourceId && REALIZED_KIND[r.sourceKind as SavingsFindingKind],
  );
  if (candidates.length === 0) return out;
  const oldest = candidates.reduce(
    (min, r) => (r.firstSeenAt < min ? r.firstSeenAt : min),
    candidates[0]!.firstSeenAt,
  );
  const ids = [...new Set(candidates.map((r) => r.resourceId!))];
  for (let i = 0; i < ids.length; i += 500) {
    const events = await db
      .select({
        id: savingsEvents.id,
        kind: savingsEvents.kind,
        resourceId: savingsEvents.resourceId,
        title: savingsEvents.title,
        occurredOn: savingsEvents.occurredOn,
      })
      .from(savingsEvents)
      .where(
        and(
          eq(savingsEvents.organizationId, organizationId),
          inArray(savingsEvents.resourceId, ids.slice(i, i + 500)),
          inArray(savingsEvents.kind, ["orphan_deletion", "rightsizing"]),
          gte(savingsEvents.occurredOn, oldest.toISOString().slice(0, 10)),
        ),
      )
      .orderBy(desc(savingsEvents.occurredOn));
    for (const r of candidates) {
      const kind = REALIZED_KIND[r.sourceKind as SavingsFindingKind];
      const detected = r.firstSeenAt.toISOString().slice(0, 10);
      const match = events.find(
        (e) => e.resourceId === r.resourceId && e.kind === kind && String(e.occurredOn) >= detected,
      );
      const k = pairKey(r.sourceKind, r.sourceId);
      if (match && !out.has(k)) out.set(k, { eventId: match.id, title: match.title });
    }
  }
  return out;
}

/**
 * Every recorded finding of the org, newest snapshot, with actor names and
 * realized-savings links. `visibleAccountIds` (the caller's strict account
 * grant, null for unrestricted) narrows it: a finding carries money and is
 * per account, the credits and realized savings rule.
 */
export async function listRecordedFindings(
  organizationId: string,
  visibleAccountIds: ReadonlySet<string> | null,
): Promise<SavingsFinding[]> {
  const rows = (
    await db
      .select()
      .from(savingsFindingStates)
      .where(eq(savingsFindingStates.organizationId, organizationId))
  ).filter(
    (r) => !visibleAccountIds || (r.accountId !== null && visibleAccountIds.has(r.accountId)),
  );
  const [names, realized] = await Promise.all([
    userNames(rows.flatMap((r) => (r.statusChangedByUserId ? [r.statusChangedByUserId] : []))),
    realizedLinks(organizationId, rows),
  ]);
  return rows.flatMap((r) => {
    const f = toFinding(r, names, realized);
    return f ? [f] : [];
  });
}

/* ------------------------------------------------------------------ *
 * Status changes
 * ------------------------------------------------------------------ */

export interface SetFindingStatusResult {
  updated: SavingsFindingStatusChange[];
  missing: string[];
  /** What each updated finding was before, for the audit log and events. */
  previous: Map<string, SavingsFindingStatus>;
  findings: Map<string, SavingsFinding>;
}

/**
 * Move findings to `status` by hand. Completed gets `resolution: "manual"`;
 * every other status clears the resolution. Keys the caller cannot see (no row,
 * or an account outside their strict grant) come back as `missing`.
 */
export async function setFindingStatus(
  organizationId: string,
  input: { keys: readonly string[]; status: SavingsFindingStatus; note: string | null },
  actor: { userId: string | null },
  visibleAccountIds: ReadonlySet<string> | null,
  opts: { now?: Date; url?: string | null } = {},
): Promise<SetFindingStatusResult> {
  const now = opts.now ?? new Date();
  const parsed = input.keys.flatMap((key) => {
    const p = parseSavingsFindingKey(key);
    return p ? [{ key, ...p }] : [];
  });
  const rows =
    parsed.length === 0
      ? []
      : await db
          .select()
          .from(savingsFindingStates)
          .where(
            and(
              eq(savingsFindingStates.organizationId, organizationId),
              or(
                ...parsed.map((p) =>
                  and(
                    eq(savingsFindingStates.sourceKind, p.kind),
                    eq(savingsFindingStates.sourceId, p.sourceId),
                  ),
                ),
              ),
            ),
          );
  const found = new Map(
    rows
      .filter(
        (r) => !visibleAccountIds || (r.accountId !== null && visibleAccountIds.has(r.accountId)),
      )
      .map((r) => [pairKey(r.sourceKind, r.sourceId), r]),
  );
  const missing: string[] = [];
  const targets: StateRow[] = [];
  for (const p of parsed) {
    const row = found.get(pairKey(p.kind, p.sourceId));
    if (row) targets.push(row);
    else missing.push(p.key);
  }
  for (const key of input.keys) {
    if (!parseSavingsFindingKey(key)) missing.push(key);
  }

  const resolution: SavingsFindingResolution | null =
    input.status === "completed" ? "manual" : null;
  const previous = new Map<string, SavingsFindingStatus>();
  for (const row of targets) {
    previous.set(
      savingsFindingKey(row.sourceKind as SavingsFindingKind, row.sourceId),
      row.status as SavingsFindingStatus,
    );
  }
  const byKind = new Map<string, string[]>();
  for (const row of targets)
    byKind.set(row.sourceKind, [...(byKind.get(row.sourceKind) ?? []), row.sourceId]);
  for (const [kind, ids] of byKind) {
    await db
      .update(savingsFindingStates)
      .set({
        status: input.status,
        statusChangedAt: now,
        statusChangedByUserId: actor.userId,
        statusNote: input.note,
        resolution,
      })
      .where(
        and(
          eq(savingsFindingStates.organizationId, organizationId),
          eq(savingsFindingStates.sourceKind, kind),
          inArray(savingsFindingStates.sourceId, ids),
        ),
      );
  }

  const names = await userNames(actor.userId ? [actor.userId] : []);
  const changedBy = actor.userId
    ? { userId: actor.userId, name: names.get(actor.userId) ?? null }
    : null;
  const updated: SavingsFindingStatusChange[] = targets.map((row) => ({
    key: savingsFindingKey(row.sourceKind as SavingsFindingKind, row.sourceId),
    status: input.status,
    statusChangedAt: now.toISOString(),
    statusChangedBy: changedBy,
    statusNote: input.note,
    resolution,
  }));
  const findings = new Map<string, SavingsFinding>();
  for (const row of targets) {
    const f = toFinding(
      {
        ...row,
        status: input.status,
        statusChangedAt: now,
        statusChangedByUserId: actor.userId,
        statusNote: input.note,
        resolution,
      },
      names,
      new Map(),
    );
    if (f) findings.set(f.key, f);
  }

  const transitions: FindingStatusTransition[] = targets
    .filter((row) => row.status !== input.status)
    .map((row) => ({
      kind: row.sourceKind as SavingsFindingKind,
      sourceId: row.sourceId,
      previousStatus: row.status as SavingsFindingStatus,
      status: input.status,
      resolution,
    }));
  if (transitions.length > 0) {
    await publishTransitions(
      organizationId,
      transitions,
      actor.userId,
      input.note,
      opts.url ?? null,
      now,
    );
  }
  return { updated, missing, previous, findings };
}

/** Publish `savings.finding.status_changed` for each transition. Never throws. */
async function publishTransitions(
  organizationId: string,
  transitions: readonly FindingStatusTransition[],
  changedByUserId: string | null,
  note: string | null,
  url: string | null,
  now: Date,
): Promise<void> {
  try {
    const rows = await db
      .select()
      .from(savingsFindingStates)
      .where(
        and(
          eq(savingsFindingStates.organizationId, organizationId),
          or(
            ...transitions.map((t) =>
              and(
                eq(savingsFindingStates.sourceKind, t.kind),
                eq(savingsFindingStates.sourceId, t.sourceId),
              ),
            ),
          ),
        ),
      );
    const byKey = new Map(rows.map((r) => [pairKey(r.sourceKind, r.sourceId), r]));
    for (const t of transitions) {
      const row = byKey.get(pairKey(t.kind, t.sourceId));
      if (!row) continue;
      const key = savingsFindingKey(t.kind, t.sourceId);
      await publishEvent(
        SAVINGS_FINDING_STATUS_CHANGED,
        organizationId,
        {
          key,
          kind: t.kind,
          title: row.title || row.resourceName || t.sourceId,
          resourceName: row.resourceName || t.sourceId,
          resourceId: row.resourceId,
          pluginId: row.pluginId,
          previousStatus: t.previousStatus,
          status: t.status,
          resolution: t.resolution,
          changedByUserId,
          note,
          monthlySavings: row.monthlyAmount,
          currency: row.currency,
          detectedAt: row.firstSeenAt.toISOString(),
        },
        {
          title: `${row.title || row.resourceName}: ${t.status.replace("_", " ")}`,
          accountId: row.accountId,
          url,
          idempotencyKey: `savings-finding:${key}:${t.status}:${now.toISOString()}`,
          occurredAt: now,
        },
      );
    }
  } catch (err) {
    console.warn("[savings-findings] publishing status events failed:", err);
  }
}
