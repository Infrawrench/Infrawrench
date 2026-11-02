/**
 * AWS's public service health history in the AWS pricing warehouse
 * (`service_events`, in `@infrawrench/server-core/aws-pricing-warehouse/schema`),
 * so instances.infrawrench.com's chat can answer questions like "how often
 * was EC2 in Dublin down in 2023".
 *
 * The source is the AWS Health Dashboard's own public feeds, the files its
 * status page loads:
 *
 * - {@link HISTORY_URL}: every event of the last twelve months, keyed by
 *   service key (`ec2-eu-west-1`), each with its updates.
 * - {@link CURRENT_URL}: events still open (UTF-16 with a byte order mark).
 * - {@link CATALOG_URL}: every service key with its service and region name.
 *
 * The history feed only reaches back a year, so the table keeps every event
 * it has ever seen and the sync merges each fetch into it: an event already
 * stored is replaced only by a copy with at least as many updates. Years
 * before the feed were seeded once from Internet Archive copies of these
 * feeds and of the old dashboard's `status.aws.amazon.com/data.json`, whose
 * format {@link readFeed} also reads (its updates carry a Pacific clock time
 * but no date, which {@link datedUpdates} reconstructs).
 *
 * The table is a few thousand rows, so a change rewrites it whole: rows go to
 * the `staging` database and the `aws` partition is swapped in, as the price
 * loader swaps a bundle.
 */

import {
  SERVICE_EVENTS,
  STAGING_DATABASE,
  createTableSql,
} from "@infrawrench/server-core/aws-pricing-warehouse/schema";

import { RowBinary, type ClickHouseHttp } from "./warehouse";

export const HISTORY_URL =
  "https://history-events-us-west-2-prod.s3.amazonaws.com/historyevents.json";
export const CURRENT_URL = "https://health.aws.amazon.com/public/currentevents";
export const CATALOG_URL = "https://servicedata-us-west-2-prod.s3.amazonaws.com/services.json";

const PROVIDER = "aws";

/** One `service_events` row. */
export interface ServiceEvent {
  provider: string;
  event_key: string;
  service: string;
  service_name: string;
  region: string;
  arn: string;
  severity: string;
  summary: string;
  posted_at: number;
  last_update_at: number;
  resolved_at: number | null;
  impact_started_at: number | null;
  impact_ended_at: number | null;
  updates: number;
  description: string;
  event_log: string;
  impacted_services: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Reading the feeds

/** An update, with its time in epoch seconds. */
export interface FeedUpdate {
  at: number;
  /** 0 resolved, 1 impacted, 2 degraded, 3 disrupted; null when the feed does not say. */
  status: number | null;
  message: string;
}

/** An event as a feed has it, before it is matched to a service and region. */
export interface FeedEvent {
  /** The dashboard's service key, e.g. `ec2-eu-west-1`, `iam`, or a legacy `EC2EU`. */
  key: string;
  date: number;
  status: number;
  summary: string;
  serviceName: string;
  regionName: string;
  arn: string;
  updates: FeedUpdate[];
  impacted: Record<string, string>;
  /** Listed among the open events and not marked resolved. */
  open: boolean;
}

/** AWS marks a resolved event with status 0 or a `[RESOLVED]` title. */
const isResolved = (e: Pick<FeedEvent, "status" | "summary" | "updates">): boolean =>
  e.status === 0 || /^\[resolved\]/i.test(e.summary) || e.updates.some((u) => u.status === 0);

/** Bytes to text: gzip and UTF-16 (the current events feed) are both seen. */
export async function decodeFeed(bytes: Uint8Array): Promise<string> {
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const stream = new Blob([new Uint8Array(bytes)])
      .stream()
      .pipeThrough(new DecompressionStream("gzip"));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    // UTF-16 big endian; swap to little endian, which every TextDecoder has.
    const swapped = new Uint8Array(bytes.length - 2);
    for (let i = 2; i + 1 < bytes.length; i += 2) {
      swapped[i - 2] = bytes[i + 1]!;
      swapped[i - 1] = bytes[i]!;
    }
    return new TextDecoder("utf-16le").decode(swapped);
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe)
    return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  return new TextDecoder().decode(bytes);
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown): string => (typeof v === "string" ? v : "");
const int = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number.parseInt(text(v), 10);
  return Number.isFinite(n) ? n : 0;
};

