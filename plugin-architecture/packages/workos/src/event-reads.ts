import { requireListPage } from "@infrawrench/plugin-base";
import { cursorOf, PAGE_SIZE, type WosEvent } from "./api.js";

/**
 * Pages one read of the Events API may take. A chart window or a log tail, where
 * part of the list is fine, so reaching this keeps what was read.
 */
const MAX_EVENT_PAGES = 20;

/** How many times a chart window may be re-read from its newest end. */
const MAX_WINDOW_READS = 3;

const HOUR_MS = 60 * 60 * 1000;

/** The windows a log tail tries when WorkOS answers oldest first, narrowest first. */
const TAIL_SPANS_MS = [HOUR_MS, 24 * HOUR_MS, 7 * 24 * HOUR_MS, 30 * 24 * HOUR_MS];

/**
 * What one request adds to the caller's query. WorkOS's reference calls `after` and
 * `range_start` mutually exclusive, so only a read's first request names a start.
 */
export interface EventPaging {
  limit: number;
  after?: string;
  range_start?: string;
}

export type GetEventPage = (paging: EventPaging) => Promise<{
  data?: WosEvent[];
  list_metadata?: { after?: string | null };
}>;

interface EventRead {
  rows: WosEvent[];
  /** Ran out of pages with more to read. */
  cut: boolean;
  /** The rows run oldest to newest. Rows all at one instant say nothing, and count as not. */
  oldestFirst: boolean;
  /** The first and last times read, or `undefined` for no rows with a time. */
  firstMs: number | undefined;
  lastMs: number | undefined;
}

/** The document requires `created_at`, but a bad one must not break the whole read. */
function eventMs(event: WosEvent): number {
  return Date.parse(event.created_at);
}

/**
 * Follow one read through its pages, in whichever order WorkOS answers. WorkOS documents
 * oldest first with no `order` parameter, and this plugin has always sent `order=desc`,
 * so nothing here assumes either: the rows say which it got. Read newest first, it can
 * stop once it has `wanted` rows or has passed `startMs`.
 */
async function readEventPages(
  getPage: GetEventPage,
  options: { startMs?: number; wanted?: number },
): Promise<EventRead> {
  const { startMs, wanted } = options;
  const rows: WosEvent[] = [];
  let firstMs: number | undefined;
  let lastMs: number | undefined;
  const isOldestFirst = () => firstMs !== undefined && lastMs !== undefined && firstMs < lastMs;
  const finished = (cut: boolean): EventRead => ({
    rows,
    cut,
    oldestFirst: isOldestFirst(),
    firstMs,
    lastMs,
  });

  let after = "";
  for (let page = 0; page < MAX_EVENT_PAGES; page++) {
    const body = await getPage(
      after
        ? { limit: PAGE_SIZE, after }
        : {
            limit: PAGE_SIZE,
            ...(startMs !== undefined ? { range_start: new Date(startMs).toISOString() } : {}),
          },
    );
    const batch = requireListPage(body.data, { vendor: "WorkOS", path: "/events", key: "data" });
    rows.push(...batch);
    for (const event of batch) {
      const at = eventMs(event);
      if (!Number.isFinite(at)) continue;
      firstMs ??= at;
      lastMs = at;
    }
    after = cursorOf(body);
    if (!after || batch.length === 0) return finished(false);
    if (!isOldestFirst()) {
      if (wanted !== undefined && rows.length >= wanted) return finished(false);
      if (startMs !== undefined && lastMs !== undefined && lastMs < startMs) return finished(false);
    }
  }
  return finished(true);
}

/** The events of a chart window, and the stretch of it they can speak for. */
export interface EventWindow {
  events: WosEvent[];
  /** Nothing is known before this. */
  fromMs: number;
  /** Nothing is known after this; `Infinity` when the read reached the window's end. */
  toMs: number;
}

/**
 * Read `[startMs, endMs]`. When the window holds more than a read can take, what was
 * read is all that is known, and a chart must not draw the rest as zero. Read oldest
 * first, that would lose the newest buckets, so the window is read again from its end,
 * over a span the first read suggests one read can finish.
 */
export async function readEventWindow(
  getPage: GetEventPage,
  startMs: number,
  endMs: number,
): Promise<EventWindow> {
  let from = startMs;
  for (let attempt = 1; ; attempt++) {
    const read = await readEventPages(getPage, { startMs: from });
    const { rows, firstMs, lastMs } = read;
    if (!read.cut) return { events: rows, fromMs: from, toMs: Number.POSITIVE_INFINITY };
    if (!read.oldestFirst) {
      const oldest = rows.map(eventMs).filter(Number.isFinite);
      return { events: rows, fromMs: Math.min(...oldest, endMs), toMs: Number.POSITIVE_INFINITY };
    }
    const next = endMs - ((lastMs ?? endMs) - (firstMs ?? endMs));
    if (attempt >= MAX_WINDOW_READS || next <= from) {
      return { events: rows, fromMs: from, toMs: lastMs ?? endMs };
    }
    from = next;
  }
}

/**
 * The newest `wanted` events, oldest of them first, for a log tail. Read newest first,
 * the first page answers it. Read oldest first with more than a read can take, the
 * newest are at the far end of the list, and `after` cannot jump there, so it starts
 * again from recent windows until one holds enough.
 */
export async function readEventTail(
  getPage: GetEventPage,
  wanted: number,
  nowMs: number,
): Promise<WosEvent[]> {
  const whole = await readEventPages(getPage, { wanted });
  let read = whole;
  if (whole.cut && whole.oldestFirst) {
    for (const span of TAIL_SPANS_MS) {
      read = await readEventPages(getPage, { startMs: nowMs - span, wanted });
      if (read.cut || read.rows.length >= wanted) break;
    }
  }
  // Nothing in the widest window still leaves older events worth showing over none.
  const rows = read.rows.length > 0 ? read.rows : whole.rows;
  return [...rows].sort((a, b) => (eventMs(a) || 0) - (eventMs(b) || 0)).slice(-wanted);
}
