import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { T, useGT } from "gt-react";
import {
  CALENDAR_EVENT_KINDS,
  calendarDayKey,
  calendarMonthGrid,
  groupCalendarEventsByDay,
  type CalendarEvent,
  type CalendarEventKind,
  type CalendarEventSeverity,
  type CalendarResponse,
  type CalendarSubscription,
} from "@infrawrench/client-core";

export interface CalendarRange {
  /** ISO 8601, inclusive lower bound. */
  from: string;
  /** ISO 8601, exclusive upper bound. */
  to: string;
  /** Empty means every kind. */
  kinds: CalendarEventKind[];
}

export interface CalendarSectionProps {
  /**
   * The events for the range last requested, or null while the first load is
   * in flight. Hosts fetch (web: `/calendar`, desktop: cloud IPC) and hand the
   * response over — this component never talks to a network.
   */
  data: CalendarResponse | null;
  /**
   * Load or refresh failure. With `data` still present the last month stays on
   * screen under a banner: a failed refresh must not blank a drawn calendar.
   */
  error?: string | null | undefined;
  onRetry?: (() => void) | undefined;
  /**
   * Called whenever the visible window or the kind filter changes. The host
   * owns fetching, so the section never has to know how the two platforms talk
   * to the API.
   */
  onRangeChange: (range: CalendarRange) => void;
  /** Jump to an event's resource. Omitted, resource events are plain text. */
  onOpenResource?: ((target: { accountId: string; resourceId: string }) => void) | undefined;
  /** Open a workspace tab an event points at. Omitted, those events are plain text. */
  onOpenTab?:
    ((tab: "expiring" | "incidents" | "workflows" | "costs" | "settings") => void) | undefined;
  /**
   * iCalendar subscriptions, or null while loading. Undefined means the host
   * does not offer them at all, which hides the whole tab.
   */
  subscriptions?: CalendarSubscription[] | null | undefined;
  /**
   * Mint a subscription. Resolves with the one-time URL, which the section
   * shows until dismissed — there is no second chance to read it.
   */
  onCreateSubscription?:
    ((input: { name: string; kinds: CalendarEventKind[] }) => Promise<string>) | undefined;
  onRevokeSubscription?: ((subscriptionId: string) => Promise<void>) | undefined;
  /**
   * IANA zone the grid is drawn in. Defaults to the host's own zone, which is
   * what someone planning their week actually wants — the calendar is read by
   * a person, not by a scheduler.
   */
  timeZone?: string | undefined;
}

type Gt = ReturnType<typeof useGT>;
type View = "month" | "agenda" | "subscriptions";

const MS_PER_DAY = 86_400_000;

const KIND_BADGE_CLASSES: Record<CalendarEventKind, string> = {
  "change-freeze": "bg-sky-500/10 text-info",
  "sleep-schedule": "bg-surface-overlay text-on-surface-tertiary",
  expiry: "bg-amber-500/10 text-warning",
  "commitment-expiry": "bg-violet-500/10 text-on-surface-secondary",
  "workflow-schedule": "bg-emerald-500/10 text-success",
  incident: "bg-red-500/10 text-danger",
};

const SEVERITY_DOT_CLASSES: Record<CalendarEventSeverity, string> = {
  critical: "bg-danger",
  warning: "bg-warning",
  info: "bg-on-surface-faint",
};

function kindLabel(gt: Gt, kind: CalendarEventKind): string {
  switch (kind) {
    case "change-freeze":
      return gt("Freezes");
    case "sleep-schedule":
      return gt("Sleep windows");
    case "expiry":
      return gt("Deadlines");
    case "commitment-expiry":
      return gt("Commitments");
    case "workflow-schedule":
      return gt("Scheduled runs");
    case "incident":
      return gt("Incidents");
  }
}

/** The host's own zone, or UTC when the environment will not say. */
function hostTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function formatTime(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(iso));
  } catch {
    return iso.slice(11, 16);
  }
}

