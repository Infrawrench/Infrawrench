// `infrawrench probes` — synthetic HTTP uptime/latency checks, run on an
// interval from the egress proxy on Cloudflare's edge (an external vantage
// point), with `infrawrench probes <id|name>` for one probe's latency history.
//
// Cloud-only, like `alerts`: the checks run in the cloud poller and their
// results live in the cloud metric store, so a local workspace has nothing to
// list. The CLI lists; creating and editing probes lives on the web/desktop
// Probes tab (whose editor suggests endpoints from synced resources).
//
// The response shapes come from `@infrawrench/client-core` — the same
// definitions every other surface renders — so a server-side change breaks
// the CLI's build instead of its output. The imports are type-only, so the
// CLI still ships zero new runtime dependencies.
import { CliError, orgFetch, resolveOrg, type CliContext } from "../context";
import type {
  ProbeListResponse,
  ProbeMetricsResponse,
  SyntheticProbe,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import { c, printJson, println, printTable, type Column } from "../output";
import { sparkline } from "../charts";
import { formatChangeTime } from "../format";

function statusCell(probe: SyntheticProbe): string {
  if (!probe.enabled) return c.dim("○ disabled");
  switch (probe.status) {
    case "up":
      return c.green("● up");
    case "down":
      return c.red("● down");
    default:
      return c.yellow("● pending");
  }
}

function uptimeCell(probe: SyntheticProbe): string {
  if (probe.uptime24h === null) return c.dim("—");
  const pct = Number((probe.uptime24h * 100).toFixed(2));
  const text = `${pct}%`;
  if (pct >= 99.9) return c.green(text);
  if (pct >= 99) return c.yellow(text);
  return c.red(text);
}

export async function cmdProbes(ctx: CliContext, probeArg?: string): Promise<void> {
  if (ctx.flags.local) {
    throw new CliError(
      "Synthetic probes live in Infrawrench Cloud — the poller runs them through the egress proxy. Drop --local.",
    );
  }
  const org = await resolveOrg(ctx);
  const { probes } = await orgFetch<ProbeListResponse>(org.id, "/probes");

  if (probeArg) {
    const needle = probeArg.toLowerCase();
    const probe =
      probes.find((p) => p.id === probeArg) ??
      probes.find((p) => p.name.toLowerCase() === needle) ??
      probes.find((p) => p.name.toLowerCase().includes(needle));
    if (!probe) {
      throw new CliError(`No probe matches "${probeArg}". Run \`infrawrench probes\` to list.`);
    }
    await printProbeDetail(ctx, org.id, probe);
    return;
  }

  if (ctx.flags.output === "json") {
    printJson({ org: org.id, probes });
    return;
  }

  if (probes.length === 0) {
    println(
      c.dim(
        "No probes yet. Create one from the Probes tab — the editor suggests endpoints from your synced resources.",
      ),
    );
    return;
  }

  const down = probes.filter((p) => p.status === "down").length;
  println(
    `${c.bold(org.displayName)} ${c.dim(
      `· ${probes.length} probe${probes.length === 1 ? "" : "s"}`,
    )}${down > 0 ? `  ${c.red(`${down} down`)}` : ""}`,
  );
  println();

  const columns: Column<SyntheticProbe>[] = [
    { header: "", value: (p) => statusCell(p) },
    { header: "probe", value: (p) => p.name },
    { header: "endpoint", value: (p) => c.dim(`${p.method} ${p.url}`) },
    { header: "every", value: (p) => c.dim(`${p.intervalSeconds}s`), align: "right" },
    { header: "uptime 24h", value: (p) => uptimeCell(p), align: "right" },
    {
      header: "latency",
      value: (p) => (p.lastLatencyMs === null ? c.dim("—") : `${p.lastLatencyMs}ms`),
      align: "right",
    },
    {
      header: "checked",
      value: (p) => (p.lastProbeAt ? c.dim(formatChangeTime(p.lastProbeAt)) : c.dim("never")),
    },
  ];
  printTable(probes, columns);

  println();
  println(
    c.dim(
      "Probed from outside your infrastructure, so this is the internet's view. `infrawrench probes <id|name>` charts one probe's latency.",
    ),
  );
}

/** One probe: its settings, state, and a 24h latency sparkline. */
async function printProbeDetail(
  ctx: CliContext,
  orgId: string,
  probe: SyntheticProbe,
): Promise<void> {
  const endMs = Date.now();
  const startMs = endMs - 24 * 60 * 60 * 1000;
  const params = new URLSearchParams({ startMs: String(startMs), endMs: String(endMs) });
  const { series } = await orgFetch<ProbeMetricsResponse>(
    orgId,
    `/probes/${encodeURIComponent(probe.id)}/metrics?${params.toString()}`,
  );

  if (ctx.flags.output === "json") {
    printJson({ org: orgId, probe, series });
    return;
  }

  println(`${c.bold(probe.name)}  ${statusCell(probe)}`);
  println(c.dim(`${probe.method} ${probe.url} · every ${probe.intervalSeconds}s`));
  const facts: string[] = [];
  if (probe.uptime24h !== null) facts.push(`uptime 24h ${uptimeCell(probe)}`);
  if (probe.lastLatencyMs !== null) facts.push(`last ${probe.lastLatencyMs}ms`);
  if (probe.lastStatusCode !== null) facts.push(`HTTP ${probe.lastStatusCode}`);
  if (probe.status === "down" && probe.lastError) facts.push(c.red(probe.lastError));
  if (probe.lastProbeAt) facts.push(c.dim(`checked ${formatChangeTime(probe.lastProbeAt)}`));
  if (facts.length > 0) println(facts.join(c.dim(" · ")));

  // Match the latency series by label, falling back to unit so a server-side
  // label rename degrades to the right chart — never the 0/1 "Up" series.
  const latency = series.find((s) => s.label === "Latency") ?? series.find((s) => s.unit === "ms");
  const values = latency?.points.map((p) => p.value) ?? [];
  println();
  if (values.length === 0) {
    println(c.dim("No latency samples in the last 24 hours."));
  } else {
    const min = Math.round(Math.min(...values));
    const max = Math.round(Math.max(...values));
    println(`${c.dim("latency 24h")} ${sparkline(values, Math.min(values.length, 60))}`);
    println(c.dim(`min ${min}ms · max ${max}ms · ${values.length} samples`));
  }
}
