/**
 * Assemble the operations calendar from everything the org already stores.
 *
 * Six sources, each a plain read: change freezes, sleep/wake schedules, the
 * expiry feed (which already merges plugin-declared deadlines with resource
 * leases), commitment term ends, cron-triggered workflows, and declared
 * incidents. No provider API calls, no credentials — the orphan-finder stance.
 *
 * Every source is independently guarded. A calendar is a *summary* surface: if
 * the commitments read throws because an account is half-migrated, the right
 * answer is a month view missing its commitment chips and a named degradation,
 * not an empty page. `failedKinds` carries that out to the UI rather than
 * hiding it, the same call `CostsPanel` makes with its four independent
 * sections.
 */
import { and, eq, gte, isNull, lte, or, isNotNull } from "drizzle-orm";
import {
  CALENDAR_EVENT_KINDS,
  CALENDAR_MAX_OCCURRENCES_PER_SOURCE,
  compareCalendarEvents,
  computeUpcomingTransitions,
  nextCronOccurrences,
  overlapsWindow,
  pairSleepWindows,
  validateCronExpression,
  type CalendarEvent,
  type CalendarEventKind,
  type CalendarResponse,
  type TimeWindow,
} from "@infrawrench/client-core";

import { db } from "../db/client";
import {
  accountCommitments,
  accounts,
  changeFreezes,
  incidents,
  resourceSchedules,
  resources,
  workflows,
} from "../db/schema";
import { listExpiring } from "../expiry/feed";

export interface ListCalendarOptions {
  /** Inclusive lower bound, epoch ms. */
  from: number;
  /** Exclusive upper bound, epoch ms. */
  to: number;
  /** Kinds to include; empty or omitted means every kind. */
  kinds?: CalendarEventKind[];
  /** Scan instant; defaults to `Date.now()`. Fixed in tests. */
  now?: number;
}

/**
 * Alias rather than an extension: the wire shape is `CalendarResponse`, and the
 * one place a second name would be tempting — `failedKinds` — belongs on the
 * wire type, because every surface has to render the degradation.
 */
export type CalendarFeedResult = CalendarResponse;

/**
 * What an open-ended span means to the overlap test.
 *
 * `overlapsWindow` reads a null end as *a point in time* — which is right for a
 * deadline and exactly wrong for a freeze held until further notice. The two
 * readings are both needed, so the span sources say which one they mean here
 * rather than leaving it to the shape of the value.
 */
const RUNS_FOREVER = Number.POSITIVE_INFINITY;

/** ISO 8601 for a Date or epoch ms, with no assumption about which we hold. */
function iso(value: Date | number): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

/**
 * Clamp a span to the requested window for *rendering* purposes.
 *
 * A freeze that started in March and has no end must draw across the whole of
 * the month being viewed; sending its real start would make every consumer
 * clamp it themselves, and sending nothing would lose it. So the event carries
 * the true `startsAt` when it falls inside the window and the window's own edge
 * when it does not — with `openEnded` set, which is what tells a renderer the
 * bar continues past the edge rather than stopping there.
 */
