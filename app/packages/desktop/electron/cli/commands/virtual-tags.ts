// `infrawrench virtual-tags`: the keys the organization computes from its own
// ordered rules (one `team`, one `env`) rather than the tags providers report.
//
// Worth a terminal command because a virtual tag is only as good as its
// coverage. "How much spend did no rule match?" is the question someone asks
// before trusting a showback number, and `--json` lets a CI check fail when the
// unmatched share creeps up. Editing stays in Settings: a rule change
// re-answers every past cost question, and the editor previews that first.
//
// The wire types come from `@infrawrench/client-core`, type-only with the
// resolution-mode attribute (the CLI is CJS, client-core is ESM), so the CLI
// still ships zero runtime dependencies.
import { CliError, orgFetch, resolveOrg, type CliContext } from "../context";
import type {
  BusinessMetric,
  VirtualTag,
  VirtualTagProcessingState,
  VirtualTagStatus,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import { formatVirtualTagRule, matchVirtualTag, shareOfTotal } from "../format";
import { c, formatMoney, printJson, println, printTable, safe, type Column } from "../output";

/**
 * Restated from client-core's `VIRTUAL_TAG_PROCESSING_STATE_LABELS` (a runtime
 * const the CLI cannot import); the `Record` over the imported union makes a
 * state added upstream a build error here.
 */
const STATE_LABELS: Record<VirtualTagProcessingState, string> = {
  pending: "Queued",
  processing: "Processing",
  ready: "Ready",
  failed: "Failed",
};

function requireCloud(ctx: CliContext): void {
  if (ctx.flags.local) {
    throw new CliError(
      "Virtual tags live in Infrawrench Cloud. They are evaluated against collected spend, and " +
        "a local-only workspace has no collected spend to tag.",
    );
  }
}

function stateBadge(status: VirtualTagStatus): string {
  const label = STATE_LABELS[status.state] ?? status.state;
  switch (status.state) {
    case "ready":
      return c.green(label);
    case "failed":
      return c.red(label);
    case "processing":
      return c.cyan(label);
    default:
      return c.yellow(label);
  }
}

/**
 * Unmatched spend as "12.4%" (or "12.4% USD · 3.0% EUR" across currencies,
 * which are never merged). Null before a first successful evaluation.
 */
function unmatchedSummary(status: VirtualTagStatus): string | null {
  const stats = status.stats;
  if (!stats) return null;
  const parts = stats.currencies
    .map((cur) => {
      const share = shareOfTotal(cur.unmatched, cur.total);
      return share === null
        ? null
        : stats.currencies.length > 1
          ? `${share} ${cur.currency}`
          : share;
    })
    .filter((p): p is string => p !== null);
  return parts.length > 0 ? parts.join(" · ") : "no spend";
}

async function loadTags(orgId: string): Promise<VirtualTag[]> {
  return orgFetch<VirtualTag[]>(orgId, "/virtual-tags");
}

async function resolveTag(orgId: string, query: string): Promise<VirtualTag> {
  if (!query.trim()) throw new CliError("Give a virtual tag key, id or name.", 2);
  const tags = await loadTags(orgId);
  const found = matchVirtualTag(tags, query);
  if (found.match) return found.match;
  if (found.candidates.length === 0) {
    throw new CliError(
      `No virtual tag matches "${query}". \`infrawrench virtual-tags\` lists them.`,
    );
  }
  throw new CliError(
    `"${query}" matches ${found.candidates.length} virtual tags: ${found.candidates
      .map((t) => t.key)
      .join(", ")}.`,
  );
}

/** `infrawrench virtual-tags`: every tag with its status and coverage. */
export async function cmdVirtualTags(ctx: CliContext): Promise<void> {
  requireCloud(ctx);
  const org = await resolveOrg(ctx);
  const tags = await loadTags(org.id);

  if (ctx.flags.output === "json") {
    printJson({ org: org.id, tags });
    return;
  }

  if (tags.length === 0) {
    println(
      c.dim(
        "No virtual tags. Define one in Settings > Virtual tags to report on one team or env key " +
          "across every provider, however each account spelled its tags.",
      ),
    );
    return;
  }

  println(
    `${c.bold(org.displayName)} ${c.dim(`· ${tags.length} virtual tag${tags.length === 1 ? "" : "s"}`)}`,
  );
  println();

  const columns: Column<VirtualTag>[] = [
    { header: "key", value: (t) => c.bold(safe(t.key)) },
    { header: "name", value: (t) => safe(t.name) },
    { header: "rules", value: (t) => String(t.rules.length), align: "right" },
    { header: "default", value: (t) => (t.defaultValue ? safe(t.defaultValue) : c.dim("not set")) },
    { header: "status", value: (t) => stateBadge(t.status) },
    {
      header: "unmatched",
      value: (t) => unmatchedSummary(t.status) ?? c.dim("n/a"),
      align: "right",
    },
    {
      header: "values",
      value: (t) => (t.status.stats ? String(t.status.stats.distinctValues) : c.dim("n/a")),
      align: "right",
    },
  ];
  printTable(tags, columns);

  println();
  println(
    c.dim(
      "Use a key as virtual_tag['key'] in --where, or group by it with " +
        "`infrawrench costs --group-by virtual_tag:<key>`. Unmatched is the share of spend no rule " +
        "matched (it took the default value, or is not set).",
    ),
  );
}

/** `infrawrench virtual-tags show <key|id|name>`: one tag in full. */
export async function cmdVirtualTag(ctx: CliContext, query: string): Promise<void> {
  requireCloud(ctx);
  const org = await resolveOrg(ctx);
  const tag = await resolveTag(org.id, query);

  if (ctx.flags.output === "json") {
    printJson({ org: org.id, ...tag });
    return;
  }

  // Metric splits name a metric by id; resolve to names when the list is
  // readable. A caller without that permission still gets the ids.
  const hasMetricSplit = tag.rules.some((r) => r.kind === "metric_split");
  const metrics = hasMetricSplit
    ? await orgFetch<{ metrics: BusinessMetric[] }>(org.id, "/business-metrics")
        .then((r) => r.metrics ?? [])
        .catch(() => [] as BusinessMetric[])
    : [];
  const metricName = (id: string): string => safe(metrics.find((m) => m.id === id)?.name ?? id);

  printTag(tag, metricName);
}

function printTag(tag: VirtualTag, metricName: (id: string) => string): void {
  const { status } = tag;
  println(
    `${c.bold(safe(tag.name))} ${c.dim(`· virtual_tag['${safe(tag.key)}'] ·`)} ${stateBadge(status)}`,
  );
  if (tag.description) println(c.dim(safe(tag.description)));
  println();
  println(`  ${c.dim("id")}         ${tag.id}`);
  println(
    `  ${c.dim("default")}    ${tag.defaultValue ? safe(tag.defaultValue) : c.dim("not set")}`,
  );
  if (status.processedAt) println(`  ${c.dim("processed")}  ${status.processedAt}`);
  if (status.stats?.from && status.stats.to) {
    println(`  ${c.dim("evaluated")}  ${status.stats.from} → ${status.stats.to}`);
  }
  println(`  ${c.dim("updated")}    ${tag.updatedAt}`);
  if (status.state === "failed" && status.error) {
    println();
    println(`${c.red("!")} ${c.bold("last evaluation failed")}`);
    println(`  ${safe(status.error)}`);
  }

  // One table per currency would repeat the rules; the claimed amounts sit in
  // one column per currency instead, since currencies are never merged.
  const currencies = status.stats?.currencies ?? [];
  println();
  println(c.bold("Rules") + c.dim(" (first match wins)"));
  if (tag.rules.length === 0) {
    println(c.dim("  (none: every row takes the default value)"));
  } else {
    const rows = tag.rules.map((rule, index) => ({ rule, index }));
    const columns: Column<(typeof rows)[number]>[] = [
      { header: "#", value: (r) => String(r.index + 1), align: "right" },
      {
        header: "rule",
        value: (r) =>
          safe(formatVirtualTagRule(r.rule, metricName)) +
          (r.rule.description ? c.dim(`  ${safe(r.rule.description)}`) : ""),
      },
      ...currencies.map((cur): Column<(typeof rows)[number]> => ({
        header: `claims ${cur.currency}`,
        value: (r) => {
          const amount = cur.byRule[r.index];
          if (amount === undefined) return c.dim("n/a");
          const share = shareOfTotal(amount, cur.total);
          return `${formatMoney(amount, cur.currency)}${share ? c.dim(` ${share}`) : ""}`;
        },
        align: "right",
      })),
    ];
    printTable(rows, columns, { indent: 2 });
  }

  if (!status.stats) {
    println();
    println(
      c.dim(
        status.state === "failed"
          ? "No statistics yet: the tag has never evaluated successfully."
          : "No statistics yet: the first evaluation has not finished.",
      ),
    );
    return;
  }

  const stats = status.stats;
  println();
  println(c.bold("Coverage"));
  if (currencies.length === 0) {
    println(c.dim("  No spend in the evaluated range."));
  }
  for (const cur of currencies) {
    const share = shareOfTotal(cur.unmatched, cur.total);
    println(
      `  ${c.dim(cur.currency)}  total ${formatMoney(cur.total, cur.currency)}  ·  unmatched ` +
        `${formatMoney(cur.unmatched, cur.currency)}${share ? ` (${share})` : ""}`,
    );
  }
  println(`  ${c.dim("distinct values")}  ${stats.distinctValues}`);
  if (stats.metricFallbackDays > 0) {
    println(
      `  ${c.yellow("!")} ${stats.metricFallbackDays} day${stats.metricFallbackDays === 1 ? "" : "s"} ` +
        c.dim("a metric split had no complete metric values and reused the last good weights"),
    );
  }

  for (const cur of currencies) {
    if (cur.topValues.length === 0) continue;
    println();
    println(c.bold(`Top values`) + c.dim(` (${cur.currency})`));
    printTable(
      cur.topValues,
      [
        { header: "value", value: (v) => safe(v.value) },
        { header: "amount", value: (v) => formatMoney(v.amount, cur.currency), align: "right" },
        {
          header: "share",
          value: (v) => shareOfTotal(v.amount, cur.total) ?? c.dim("n/a"),
          align: "right",
        },
      ],
      { indent: 2 },
    );
  }
}

/**
 * `infrawrench virtual-tags reprocess <key|id|name>`: queue the background
 * evaluation again. Rules are unchanged, so no figure moves; this refreshes the
 * statistics (after new spend arrives, or to retry a failed pass).
 */
export async function cmdReprocessVirtualTag(ctx: CliContext, query: string): Promise<void> {
  requireCloud(ctx);
  const org = await resolveOrg(ctx);
  const target = await resolveTag(org.id, query);
  const tag = await orgFetch<VirtualTag>(
    org.id,
    `/virtual-tags/${encodeURIComponent(target.id)}/reprocess`,
    { method: "POST" },
  );

  if (ctx.flags.output === "json") {
    printJson({ org: org.id, ...tag });
    return;
  }

  println(
    `${c.green("✓")} ${c.bold(safe(tag.key))} ${c.dim("queued for reprocessing ·")} ${stateBadge(tag.status)}`,
  );
  println(
    c.dim(
      `Cost queries already use the current rules; this refreshes the statistics. ` +
        `Check progress with \`infrawrench virtual-tags show ${tag.key}\`.`,
    ),
  );
}
