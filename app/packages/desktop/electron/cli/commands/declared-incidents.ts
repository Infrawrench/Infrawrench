// `infrawrench declared-incidents` — incidents your organization declared, with
// `infrawrench declared-incidents <id|title>` for one incident's assembled
// timeline.
//
// **The long name is the point.** `infrawrench incidents` was already taken, by
// the provider status-page correlation ("is it me or is it them?") — somebody
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
// The response shapes come from `@infrawrench/client-core` — the same
// definitions every other surface renders — so a server-side change breaks the
// CLI's build instead of its output. The imports are type-only, so the CLI
// still ships zero new runtime dependencies.
import { CliError, orgFetch, resolveOrg, type CliContext } from "../context";
import type {
  Incident,
  IncidentListResponse,
  IncidentTimelineResponse,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import { c, printJson, println, printTable, safe, type Column } from "../output";
import { formatChangeTime } from "../format";

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

export async function cmdDeclaredIncidents(ctx: CliContext, incidentArg?: string): Promise<void> {
  if (ctx.flags.local) {
    throw new CliError(
      "Incidents live in Infrawrench Cloud — an incident is org-scoped and declaring one composes cloud features. Drop --local.",
    );
  }
  const org = await resolveOrg(ctx);
  const { incidents } = await orgFetch<IncidentListResponse>(org.id, "/incidents");

  if (incidentArg) {
    const needle = incidentArg.toLowerCase();
    const incident =
      incidents.find((i) => i.id === incidentArg) ??
      incidents.find((i) => i.title.toLowerCase() === needle) ??
      incidents.find((i) => i.title.toLowerCase().includes(needle));
    if (!incident) {
      throw new CliError(
        `No incident matches "${incidentArg}". Run \`infrawrench declared-incidents\` to list.`,
      );
    }
    await printIncidentDetail(ctx, org.id, incident);
    return;
  }

  if (ctx.flags.output === "json") {
    printJson({ org: org.id, incidents });
    return;
  }

  if (incidents.length === 0) {
    println(c.dim("No incidents have been declared. Long may it last."));
    return;
  }

  const open = incidents.filter((i) => i.status !== "resolved").length;
  println(
    `${c.bold(safe(org.displayName))} ${c.dim(
      `· ${incidents.length} incident${incidents.length === 1 ? "" : "s"}`,
    )}${open > 0 ? `  ${c.red(`${open} not resolved`)}` : ""}`,
  );
  println();

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
  printTable(incidents, columns);

  println();
  println(
    c.dim(
      "`infrawrench declared-incidents <id|title>` prints one incident's assembled timeline. Declare and resolve from the Incidents tab.",
    ),
  );
}

/** One incident: its facts, its artefacts, and the joined timeline. */
async function printIncidentDetail(
  ctx: CliContext,
  orgId: string,
  incident: Incident,
): Promise<void> {
  const timeline = await orgFetch<IncidentTimelineResponse>(
    orgId,
    `/incidents/${encodeURIComponent(incident.id)}/timeline`,
  );

  if (ctx.flags.output === "json") {
    printJson({ org: orgId, incident, timeline });
    return;
  }

  println(`${severityCell(incident)} ${c.bold(safe(incident.title))}  ${statusCell(incident)}`);
  println(
    c.dim(
      `started ${formatChangeTime(incident.startedAt)} · ${duration(
        incident.startedAt,
        incident.resolvedAt,
      )}${incident.declaredByName ? ` · declared by ${safe(incident.declaredByName)}` : ""}`,
    ),
  );
  if (incident.summary) println(safe(incident.summary));
  println();

  // Artefacts first, and failures loudly: the point of recording a failed
  // artefact is that somebody sees it.
  if (incident.artifacts.length > 0) {
    for (const artifact of incident.artifacts) {
      const line = `${artifact.kind}: ${artifact.status}${artifact.label ? ` (${safe(artifact.label)})` : ""}`;
      println(
        isFailureStatus(artifact.status)
          ? c.red(`  ✗ ${line} — ${safe(artifact.error) || "no detail recorded"}`)
          : c.dim(`  · ${line}`),
      );
    }
    println();
  }

  const degraded = timeline.feeds.filter((f) => f.status !== "ok");
  if (degraded.length > 0) {
    println(
      c.dim(
        `feeds unavailable or not visible to you: ${degraded.map((f) => safe(f.feed)).join(", ")}`,
      ),
    );
    println();
  }

  if (timeline.entries.length === 0) {
    println(
      c.dim(
        "Nothing else was recorded in this window — the change feed, deploys and alerts were all quiet.",
      ),
    );
    return;
  }

  for (const entry of timeline.entries) {
    println(
      `${severityGlyph(entry.severity)} ${c.dim(formatChangeTime(entry.at).padEnd(16))} ${c.dim(
        safe(entry.source).padEnd(13),
      )} ${safe(entry.title)}`,
    );
    if (entry.detail) println(`  ${c.dim(safe(entry.detail))}`);
  }

  if (timeline.truncated) {
    println();
    println(c.dim("Timeline truncated — this window holds more events than one view can carry."));
  }
}
