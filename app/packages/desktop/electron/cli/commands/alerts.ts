// `infrawrench alerts` — metric threshold alert rules ("CPU > 90% for 15m")
// and `infrawrench alerts events`, their recent firings.
//
// Cloud-only, like `oversized`: rules are evaluated by the cloud poller
// against the cloud metrics warehouse, so a local workspace has nothing to
// list. The CLI lists; creating and editing rules lives on the web/desktop
// Metric alerts page.
//
// The response shapes come from `@infrawrench/client-core` — the same
// definitions every other surface renders — so a server-side change breaks
// the CLI's build instead of its output. The imports are type-only, so the
// CLI still ships zero new runtime dependencies.
import { CliError, orgFetch, resolveOrg, type CliContext } from "../context";
import type { MetricAlertEvent, MetricAlertRuleWithStatus } from "@infrawrench/client-core" with {
  "resolution-mode": "import",
};
import { c, printJson, println, printTable, type Column } from "../output";
import { formatChangeTime, formatMetricAlertCondition, formatMetricAlertSelector } from "../format";

export async function cmdAlerts(ctx: CliContext): Promise<void> {
  if (ctx.flags.local) {
    throw new CliError(
      "Metric alerts live in Infrawrench Cloud — the poller evaluates them server-side. Drop --local.",
    );
  }
  const org = await resolveOrg(ctx);
  const rules = await orgFetch<MetricAlertRuleWithStatus[]>(org.id, "/metric-alerts");

  if (ctx.flags.output === "json") {
    printJson({ org: org.id, rules });
    return;
  }

  if (rules.length === 0) {
    println(
      c.dim(
        'No metric alert rules yet. Create one from the Metric alerts page — e.g. "CPU % > 90 for 15m on plugin aws".',
      ),
    );
    return;
  }

  const firingTotal = rules.reduce((sum, r) => sum + r.firingCount, 0);
  println(
    `${c.bold(org.displayName)} ${c.dim(
      `· ${rules.length} rule${rules.length === 1 ? "" : "s"} · ${firingTotal} firing`,
    )}`,
  );
  println();

  const columns: Column<MetricAlertRuleWithStatus>[] = [
    {
      header: "",
      value: (r) => (r.firingCount > 0 ? c.red("●") : r.enabled ? c.green("●") : c.dim("○")),
    },
    { header: "rule", value: (r) => r.name },
    { header: "condition", value: (r) => formatMetricAlertCondition(r) },
    { header: "resources", value: (r) => c.dim(formatMetricAlertSelector(r)) },
    {
      header: "matches",
      value: (r) => String(r.matchingResourceCount),
      align: "right",
    },
    {
      header: "firing",
      value: (r) => (r.firingCount > 0 ? c.red(String(r.firingCount)) : c.dim("0")),
      align: "right",
    },
  ];
  printTable(rules, columns);

  println();
  println(
    c.dim(
      "Rules match resources by query (provider + type + tag), so resources created later are covered automatically. `infrawrench alerts events` shows recent firings.",
    ),
  );
}

export async function cmdAlertEvents(ctx: CliContext, limit?: number): Promise<void> {
  if (ctx.flags.local) {
    throw new CliError(
      "Metric alerts live in Infrawrench Cloud — the poller evaluates them server-side. Drop --local.",
    );
  }
  const org = await resolveOrg(ctx);
  const params = new URLSearchParams();
  if (limit) params.set("limit", String(Math.min(limit, 200)));
  const qs = params.toString();
  const events = await orgFetch<MetricAlertEvent[]>(
    org.id,
    `/metric-alerts/events${qs ? `?${qs}` : ""}`,
  );

  if (ctx.flags.output === "json") {
    printJson({ org: org.id, events });
    return;
  }

  if (events.length === 0) {
    println(c.dim("No metric alert firings recorded."));
    return;
  }

  println(
    `${c.bold(org.displayName)} ${c.dim(`· ${events.length} firing${events.length === 1 ? "" : "s"}, newest first`)}`,
  );
  println();

  const columns: Column<MetricAlertEvent>[] = [
    { header: "rule", value: (e) => e.ruleName },
    { header: "resource", value: (e) => e.resourceName },
    {
      header: "observed",
      value: (e) => String(Number(e.observedValue.toFixed(2))),
      align: "right",
    },
    { header: "fired", value: (e) => c.dim(formatChangeTime(e.firedAt)) },
    {
      header: "status",
      value: (e) =>
        e.status === "firing"
          ? c.red("firing")
          : c.green(`resolved${e.resolvedAt ? ` ${formatChangeTime(e.resolvedAt)}` : ""}`),
    },
  ];
  printTable(events, columns);
}
