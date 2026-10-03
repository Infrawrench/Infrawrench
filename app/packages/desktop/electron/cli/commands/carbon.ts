// `infrawrench carbon`: the org's estimated operational CO2e, the counterpart
// to `infrawrench costs` for the same estate.
//
// Cloud-only: the estimate resolves instance types to vCPUs through each
// provider's size catalogue with the org's credentials, which a local
// workspace does not hold for this path.
//
// The text output keeps the same three honesty rules the Costs page does: the
// count of what could *not* be estimated sits beside the total, the
// assumptions print under it, and nothing reads as measured.
//
// The response shape comes from `@infrawrench/client-core`; the import is
// type-only, so the CLI still ships zero new runtime dependencies.
import { orgFetch, resolveOrg, type CliContext } from "../context";
import type { CarbonEstimate } from "@infrawrench/client-core" with {
  "resolution-mode": "import",
};
import type { RangeFlags } from "../args";
import { resolveDayWindow } from "../args";
import { c, formatCo2e, printJson, println, printTable, type Column } from "../output";
import { barChart } from "../charts";

const REASONS: Record<string, string> = {
  "unsupported-provider": "no published grid figures",
  "unknown-region": "region not in the coefficient set",
  "unknown-size": "no vCPU count synced",
};

type Row = CarbonEstimate["rows"][number];

export async function cmdCarbon(ctx: CliContext, range: RangeFlags): Promise<void> {
  const org = await resolveOrg(ctx);
  const windowDays = resolveDayWindow(range, 30, 365);
  const estimate = await orgFetch<CarbonEstimate>(org.id, `/carbon?windowDays=${windowDays}`);

  if (ctx.flags.output === "json") {
    printJson(estimate);
    return;
  }

  println(
    `${c.bold(`~${formatCo2e(estimate.totalKgCo2e)} CO2e`)} ${c.dim(
      `· estimated · ${org.displayName} · last ${estimate.windowDays}d · ${Math.round(estimate.totalKwh)} kWh`,
    )}`,
  );
  // Beside the total, not at the bottom: a figure covering a third of an
  // estate must not read as a complete answer.
  const gaps = estimate.unestimatedCount;
  println(
    `${estimate.estimatedCount} resource${estimate.estimatedCount === 1 ? "" : "s"} estimated · ${
      gaps > 0 ? c.yellow(`${gaps} could not be estimated`) : "none left out"
    }${estimate.duplicateCount > 0 ? c.dim(` · ${estimate.duplicateCount} nodes counted as their instance`) : ""}`,
  );

  if (estimate.byProvider.length > 0) {
    println();
    println(c.bold("By provider"));
    for (const line of barChart(
      estimate.byProvider.map((g) => ({
        label: g.label,
        value: g.kgCo2e,
        display: formatCo2e(g.kgCo2e),
      })),
    )) {
      println(line);
    }
  }

  if (estimate.byRegion.length > 0) {
    println();
    println(c.bold("By region"));
    for (const line of barChart(
      estimate.byRegion.slice(0, 12).map((g) => ({
        label: g.label,
        value: g.kgCo2e,
        display: formatCo2e(g.kgCo2e),
      })),
    )) {
      println(line);
    }
  }

  if (estimate.rows.length > 0) {
    println();
    println(c.bold("Heaviest resources"));
    const columns: Column<Row>[] = [
      { header: "resource", value: (r) => r.displayName },
      { header: "provider", value: (r) => c.dim(r.pluginId) },
      { header: "region", value: (r) => r.region },
      { header: "vcpu", value: (r) => String(r.vcpus * r.count), align: "right" },
      { header: "g/kWh", value: (r) => String(Math.round(r.gridIntensity)), align: "right" },
      { header: "co2e", value: (r) => formatCo2e(r.kgCo2e), align: "right" },
    ];
    printTable(estimate.rows.slice(0, 15), columns);
  }

  if (estimate.unestimated.length > 0) {
    println();
    println(c.bold("Not estimated, and why"));
    for (const row of estimate.unestimated.slice(0, 20)) {
      println(
        `  ${row.displayName} ${c.dim(`${row.pluginId} · ${REASONS[row.reason] ?? row.reason}`)}`,
      );
    }
    if (estimate.unestimatedCount > 20) {
      println(c.dim(`  … and ${estimate.unestimatedCount - 20} more (--output json for all)`));
    }
  }

  println();
  const a = estimate.assumptions;
  println(c.dim(`Assumes ${Math.round(a.cpuUtilization * 100)}% average CPU utilisation.`));
  println(c.dim(`Grid figures: ${a.coefficientSource} (${a.coefficientVintage}).`));
  println(c.dim(a.scope));
}
