// `infrawrench idle-rules`: the metric-based idle rules the connected
// providers declare (idle NAT gateways, load balancers, caches, provisioned
// tables, empty clusters, unused custom metrics), with the org's effective
// thresholds and each account's last collection, so an empty `orphans` list
// can be told apart from a credential that cannot read metrics.
//
// `idle-rules rescan` makes every account due on the next poller tick.
// Cloud only: the poller reads the metrics. Settings are edited in the app
// (Costs, Potential savings, Idle rules) or through the Terraform provider.
import type { IdleFindingsOverview } from "@infrawrench/client-core" with {
  "resolution-mode": "import",
};
import { formatIdleValue } from "../format";
import { orgFetch, resolveOrg, type CliContext } from "../context";
import { c, printJson, println, printTable, safe } from "../output";

export async function cmdIdleRules(ctx: CliContext, verb: string | undefined): Promise<void> {
  const org = await resolveOrg(ctx);

  if (verb === "rescan") {
    await orgFetch<{ ok: true }>(org.id, "/idle-findings/rescan", { method: "POST" });
    if (ctx.flags.output === "json") {
      printJson({ org: org.id, ok: true });
      return;
    }
    println("Every account is due for an idle collection on the next poller tick.");
    return;
  }

  const overview = await orgFetch<IdleFindingsOverview>(org.id, "/idle-findings");
  if (ctx.flags.output === "json") {
    printJson({ org: org.id, ...overview });
    return;
  }

  const { settings } = overview;
  println(
    `${c.bold(org.displayName)} ${c.dim(
      `· idle rules ${settings.enabled ? "on" : "off"} · ${settings.lookbackDays}-day lookback`,
    )}`,
  );
  if (overview.rules.length === 0) {
    println(c.dim("None of the loaded providers declare idle rules."));
    return;
  }

  printTable(overview.rules, [
    { header: "rule", value: (r) => safe(r.label) },
    { header: "provider", value: (r) => c.dim(safe(r.pluginName)) },
    {
      header: "on",
      value: (r) => (settings.enabled && r.enabled ? "yes" : c.dim("no")),
    },
    {
      header: "thresholds",
      value: (r) =>
        r.thresholds.length === 0
          ? c.dim("none")
          : r.thresholds
              .map(
                (t) =>
                  `${safe(t.label)} ${formatIdleValue(t.value, t.unit)}` +
                  (t.value !== t.default
                    ? c.dim(` (default ${formatIdleValue(t.default, t.unit)})`)
                    : ""),
              )
              .join("; "),
    },
  ]);

  if (overview.accounts.length > 0) {
    println();
    println(c.bold("Collection"));
    printTable(overview.accounts, [
      { header: "account", value: (a) => safe(a.accountName) },
      { header: "provider", value: (a) => c.dim(safe(a.pluginName)) },
      {
        header: "last read",
        value: (a) =>
          a.lastPolledAt ? a.lastPolledAt.slice(0, 16).replace("T", " ") : c.dim("not yet"),
      },
      { header: "flagged", value: (a) => String(a.findingCount), align: "right" },
      {
        header: "error",
        value: (a) =>
          a.lastError
            ? `${safe(a.lastError)}${a.helpUrl ? c.dim(` (${safe(a.helpUrl)})`) : ""}`
            : c.dim("none"),
      },
    ]);
  }
  println();
  println(
    c.dim(
      "Findings appear in `infrawrench orphans`. `infrawrench idle-rules rescan` re-reads now.",
    ),
  );
}
