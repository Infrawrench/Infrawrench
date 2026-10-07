// `infrawrench slos`: service-level objectives with their error budgets, and
// `infrawrench slos <id|name>` for one SLO's burn rates and charts.
//
// Cloud-only, like `probes`: SLOs are evaluated by the cloud poller over the
// cloud metric store. The CLI reads; writing SLOs lives on the web/desktop SLOs
// tab, where the probe and metric pickers are.
//
// Types come from `@infrawrench/client-core` type-only; the pure arithmetic
// (budget formatting, burndown) is loaded with a dynamic import, the main
// project's rule for client-core runtime code. Zero new runtime dependencies.
import { CliError, orgFetch, resolveOrg, type CliContext } from "../context";
import type { Slo, SloDetailResponse, SloListResponse } from "@infrawrench/client-core" with {
  "resolution-mode": "import",
};
import { c, printJson, println, printTable, safe, type Column } from "../output";
import { sparkline } from "../charts";
import { formatChangeTime } from "../format";

type Core = typeof import("@infrawrench/client-core", { with: { "resolution-mode": "import" } });

function statusCell(slo: Slo): string {
  if (!slo.enabled) return c.dim("○ disabled");
  switch (slo.status) {
    case "exhausted":
      return c.red("● budget spent");
    case "fast_burn":
      return c.red("● fast burn");
    case "slow_burn":
      return c.yellow("● slow burn");
    case "ok":
      return c.green("● ok");
    case "unknown":
      return c.dim("● no data");
  }
}

function budgetCell(core: Core, slo: Slo): string {
  if (slo.budgetRemaining === null || slo.budgetRemainingMinutes === null) return c.dim("-");
  if (slo.budgetRemaining <= 0) {
    return c.red(`over by ${core.formatBudgetDuration(slo.budgetRemainingMinutes)}`);
  }
  const text = `${Number((slo.budgetRemaining * 100).toFixed(1))}% (${core.formatBudgetDuration(slo.budgetRemainingMinutes)})`;
  return slo.budgetRemaining < 0.25 ? c.yellow(text) : text;
}

export async function cmdSlos(ctx: CliContext, sloArg?: string): Promise<void> {
  if (ctx.flags.local) {
    throw new CliError(
      "SLOs live in Infrawrench Cloud. The poller evaluates them over the cloud metric store. Drop --local.",
    );
  }
  const core: Core = await import("@infrawrench/client-core");
  const org = await resolveOrg(ctx);
  const { slos } = await orgFetch<SloListResponse>(org.id, "/slos");

  if (sloArg) {
    const needle = sloArg.toLowerCase();
    const slo =
      slos.find((s) => s.id === sloArg) ??
      slos.find((s) => s.name.toLowerCase() === needle) ??
      slos.find((s) => s.name.toLowerCase().includes(needle));
    if (!slo) throw new CliError(`No SLO matches "${sloArg}". Run \`infrawrench slos\` to list.`);
    await printSloDetail(ctx, core, org.id, slo.id);
    return;
  }

  if (ctx.flags.output === "json") {
    printJson({ org: org.id, slos });
    return;
  }

  if (slos.length === 0) {
    println(c.dim("No SLOs yet. Create one from the SLOs tab, from a probe or a resource metric."));
    return;
  }

  const sorted = [...slos].sort(
    (a, b) => core.compareSloStatus(a.status, b.status) || a.name.localeCompare(b.name),
  );
  const burning = slos.filter(
    (s) => s.enabled && (s.status === "exhausted" || s.status === "fast_burn"),
  ).length;
  println(
    `${c.bold(safe(org.displayName))} ${c.dim(`· ${slos.length} SLO${slos.length === 1 ? "" : "s"}`)}${
      burning > 0 ? `  ${c.red(`${burning} burning or spent`)}` : ""
    }`,
  );
  println();

  const columns: Column<Slo>[] = [
    { header: "", value: (s) => statusCell(s) },
    { header: "slo", value: (s) => safe(s.name) },
    {
      header: "sli / target",
      value: (s) =>
        `${s.sli === null ? c.dim("-") : core.formatSloPercent(s.sli)} ${c.dim(`/ ${core.formatSloTarget(s.targetPercent)}`)}`,
      align: "right",
    },
    { header: "window", value: (s) => c.dim(`${s.windowDays}d`), align: "right" },
    { header: "budget left", value: (s) => budgetCell(core, s), align: "right" },
    {
      header: "burn 1h",
      value: (s) => {
        const r = s.burnRates["1h"];
        return r === null || r === undefined ? c.dim("-") : core.formatBurnRate(r);
      },
      align: "right",
    },
    { header: "source", value: (s) => c.dim(safe(core.describeSloSource(s))) },
  ];
  printTable(sorted, columns);
  println();
  println(c.dim("`infrawrench slos <id|name>` shows one SLO's burn rates and budget burndown."));
}