function formatDayHeading(dayKey: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      weekday: "long",
      day: "numeric",
      month: "long",
      // The key is already a calendar date; formatting it in UTC is what keeps
      // it from sliding a day for readers west of the meridian.
      timeZone: "UTC",
    }).format(new Date(`${dayKey}T12:00:00Z`));
  } catch {
    return dayKey;
  }
}

function formatMonthHeading(year: number, month: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    }).format(new Date(Date.UTC(year, month - 1, 15)));
  } catch {
    return `${year}-${String(month).padStart(2, "0")}`;
  }
}

/** Monday-first weekday initials, from the runtime's own locale data. */
function weekdayLabels(): string[] {
  const format = new Intl.DateTimeFormat(undefined, { weekday: "short", timeZone: "UTC" });
  // 2026-06-01 is a Monday.
  return Array.from({ length: 7 }, (_, index) =>
    format.format(new Date(Date.UTC(2026, 5, 1 + index))),
  );
}

/** One event, as it appears inside a day cell or an agenda row. */
function EventChip({
  event,
  timeZone,
  onOpen,
  compact,
}: {
  event: CalendarEvent;
  timeZone: string;
  onOpen: (() => void) | undefined;
  compact: boolean;
}) {
  const gt = useGT();
  const time = event.allDay ? gt("All day") : formatTime(event.startsAt, timeZone);
  const body = (
    <>
      <span
        aria-hidden="true"
        className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${SEVERITY_DOT_CLASSES[event.severity]}`}
      />
      <span className="truncate">{event.title}</span>
      {!compact && (
        <span className="ml-auto shrink-0 text-xs tabular-nums text-on-surface-faint">{time}</span>
      )}
    </>
  );
  const className = `flex w-full items-center gap-1.5 rounded px-1.5 py-0.5 text-left text-xs ${
    KIND_BADGE_CLASSES[event.kind]
  } ${onOpen ? "hover:brightness-110" : ""}`;

  if (!onOpen) {
    return (
      <span className={className} title={event.detail ?? event.title}>
        {body}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      className={className}
      title={event.detail ?? event.title}
    >
      {body}
    </button>
  );
}

/**
 * The operations calendar — one time axis over everything the org already has a
 * date for.
 *
 * Nothing on this screen is a record of its own: freezes, sleep windows,
 * deadlines, commitment terms, scheduled runs and incidents all live elsewhere,
 * and the calendar is the projection nobody had. Three views over that one
 * computation — a month grid, a flat agenda, and the iCalendar subscriptions
 * that put the same thing in someone's phone.
 *
 * The month it shows is *this* component's state, and it asks the host to fetch
 * through `onRangeChange`. That is the opposite of the other sections' shape
 * (host fetches, section renders) and it is deliberate: the window is a control
 * on the page, and lifting it into two hosts would mean writing the same
 * month-arithmetic twice.
 */
export function CalendarSection({
  data,
  error,
  onRetry,
  onRangeChange,
  onOpenResource,
  onOpenTab,
  subscriptions,
  onCreateSubscription,
  onRevokeSubscription,
  timeZone,
}: CalendarSectionProps) {
  const gt = useGT();
  const zone = timeZone ?? hostTimeZone();
  const [view, setView] = useState<View>("month");
  const [anchor, setAnchor] = useState(() => {
    const now = new Date();
    return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
  });
  const [hiddenKinds, setHiddenKinds] = useState<ReadonlySet<CalendarEventKind>>(new Set());
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  const grid = useMemo(() => calendarMonthGrid(anchor.year, anchor.month), [anchor]);

  // The fetched window is the grid's own span, so the leading and trailing days
  // borrowed from the neighbouring months are populated rather than blank.
  const range = useMemo<CalendarRange>(() => {
    const first = grid[0]?.[0] ?? "";
    const last = grid[5]?.[6] ?? "";
    return {
      from: `${first}T00:00:00.000Z`,
      // Exclusive: the day after the last cell, so that cell is whole.
      to: new Date(Date.parse(`${last}T00:00:00.000Z`) + MS_PER_DAY).toISOString(),
      kinds: CALENDAR_EVENT_KINDS.filter((kind) => !hiddenKinds.has(kind)),
    };
  }, [grid, hiddenKinds]);

  // `onRangeChange` is a host callback that may be re-created per render; a
  // ref keeps it out of the effect's dependencies, so the fetch fires when the
  // *window* changes and not when the parent happens to re-render.
  const notify = useRef(onRangeChange);
  notify.current = onRangeChange;
  useEffect(() => {
    notify.current(range);
  }, [range]);

  const eventsByDay = useMemo(
    () => groupCalendarEventsByDay(data?.events ?? [], zone),
    [data, zone],
  );

  const todayKey = useMemo(() => calendarDayKey(new Date().toISOString(), zone), [zone]);

  const openEvent = useCallback(
    (event: CalendarEvent): (() => void) | undefined => {
      const link = event.link;
      if (!link) return undefined;
      if (link.target === "resource") {
        if (!onOpenResource) return undefined;
        return () => onOpenResource({ accountId: link.accountId, resourceId: link.resourceId });
      }
      if (!onOpenTab) return undefined;
      return () => onOpenTab(link.tab);
    },
    [onOpenResource, onOpenTab],
  );

  function shiftMonth(delta: number) {
    setSelectedDay(null);
    setAnchor((current) => {
      const next = new Date(Date.UTC(current.year, current.month - 1 + delta, 1));
      return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1 };
    });
  }

  function toggleKind(kind: CalendarEventKind) {
    setHiddenKinds((current) => {
      const next = new Set(current);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }

  const selectedEvents = selectedDay ? (eventsByDay.get(selectedDay) ?? []) : [];

  return (
    <div className="flex-1 overflow-auto p-6">
      <h1 className="text-xl font-semibold mb-1">{gt("Calendar")}</h1>
      <T>
        <p className="text-sm text-on-surface-muted mb-6">
          Everything with a date on it, on one axis: change freezes, sleep windows, expiring
          certificates and leases, commitment terms ending, scheduled workflow runs and declared
          incidents. Nothing here is a new record — it is the things you already have, finally
          beside each other. Subscribe from a calendar app to carry it around.
        </p>
      </T>

      {error != null && data === null && (
        <div role="alert" className="text-sm text-danger">
          {gt("Couldn't load the calendar — {error}", { error })}{" "}
          {onRetry && (
            <button type="button" onClick={onRetry} className="underline">
              {gt("Retry")}
            </button>
          )}
        </div>
      )}
      {data === null && error == null && (
        <p role="status" className="text-sm text-on-surface-faint">
          {gt("Gathering dated records…")}
        </p>
      )}
      {error != null && data !== null && (
        <p role="alert" className="mb-4 text-xs text-danger">
          {gt("Couldn't refresh — showing the last loaded window. {error}", { error })}
        </p>
      )}

      {data !== null && data.failedKinds.length > 0 && (
        <p role="alert" className="mb-4 text-xs text-warning">
          {gt(
            "Some sources could not be read, so this view is incomplete: {kinds}. Everything else is current.",
            { kinds: data.failedKinds.map((kind) => kindLabel(gt, kind)).join(", ") },
          )}
        </p>
      )}

      <div
        role="tablist"
        aria-label={gt("Calendar views")}
        className="mb-4 flex rounded-lg border border-border overflow-hidden text-xs w-fit"
      >
        {(
          [
            ["month", gt("Month")],
            ["agenda", gt("Agenda")],
            ...(subscriptions !== undefined
              ? ([["subscriptions", gt("Subscriptions")]] as const)
              : []),
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={view === key}
            onClick={() => setView(key)}
            className={`px-3 py-1.5 transition-colors ${
              view === key
                ? "bg-surface-overlay text-on-surface"
                : "text-on-surface-tertiary hover:text-on-surface-secondary"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {view !== "subscriptions" && (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => shiftMonth(-1)}
                aria-label={gt("Previous month")}
                className="rounded-lg border border-border px-2 py-1 text-xs text-on-surface-tertiary hover:text-on-surface"
              >
                ‹
              </button>
              <button
                type="button"
                onClick={() => {
                  const now = new Date();
                  setSelectedDay(null);
                  setAnchor({ year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 });
                }}
                className="rounded-lg border border-border px-2.5 py-1 text-xs text-on-surface-tertiary hover:text-on-surface"
              >
                {gt("Today")}
              </button>
              <button
                type="button"
                onClick={() => shiftMonth(1)}
                aria-label={gt("Next month")}
                className="rounded-lg border border-border px-2 py-1 text-xs text-on-surface-tertiary hover:text-on-surface"
              >
                ›
              </button>
            </div>
            <h2 className="text-sm font-medium text-on-surface">
              {formatMonthHeading(anchor.year, anchor.month)}
            </h2>
            <span className="text-xs text-on-surface-faint">{zone}</span>
          </div>

          <div className="mb-4 flex flex-wrap items-center gap-1.5 text-xs">
            <span className="text-on-surface-faint mr-1">{gt("Show")}</span>
            {CALENDAR_EVENT_KINDS.map((kind) => {
              const shown = !hiddenKinds.has(kind);
              const empty = data?.emptyKinds.includes(kind) ?? false;
              return (
                <button
                  key={kind}
                  type="button"
                  aria-pressed={shown}
                  onClick={() => toggleKind(kind)}
                  className={`rounded-full border px-2.5 py-1 transition-colors ${
                    shown
                      ? "border-transparent bg-surface-overlay text-on-surface"
                      : "border-border text-on-surface-tertiary hover:text-on-surface-secondary"
                  }`}
                >
                  {kindLabel(gt, kind)}
                  {shown && empty && (
                    <span className="ml-1 text-on-surface-faint">{gt("(none)")}</span>
                  )}
                </button>
              );
            })}
          </div>
        </>
      )}

      {view === "month" && (
        <>
          <div
            role="grid"
            aria-label={formatMonthHeading(anchor.year, anchor.month)}
            className="overflow-hidden rounded-xl border border-border"
          >
            <div role="row" className="grid grid-cols-7 border-b border-border bg-surface-overlay">
              {weekdayLabels().map((label) => (
                <div
                  key={label}
                  role="columnheader"
                  className="px-2 py-1.5 text-center text-xs font-medium text-on-surface-tertiary"
                >
                  {label}
                </div>
              ))}
            </div>
            {grid.map((week) => (
              <div key={week[0]} role="row" className="grid grid-cols-7">
                {week.map((dayKey) => {
                  const dayEvents = eventsByDay.get(dayKey) ?? [];
                  const inMonth = Number(dayKey.slice(5, 7)) === anchor.month;
                  const isToday = dayKey === todayKey;
                  return (
                    <div
                      key={dayKey}
                      role="gridcell"
                      className={`min-h-24 border-t border-r border-border p-1 last:border-r-0 ${
                        inMonth ? "" : "bg-surface-overlay/40"
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => setSelectedDay(dayKey === selectedDay ? null : dayKey)}
                        aria-label={gt("{day} — {count} events", {
                          day: formatDayHeading(dayKey),
                          count: dayEvents.length,
                        })}
                        className={`mb-1 flex h-5 w-5 items-center justify-center rounded-full text-xs tabular-nums ${
                          isToday
                            ? "bg-accent text-on-accent"
                            : selectedDay === dayKey
                              ? "bg-surface-overlay text-on-surface"
                              : inMonth
                                ? "text-on-surface-secondary"
                                : "text-on-surface-faint"
                        }`}
                      >
                        {Number(dayKey.slice(8, 10))}
                      </button>
                      <div className="flex flex-col gap-0.5">
                        {dayEvents.slice(0, 3).map((event) => (
                          <EventChip
                            key={event.id}
                            event={event}
                            timeZone={zone}
                            onOpen={openEvent(event)}
                            compact
                          />
                        ))}
                        {dayEvents.length > 3 && (
                          <button
                            type="button"
                            onClick={() => setSelectedDay(dayKey)}
                            className="px-1.5 text-left text-xs text-on-surface-faint hover:text-on-surface-secondary"
                          >
                            {gt("+{count} more", { count: dayEvents.length - 3 })}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>

          {selectedDay && (
            <div className="mt-4 rounded-xl border border-border p-4">
              <h3 className="mb-2 text-sm font-medium text-on-surface">
                {formatDayHeading(selectedDay)}
              </h3>
              {selectedEvents.length === 0 ? (
                <p className="text-xs text-on-surface-faint">{gt("Nothing scheduled.")}</p>
              ) : (
                <ul className="flex flex-col gap-1.5">
                  {selectedEvents.map((event) => (
                    <li key={event.id}>
                      <EventChip
                        event={event}
                        timeZone={zone}
                        onOpen={openEvent(event)}
                        compact={false}
                      />
                      {event.detail && (
                        <p className="mt-0.5 pl-3 text-xs text-on-surface-tertiary">
                          {event.detail}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}

      {view === "agenda" && data !== null && (
        <AgendaView
          events={data.events}
          timeZone={zone}
          openEvent={openEvent}
          eventsByDay={eventsByDay}
        />
      )}

      {view === "subscriptions" && (
        <SubscriptionsView
          subscriptions={subscriptions ?? null}
          onCreate={onCreateSubscription}
          onRevoke={onRevokeSubscription}
        />
      )}
    </div>
  );
}

function AgendaView({
  events,
  timeZone,
  openEvent,
  eventsByDay,
}: {
  events: CalendarEvent[];
  timeZone: string;
  openEvent: (event: CalendarEvent) => (() => void) | undefined;
  eventsByDay: Map<string, CalendarEvent[]>;
}) {
  const gt = useGT();
  if (events.length === 0) {
    return (
      <p className="text-sm text-on-surface-faint">
        {gt("Nothing dated in this window. Try a wider month or turn a filter back on.")}
      </p>
    );
  }
  const days = [...eventsByDay.keys()].sort();
  return (
    <div className="flex flex-col gap-4">
      {days.map((dayKey) => (
        <div key={dayKey}>
          <h3 className="mb-1.5 text-xs font-medium uppercase tracking-wide text-on-surface-faint">
            {formatDayHeading(dayKey)}
          </h3>
          <ul className="flex flex-col gap-1">
            {(eventsByDay.get(dayKey) ?? []).map((event) => (
              <li key={event.id}>
                <EventChip
                  event={event}
                  timeZone={timeZone}
                  onOpen={openEvent(event)}
                  compact={false}
                />
                {event.detail && (
                  <p className="mt-0.5 pl-3 text-xs text-on-surface-tertiary">{event.detail}</p>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function SubscriptionsView({
  subscriptions,
  onCreate,
  onRevoke,
}: {
  subscriptions: CalendarSubscription[] | null;
  onCreate: ((input: { name: string; kinds: CalendarEventKind[] }) => Promise<string>) | undefined;
  onRevoke: ((subscriptionId: string) => Promise<void>) | undefined;
}) {
  const gt = useGT();
  const [name, setName] = useState("");
  const [kinds, setKinds] = useState<ReadonlySet<CalendarEventKind>>(new Set());
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  /** The one-time URL. Held until dismissed — there is no second chance. */
  const [mintedUrl, setMintedUrl] = useState<string | null>(null);

  async function create() {
    if (!onCreate || !name.trim()) return;
    setBusy(true);
    setActionError(null);
    try {
      const url = await onCreate({ name: name.trim(), kinds: [...kinds] });
      setMintedUrl(url);
      setName("");
      setKinds(new Set());
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    if (!onRevoke) return;
    setBusy(true);
    setActionError(null);
    try {
      await onRevoke(id);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const live = (subscriptions ?? []).filter((s) => s.revokedAt === null);
  const revoked = (subscriptions ?? []).filter((s) => s.revokedAt !== null);

  return (
    <div className="flex flex-col gap-5">
      <T>
        <p className="max-w-2xl text-sm text-on-surface-muted">
          A subscription is a URL you paste into Google Calendar, Outlook or your phone. It updates
          on its own, roughly hourly. Anyone holding the URL can read this calendar, so treat it as
          a password — it carries names and times, never credentials, costs or anything you could
          act on.
        </p>
      </T>

      {mintedUrl && (
        <div className="rounded-xl border border-accent/40 bg-accent/5 p-4">
          <p className="mb-2 text-sm font-medium text-on-surface">
            {gt("Copy this now — it is not shown again")}
          </p>
          <code className="block break-all rounded bg-surface-overlay px-2 py-1.5 text-xs text-on-surface-secondary">
            {mintedUrl}
          </code>
          <button
            type="button"
            onClick={() => setMintedUrl(null)}
            className="mt-2 text-xs text-on-surface-tertiary underline hover:text-on-surface"
          >
            {gt("Done")}
          </button>
        </div>
      )}

      {actionError != null && (
        <p role="alert" className="text-xs text-danger">
          {actionError}
        </p>
      )}

      {onCreate && (
        <div className="flex flex-col gap-3 rounded-xl border border-border p-4">
          <label className="flex flex-col gap-1 text-xs text-on-surface-tertiary">
            {gt("Name")}
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              placeholder={gt("Platform team calendar")}
              className="rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm text-on-surface"
            />
          </label>
          <fieldset className="flex flex-col gap-2">
            <legend className="text-xs text-on-surface-tertiary">
              {gt("Include (none selected means everything, including kinds added later)")}
            </legend>
            <div className="flex flex-wrap gap-1.5 text-xs">
              {CALENDAR_EVENT_KINDS.map((kind) => {
                const on = kinds.has(kind);
                return (
                  <button
                    key={kind}
                    type="button"
                    aria-pressed={on}
                    onClick={() =>
                      setKinds((current) => {
                        const next = new Set(current);
                        if (next.has(kind)) next.delete(kind);
                        else next.add(kind);
                        return next;
                      })
                    }
                    className={`rounded-full border px-2.5 py-1 transition-colors ${
                      on
                        ? "border-transparent bg-surface-overlay text-on-surface"
                        : "border-border text-on-surface-tertiary hover:text-on-surface-secondary"
                    }`}
                  >
                    {kindLabel(gt, kind)}
                  </button>
                );
              })}
            </div>
          </fieldset>
          <div>
            <button
              type="button"
              disabled={busy || name.trim().length === 0}
              onClick={() => void create()}
              className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-on-accent disabled:opacity-50"
            >
              {gt("Create subscription")}
            </button>
          </div>
        </div>
      )}

      {subscriptions === null ? (
        <p role="status" className="text-sm text-on-surface-faint">
          {gt("Loading subscriptions…")}
        </p>
      ) : live.length === 0 ? (
        <p className="text-sm text-on-surface-faint">{gt("No subscriptions yet.")}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {live.map((subscription) => (
            <li
              key={subscription.id}
              className="flex flex-wrap items-center gap-3 rounded-xl border border-border p-3"
            >
              <span className="font-medium text-on-surface">{subscription.name}</span>
              <span className="text-xs text-on-surface-tertiary">
                {subscription.kinds.length === 0
                  ? gt("Everything")
                  : subscription.kinds.map((kind) => kindLabel(gt, kind)).join(", ")}
              </span>
              <span className="text-xs text-on-surface-faint">
                {subscription.lastAccessedAt
                  ? gt("Last fetched {when}", {
                      when: new Date(subscription.lastAccessedAt).toLocaleString(),
                    })
                  : gt("Never fetched")}
              </span>
              {onRevoke && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void revoke(subscription.id)}
                  className="ml-auto text-xs text-danger underline disabled:opacity-50"
                >
                  {gt("Revoke")}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {revoked.length > 0 && (
        <details className="text-xs text-on-surface-tertiary">
          <summary className="cursor-pointer">
            {gt("{count} revoked", { count: revoked.length })}
          </summary>
          <ul className="mt-2 flex flex-col gap-1">
            {revoked.map((subscription) => (
              <li key={subscription.id}>
                {subscription.name}
                {" — "}
                {gt("revoked {when}", {
                  when: new Date(subscription.revokedAt ?? "").toLocaleDateString(),
                })}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
