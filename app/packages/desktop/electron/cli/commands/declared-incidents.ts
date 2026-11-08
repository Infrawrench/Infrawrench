// `infrawrench declared-incidents`: incidents your organization declared, with
// `infrawrench declared-incidents <id|title>` for one incident's assembled
// timeline.
//
// **The long name is the point.** `infrawrench incidents` was already taken, by
// the provider status-page correlation ("is it me or is it them?"): somebody
// else's outage, scraped from their feed. That is a different object that
// happens to share an English word, and quietly stealing the short name would
// break a shipped command and leave two features answering to it. So this one
// says which kind it means.
//
// Cloud-only, like `probes` and `alerts`: an incident is org-scoped and
// declaring one composes cloud features (change freezes, alert routing, status
// pages), so a local workspace has nothing to list. The CLI reads; declaring
// and resolving live on the web/desktop Incidents tab and on the phone.
//
// The response shapes come from `@infrawrench/client-core` (the same
// definitions every other surface renders) so a server-side change breaks the
// CLI's build instead of its output. The imports are type-only, so the CLI
// still ships zero new runtime dependencies.
import { Effect, Option, Schema } from "effect";
import { Argument, Command } from "effect/cli";
import type {
  IncidentListResponse,
  IncidentTimelineResponse,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import { CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import { CliFailure } from "../effect/errors";
import * as Print from "../effect/print";
import { CliSession } from "../effect/session";
import { wire } from "../effect/wire";
import { c, safe, type Column } from "../output";
import { formatChangeTime } from "../format";

const PATH = "/incidents";

// Severity, status and artefact status stay strings: each renderer has a
// fallback for a value a newer server adds.
const IncidentList = wire<IncidentListResponse>()(
  Schema.Struct({
    incidents: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        title: Schema.String,
        severity: Schema.String,
        status: Schema.String,
        summary: Schema.NullOr(Schema.String),
        startedAt: Schema.String,
        resolvedAt: Schema.NullOr(Schema.String),
        declaredByName: Schema.NullOr(Schema.String),
        artifacts: Schema.Array(
          Schema.Struct({
            kind: Schema.String,
            status: Schema.String,
            label: Schema.NullOr(Schema.String),
            error: Schema.NullOr(Schema.String),
          }),
        ),
      }),
    ),
  }),
);
type Incident = (typeof IncidentList.Type)["incidents"][number];

/** The list with each incident left as the server sent it, for `--json`. */
const RawIncidentList = Schema.Struct({ incidents: Schema.Array(Schema.Unknown) });

const Timeline = wire<IncidentTimelineResponse>()(
  Schema.Struct({
    entries: Schema.Array(
      Schema.Struct({
        source: Schema.String,
        at: Schema.String,
        title: Schema.String,
        detail: Schema.optional(Schema.NullOr(Schema.String)),
        severity: Schema.String,
      }),
    ),
    feeds: Schema.Array(Schema.Struct({ feed: Schema.String, status: Schema.String })),
    truncated: Schema.Boolean,
  }),
);
type Timeline = typeof Timeline.Type;

/**
 * Duration rendering, hand-rolled rather than imported: client-core's
 * `formatIncidentDuration` is a runtime import and the CLI's imports from that
 * package must stay type-only (the `cli/format.ts` rule).
 */
function duration(startedAt: string, endedAt: string | null): string {
  const start = Date.parse(startedAt);
  const end = endedAt ? Date.parse(endedAt) : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return "—";
  const minutes = Math.round((end - start) / 60_000);
  if (minutes < 1) return "<1m";
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (mins > 0 || parts.length === 0) parts.push(`${mins}m`);
  return parts.join(" ");
}

/**
 * Both artefact failure states, so neither hides. `close_failed` is the one that
 * matters most in a terminal: it means a change freeze is still blocking the
 * org, or a status page is still telling customers there is an outage.
 */
function isFailureStatus(status: string): boolean {
  return status === "failed" || status === "close_failed";
}

// severityCell/statusCell render closed server enums, never free text, so they
// are the only server values in this file printed without safe().
function severityCell(incident: Incident): string {
  const label = incident.severity.toUpperCase();
  switch (incident.severity) {
    case "sev1":
      return c.red(label);
    case "sev2":
      return c.yellow(label);
    default:
      return c.dim(label);
  }
}

function statusCell(incident: Incident): string {
  switch (incident.status) {
    case "open":
      return c.red("● open");
    case "mitigated":
      return c.yellow("● mitigated");
    default:
      return c.dim("○ resolved");
  }
}

/** A glyph per timeline severity, the `moment` command's convention. */
function severityGlyph(severity: string): string {
  switch (severity) {
    case "critical":
      return c.red("●");
    case "warning":
      return c.yellow("●");
    default:
      return c.dim("·");
  }
}

/** The incident `wanted` names: id, then exact title, then a title containing it. */
function findIncident(incidents: ReadonlyArray<Incident>, wanted: string): number {
  const needle = wanted.toLowerCase();
  const byId = incidents.findIndex((i) => i.id === wanted);
  if (byId >= 0) return byId;
  const exact = incidents.findIndex((i) => i.title.toLowerCase() === needle);
  if (exact >= 0) return exact;
  return incidents.findIndex((i) => i.title.toLowerCase().includes(needle));
}

