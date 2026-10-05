/**
 * Where savings events come from: the moments an action that saves money
 * actually happens, plus the inventory diff that catches the same actions
 * taken outside Infrawrench.
 *
 * Every function here is **best-effort and never throws**. The action it
 * describes (a resize, a delete, a schedule) has already happened and must
 * succeed whether or not its saving could be recorded; a failure is logged and
 * the action goes on. The cost of a missed event is a saving nobody gets
 * credit for, which a person can log by hand; the cost of a throw here would
 * be a failed delete.
 *
 * Projections are taken at the moment of the action, from the same sources the
 * finders quote: the provider's size catalogue for a resize (what the
 * Oversized section showed), trailing billing or the price-table estimate for
 * a deletion (what Potential savings showed), the schedule quote for a sleep
 * schedule. The realized figure is computed later, from billing, against a
 * baseline read on that day.
 */
import { and, eq } from "drizzle-orm";
import {
  AVERAGE_DAYS_PER_MONTH,
  extractRecordTags,
  projectedMonthlySaving,
  weeklyOffFraction,
} from "@infrawrench/client-core";
import {
  evaluateOrphanRule,
  type PluginClient,
  type ResourceInstance,
  type ResourceTypeDefinition,
  type SizeOption,
} from "@infrawrench/plugin-base";

import { queryCosts } from "../clickhouse/cost-readers";
import { addDays, isoDay } from "../cost/dates";
import { db } from "../db/client";
import { resources } from "../db/schema";
import { getOrgAccountClient } from "../org-accounts";
import { getPlugin } from "../plugin-loader";
import type { PriorResourceSnapshot, ResourceChangeEvent } from "../resource-changes";
import type { ScheduleRecord } from "../schedules/store";
import { endOpenScheduleSavings, recordSavingsEvent, resumeScheduleSaving } from "./events";

/** Trailing days of billing a deletion's projection is quoted from. */
export const DELETION_COST_WINDOW_DAYS = 30;

type Fields = Record<string, string | number | boolean>;

interface AccountCtx {
  client: PluginClient;
  plugin: { resourceTypes: ResourceTypeDefinition[] };
}

function asFields(raw: unknown): Fields {
  if (!raw || typeof raw !== "object") return {};
  const out: Fields = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = v;
  }
  return out;
}

function warn(what: string, err: unknown): void {
  console.warn(`[savings] ${what}:`, err instanceof Error ? err.message : err);
}

async function loadCtx(accountId: string, organizationId: string): Promise<AccountCtx | null> {
  try {
    const ctx = await getOrgAccountClient(accountId, organizationId);
    return ctx ? { client: ctx.client, plugin: ctx.plugin } : null;
  } catch (err) {
    warn(`loading account ${accountId}`, err);
    return null;
  }
}

async function loadResourceRow(organizationId: string, resourceId: string) {
  const [row] = await db
    .select({
      id: resources.id,
      accountId: resources.accountId,
      pluginId: resources.pluginId,
      resourceTypeId: resources.resourceTypeId,
      externalId: resources.externalId,
      displayName: resources.displayName,
      fieldsJson: resources.fieldsJson,
    })
    .from(resources)
    .where(and(eq(resources.organizationId, organizationId), eq(resources.id, resourceId)))
    .limit(1);
  return row ?? null;
}

/**
 * The resource's trailing daily spend from billing, or null when billing holds
 * nothing for it (or holds it in more than one currency, which would make one
 * figure meaningless).
 */
async function trailingDailyCost(
  organizationId: string,
  accountId: string,
  externalId: string | null,
  today: string,
): Promise<{ perDay: number; currency: string } | null> {
  if (!externalId) return null;
  try {
    const groups = await queryCosts(organizationId, {
      from: addDays(today, -DELETION_COST_WINDOW_DAYS),
      to: addDays(today, -1),
      binning: "daily",
      groupBy: "resource",
      filters: [
        { dimension: "resource", op: "in", values: [externalId] },
        { dimension: "account", op: "in", values: [accountId] },
      ],
    });
    if (groups.length !== 1) return null;
    const total = groups[0]!.points.reduce((sum, p) => sum + p.amount, 0);
    if (total <= 0) return null;
    return { perDay: total / DELETION_COST_WINDOW_DAYS, currency: groups[0]!.currency };
  } catch (err) {
    warn(`trailing cost for ${externalId}`, err);
    return null;
  }
}