function clampSpan(
  start: number,
  end: number | null,
  window: TimeWindow,
): { startsAt: string; endsAt: string | null; openEnded: boolean } {
  const startsBefore = start < window.from;
  const endsAfter = end === null || end > window.to;
  return {
    startsAt: iso(startsBefore ? window.from : start),
    endsAt: end === null ? null : iso(endsAfter ? window.to : end),
    openEnded: end === null || startsBefore || endsAfter,
  };
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

async function freezeEvents(organizationId: string, window: TimeWindow): Promise<CalendarEvent[]> {
  const rows = await db
    .select()
    .from(changeFreezes)
    .where(
      and(
        eq(changeFreezes.organizationId, organizationId),
        // A freeze that ended before the window opened cannot appear in it. An
        // open-ended one (`ends_at IS NULL`) always can, which is exactly the
        // freeze somebody forgot to lift.
        or(isNull(changeFreezes.endsAt), gte(changeFreezes.endsAt, new Date(window.from))),
        lte(changeFreezes.startsAt, new Date(window.to)),
      ),
    );

  const events: CalendarEvent[] = [];
  for (const row of rows) {
    const start = row.startsAt.getTime();
    // An inactive freeze that was ended early stopped at `updatedAt`, not at
    // its declared end: showing the declared end would draw a week of frozen
    // calendar that never happened.
    const end = row.active ? (row.endsAt?.getTime() ?? null) : row.updatedAt.getTime();
    if (!overlapsWindow(start, end ?? RUNS_FOREVER, window)) continue;
    const span = clampSpan(start, end, window);
    events.push({
      id: `change-freeze:${row.id}`,
      kind: "change-freeze",
      title: row.name,
      detail:
        row.reason ??
        (row.active && row.endsAt === null ? "Open-ended — holds until someone ends it" : null),
      ...span,
      allDay: false,
      // A freeze in effect is the single most consequential thing on the
      // calendar: it is what makes a deploy 423 rather than ship.
      severity: row.active ? "warning" : "info",
      link: { target: "tab", tab: "settings" },
    });
  }
  return events;
}

async function sleepScheduleEvents(
  organizationId: string,
  window: TimeWindow,
): Promise<CalendarEvent[]> {
  const rows = await db
    .select({
      id: resourceSchedules.id,
      accountId: resourceSchedules.accountId,
      resourceId: resourceSchedules.resourceId,
      daysOfWeek: resourceSchedules.daysOfWeek,
      stopTime: resourceSchedules.stopTime,
      startTime: resourceSchedules.startTime,
      timezone: resourceSchedules.timezone,
      displayName: resources.displayName,
    })
    .from(resourceSchedules)
    .leftJoin(resources, eq(resources.id, resourceSchedules.resourceId))
    // A paused schedule stops nothing, so it belongs on no calendar. Deleted
    // resources fall out with the join's null name check below.
    .where(
      and(
        eq(resourceSchedules.organizationId, organizationId),
        eq(resourceSchedules.paused, false),
      ),
    );

  const events: CalendarEvent[] = [];
  for (const row of rows) {
    // Start the expansion one window's width before `from`, so a window that
    // opened yesterday evening and closes this morning still appears today.
    const transitions = computeUpcomingTransitions(
      {
        daysOfWeek: row.daysOfWeek,
        stopTime: row.stopTime,
        startTime: row.startTime,
        timezone: row.timezone,
      },
      { now: window.from - 86_400_000, count: CALENDAR_MAX_OCCURRENCES_PER_SOURCE },
    );
    const name = row.displayName ?? "a resource";
    for (const sleep of pairSleepWindows(transitions)) {
      const start = Date.parse(sleep.startsAt);
      const end = sleep.endsAt === null ? null : Date.parse(sleep.endsAt);
      if (!overlapsWindow(start, end ?? RUNS_FOREVER, window)) continue;
      events.push({
        // Keyed by the occurrence, not the row: every window is its own event
        // to a subscribed calendar client, and a shared UID would collapse a
        // month of nightly shutdowns into one.
        id: `sleep-schedule:${row.id}:${sleep.startsAt}`,
        kind: "sleep-schedule",
        title: `${name} asleep`,
        detail: `Stops ${row.stopTime}, starts ${row.startTime} (${row.timezone})`,
        ...clampSpan(start, end, window),
        allDay: false,
        severity: "info",
        link: { target: "resource", accountId: row.accountId, resourceId: row.resourceId },
      });
    }
  }
  return events;
}

async function expiryEvents(
  organizationId: string,
  window: TimeWindow,
  now: number,
): Promise<CalendarEvent[]> {
  const feed = await listExpiring(organizationId, { now });
  const accountRows = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.organizationId, organizationId), isNull(accounts.deletedAt)));
  const liveAccounts = new Set(accountRows.map((row) => row.id));

  const events: CalendarEvent[] = [];
  for (const item of feed.items) {
    const due = Date.parse(item.dueAt);
    if (Number.isNaN(due) || !overlapsWindow(due, null, window)) continue;
    events.push({
      id: `expiry:${item.resourceId}:${item.fieldKey}`,
      kind: "expiry",
      title: `${item.displayName} — ${item.label.toLowerCase()}`,
      detail: `${item.resourceTypeName} · ${item.pluginName} · ${item.accountName}`,
      startsAt: iso(due),
      endsAt: null,
      openEnded: false,
      // A deadline read off a date field is a day, not a moment: rendering it
      // at whatever midnight the provider happened to store reads as false
      // precision, and calendar clients would file it under a timed event.
      allDay: true,
      severity:
        item.severity === "expired" || item.severity === "critical"
          ? "critical"
          : item.severity === "warning"
            ? "warning"
            : "info",
      link: liveAccounts.has(item.accountId)
        ? { target: "resource", accountId: item.accountId, resourceId: item.resourceId }
        : { target: "tab", tab: "expiring" },
    });
  }
  return events;
}

async function commitmentEvents(
  organizationId: string,
  window: TimeWindow,
): Promise<CalendarEvent[]> {
  const rows = await db
    .select({
      id: accountCommitments.id,
      description: accountCommitments.description,
      kind: accountCommitments.kind,
      endDate: accountCommitments.endDate,
      state: accountCommitments.state,
      region: accountCommitments.region,
      accountName: accounts.displayName,
    })
    .from(accountCommitments)
    .leftJoin(accounts, eq(accounts.id, accountCommitments.accountId))
    .where(
      and(
        eq(accountCommitments.organizationId, organizationId),
        isNotNull(accountCommitments.endDate),
      ),
    );

  const events: CalendarEvent[] = [];
  for (const row of rows) {
    if (!row.endDate) continue;
    const end = row.endDate.getTime();
    if (!overlapsWindow(end, null, window)) continue;
    events.push({
      id: `commitment-expiry:${row.id}`,
      kind: "commitment-expiry",
      title: `${row.description} term ends`,
      detail: [row.kind.replace(/_/g, " "), row.region, row.accountName]
        .filter((part): part is string => Boolean(part))
        .join(" · "),
      startsAt: iso(end),
      endsAt: null,
      openEnded: false,
      allDay: true,
      // Lapsing onto on-demand pricing is a cost event, not an outage — but an
      // expensive one, and the whole reason the commitment-expiry alert exists.
      severity: row.state === "active" ? "warning" : "info",
      link: { target: "tab", tab: "costs" },
    });
  }
  return events;
}

