// `infrawrench blast-radius <resource-id>` — what breaks if a resource is
// deleted, from the same /blast-radius endpoint the delete dialog and the
// resource-detail tab read.
//
// It is a command of its own rather than a flag on `graph` because the report
// is not a graph: two thirds of it (soft references and measured traffic) do
// not exist as edges, and the server assembles all three together. `graph
// --resource` keeps its own blast-radius count, which is the graph's answer;
// this is the whole answer.
import { CliError, orgFetch, resolveOrg, type CliContext } from "../context";
import type { BlastRadiusReport } from "@infrawrench/client-core" with {
  "resolution-mode": "import",
};
import { c, printJson, println } from "../output";

export async function cmdBlastRadius(ctx: CliContext, resourceId: string | undefined) {
  if (ctx.flags.local) {
    throw new CliError(
      "The impact report is assembled by Infrawrench Cloud — it reads the org's dashboards, probes, leases and flow data, none of which a local workspace has.",
    );
  }
  if (!resourceId) {
    throw new CliError("Usage: infrawrench blast-radius <resource-id>  (see `infrawrench ls`)");
  }
  const org = await resolveOrg(ctx);
  const report = await orgFetch<BlastRadiusReport>(
    org.id,
    `/blast-radius?resourceId=${encodeURIComponent(resourceId)}`,
  );

  if (ctx.flags.output === "json") {
    printJson({ org: org.id, ...report });
    return;
  }

  println(c.bold(report.resource?.displayName ?? resourceId));
  println(report.headline);
  println();

  if (report.dependants.length > 0) {
    println(c.bold("Depended on by"));
    for (const d of report.dependants) {
      const distance = d.depth === 1 ? c.red("direct") : c.dim(`${d.depth} hops`);
      println(
        `  ${d.node.displayName}  ${c.dim(`${d.node.resourceTypeLabel} · ${d.node.accountName}`)}  ${distance}`,
      );
    }
    println();
  }

  if (report.references.length > 0) {
    println(c.bold("Points at it"));
    for (const ref of report.references) {
      const suffix = ref.userFacing ? `  ${c.red("customer-visible")}` : "";
      println(
        `  ${c.dim(`[${ref.kind}]`)} ${ref.name}${ref.detail ? c.dim(` — ${ref.detail}`) : ""}${suffix}`,
      );
    }
    println();
  }

  if (report.flowPeers.length > 0) {
    println(c.bold("Talks to"));
    for (const peer of report.flowPeers) {
      const arrow = peer.direction === "egress" ? "→" : "←";
      println(`  ${arrow} ${peer.label}  ${c.dim(`${peer.scope} · ${formatBytes(peer.bytes)}`)}`);
    }
    println();
  }

  // Always printed, including on an otherwise empty report — a silent gap is
  // how "we could not look" gets read as "there is nothing there".
  if (report.unchecked.length > 0) {
    println(c.bold("Not checked"));
    for (const gap of report.unchecked) println(`  ${c.dim(gap.reason)}`);
  } else {
    println(c.dim("Everything this report can look at was checked."));
  }
}

/** Decimal units, matching the network-costs surfaces (`formatFlowBytes`). */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "kB", "MB", "GB", "TB", "PB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