/**
 * The events in any of the three feed shapes: the current history file (an
 * object of service key to events), the current events list, and the old
 * dashboard's `data.json` (`{ archive, current }`, updates as HTML).
 */
export function readFeed(doc: unknown): FeedEvent[] {
  const opened = (e: FeedEvent): FeedEvent => ({ ...e, open: !isResolved(e) });
  if (Array.isArray(doc)) {
    return doc.filter(isObject).map((e) => opened(modernEvent(text(e["service"]), e)));
  }
  if (!isObject(doc)) return [];
  if (Array.isArray(doc["archive"]) || Array.isArray(doc["current"])) {
    return [
      ...asArray(doc["archive"]).filter(isObject).map(legacyEvent),
      ...asArray(doc["current"]).filter(isObject).map(legacyEvent).map(opened),
    ];
  }
  const events: FeedEvent[] = [];
  for (const [key, list] of Object.entries(doc)) {
    for (const e of asArray(list)) if (isObject(e)) events.push(modernEvent(key, e));
  }
  return events;
}

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function modernEvent(key: string, e: Json): FeedEvent {
  const log = asArray(e["event_log"])
    .filter(isObject)
    .sort((a, b) => int(a["timestamp"]) - int(b["timestamp"]));
  const updates = log.map((u) => ({
    at: int(u["timestamp"]),
    status: u["status"] === undefined ? null : int(u["status"]),
    message: plain(text(u["message"])),
  }));
  // The history feed often leaves the title to the updates.
  const titles = log.map((u) => plain(text(u["summary"]))).filter(Boolean);
  const summary =
    plain(text(e["summary"])) || titles.find((t) => !/^\[resolved\]/i.test(t)) || titles[0] || "";
  const impacted: Record<string, string> = {};
  const listed = e["impacted_services"];
  if (isObject(listed)) {
    for (const [service, info] of Object.entries(listed)) {
      impacted[service] = isObject(info) ? plain(text(info["service_name"])) : "";
    }
  }
  return {
    key,
    date: int(e["date"]),
    status: int(e["status"]),
    summary,
    serviceName: plain(text(e["service_name"])),
    regionName: plain(text(e["region_name"])),
    arn: text(e["arn"]),
    updates,
    impacted,
    open: false,
  };
}

function legacyEvent(e: Json): FeedEvent {
  const date = int(e["date"]);
  return {
    key: text(e["service"]),
    date,
    status: int(e["status"]),
    summary: plain(text(e["summary"])),
    serviceName: plain(text(e["service_name"])),
    regionName: "",
    arn: "",
    updates: datedUpdates(text(e["description"]), date),
    impacted: {},
    open: false,
  };
}

