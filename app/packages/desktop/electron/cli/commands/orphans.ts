// `infrawrench orphans` — likely-wasted resources (unattached volumes,
// unassigned IPs) with the plugin's reason for flagging each one.
//
// Works in both modes, because the classification is declarative and runs over
// stored state rather than a live provider call:
//   - cloud (default) — GET /orphans, the same endpoint the web + desktop Costs
//     panels' Potential savings section uses, with trailing per-resource spend
//     where the org collects it.
//   - --local — electron/local-orphans.ts scans this machine's SQLite
//     workspace. No credentials, no network. Spend is collected by the cloud,
//     so local rows carry no cost and the column is dropped rather than
//     printed as zero.
//
// The response shape comes from `@infrawrench/plugin-base` — the same
// definition the web and desktop savings sections use — so a server-side change
// breaks the CLI's build instead of its output. The import is type-only, so
// the CLI still ships zero new runtime dependencies.
import { orgFetch, resolveOrg, type CliContext } from "../context";
import { listLocalOrphans } from "../../local-orphans";
import type { OrphanListResponse } from "@infrawrench/plugin-base" with {
  "resolution-mode": "import",
};
import { c, formatMoney, printJson, println, printTable, type Column } from "../output";

type FlaggedResource = OrphanListResponse["accounts"][number]["resources"][number];

export async function cmdOrphans(ctx: CliContext): Promise<void> {
  const scope = ctx.flags.local
    ? { label: "Local workspace", response: await listLocalOrphans(), json: {} }
    : await (async () => {
        const org = await resolveOrg(ctx);
        return {
          label: org.displayName,
          response: await orgFetch<OrphanListResponse>(org.id, "/orphans"),
          json: { org: org.id },
        };
      })();
  const { response } = scope;
  // Cost annotation comes from collected billing rows, which only the cloud
  // has. Saying "$0.00" for every local row would be a lie; drop the column.
  const showCost = response.costBasis !== "unavailable";

  if (ctx.flags.output === "json") {
    printJson({ ...scope.json, ...response });
    return;
  }

  if (response.accounts.length === 0) {
    println(
      c.dim(
        "Nothing looks wasted. Resources are flagged when a plugin heuristic matches — an empty list is the good outcome.",
      ),
    );
    if (!showCost) {
      println(
        c.dim(
          "This scan covered the local workspace only; drop --local to classify what your cloud accounts sync.",
        ),
      );
    }
    return;
  }

  println(
    `${c.bold(scope.label)} ${c.dim(`· ${response.totalCount} flagged resource${response.totalCount === 1 ? "" : "s"}`)}`,
  );

  const columns: Column<FlaggedResource>[] = [
    { header: "resource", value: (r) => r.displayName },
    { header: "type", value: (r) => c.dim(r.resourceTypeName) },
    { header: "reason", value: (r) => r.reason },
  ];
  if (showCost) {
    columns.push({
      header: `cost (${response.costWindowDays}d)`,
      value: (r) => (r.cost ? formatMoney(r.cost.amount, r.cost.currency) : c.dim("—")),
      align: "right",
    });
  }

  for (const group of response.accounts) {
    println();
    println(`${c.bold(group.accountName)} ${c.dim(`· ${group.pluginName}`)}`);
    printTable(group.resources, columns);
  }

  println();
  println(
    c.dim(
      showCost
        ? "Cost figures are best-effort per-resource billing matches; most providers don't report them. Confirm a resource is unused before deleting it."
        : "Spend is collected by Infrawrench Cloud, so a local scan has no cost column — the flags never depend on billing data. Confirm a resource is unused before deleting it.",
    ),
  );
}