const printList = Effect.fnUntraced(function* (
  orgName: string,
  incidents: ReadonlyArray<Incident>,
) {
  if (incidents.length === 0) {
    return yield* Print.line(c.dim("No incidents have been declared. Long may it last."));
  }

  const open = incidents.filter((i) => i.status !== "resolved").length;
  yield* Print.line(
    `${c.bold(safe(orgName))} ${c.dim(
      `· ${incidents.length} incident${incidents.length === 1 ? "" : "s"}`,
    )}${open > 0 ? `  ${c.red(`${open} not resolved`)}` : ""}`,
  );
  yield* Print.line();

  const columns: Column<Incident>[] = [
    { header: "", value: (i) => statusCell(i) },
    { header: "sev", value: (i) => severityCell(i) },
    { header: "incident", value: (i) => safe(i.title) },
    { header: "started", value: (i) => c.dim(formatChangeTime(i.startedAt)) },
    { header: "duration", value: (i) => duration(i.startedAt, i.resolvedAt), align: "right" },
    { header: "declared by", value: (i) => c.dim(safe(i.declaredByName) || "—") },
    {
      header: "artefacts",
      value: (i) => {
        const failed = i.artifacts.filter((a) => isFailureStatus(a.status)).length;
        if (failed > 0) return c.red(`${failed} failed`);
        return c.dim(`${i.artifacts.length}`);
      },
      align: "right",
    },
  ];
  yield* Print.table(incidents, columns);

  yield* Print.line();
  yield* Print.line(
    c.dim(
      "`infrawrench declared-incidents <id|title>` prints one incident's assembled timeline. Declare and resolve from the Incidents tab.",
    ),
  );
});

/** One incident: its facts, its artefacts, and the joined timeline. */
const printIncidentDetail = Effect.fnUntraced(function* (incident: Incident, timeline: Timeline) {
  yield* Print.line(
    `${severityCell(incident)} ${c.bold(safe(incident.title))}  ${statusCell(incident)}`,
  );
  yield* Print.line(
    c.dim(
      `started ${formatChangeTime(incident.startedAt)} · ${duration(
        incident.startedAt,
        incident.resolvedAt,
      )}${incident.declaredByName ? ` · declared by ${safe(incident.declaredByName)}` : ""}`,
    ),
  );
  if (incident.summary) yield* Print.line(safe(incident.summary));
  yield* Print.line();

  // Artefacts first, and failures loudly: the point of recording a failed
  // artefact is that somebody sees it.
  if (incident.artifacts.length > 0) {
    for (const artifact of incident.artifacts) {
      const line = `${artifact.kind}: ${artifact.status}${artifact.label ? ` (${safe(artifact.label)})` : ""}`;
      yield* Print.line(
        isFailureStatus(artifact.status)
          ? c.red(`  ✗ ${line}, ${safe(artifact.error) || "no detail recorded"}`)
          : c.dim(`  · ${line}`),
      );
    }
    yield* Print.line();
  }

  const degraded = timeline.feeds.filter((f) => f.status !== "ok");
  if (degraded.length > 0) {
    yield* Print.line(
      c.dim(
        `feeds unavailable or not visible to you: ${degraded.map((f) => safe(f.feed)).join(", ")}`,
      ),
    );
    yield* Print.line();
  }

  if (timeline.entries.length === 0) {
    return yield* Print.line(
      c.dim(
        "Nothing else was recorded in this window. The change feed, deploys and alerts were all quiet.",
      ),
    );
  }

  for (const entry of timeline.entries) {
    yield* Print.line(
      `${severityGlyph(entry.severity)} ${c.dim(formatChangeTime(entry.at).padEnd(16))} ${c.dim(
        safe(entry.source).padEnd(13),
      )} ${safe(entry.title)}`,
    );
    if (entry.detail) yield* Print.line(`  ${c.dim(safe(entry.detail))}`);
  }

  if (timeline.truncated) {
    yield* Print.line();
    yield* Print.line(
      c.dim("Timeline truncated. This window holds more events than one view can carry."),
    );
  }
});

export const declaredIncidents = Command.make(
  "declared-incidents",
  {
    incident: Argument.String("id|title").pipe(
      Argument.withDescription("An incident to show the timeline of, by id or title"),
      Argument.optional,
    ),
  },
  Effect.fn("declared-incidents")(function* ({ incident: incidentArg }) {
    const session = yield* CliSession;
    if (session.local) {
      return yield* new CliFailure({
        message:
          "Incidents live in Infrawrench Cloud. An incident is org-scoped and declaring one composes cloud features. Drop --local.",
      });
    }
    const api = yield* CloudApi;
    const org = yield* currentOrg;
    const body = yield* api.json(org.id, PATH);
    const raw = yield* decodeBody(RawIncidentList, PATH)(body);

    if (Option.isSome(incidentArg)) {
      const { incidents } = yield* decodeBody(IncidentList, PATH)(body);
      const index = findIncident(incidents, incidentArg.value);
      const incident = incidents[index];
      if (!incident) {
        return yield* new CliFailure({
          message: `No incident matches "${incidentArg.value}". Run \`infrawrench declared-incidents\` to list.`,
        });
      }
      const timelinePath = `/incidents/${encodeURIComponent(incident.id)}/timeline`;
      const timelineBody = yield* api.json(org.id, timelinePath);
      if (session.output === "json") {
        return yield* Print.json({
          org: org.id,
          incident: raw.incidents[index],
          timeline: timelineBody,
        });
      }
      const timeline = yield* decodeBody(Timeline, timelinePath)(timelineBody);
      return yield* printIncidentDetail(incident, timeline);
    }

    if (session.output === "json") {
      return yield* Print.json({ org: org.id, incidents: raw.incidents });
    }
    const { incidents } = yield* decodeBody(IncidentList, PATH)(body);
    yield* printList(org.displayName, incidents);
  }),
).pipe(
  Command.withDescription(
    "Incidents you declared (incident mode): severity, status, duration and failed artefacts",
  ),
);
