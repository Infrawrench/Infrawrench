// `infrawrench moment [timestamp]` — "what changed around 03:14?" in the
// terminal, backed by the same /moment endpoint the web and desktop screens
// read: one merged, chronological window across the change timeline, provider
// incidents, cost anomalies, workflow runs, deployments, audit entries,
// change freezes and the drift/expiry alert deliveries.
//
// Wire types and the merge/badge/grouping logic come from
// `@infrawrench/client-core` — the same definitions every other surface
// renders with, so a server-side change breaks the CLI's build, not its
// output.
import { CliError, orgFetch, resolveOrg, type CliContext } from "../context";
import type { MomentEvent, MomentResponse, MomentSeverity } from "@infrawrench/client-core" with {
  "resolution-mode": "import",
};
import type { RangeFlags } from "../args";
import { parseDuration } from "../args";
import { c, printJson, println } from "../output";

/** One glyph + color per severity, so a long window reads at a glance. */
const SEVERITY_STYLE: Record<MomentSeverity, { glyph: string; color: (s: string) => string }> = {
  info: { glyph: "·", color: c.dim },
  warning: { glyph: "!", color: c.yellow },
  critical: { glyph: "✗", color: c.red },
};

export async function cmdMoment(ctx: CliContext, range: RangeFlags): Promise<void> {
  if (ctx.flags.local) {
    throw new CliError(
      "The moment view merges feeds recorded by Infrawrench Cloud (change timeline, incidents, anomalies, runs) — local-only mode records none of them.",
    );
  }
  const org = await resolveOrg(ctx);

  // Positional timestamp: absent or "now" = around now. Anything Date.parse
  // accepts works — "2026-08-03T03:14" and "2026-08-03 03:14" both do.
  const rawAt = ctx.positionals.slice(1).join(" ").trim();
  let at: string | undefined;
  if (rawAt !== "" && rawAt.toLowerCase() !== "now") {
    const parsed = Date.parse(rawAt);
    if (Number.isNaN(parsed)) {
      throw new CliError(
        `Invalid timestamp "${rawAt}" — use ISO 8601, e.g. 2026-08-03T03:14:00Z (or omit it for "around now").`,
        2,
      );
    }
    at = new Date(parsed).toISOString();
  }

  // --window 30m|6h|1d — a ± half-width, sent to the server in minutes.
  let windowMinutes: number | undefined;
  if (range.window !== undefined) {
    windowMinutes = Math.max(1, Math.round(parseDuration(range.window) / 60_000));
  }

  const params = new URLSearchParams();
  if (at) params.set("at", at);
  if (windowMinutes !== undefined) params.set("window", String(windowMinutes));
  const query = params.toString();
  const response = await orgFetch<MomentResponse>(org.id, query ? `/moment?${query}` : "/moment");

  if (ctx.flags.output === "json") {
    printJson({ org: org.id, ...response });
    return;
  }

  const { buildMomentTimeline, describeIncidentBadge, MOMENT_FEED_LABELS } =
    await import("@infrawrench/client-core");

  const stamp = (iso: string) => new Date(iso).toISOString().replace("T", " ").slice(0, 19);
  println(
    `${c.bold(org.displayName)} ${c.dim(`· ${stamp(response.from)} → ${stamp(response.to)} UTC (±${response.windowMinutes}m around ${stamp(response.at)})`)}`,
  );

  // Per-feed health first: an omitted or failing feed must be visible, never
  // silently absent from the narrative.
  for (const feed of response.feeds) {
    const label = MOMENT_FEED_LABELS[feed.feed] ?? feed.feed;
    if (feed.status === "error") {
      println(c.yellow(`  ${label} unavailable${feed.error ? ` — ${feed.error}` : ""}`));
    } else if (feed.status === "omitted") {
      println(c.dim(`  ${label} omitted — your role lacks its read permission`));
    } else if (feed.truncated) {
      println(c.dim(`  ${label} truncated — more events than the window returns`));
    }
  }

  if (response.incidents.length > 0) {
    println();
    println(c.bold("Provider incidents overlapping this window"));
    for (const incident of response.incidents) {
      const active = incident.resolvedAt ? "" : ` ${c.yellow("(active)")}`;
      println(
        `  ${c.yellow("▲")} ${incident.pluginName}: ${incident.title}${active}${incident.url ? ` ${c.dim(incident.url)}` : ""}`,
      );
    }
  }

  const timeline = buildMomentTimeline(response.events, response.incidents);
  if (timeline.length === 0) {
    println();
    println(c.dim("Nothing recorded in this window. Try a wider one: --window 6h."));
    return;
  }

  const spansById = (ids: string[]) => response.incidents.filter((s) => ids.includes(s.id));
  const line = (event: MomentEvent, incidentIds: string[], indent: string) => {
    const style = SEVERITY_STYLE[event.severity] ?? SEVERITY_STYLE.info;
    const badge = describeIncidentBadge(spansById(incidentIds));
    const parts = [
      `${indent}${c.dim(stamp(event.timestamp).slice(11))} ${style.color(style.glyph)}`,
      c.dim(`[${MOMENT_FEED_LABELS[event.feed] ?? event.feed}]`),
      event.severity === "critical" ? c.red(event.title) : event.title,
    ];
    if (event.detail) parts.push(c.dim(`— ${event.detail}`));
    if (badge) parts.push(c.yellow(`(${badge})`));
    println(parts.join(" "));
  };

  println();
  for (const item of timeline) {
    if (item.kind === "event") {
      line(item.event, item.incidentIds, "  ");
    } else {
      const first = item.events[0];
      println(
        `  ${c.dim(first ? stamp(first.timestamp).slice(11) : "")} ${c.dim("┌")} ${c.bold(`${item.events.length} events`)} on ${item.resourceName ?? item.resourceId}`,
      );
      for (const event of item.events) line(event, item.incidentIds, "    ");
    }
  }

  println();
  println(
    c.dim(
      `${response.events.length} event${response.events.length === 1 ? "" : "s"}. Recentre with \`infrawrench moment <timestamp>\`, zoom with --window 15m|1h|6h.`,
    ),
  );
}