/** The price-table monthly estimate for a configuration, or null. */
async function estimateMonthly(
  ctx: AccountCtx | null,
  resourceTypeId: string,
  fields: Fields,
): Promise<{ monthly: number; currency: string } | null> {
  if (!ctx?.client.estimateCost) return null;
  try {
    const stringFields: Record<string, string> = {};
    for (const [k, v] of Object.entries(fields)) stringFields[k] = String(v);
    const estimate = await ctx.client.estimateCost(resourceTypeId, stringFields);
    return estimate ? { monthly: estimate.monthlyAmount, currency: estimate.currency } : null;
  } catch (err) {
    warn(`estimate for ${resourceTypeId}`, err);
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Right-sizing
 * ------------------------------------------------------------------ */

/** The size catalogue with live prices overlaid: what the Oversized section priced against. */
async function pricedSizes(
  ctx: AccountCtx,
  typeDef: ResourceTypeDefinition,
  fields: Fields,
): Promise<SizeOption[] | null> {
  const declaration = typeDef.rightsizing;
  if (!declaration || !ctx.client.getCreateConfig) return null;
  const config = await ctx.client.getCreateConfig(typeDef.id);
  const fieldKey = declaration.createSizeFieldKey ?? declaration.sizeFieldKey;
  const sizes = config.fields.find((f) => f.key === fieldKey && f.kind === "size-picker")?.sizes;
  if (!sizes || sizes.length === 0) return null;
  const region = declaration.regionFieldKey ? String(fields[declaration.regionFieldKey] ?? "") : "";
  const overlay = ctx.client.getCreateSizePricing
    ? await ctx.client
        .getCreateSizePricing(typeDef.id, {
          ...(region ? { regionId: region } : {}),
          sizes: sizes.map((s) => ({ id: s.id, vcpus: s.vcpus, memoryMb: s.memoryMb })),
        })
        .catch(() => ({}) as Record<string, number>)
    : {};
  return sizes.map((s) => {
    const price = (overlay as Record<string, number | undefined>)[s.id] ?? s.priceMonthly;
    return price === undefined ? s : { ...s, priceMonthly: price };
  });
}

export interface ResizeCapture {
  organizationId: string;
  accountId: string;
  resourceId: string;
  resourceTypeId: string;
  pluginId: string;
  source: "in_app" | "detected";
  priorFields: unknown;
  nextFields: unknown;
  displayName: string;
  externalId?: string | null;
  userId?: string | null;
  /** Reused when the caller already holds one (the sync pass does). */
  ctx?: AccountCtx | null;
  now?: Date;
}

/**
 * A resize of a right-sizing-declared type to a smaller size is a saving.
 * An upsize, or a resize between sizes we cannot order, is not recorded.
 */
export async function captureResizeSaving(input: ResizeCapture): Promise<void> {
  try {
    const ctx = input.ctx ?? (await loadCtx(input.accountId, input.organizationId));
    if (!ctx) return;
    const typeDef = ctx.plugin.resourceTypes.find((t) => t.id === input.resourceTypeId);
    const declaration = typeDef?.rightsizing;
    if (!typeDef || !declaration) return;

    const prior = asFields(input.priorFields);
    const next = asFields(input.nextFields);
    const sizeOf = (f: Fields) =>
      String(
        f[declaration.sizeFieldKey] ??
          (declaration.createSizeFieldKey ? f[declaration.createSizeFieldKey] : "") ??
          "",
      );
    const before = sizeOf(prior);
    const after = sizeOf(next);
    if (!before || !after || before === after) return;

    const sizes = await pricedSizes(ctx, typeDef, { ...prior, ...next }).catch((err) => {
      warn(`size catalogue for ${typeDef.id}`, err);
      return null;
    });
    const from = sizes?.find((s) => s.id === before);
    const to = sizes?.find((s) => s.id === after);
    const priced =
      from?.priceMonthly !== undefined && to?.priceMonthly !== undefined
        ? { before: from.priceMonthly, after: to.priceMonthly }
        : null;

    if (priced) {
      if (priced.after >= priced.before) return;
    } else {
      // Unpriced: only a resize that shrinks one axis without growing the
      // other is a downsize we are sure of. Anything else is not recorded.
      if (!from || !to) return;
      const shrinks =
        to.vcpus <= from.vcpus &&
        to.memoryMb <= from.memoryMb &&
        (to.vcpus < from.vcpus || to.memoryMb < from.memoryMb);
      if (!shrinks) return;
    }

    const today = isoDay(input.now ?? new Date());
    const row =
      input.externalId === undefined
        ? await loadResourceRow(input.organizationId, input.resourceId)
        : null;
    await recordSavingsEvent({
      organizationId: input.organizationId,
      kind: "rightsizing",
      source: input.source,
      title: `Resized ${input.displayName} from ${from?.label ?? before} to ${to?.label ?? after}`,
      occurredOn: today,
      accountId: input.accountId,
      pluginId: input.pluginId,
      resourceTypeId: input.resourceTypeId,
      resourceId: input.resourceId,
      externalId: input.externalId ?? row?.externalId ?? null,
      resourceName: input.displayName,
      tags: extractRecordTags({ ...prior, ...next }),
      projectedMonthlyAmount: priced ? priced.before - priced.after : null,
      currency: priced ? (declaration.priceCurrency ?? "USD") : null,
      baselineDailyEstimate: priced ? priced.before / AVERAGE_DAYS_PER_MONTH : null,
      postDailyEstimate: priced ? priced.after / AVERAGE_DAYS_PER_MONTH : null,
      dedupeKey: `rightsizing:${input.resourceId}:${after}:${today}`,
      createdByUserId: input.userId ?? null,
    });
  } catch (err) {
    warn(`recording resize of ${input.resourceId}`, err);
  }
}

/* ------------------------------------------------------------------ *
 * Orphan / idle deletions
 * ------------------------------------------------------------------ */

export interface DeletionCapture {
  organizationId: string;
  accountId: string;
  resourceId: string;
  resourceTypeId: string;
  pluginId: string;
  source: "in_app" | "detected";
  /** Fields as they were before the delete; read from the stored row when omitted. */
  fields?: unknown;
  displayName?: string;
  userId?: string | null;
  ctx?: AccountCtx | null;
  now?: Date;
}

/**
 * Deleting a resource the orphan finder would have flagged is a saving worth
 * all of what it cost. A deletion of anything else is not recorded: removing
 * something in use is a change, not an optimization, and counting it would
 * credit teardown as savings.
 */
export async function captureDeletionSaving(input: DeletionCapture): Promise<void> {
  try {
    const loaded = await getPlugin(input.pluginId);
    const typeDef = loaded?.plugin.resourceTypes.find((t) => t.id === input.resourceTypeId);
    if (!typeDef?.orphanRule) return;

    const row = await loadResourceRow(input.organizationId, input.resourceId);
    const fields = asFields(input.fields ?? row?.fieldsJson);
    const reason = evaluateOrphanRule(typeDef.orphanRule, fields);
    if (!reason) return;

    const today = isoDay(input.now ?? new Date());
    const externalId = row?.externalId ?? null;
    const billed = await trailingDailyCost(
      input.organizationId,
      input.accountId,
      externalId,
      today,
    );
    const estimated = billed
      ? null
      : await estimateMonthly(
          input.ctx ?? (await loadCtx(input.accountId, input.organizationId)),
          input.resourceTypeId,
          fields,
        );
    const perDay =
      billed?.perDay ?? (estimated ? estimated.monthly / AVERAGE_DAYS_PER_MONTH : null);
    const currency = billed?.currency ?? estimated?.currency ?? null;
    const name = input.displayName ?? row?.displayName ?? input.resourceId;

    await recordSavingsEvent({
      organizationId: input.organizationId,
      kind: "orphan_deletion",
      source: input.source,
      title: `Deleted ${name}`,
      note: reason,
      occurredOn: today,
      accountId: input.accountId,
      pluginId: input.pluginId,
      resourceTypeId: input.resourceTypeId,
      resourceId: input.resourceId,
      externalId,
      resourceName: name,
      tags: extractRecordTags(fields),
      projectedMonthlyAmount: perDay === null ? null : perDay * AVERAGE_DAYS_PER_MONTH,
      currency,
      baselineDailyEstimate: perDay,
      postDailyEstimate: perDay === null ? null : 0,
      dedupeKey: `orphan_deletion:${input.resourceId}`,
      createdByUserId: input.userId ?? null,
    });
  } catch (err) {
    warn(`recording deletion of ${input.resourceId}`, err);
  }
}

/* ------------------------------------------------------------------ *
 * Sleep schedules
 * ------------------------------------------------------------------ */

/**
 * A schedule in force is a recurring saving: one event per stretch it runs
 * unchanged. Pausing, retiming or deleting it ends the open stretch (see
 * {@link endScheduleSaving}); resuming or retiming opens a new one with the
 * new off fraction, so a stretch's estimate always describes the timing that
 * was actually in force.
 */
export async function captureScheduleSaving(
  schedule: ScheduleRecord,
  userId?: string | null,
  now = new Date(),
): Promise<void> {
  try {
    if (schedule.paused) return;
    const row = await loadResourceRow(schedule.organizationId, schedule.resourceId);
    if (!row) return;
    const today = isoDay(now);
    const offFraction = weeklyOffFraction({
      daysOfWeek: schedule.daysOfWeek,
      stopTime: schedule.stopTime,
      startTime: schedule.startTime,
      timezone: schedule.timezone,
    });
    if (offFraction <= 0) return;
    const resumed = await resumeScheduleSaving(
      schedule.organizationId,
      schedule.id,
      offFraction,
      addDays(today, -1),
    );
    if (resumed !== "none") return;
    const fields = asFields(row.fieldsJson);
    const billed = await trailingDailyCost(
      schedule.organizationId,
      schedule.accountId,
      row.externalId,
      today,
    );
    const estimated = billed
      ? null
      : await estimateMonthly(
          await loadCtx(schedule.accountId, schedule.organizationId),
          schedule.resourceTypeId,
          fields,
        );
    const perDay =
      billed?.perDay ?? (estimated ? estimated.monthly / AVERAGE_DAYS_PER_MONTH : null);
    const currency = billed?.currency ?? estimated?.currency ?? null;

    await recordSavingsEvent({
      organizationId: schedule.organizationId,
      kind: "sleep_schedule",
      source: "in_app",
      title: `Sleep schedule on ${row.displayName}`,
      occurredOn: today,
      accountId: schedule.accountId,
      pluginId: schedule.pluginId,
      resourceTypeId: schedule.resourceTypeId,
      resourceId: schedule.resourceId,
      externalId: row.externalId,
      resourceName: row.displayName,
      tags: extractRecordTags(fields),
      projectedMonthlyAmount:
        perDay === null
          ? null
          : projectedMonthlySaving(
              perDay * DELETION_COST_WINDOW_DAYS,
              DELETION_COST_WINDOW_DAYS,
              offFraction,
            ),
      currency,
      baselineDailyEstimate: perDay,
      offFraction,
      scheduleId: schedule.id,
      createdByUserId: userId ?? null,
    });
  } catch (err) {
    warn(`recording schedule ${schedule.id}`, err);
  }
}

/** End the open stretch for a schedule. Never throws. */
export async function endScheduleSaving(
  organizationId: string,
  scheduleId: string,
  now = new Date(),
): Promise<void> {
  try {
    await endOpenScheduleSavings(organizationId, scheduleId, isoDay(now));
  } catch (err) {
    warn(`ending schedule ${scheduleId}`, err);
  }
}

/* ------------------------------------------------------------------ *
 * Out-of-band changes, from the inventory diff
 * ------------------------------------------------------------------ */

/**
 * Savings someone made in the provider's own console, caught by the sync
 * pass's change timeline: a right-sizing type whose size field moved down, or
 * an orphan-flagged resource that disappeared.
 *
 * The in-app paths record the same actions first with the same dedupe keys,
 * so an action taken in Infrawrench and then observed on sync is one saving.
 * An in-app resize also writes the new fields to the stored row, so the sync
 * sees no diff at all; an in-app delete does not, and its key is what keeps
 * the sync's "deleted" event from counting twice.
 */
export async function captureSavingsFromChanges(args: {
  organizationId: string;
  accountId: string;
  ctx: AccountCtx;
  prior: PriorResourceSnapshot[];
  fetched: ResourceInstance[];
  events: ResourceChangeEvent[];
}): Promise<void> {
  const relevant = args.events.filter(
    (e) => e.changeKind === "updated" || e.changeKind === "deleted",
  );
  if (relevant.length === 0) return;
  const priorById = new Map(args.prior.map((p) => [p.id, p]));
  const fetchedById = new Map(args.fetched.map((f) => [f.id, f]));

  for (const event of relevant) {
    const typeDef = args.ctx.plugin.resourceTypes.find((t) => t.id === event.resourceTypeId);
    if (!typeDef) continue;
    if (event.changeKind === "updated" && typeDef.rightsizing) {
      const sizeKey = typeDef.rightsizing.sizeFieldKey;
      if (!event.diff.some((d) => d.field === sizeKey)) continue;
      const fetched = fetchedById.get(event.resourceId);
      await captureResizeSaving({
        organizationId: args.organizationId,
        accountId: args.accountId,
        resourceId: event.resourceId,
        resourceTypeId: event.resourceTypeId,
        pluginId: event.pluginId,
        source: "detected",
        priorFields: priorById.get(event.resourceId)?.fieldsJson,
        nextFields: fetched?.fields,
        displayName: event.displayName,
        externalId: fetched?.externalId ?? null,
        ctx: args.ctx,
      });
    } else if (event.changeKind === "deleted" && typeDef.orphanRule) {
      await captureDeletionSaving({
        organizationId: args.organizationId,
        accountId: args.accountId,
        resourceId: event.resourceId,
        resourceTypeId: event.resourceTypeId,
        pluginId: event.pluginId,
        source: "detected",
        fields: priorById.get(event.resourceId)?.fieldsJson,
        displayName: event.displayName,
        ctx: args.ctx,
      });
    }
  }
}