/** HTML or text to one line of plain text. */
export function plain(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/[\s ]+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Clock times

const ZONES: Readonly<Record<string, number>> = {
  PDT: -7,
  PST: -8,
  MDT: -6,
  MST: -7,
  EDT: -4,
  EST: -5,
  UTC: 0,
  GMT: 0,
};
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAY = 86_400;

/** A wall-clock time as AWS writes one: `6:06 PM PDT`, `September 24 11:55 PM`, `8:03AM`. */
export interface Clock {
  hour: number;
  minute: number;
  zone?: string;
  month?: number;
  day?: number;
}

export function parseClock(s: string): Clock | null {
  const time = /\b(\d{1,2}):(\d{2})\s*([AP])\.?\s?M\b\.?/i.exec(s);
  if (!time) return null;
  const hour = (Number(time[1]) % 12) + (/p/i.test(time[3]!) ? 12 : 0);
  const clock: Clock = { hour, minute: Number(time[2]) };
  const zone = /\b(PDT|PST|MDT|MST|EDT|EST|UTC|GMT)\b/i.exec(s)?.[1]?.toUpperCase();
  if (zone) clock.zone = zone;
  const date =
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/i.exec(
      s,
    );
  if (date) {
    clock.month = MONTHS.indexOf(date[1]!.toLowerCase());
    clock.day = Number(date[2]);
  }
  return clock;
}

/** The time `clock` names on the local day of `near` (or its own date, in the year nearest `near`). */
function place(clock: Clock, near: number, fallbackZone: string): number {
  const offset = (ZONES[clock.zone ?? fallbackZone] ?? -7) * 3600;
  const local = new Date((near + offset) * 1000);
  let year = local.getUTCFullYear();
  const month = clock.month ?? local.getUTCMonth();
  const day = clock.day ?? local.getUTCDate();
  const at = (y: number) => Date.UTC(y, month, day, clock.hour, clock.minute) / 1000 - offset;
  if (clock.month === undefined) return at(year);
  // An explicit date near a new year can belong to the year either side.
  if (at(year) - near > 180 * DAY) year--;
  else if (near - at(year) > 180 * DAY) year++;
  return at(year);
}

/**
 * The old dashboard's updates, `<div><span> 6:06 PM PDT</span>&nbsp;text</div>`
 * each, dated: they carry a clock time only, in order, starting around when
 * the event was posted, so each is placed on the first day that keeps them in
 * order. Without any timestamps the description is one update at `posted`.
 */
export function datedUpdates(description: string, posted: number): FeedUpdate[] {
  const parts = description.split(/<div[^>]*>/i).filter((p) => p.trim() !== "");
  const updates: FeedUpdate[] = [];
  let previous = posted - 2 * 3600;
  let zone = "PDT";
  for (const part of parts) {
    const span = /^\s*<span[^>]*>([^<]*)<\/span>/i.exec(part);
    const clock = span ? parseClock(span[1]!) : null;
    const message = plain(span ? part.slice(span[0].length) : part);
    if (!clock) {
      if (message) updates.push({ at: updates.at(-1)?.at ?? posted, status: null, message });
      continue;
    }
    zone = clock.zone ?? zone;
    let at = place(clock, previous, zone);
    if (clock.month === undefined) while (at < previous) at += DAY;
    previous = at;
    updates.push({ at, status: null, message });
  }
  if (updates.length === 0) {
    const message = plain(description);
    if (message) updates.push({ at: posted, status: null, message });
  }
  return updates;
}

const BETWEEN =
  /\bbetween\s+(.{1,60}?)\s+and\s+(.{1,60}?\b(?:PDT|PST|MDT|MST|EDT|EST|UTC|GMT)\b(?:,?\s+on\s+[a-z]+\.?\s+\d{1,2}(?:st|nd|rd|th)?)?)/gi;

/**
 * The impact window a resolution message states, `Between 6:14 AM and 9:33 AM
 * PDT, ...` (or `between 11:49 PM PDT on October 19 and 2:24 AM PDT on October
 * 20`), as epoch seconds; `written` is when the message was posted, which
 * fixes the day. A message that gives several windows (one per phase of a
 * long outage) spans them all. Null when it gives none that reads forwards.
 */
export function impactWindow(
  message: string,
  written: number,
): { start: number; end: number } | null {
  let window: { start: number; end: number } | null = null;
  for (const match of message.matchAll(BETWEEN)) {
    const startClock = parseClock(match[1]!);
    const endClock = parseClock(match[2]!);
    if (!startClock || !endClock) continue;
    const zone = endClock.zone ?? startClock.zone ?? "PDT";
    let end = place(endClock, written, zone);
    // Written after the end, so a bare time later than the message is the day before.
    if (endClock.month === undefined && end > written + 3600) end -= DAY;
    let start = place(startClock, end, startClock.zone ?? zone);
    if (startClock.month === undefined && start > end) start -= DAY;
    if (start > end || end - start > 31 * DAY) continue;
    window = window
      ? { start: Math.min(window.start, start), end: Math.max(window.end, end) }
      : { start, end };
  }
  // A long outage's message gives its first phase as a window and the rest
  // in prose: `By 3:01 PM, all AWS services returned to normal operations.`
  if (window) {
    for (const match of message.matchAll(RECOVERED_BY)) {
      const clock = parseClock(match[1]!);
      if (!clock) continue;
      let end = place(clock, written, clock.zone ?? "PDT");
      if (clock.month === undefined && end > written + 3600) end -= DAY;
      if (end > window.end && end - window.start <= 31 * DAY) window = { ...window, end };
    }
  }
  return window;
}

const RECOVERED_BY =
  /\bby\s+(\d{1,2}:\d{2}\s*[AP]M(?:\s+[A-Z]{3})?(?:\s+on\s+[a-z]+\.?\s+\d{1,2}(?:st|nd|rd|th)?)?),?\s+[^.]{0,100}?\b(?:returned to normal|operating normally|fully recovered|recovered)\b/gi;

// ---------------------------------------------------------------------------
// Rows

/** Service key to service and region names, from {@link CATALOG_URL}. */
export type ServiceCatalog = Map<
  string,
  { serviceName: string; region: string; regionName: string }
>;

export function readCatalog(doc: unknown): ServiceCatalog {
  const catalog: ServiceCatalog = new Map();
  for (const e of asArray(doc)) {
    if (!isObject(e)) continue;
    catalog.set(text(e["service"]), {
      serviceName: plain(text(e["service_name"])),
      region: text(e["region_id"]),
      regionName: plain(text(e["region_name"])),
    });
  }
  return catalog;
}

const REGION_SUFFIX = /^(.+?)-((?:us|eu|ap|sa|ca|me|af|il|mx|cn)(?:-gov|-iso[a-z]?)?-[a-z]+-\d)$/;

/**
 * The old dashboard's keys from before region codes (2008 to 2011), as the
 * service code and region they mean now. The set is closed: the dashboard
 * that used them was retired in 2023.
 */
const LEGACY_KEYS: Readonly<Record<string, readonly [string, string]>> = {
  CloudFormation: ["cloudformation", "us-east-1"],
  CloudFormationEUWest: ["cloudformation", "eu-west-1"],
  CloudFormationNoCal: ["cloudformation", "us-west-1"],
  CloudFront: ["cloudfront", ""],
  CloudWatch: ["cloudwatch", "us-east-1"],
  CloudWatchAPac: ["cloudwatch", "ap-southeast-1"],
  CloudWatchEUWest: ["cloudwatch", "eu-west-1"],
  CloudWatchNoCal: ["cloudwatch", "us-west-1"],
  EC2: ["ec2", "us-east-1"],
  EC2API: ["ec2", "us-east-1"],
  EC2APac: ["ec2", "ap-southeast-1"],
  EC2EU: ["ec2", "eu-west-1"],
  EC2NoCal: ["ec2", "us-west-1"],
  ElasticBeanstalk: ["elasticbeanstalk", "us-east-1"],
  ElasticMapReduce: ["emr", "us-east-1"],
  ElasticMapReduceUSWest: ["emr", "us-west-1"],
  FPS: ["fps", ""],
  MTURKR: ["mturk-requestor", ""],
  MTURKW: ["mturk-worker", ""],
  ManagementConsole: ["management-console", ""],
  RelationalDBService: ["rds", "us-east-1"],
  RelationalDBServiceEU: ["rds", "eu-west-1"],
  RelationalDBServiceNoCal: ["rds", "us-west-1"],
  Route53: ["route53", ""],
  S3EU: ["s3", "eu-west-1"],
  S3NoCal: ["s3", "us-west-1"],
  S3US: ["s3", "us-east-1"],
  "s3-us-standard": ["s3", "us-east-1"],
  SDB: ["simpledb", "us-east-1"],
  SimpleDBNoCal: ["simpledb", "us-west-1"],
  SES: ["ses", "us-east-1"],
  SNSAPac: ["sns", "ap-southeast-1"],
  SNSUSWest: ["sns", "us-west-1"],
  SQS: ["sqs", "us-east-1"],
  SQSNoCal: ["sqs", "us-west-1"],
  VirtualPrivateCloud: ["vpc", "us-east-1"],
  VirtualPrivateCloudEU: ["vpc", "eu-west-1"],
};

const SEVERITY = ["impacted", "impacted", "degraded", "disrupted"];

/**
 * Feed events as rows. Service and region come from the service key: the
 * catalog first, then the key's own region suffix, then {@link LEGACY_KEYS}.
 * Names the feeds leave out are filled from the catalog or any other event
 * for the same service.
 */
export function toRows(
  events: readonly FeedEvent[],
  catalog: ServiceCatalog = new Map(),
): ServiceEvent[] {
  const nameOf = new Map<string, string>();
  const learn = (service: string, name: string) => {
    if (service && name && !nameOf.has(service)) nameOf.set(service, name);
  };
  const split = (key: string): { service: string; region: string } => {
    const entry = catalog.get(key);
    if (entry?.region && key.endsWith(`-${entry.region}`)) {
      return { service: key.slice(0, -(entry.region.length + 1)), region: entry.region };
    }
    const match = REGION_SUFFIX.exec(key);
    if (match) return { service: match[1]!, region: match[2]! };
    const legacy = LEGACY_KEYS[key];
    return legacy ? { service: legacy[0], region: legacy[1] } : { service: key, region: "" };
  };
  // The old dashboard put the region in the name: `Amazon CloudWatch (Ireland)`.
  const baseName = (name: string, region: string): string => {
    const match = /^(.*?)\s*\(([^()]+)\)\s*$/.exec(name);
    return match && region ? match[1]! : name;
  };

  for (const [key, entry] of catalog) learn(split(key).service, entry.serviceName);
  for (const e of events) {
    const { service, region } = split(e.key);
    learn(service, baseName(e.serviceName, region));
    for (const [key, name] of Object.entries(e.impacted)) learn(split(key).service, name);
  }

  return events.map((e) => {
    const { service, region } = split(e.key);
    const base = baseName(e.serviceName, region);
    const updates = e.updates.length
      ? e.updates
      : [{ at: e.date, status: e.status, message: e.summary }];
    const statuses = [e.status, ...updates.map((u) => u.status ?? 0)];
    const worst = Math.max(1, ...statuses.filter((s) => s >= 1 && s <= 3));
    const resolvedUpdate = updates.find((u) => u.status === 0);
    const last = updates.at(-1)!;
    // The old feed seldom marked an event resolved; it is over once it is
    // no longer among the open events.
    const resolved = resolvedUpdate !== undefined || isResolved(e) || !e.open;
    let window: { start: number; end: number } | null = null;
    for (let i = updates.length - 1; i >= 0 && !window; i--) {
      window = impactWindow(updates[i]!.message, updates[i]!.at);
    }
    return {
      provider: PROVIDER,
      event_key: `${e.key}|${e.date}`,
      service,
      service_name: base || nameOf.get(service) || "",
      region,
      arn: e.arn,
      severity: SEVERITY[worst]!,
      summary: e.summary.replace(/^\[resolved\]\s*/i, ""),
      posted_at: e.date,
      last_update_at: Math.max(e.date, last.at),
      resolved_at: resolved ? (resolvedUpdate?.at ?? Math.max(e.date, last.at)) : null,
      impact_started_at: window?.start ?? null,
      impact_ended_at: window?.end ?? null,
      updates: updates.length,
      description: last.message,
      event_log: updates
        .map(
          (u) =>
            `${new Date(u.at * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC  ${u.message}`,
        )
        .join("\n\n"),
      impacted_services: e.impacted,
    };
  });
}

/**
 * `incoming` folded into `existing` by event key. An event is replaced by a
 * copy with at least as many updates (a later copy of a feed), never by an
 * earlier one, so `incoming` goes oldest copy first; a blank service name
 * keeps the one already known. Feeds can disagree by a minute on when an
 * event was posted, so a copy whose ARN is already known takes that event's
 * key. With `closeMissing`, `incoming` includes the current open events, and
 * any other event still open is closed at its last update.
 * `changed` counts stored events that differ.
 */
export function mergeEvents(
  existing: readonly ServiceEvent[],
  incoming: readonly ServiceEvent[],
  options: { closeMissing?: boolean } = {},
): { events: ServiceEvent[]; changed: number } {
  const keyOfArn = new Map<string, string>();
  for (const e of existing) if (e.arn) keyOfArn.set(e.arn, e.event_key);
  const newer = (stored: ServiceEvent | undefined, event: ServiceEvent): ServiceEvent | null => {
    if (stored && event.updates < stored.updates) return null;
    return stored && !event.service_name ? { ...event, service_name: stored.service_name } : event;
  };
  // Collapse the feeds' copies first, so one event in two feeds is one change.
  const latest = new Map<string, ServiceEvent>();
  for (let event of incoming) {
    if (event.arn) {
      const key = keyOfArn.get(event.arn);
      if (key === undefined) keyOfArn.set(event.arn, event.event_key);
      else if (key !== event.event_key) event = { ...event, event_key: key };
    }
    const next = newer(latest.get(event.event_key), event);
    if (next) latest.set(event.event_key, next);
  }
  const byKey = new Map(existing.map((e) => [e.event_key, e]));
  let changed = 0;
  const put = (stored: ServiceEvent | undefined, next: ServiceEvent) => {
    if (stored && same(stored, next)) return;
    byKey.set(next.event_key, next);
    changed++;
  };
  for (const event of latest.values()) {
    const stored = byKey.get(event.event_key);
    const next = newer(stored, event);
    if (next) put(stored, next);
  }
  if (options.closeMissing) {
    for (const event of [...byKey.values()]) {
      if (event.resolved_at !== null || latest.get(event.event_key)?.resolved_at === null) continue;
      put(event, { ...event, resolved_at: event.last_update_at });
    }
  }
  const events = [...byKey.values()].sort(
    (a, b) => a.posted_at - b.posted_at || a.event_key.localeCompare(b.event_key),
  );
  return { events, changed };
}

function same(a: ServiceEvent, b: ServiceEvent): boolean {
  return SERVICE_EVENTS.columns.every((c) => {
    const key = c.name as keyof ServiceEvent;
    return c.type.startsWith("Map(")
      ? JSON.stringify(sortedEntries(a[key])) === JSON.stringify(sortedEntries(b[key]))
      : a[key] === b[key];
  });
}

const sortedEntries = (v: unknown) =>
  Object.entries((v ?? {}) as Record<string, string>).sort(([x], [y]) => x.localeCompare(y));

// ---------------------------------------------------------------------------
// The table

/** A batch is sent once it reaches this many bytes (CloudHouse dies on ~40 MB bodies). */
const BATCH_BYTES = 4 * 1024 * 1024;

export class ServiceEventsTable {
  constructor(
    private readonly ch: ClickHouseHttp,
    private readonly log: (line: string) => void = console.log,
  ) {}

  async ensure(): Promise<void> {
    await this.ch.exec(`CREATE DATABASE IF NOT EXISTS ${STAGING_DATABASE}`);
    await this.ch.exec(createTableSql(SERVICE_EVENTS));
    await this.ch.exec(createTableSql(SERVICE_EVENTS, STAGING_DATABASE));
  }

  async read(): Promise<ServiceEvent[]> {
    const columns = SERVICE_EVENTS.columns
      .map((c) =>
        c.type.includes("DateTime") ? `toUnixTimestamp(${c.name}) AS ${c.name}` : c.name,
      )
      .join(", ");
    const rows = await this.ch.rows<ServiceEvent>(
      `SELECT ${columns} FROM ${SERVICE_EVENTS.name} WHERE provider = '${PROVIDER}'`,
    );
    return rows.map((r) => ({
      ...r,
      posted_at: Number(r.posted_at),
      last_update_at: Number(r.last_update_at),
      resolved_at: r.resolved_at === null ? null : Number(r.resolved_at),
      impact_started_at: r.impact_started_at === null ? null : Number(r.impact_started_at),
      impact_ended_at: r.impact_ended_at === null ? null : Number(r.impact_ended_at),
      updates: Number(r.updates),
      impacted_services: r.impacted_services ?? {},
    }));
  }

  /** Make the provider's partition exactly `events`. */
  async replace(events: readonly ServiceEvent[]): Promise<void> {
    const staging = `${STAGING_DATABASE}.${SERVICE_EVENTS.name}`;
    await this.ch.exec(`TRUNCATE TABLE ${staging}`);
    const buffer = new RowBinary();
    const flush = async () => {
      if (buffer.rows === 0) return;
      await this.ch.insert(staging, SERVICE_EVENTS.columns, buffer.bytes().slice());
      buffer.reset();
    };
    for (const event of events) {
      buffer.row(SERVICE_EVENTS.columns, event as unknown as Record<string, unknown>);
      if (buffer.length >= BATCH_BYTES) await flush();
    }
    await flush();
    // A retried INSERT can land twice; never swap duplicates in.
    const [row] = await this.ch.rows<{ n: string | number }>(`SELECT count() AS n FROM ${staging}`);
    if (Number(row?.n ?? 0) !== events.length) {
      throw new Error(`service events: staged ${String(row?.n)} rows but sent ${events.length}`);
    }
    await this.ch.exec(
      events.length
        ? `ALTER TABLE ${SERVICE_EVENTS.name} REPLACE PARTITION '${PROVIDER}' FROM ${staging}`
        : `ALTER TABLE ${SERVICE_EVENTS.name} DROP PARTITION '${PROVIDER}'`,
    );
    await this.ch.exec(`TRUNCATE TABLE ${staging}`);
    this.log(`service events: ${events.length} events`);
  }
}

// ---------------------------------------------------------------------------
// Sync

async function fetchFeed(url: string, fetcher: typeof fetch): Promise<unknown> {
  const res = await fetcher(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return JSON.parse(await decodeFeed(new Uint8Array(await res.arrayBuffer())));
}

/**
 * Merge the dashboard's current feeds into `service_events`, writing only
 * when an event is new or has moved on. Returns how many changed.
 */
export async function syncServiceEvents(
  ch: ClickHouseHttp,
  options: { fetch?: typeof fetch; log?: (line: string) => void } = {},
): Promise<{ events: number; changed: number }> {
  const fetcher = options.fetch ?? fetch;
  const log = options.log ?? console.log;
  const [history, current, catalog] = await Promise.all([
    fetchFeed(HISTORY_URL, fetcher),
    fetchFeed(CURRENT_URL, fetcher),
    // Only names; the events are still worth loading without it.
    fetchFeed(CATALOG_URL, fetcher).catch((error: unknown) => {
      log(
        `service events: catalog unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }),
  ]);
  // Current events last, so an open event's latest copy wins a tie.
  const incoming = toRows([...readFeed(history), ...readFeed(current)], readCatalog(catalog));
  const table = new ServiceEventsTable(ch, log);
  await table.ensure();
  const { events, changed } = mergeEvents(await table.read(), incoming, { closeMissing: true });
  if (changed === 0) {
    log(`service events: ${events.length} events, none changed`);
    return { events: events.length, changed };
  }
  log(`service events: ${changed} new or updated`);
  await table.replace(events);
  return { events: events.length, changed };
}
