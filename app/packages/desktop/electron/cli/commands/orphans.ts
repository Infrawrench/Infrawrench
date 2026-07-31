// `infrawrench orphans` — likely-wasted resources (unattached volumes,
// unassigned IPs) across the org's accounts, backed by the same /orphans API
// the web + desktop Costs panels' Potential savings section uses.
//
// The response shape comes from `@infrawrench/client-core` — the same
// definition the web and desktop savings sections use — so a server-side change
// breaks the CLI's build instead of its output. The import is type-only, so
// the CLI still ships zero new runtime dependencies.
import { CliError, orgFetch, resolveOrg, type CliContext } from "../context";
import type { OrphanListResponse } from "@infrawrench/client-core" with {
  "resolution-mode": "import",
};
import { c, formatMoney, printJson, println, printTable } from "../output";

export async function cmdOrphans(ctx: CliContext): Promise<void> {
  if (ctx.flags.local) {
    throw new CliError(
      "Orphan detection runs on Infrawrench Cloud over your org's synced resources — there is no local aggregate.",
    );
  }
  const org = await resolveOrg(ctx);
  const response = await orgFetch<OrphanListResponse>(org.id, "/orphans");

  if (ctx.flags.output === "json") {
    printJson({ org: org.id, ...response });
    return;
  }

  if (response.accounts.length === 0) {
    println(
      c.dim(
        "Nothing looks wasted. Resources are flagged when a plugin heuristic matches — an empty list is the good outcome.",
      ),
    );
    return;
  }

  println(
    `${c.bold(org.displayName)} ${c.dim(`· ${response.totalCount} flagged resource${response.totalCount === 1 ? "" : "s"}`)}`,
  );

  for (const group of response.accounts) {
    println();
    println(`${c.bold(group.accountName)} ${c.dim(`· ${group.pluginName}`)}`);
    printTable(group.resources, [
      { header: "resource", value: (r) => r.displayName },
      { header: "type", value: (r) => c.dim(r.resourceTypeName) },
      { header: "reason", value: (r) => r.reason },
      {
        header: `cost (${response.costWindowDays}d)`,
        value: (r) => (r.cost ? formatMoney(r.cost.amount, r.cost.currency) : c.dim("—")),
        align: "right",
      },
    ]);
  }

  println();
  println(
    c.dim(
      "Cost figures are best-effort per-resource billing matches; most providers don't report them. Confirm a resource is unused before deleting it.",
    ),
  );
}