async function printSloDetail(
  ctx: CliContext,
  core: Core,
  orgId: string,
  sloId: string,
): Promise<void> {
  const detail = await orgFetch<SloDetailResponse>(orgId, `/slos/${encodeURIComponent(sloId)}`);
  if (ctx.flags.output === "json") {
    printJson({ org: orgId, ...detail });
    return;
  }
  const { slo, buckets, activeFreeze } = detail;
  println(`${c.bold(safe(slo.name))}  ${statusCell(slo)}`);
  println(
    c.dim(
      `${safe(core.describeSloSource(slo))} · ${core.formatSloTarget(slo.targetPercent)} over ${slo.windowDays} days`,
    ),
  );
  if (slo.description) println(safe(slo.description));
  println();

  const facts = [
    `SLI ${slo.sli === null ? c.dim("no data") : core.formatSloPercent(slo.sli)}`,
    `budget ${budgetCell(core, slo)} of ${core.formatBudgetDuration(slo.budgetTotalMinutes)}`,
    `${Math.round(slo.totalEvents)} minutes measured`,
  ];
  if (slo.lastEvalAt) facts.push(c.dim(`evaluated ${formatChangeTime(slo.lastEvalAt)}`));
  println(facts.join(c.dim(" · ")));
  if (slo.lastError) println(c.yellow(safe(slo.lastError)));
  if (slo.status === "exhausted" && slo.suggestFreeze && !activeFreeze) {
    println(c.red("Error budget spent: consider a change freeze (start one from the SLOs tab)."));
  }
  if (activeFreeze) println(c.dim(`change freeze in effect: ${safe(activeFreeze.name)}`));

  println();
  println(c.bold("burn rates"));
  println(
    core.SLO_BURN_WINDOWS.map((w) => {
      const r = slo.burnRates[w];
      return `${c.dim(w)} ${r === null || r === undefined ? c.dim("-") : core.formatBurnRate(r)}`;
    }).join("   "),
  );
  for (const policy of core.SLO_BURN_POLICIES) {
    const threshold = core.sloBurnRateThreshold(policy, slo.windowDays);
    println(
      c.dim(
        `${policy.severity === "page" ? "page" : "ticket"} when ${policy.longWindow} and ${policy.shortWindow} both ≥ ${core.formatBurnRate(threshold)}`,
      ),
    );
  }

  const history = core.buildSloHistory(buckets, slo.targetPercent);
  println();
  if (history.dailySli.length === 0) {
    println(c.dim("No events in the window yet."));
    return;
  }
  const daily = history.dailySli.map((p) => p.value);
  println(`${c.dim("SLI per day     ")} ${sparkline(daily, Math.min(daily.length, 60))}`);
  const burndown = history.budgetBurndown.map((p) => p.value);
  if (burndown.length > 0) {
    println(`${c.dim("budget burndown ")} ${sparkline(burndown, Math.min(burndown.length, 60))}`);
    println(
      c.dim(
        `budget ${Math.round(burndown[0]!)}% → ${Math.round(burndown[burndown.length - 1]!)}% over the window`,
      ),
    );
  }
}