async function workflowScheduleEvents(
  organizationId: string,
  window: TimeWindow,
): Promise<CalendarEvent[]> {
  const rows = await db
    .select({
      id: workflows.id,
      name: workflows.name,
      trigger: workflows.trigger,
    })
    .from(workflows)
    .where(
      and(
        eq(workflows.organizationId, organizationId),
        eq(workflows.enabled, true),
        isNull(workflows.deletedAt),
      ),
    );

  const events: CalendarEvent[] = [];
  for (const row of rows) {
    const trigger = row.trigger as { kind?: string; cron?: string; timezone?: string } | null;
    if (!trigger || trigger.kind !== "cron" || typeof trigger.cron !== "string") continue;
    // A stored expression can be invalid — it was valid when saved and the
    // parser has moved, or it arrived through config-as-code. Skip it rather
    // than throwing the whole calendar away for one bad row.
    if (validateCronExpression(trigger.cron) !== null) continue;
    const occurrences = nextCronOccurrences(trigger.cron, CALENDAR_MAX_OCCURRENCES_PER_SOURCE, {
      from: new Date(window.from),
      ...(trigger.timezone ? { timezone: trigger.timezone } : {}),
    });
    for (const occurrence of occurrences) {
      const at = occurrence.getTime();
      if (at >= window.to) break;
      if (!overlapsWindow(at, null, window)) continue;
      events.push({
        id: `workflow-schedule:${row.id}:${occurrence.toISOString()}`,
        kind: "workflow-schedule",
        title: `${row.name} runs`,
        detail: `Cron ${trigger.cron}${trigger.timezone ? ` (${trigger.timezone})` : ""}`,
        startsAt: iso(at),
        endsAt: null,
        openEnded: false,
        allDay: false,
        severity: "info",
        link: { target: "tab", tab: "workflows" },
      });
    }
  }
  return events;
}

async function incidentEvents(
  organizationId: string,
  window: TimeWindow,
): Promise<CalendarEvent[]> {
  const rows = await db
    .select()
    .from(incidents)
    .where(
      and(
        eq(incidents.organizationId, organizationId),
        lte(incidents.startedAt, new Date(window.to)),
      ),
    );

  const events: CalendarEvent[] = [];
  for (const row of rows) {
    const start = row.startedAt.getTime();
    const end = row.resolvedAt?.getTime() ?? null;
    if (!overlapsWindow(start, end ?? RUNS_FOREVER, window)) continue;
    events.push({
      id: `incident:${row.id}`,
      kind: "incident",
      title: `${row.severity.toUpperCase()} · ${row.title}`,
      detail: row.summary,
      ...clampSpan(start, end, window),
      allDay: false,
      severity: end === null ? "critical" : row.severity === "sev1" ? "warning" : "info",
      link: { target: "tab", tab: "incidents" },
    });
  }
  return events;
}

const SOURCES: Record<
  CalendarEventKind,
  (organizationId: string, window: TimeWindow, now: number) => Promise<CalendarEvent[]>
> = {
  "change-freeze": (org, window) => freezeEvents(org, window),
  "sleep-schedule": (org, window) => sleepScheduleEvents(org, window),
  expiry: (org, window, now) => expiryEvents(org, window, now),
  "commitment-expiry": (org, window) => commitmentEvents(org, window),
  "workflow-schedule": (org, window) => workflowScheduleEvents(org, window),
  incident: (org, window) => incidentEvents(org, window),
};

/**
 * Every dated thing the org holds, inside one window, soonest first.
 *
 * Sources run concurrently and are collected with `allSettled`: one that throws
 * costs its own kind, never the page.
 */
export async function listCalendarEvents(
  organizationId: string,
  options: ListCalendarOptions,
): Promise<CalendarFeedResult> {
  const now = options.now ?? Date.now();
  const window: TimeWindow = { from: options.from, to: options.to };
  const requested =
    options.kinds && options.kinds.length > 0 ? options.kinds : [...CALENDAR_EVENT_KINDS];

  const settled = await Promise.allSettled(
    requested.map((kind) => SOURCES[kind](organizationId, window, now)),
  );

  const events: CalendarEvent[] = [];
  const failedKinds: CalendarEventKind[] = [];
  const emptyKinds: CalendarEventKind[] = [];
  settled.forEach((result, index) => {
    const kind = requested[index]!;
    if (result.status === "rejected") {
      console.error(`[calendar] source ${kind} failed:`, result.reason);
      failedKinds.push(kind);
      return;
    }
    if (result.value.length === 0) emptyKinds.push(kind);
    events.push(...result.value);
  });

  events.sort(compareCalendarEvents);
  return {
    events,
    from: iso(options.from),
    to: iso(options.to),
    emptyKinds,
    failedKinds,
    generatedAt: iso(now),
  };
}
