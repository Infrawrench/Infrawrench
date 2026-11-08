// `infrawrench moment [timestamp]`; "what changed around 03:14?" in the
// terminal, backed by the same /moment endpoint the web and desktop screens
// read: one merged, chronological window across the change timeline, provider
// incidents, cost anomalies, workflow runs, deployments, audit entries,
// change freezes and the drift/expiry alert deliveries.
//
// Wire types and the merge/badge/grouping logic come from
// `@infrawrench/client-core`: the same definitions every other surface
// renders with, so a server-side change breaks the CLI's build, not its
// output.
import { Effect, Option, Schema } from "effect";
import { Argument, Command } from "effect/cli";
import type {
  MomentEvent,
  MomentIncidentSpan,
  MomentResponse,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import { CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import { CliFailure, CliUsageError } from "../effect/errors";
import * as Print from "../effect/print";
import { halfWindow } from "../effect/range-flags";
import { CliSession } from "../effect/session";
import { knownOr, spreadBody, Unrecognized, wire } from "../effect/wire";
import { c, safe } from "../output";

// The feed, severity and impact enums decode with `knownOr`: a value a newer
// server added renders the way the legacy fallbacks did (the feed under its
// own name, the severity as info), and one client-core adds fails this build
// until it is listed here.
const FEEDS = [
  "changes",
  "statusIncidents",
  "costAnomalies",
  "workflowRuns",
  "deployments",
  "audit",
  "freezes",
  "driftAlerts",
  "expiryAlerts",
] as const;
const SEVERITIES = ["info", "warning", "critical"] as const;

/** One glyph + color per severity, so a long window reads at a glance. */
const SEVERITY_STYLE: Record<
  (typeof SEVERITIES)[number],
  { glyph: string; color: (s: string) => string }
> = {
  info: { glyph: "·", color: c.dim },
  warning: { glyph: "!", color: c.yellow },
  critical: { glyph: "✗", color: c.red },
};

const Event = Schema.Struct({
  id: Schema.String,
  feed: knownOr(FEEDS),
  kind: Schema.String,
  timestamp: Schema.String,
  title: Schema.String,
  detail: Schema.optionalKey(Schema.NullOr(Schema.String)),
  severity: knownOr(SEVERITIES),
  resourceId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  resourceName: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

const Incident = Schema.Struct({
  id: Schema.String,
  pluginId: Schema.String,
  pluginName: Schema.String,
  title: Schema.String,
  impact: knownOr(["maintenance", "minor", "major", "critical"]),
  startedAt: Schema.String,
  resolvedAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
  url: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

// `buildMomentTimeline` and `describeIncidentBadge` take mutable arrays.
const Moment = wire<MomentResponse>()(
  Schema.Struct({
    at: Schema.String,
    from: Schema.String,
    to: Schema.String,
    windowMinutes: Schema.Finite,
    feeds: Schema.Array(
      Schema.Struct({
        feed: Schema.String,
        status: Schema.String,
        error: Schema.optionalKey(Schema.NullOr(Schema.String)),
        truncated: Schema.optionalKey(Schema.Boolean),
      }),
    ),
    events: Schema.mutable(Schema.Array(Event)),
    incidents: Schema.mutable(Schema.Array(Incident)),
  }),
);
type Event = typeof Event.Type;
type Incident = typeof Incident.Type;

/**
 * The events and spans as `buildMomentTimeline` is typed to take them, with
 * a way back to each decoded event. Neither function reads severity or impact,
 * so an unknown one is projected to any known value. Feed is the comparator's
 * tie-break (equal timestamps sort by feed order, unknown feeds last, then by
 * id): an unknown feed is projected to the last known one and its id prefixed
 * so it still sorts after that feed's events and among other unknowns by id.
 */
function timelineInput(
  events: ReadonlyArray<Event>,
  incidents: ReadonlyArray<Incident>,
  lastFeed: MomentEvent["feed"],
) {
  const originals = new Map<MomentEvent, Event>();
  const projected = events.map((event) => {
    const unknownFeed = event.feed instanceof Unrecognized;
    const entry: MomentEvent = {
      ...event,
      id: `${unknownFeed ? 1 : 0}:${event.id}`,
      feed: event.feed instanceof Unrecognized ? lastFeed : event.feed,
      severity: event.severity instanceof Unrecognized ? "info" : event.severity,
    };
    originals.set(entry, event);
    return entry;
  });
  const spans = incidents.map((span): MomentIncidentSpan => ({
    ...span,
    impact: span.impact instanceof Unrecognized ? "minor" : span.impact,
  }));
  return { projected, spans, original: (entry: MomentEvent) => originals.get(entry) };
}

const stamp = (iso: string) => new Date(iso).toISOString().replace("T", " ").slice(0, 19);

export const moment = Command.make(
  "moment",
  {
    at: Argument.String("timestamp").pipe(
      Argument.withDescription('The centre, ISO 8601 (omit it, or say "now", for around now)'),
      Argument.variadic(),
    ),
    window: halfWindow,
  },
  Effect.fn("moment")(function* (input) {
    const session = yield* CliSession;
    const api = yield* CloudApi;
    if (session.local) {
      return yield* new CliFailure({
        message:
          "The moment view merges feeds recorded by Infrawrench Cloud (change timeline, incidents, anomalies, runs). Local-only mode records none of them.",
      });
    }
    const org = yield* currentOrg;

    // Absent or "now" = around now. Anything Date.parse accepts works:
    // "2026-08-03T03:14" and "2026-08-03 03:14" both do.
    const rawAt = input.at.join(" ").trim();
    let at: string | undefined;
    if (rawAt !== "" && rawAt.toLowerCase() !== "now") {
      const parsed = Date.parse(rawAt);
      if (Number.isNaN(parsed)) {
        return yield* new CliUsageError({
          message: `Invalid timestamp "${rawAt}": use ISO 8601, e.g. 2026-08-03T03:14:00Z (or omit it for "around now").`,
        });
      }
      at = new Date(parsed).toISOString();
    }

    // --window 30m|6h|1d: a ± half-width, sent to the server in minutes.
    const windowMinutes = Option.map(input.window, (ms) => Math.max(1, Math.round(ms / 60_000)));

    const params = new URLSearchParams();
    if (at) params.set("at", at);
    if (Option.isSome(windowMinutes)) params.set("window", String(windowMinutes.value));
    const query = params.toString();
    const path = query ? `/moment?${query}` : "/moment";
    const body = yield* api.json(org.id, path);

    if (session.output === "json") {
      return yield* Print.json(yield* spreadBody({ org: org.id }, body, path));
    }
    const response = yield* decodeBody(Moment, path)(body);

    const { buildMomentTimeline, describeIncidentBadge, MOMENT_FEED_IDS, MOMENT_FEED_LABELS } =
      yield* Effect.promise(() => import("@infrawrench/client-core"));
    const labels: Partial<Record<string, string>> = MOMENT_FEED_LABELS;
    const feedLabel = (feed: string | Unrecognized) =>
      feed instanceof Unrecognized ? safe(feed.raw) : (labels[feed] ?? safe(feed));

    yield* Print.line(
      `${c.bold(safe(org.displayName))} ${c.dim(`· ${stamp(response.from)} → ${stamp(response.to)} UTC (±${response.windowMinutes}m around ${stamp(response.at)})`)}`,
    );

    // Per-feed health first: an omitted or failing feed must be visible, never
    // silently absent from the narrative.
    for (const feed of response.feeds) {
      const label = feedLabel(feed.feed);
      if (feed.status === "error") {
        yield* Print.line(
          c.yellow(`  ${label} unavailable${feed.error ? `, ${safe(feed.error)}` : ""}`),
        );
      } else if (feed.status === "omitted") {
        yield* Print.line(c.dim(`  ${label} omitted: your role lacks its read permission`));
      } else if (feed.truncated) {
        yield* Print.line(c.dim(`  ${label} truncated: more events than the window returns`));
      }
    }

    if (response.incidents.length > 0) {
      yield* Print.line();
      yield* Print.line(c.bold("Provider incidents overlapping this window"));
      for (const incident of response.incidents) {
        const active = incident.resolvedAt ? "" : ` ${c.yellow("(active)")}`;
        yield* Print.line(
          `  ${c.yellow("▲")} ${safe(incident.pluginName)}: ${safe(incident.title)}${active}${incident.url ? ` ${c.dim(safe(incident.url))}` : ""}`,
        );
      }
    }

    const { projected, spans, original } = timelineInput(
      response.events,
      response.incidents,
      MOMENT_FEED_IDS.at(-1) ?? "expiryAlerts",
    );
    const timeline = buildMomentTimeline(projected, spans);
    if (timeline.length === 0) {
      yield* Print.line();
      return yield* Print.line(
        c.dim("Nothing recorded in this window. Try a wider one: --window 6h."),
      );
    }

    const spansById = (ids: string[]) => spans.filter((s) => ids.includes(s.id));
    const line = (entry: MomentEvent, incidentIds: string[], indent: string) => {
      const event = original(entry);
      if (!event) return [];
      const style =
        event.severity instanceof Unrecognized
          ? SEVERITY_STYLE.info
          : SEVERITY_STYLE[event.severity];
      const badge = describeIncidentBadge(spansById(incidentIds));
      const parts = [
        `${indent}${c.dim(stamp(event.timestamp).slice(11))} ${style.color(style.glyph)}`,
        c.dim(`[${feedLabel(event.feed)}]`),
        event.severity === "critical" ? c.red(safe(event.title)) : safe(event.title),
      ];
      if (event.detail) parts.push(c.dim(`(${safe(event.detail)})`));
      if (badge) parts.push(c.yellow(`(${safe(badge)})`));
      return [parts.join(" ")];
    };

    yield* Print.line();
    for (const item of timeline) {
      if (item.kind === "event") {
        for (const text of line(item.event, item.incidentIds, "  ")) yield* Print.line(text);
      } else {
        const first = item.events[0];
        yield* Print.line(
          `  ${c.dim(first ? stamp(first.timestamp).slice(11) : "")} ${c.dim("┌")} ${c.bold(`${item.events.length} events`)} on ${safe(item.resourceName ?? item.resourceId)}`,
        );
        for (const event of item.events) {
          for (const text of line(event, item.incidentIds, "    ")) yield* Print.line(text);
        }
      }
    }

    yield* Print.line();
    yield* Print.line(
      c.dim(
        `${response.events.length} event${response.events.length === 1 ? "" : "s"}. Recentre with \`infrawrench moment <timestamp>\`, zoom with --window 15m|1h|6h.`,
      ),
    );
  }),
).pipe(Command.withDescription("Everything that happened around a timestamp, across every feed"));
