// `infrawrench incidents` — "is it me or is it them?" in the terminal.
//
// Backed by the same /status-incidents endpoint the web banner and Changes
// page read: the cloud poller watches each provider plugin's public status
// feed, caches active incidents, and the endpoint correlates them against the
// resources the org holds — by region, resource type, or provider-wide scope.
//
// Wire types come from `@infrawrench/client-core` — the same definitions every
// other surface renders with, so a server-side change breaks the CLI's build
// instead of its output.
import { CliError, orgFetch, resolveOrg, type CliContext } from "../context";
import type { OrgStatusIncident } from "@infrawrench/client-core" with {
  "resolution-mode": "import",
};
import { c, printJson, println, printTable } from "../output";
import { formatChangeTime } from "../format";

const IMPACT_STYLE: Record<string, { label: string; color: (s: string) => string }> = {
  critical: { label: "critical", color: c.red },
  major: { label: "major", color: c.yellow },
  minor: { label: "minor", color: c.yellow },
  maintenance: { label: "maint", color: c.dim },
};

export async function cmdIncidents(ctx: CliContext): Promise<void> {
  if (ctx.flags.local) {
    throw new CliError(
      "Provider status correlation is computed by Infrawrench Cloud's poller, which watches each provider's public status feed — local-only mode has no poller, so there is nothing to correlate.",
    );
  }
  const org = await resolveOrg(ctx);

  const response = await orgFetch<{ entries?: never; incidents: OrgStatusIncident[] }>(
    org.id,
    "/status-incidents",
  );

  if (ctx.flags.output === "json") {
    printJson({ org: org.id, incidents: response.incidents });
    return;
  }

  const incidents = response.incidents;
  if (incidents.length === 0) {
    println(
      c.dim(
        "No provider incidents overlap this organization — every provider status feed we watch is clear.",
      ),
    );
    return;
  }

  const active = incidents.filter((i) => !i.resolvedAt);
  println(
    `${c.bold(org.displayName)} ${c.dim(
      `· ${active.length} active provider incident${active.length === 1 ? "" : "s"}, ` +
        `${incidents.length - active.length} resolved in the last 24h`,
    )}`,
  );
  println();

  printTable(incidents, [
    {
      header: "impact",
      value: (i) => {
        if (i.resolvedAt) return c.dim("resolved");
        const style = IMPACT_STYLE[i.impact] ?? IMPACT_STYLE["minor"]!;
        return style.color(style.label);
      },
    },
    { header: "provider", value: (i) => c.bold(i.pluginName) },
    { header: "incident", value: (i) => i.title },
    {
      header: "scope",
      value: (i) =>
        i.providerWide
          ? c.dim("provider-wide")
          : i.affectedRegions.length > 0
            ? i.affectedRegions.join(", ")
            : c.dim(i.services.slice(0, 3).join(", ") || "—"),
    },
    {
      header: "your resources",
      value: (i) => (i.affectedResourceCount > 0 ? c.yellow(String(i.affectedResourceCount)) : "0"),
    },
    {
      header: "changes during",
      value: (i) => (i.overlappingChangeCount > 0 ? String(i.overlappingChangeCount) : c.dim("0")),
    },
    { header: "since", value: (i) => c.dim(formatChangeTime(i.startedAt)) },
  ]);

  for (const incident of incidents) {
    if (incident.sampleResources.length === 0) continue;
    println();
    println(
      `${c.bold(incident.pluginName)} ${c.dim("affects")} ${incident.sampleResources
        .map((r) => r.displayName + (r.region ? c.dim(` (${r.region})`) : ""))
        .join(", ")}${
        incident.affectedResourceCount > incident.sampleResources.length
          ? c.dim(` and ${incident.affectedResourceCount - incident.sampleResources.length} more`)
          : ""
      }`,
    );
    if (incident.url) println(c.dim(`  ${incident.url}`));
  }
}
