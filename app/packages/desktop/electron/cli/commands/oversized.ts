// `infrawrench oversized` — right-sizing recommendations: machines whose p95
// CPU/memory over the last 14 days of stored metrics sits well under their
// size, with the cheapest catalog size that still clears headroom and the
// live-priced monthly saving.
//
// Cloud-only, unlike `orphans`: the percentiles live in the cloud metrics
// warehouse and the size catalogs come from the providers with the org's
// credentials — a local workspace has neither. Applying a recommendation is a
// provider mutation (most providers want the machine stopped first), so the
// CLI lists and the web/desktop Apply button applies.
//
// The response shape comes from `@infrawrench/client-core` — the same
// definition every other surface renders — so a server-side change breaks the
// CLI's build instead of its output. The import is type-only, so the CLI
// still ships zero new runtime dependencies.
import { orgFetch, resolveOrg, type CliContext } from "../context";
import type { RightsizingListResponse } from "@infrawrench/client-core" with {
  "resolution-mode": "import",
};
import { c, formatMoney, printJson, println, printTable, type Column } from "../output";

type Oversized = RightsizingListResponse["accounts"][number]["resources"][number];

export async function cmdOversized(ctx: CliContext): Promise<void> {
  const org = await resolveOrg(ctx);
  const response = await orgFetch<RightsizingListResponse>(org.id, "/rightsizing");

  if (ctx.flags.output === "json") {
    printJson({ org: org.id, ...response });
    return;
  }

  if (response.accounts.length === 0) {
    println(
      c.dim(
        "Nothing looks oversized. A machine is flagged when two weeks of stored metrics put its p95 CPU (and memory, where measured) well under its size — metrics are stored for resources pinned to a dashboard.",
      ),
    );
    return;
  }

  println(
    `${c.bold(org.displayName)} ${c.dim(
      `· ${response.totalCount} oversized resource${response.totalCount === 1 ? "" : "s"} · last ${response.windowDays}d`,
    )}`,
  );

  const columns: Column<Oversized>[] = [
    { header: "resource", value: (r) => r.displayName },
    { header: "type", value: (r) => c.dim(r.resourceTypeName) },
    { header: "size", value: (r) => `${r.currentSize.label} → ${r.recommendedSize.label}` },
    {
      header: "p95 cpu",
      value: (r) => `${r.cpuP95}%`,
      align: "right",
    },
    {
      header: "p95 mem",
      value: (r) => (r.memoryMeasured && r.memoryP95 !== null ? `${r.memoryP95}%` : c.dim("n/a")),
      align: "right",
    },
    {
      header: "saving/mo",
      value: (r) =>
        r.monthlySaving !== null ? formatMoney(r.monthlySaving, r.currency) : c.dim("—"),
      align: "right",
    },
  ];

  for (const group of response.accounts) {
    println();
    println(`${c.bold(group.accountName)} ${c.dim(`· ${group.pluginName}`)}`);
    printTable(group.resources, columns);
  }

  println();
  println(
    c.dim(
      "Savings are quoted from each provider's live size catalog. Apply a resize from the web or desktop Costs panel — it goes through the normal resource update (change freezes and audit logging apply), and most providers require the machine to be stopped first.",
    ),
  );
}
