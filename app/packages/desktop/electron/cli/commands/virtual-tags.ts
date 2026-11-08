// `infrawrench virtual-tags`: the keys the organization computes from its own
// ordered rules (one `team`, one `env`) rather than the tags providers report.
//
// Worth a terminal command because a virtual tag is only as good as its
// coverage. "How much spend did no rule match?" is the question someone asks
// before trusting a showback number, and `--json` lets a CI check fail when the
// unmatched share creeps up. Editing stays in Settings: a rule change
// re-answers every past cost question, and the editor previews that first.
//
// The response schemas are checked against `@infrawrench/client-core` by
// `wire`, type-only, so the CLI still ships zero runtime dependencies.
import { Effect, Schema } from "effect";
import { Argument, Command } from "effect/cli";
import type {
  BusinessMetric,
  VirtualTag,
  VirtualTagProcessingState,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import { bestEffort, CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import { CliFailure, CliUsageError } from "../effect/errors";
import * as Print from "../effect/print";
import { CliSession } from "../effect/session";
import { decodePaired, spreadBody, wire } from "../effect/wire";
import { formatVirtualTagRule, matchVirtualTag, shareOfTotal } from "../format";
import { c, formatMoney, safe, type Column } from "../output";

/**
 * Restated from client-core's `VIRTUAL_TAG_PROCESSING_STATE_LABELS` (a runtime
 * const the CLI cannot import); the `satisfies` over the imported union makes
 * a state removed upstream a build error here, and a state a newer server adds
 * prints as itself.
 */
const STATE_LABELS: Partial<Record<string, string>> = {
  pending: "Queued",
  processing: "Processing",
  ready: "Ready",
  failed: "Failed",
} satisfies Record<VirtualTagProcessingState, string>;

const Rule = Schema.Struct({
  query: Schema.String,
  description: Schema.NullOr(Schema.String),
  startsOn: Schema.NullOr(Schema.String),
  endsOn: Schema.NullOr(Schema.String),
  kind: Schema.String,
  value: Schema.NullOr(Schema.String),
  sources: Schema.Array(
    Schema.Struct({ tagKey: Schema.String, valuePrefix: Schema.NullOr(Schema.String) }),
  ),
  valueTransform: Schema.String,
  allocations: Schema.Array(
    Schema.Struct({
      value: Schema.String,
      percent: Schema.NullOr(Schema.Finite),
      metricId: Schema.NullOr(Schema.String),
    }),
  ),
});

const Status = Schema.Struct({
  state: Schema.String,
  processedAt: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  stats: Schema.NullOr(
    Schema.Struct({
      from: Schema.NullOr(Schema.String),
      to: Schema.NullOr(Schema.String),
      currencies: Schema.Array(
        Schema.Struct({
          currency: Schema.String,
          total: Schema.Finite,
          unmatched: Schema.Finite,
          byRule: Schema.Array(Schema.Finite),
          topValues: Schema.Array(Schema.Struct({ value: Schema.String, amount: Schema.Finite })),
        }),
      ),
      metricFallbackDays: Schema.Finite,
      distinctValues: Schema.Finite,
    }),
  ),
});
type Status = typeof Status.Type;

const Tag = wire<VirtualTag>()(
  Schema.Struct({
    id: Schema.String,
    key: Schema.String,
    name: Schema.String,
    description: Schema.NullOr(Schema.String),
    defaultValue: Schema.NullOr(Schema.String),
    rules: Schema.Array(Rule),
    status: Status,
    updatedAt: Schema.String,
  }),
);
type Tag = typeof Tag.Type;
const Tags = Schema.Array(Tag);

const Metrics = wire<{ metrics: BusinessMetric[] }>()(
  Schema.Struct({
    metrics: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
  }),
);

const TAGS_PATH = "/virtual-tags";

const refuseLocal = Effect.gen(function* () {
  const session = yield* CliSession;
  if (session.local) {
    return yield* new CliFailure({
      message:
        "Virtual tags live in Infrawrench Cloud. They are evaluated against collected spend, and " +
        "a local-only workspace has no collected spend to tag.",
    });
  }
});

function stateBadge(status: Status): string {
  const label = safe(STATE_LABELS[status.state] ?? status.state);
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
function unmatchedSummary(status: Status): string | null {
  const stats = status.stats;
  if (!stats) return null;
  const parts = stats.currencies.flatMap((cur) => {
    const share = shareOfTotal(cur.unmatched, cur.total);
    if (share === null) return [];
    return [stats.currencies.length > 1 ? `${share} ${safe(cur.currency)}` : share];
  });
  return parts.length > 0 ? parts.join(" · ") : "no spend";
}

/** A key, id or name to exactly one tag, beside the element the server sent. */
const resolveTag = Effect.fnUntraced(function* (orgId: string, query: string) {
  if (!query.trim()) {
    return yield* new CliUsageError({ message: "Give a virtual tag key, id or name." });
  }
  const api = yield* CloudApi;
  const tags = yield* decodePaired(Tags, TAGS_PATH)(yield* api.json(orgId, TAGS_PATH));
  const found = matchVirtualTag(
    tags.map((t) => ({ id: t.row.id, key: t.row.key, name: t.row.name, paired: t })),
    query,
  );
  if (found.match) return found.match.paired;
  return yield* new CliFailure({
    message:
      found.candidates.length === 0
        ? `No virtual tag matches "${query}". \`infrawrench virtual-tags\` lists them.`
        : `"${query}" matches ${found.candidates.length} virtual tags: ${found.candidates
            .map((t) => t.key)
            .join(", ")}.`,
  });
});

/** `infrawrench virtual-tags show <key|id|name>`: one tag in full. */
const showTag = Effect.fnUntraced(function* (query: string) {
  yield* refuseLocal;
  const session = yield* CliSession;
  const api = yield* CloudApi;
  const org = yield* currentOrg;
  const { row: tag, raw } = yield* resolveTag(org.id, query);

  if (session.output === "json") {
    return yield* Print.json(yield* spreadBody({ org: org.id }, raw, TAGS_PATH));
  }

  // Metric splits name a metric by id; resolve to names when the list is
  // readable. A caller without that permission still gets the ids.
  const hasMetricSplit = tag.rules.some((r) => r.kind === "metric_split");
  const metrics = hasMetricSplit
    ? yield* api.decode(Metrics, org.id, "/business-metrics").pipe(
        Effect.map((r) => r.metrics),
        bestEffort((): typeof Metrics.Type.metrics => []),
      )
    : [];
  const metricName = (id: string): string => safe(metrics.find((m) => m.id === id)?.name ?? id);

  yield* printTag(tag, metricName);
});

const printTag = Effect.fnUntraced(function* (tag: Tag, metricName: (id: string) => string) {
  const { status } = tag;
  yield* Print.line(
    `${c.bold(safe(tag.name))} ${c.dim(`· virtual_tag['${safe(tag.key)}'] ·`)} ${stateBadge(status)}`,
  );
  if (tag.description) yield* Print.line(c.dim(safe(tag.description)));
  yield* Print.line();
  yield* Print.line(`  ${c.dim("id")}         ${safe(tag.id)}`);
  yield* Print.line(
    `  ${c.dim("default")}    ${tag.defaultValue ? safe(tag.defaultValue) : c.dim("not set")}`,
  );
  if (status.processedAt) {
    yield* Print.line(`  ${c.dim("processed")}  ${safe(status.processedAt)}`);
  }
  if (status.stats?.from && status.stats.to) {
    yield* Print.line(
      `  ${c.dim("evaluated")}  ${safe(status.stats.from)} → ${safe(status.stats.to)}`,
    );
  }
  yield* Print.line(`  ${c.dim("updated")}    ${safe(tag.updatedAt)}`);
  if (status.state === "failed" && status.error) {
    yield* Print.line();
    yield* Print.line(`${c.red("!")} ${c.bold("last evaluation failed")}`);
    yield* Print.line(`  ${safe(status.error)}`);
  }

  // One table per currency would repeat the rules; the claimed amounts sit in
  // one column per currency instead, since currencies are never merged.
  const currencies = status.stats?.currencies ?? [];
  yield* Print.line();
  yield* Print.line(c.bold("Rules") + c.dim(" (first match wins)"));
  if (tag.rules.length === 0) {
    yield* Print.line(c.dim("  (none: every row takes the default value)"));
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
        header: `claims ${safe(cur.currency)}`,
        value: (r) => {
          const amount = cur.byRule[r.index];
          if (amount === undefined) return c.dim("n/a");
          const share = shareOfTotal(amount, cur.total);
          return `${formatMoney(amount, cur.currency)}${share ? c.dim(` ${share}`) : ""}`;
        },
        align: "right",
      })),
    ];
    yield* Print.table(rows, columns, { indent: 2 });
  }

  const stats = status.stats;
  if (!stats) {
    yield* Print.line();
    return yield* Print.line(
      c.dim(
        status.state === "failed"
          ? "No statistics yet: the tag has never evaluated successfully."
          : "No statistics yet: the first evaluation has not finished.",
      ),
    );
  }

  yield* Print.line();
  yield* Print.line(c.bold("Coverage"));
  if (currencies.length === 0) yield* Print.line(c.dim("  No spend in the evaluated range."));
  for (const cur of currencies) {
    const share = shareOfTotal(cur.unmatched, cur.total);
    yield* Print.line(
      `  ${c.dim(safe(cur.currency))}  total ${formatMoney(cur.total, cur.currency)}  ·  unmatched ` +
        `${formatMoney(cur.unmatched, cur.currency)}${share ? ` (${share})` : ""}`,
    );
  }
  yield* Print.line(`  ${c.dim("distinct values")}  ${stats.distinctValues}`);
  if (stats.metricFallbackDays > 0) {
    yield* Print.line(
      `  ${c.yellow("!")} ${stats.metricFallbackDays} day${stats.metricFallbackDays === 1 ? "" : "s"} ` +
        c.dim("a metric split had no complete metric values and reused the last good weights"),
    );
  }

  for (const cur of currencies) {
    if (cur.topValues.length === 0) continue;
    yield* Print.line();
    yield* Print.line(c.bold(`Top values`) + c.dim(` (${safe(cur.currency)})`));
    yield* Print.table(
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
});

const query = Argument.String("key|id|name").pipe(
  Argument.withDescription("The tag (the words join into one name)"),
  Argument.variadic(),
);

const show = Command.make(
  "show",
  { query },
  Effect.fn("virtual-tags.show")(function* (input) {
    yield* showTag(input.query.join(" "));
  }),
).pipe(
  Command.withDescription(
    "One tag in full: rules, processing status, spend each rule claims and the share left unmatched",
  ),
);

/**
 * `infrawrench virtual-tags reprocess <key|id|name>`: queue the background
 * evaluation again. Rules are unchanged, so no figure moves; this refreshes the
 * statistics (after new spend arrives, or to retry a failed pass).
 */
const reprocess = Command.make(
  "reprocess",
  { query },
  Effect.fn("virtual-tags.reprocess")(function* (input) {
    yield* refuseLocal;
    const session = yield* CliSession;
    const api = yield* CloudApi;
    const org = yield* currentOrg;
    const { row: target } = yield* resolveTag(org.id, input.query.join(" "));
    const path = `${TAGS_PATH}/${encodeURIComponent(target.id)}/reprocess`;
    const body = yield* api.json(org.id, path, { method: "POST" });

    if (session.output === "json") {
      return yield* Print.json(yield* spreadBody({ org: org.id }, body, path));
    }
    const tag = yield* decodeBody(Tag, path)(body);
    yield* Print.line(
      `${c.green("✓")} ${c.bold(safe(tag.key))} ${c.dim("queued for reprocessing ·")} ${stateBadge(tag.status)}`,
    );
    yield* Print.line(
      c.dim(
        `Cost queries already use the current rules; this refreshes the statistics. ` +
          `Check progress with \`infrawrench virtual-tags show ${safe(tag.key)}\`.`,
      ),
    );
  }),
).pipe(Command.withDescription("Re-run a tag's background evaluation over the stored history now"));

/** `infrawrench virtual-tags`: every tag with its status and coverage. */
const listTags = Effect.fnUntraced(function* () {
  yield* refuseLocal;
  const session = yield* CliSession;
  const api = yield* CloudApi;
  const org = yield* currentOrg;
  const body = yield* api.json(org.id, TAGS_PATH);

  if (session.output === "json") return yield* Print.json({ org: org.id, tags: body });
  const tags = yield* decodeBody(Tags, TAGS_PATH)(body);

  if (tags.length === 0) {
    return yield* Print.line(
      c.dim(
        "No virtual tags. Define one in Settings > Virtual tags to report on one team or env key " +
          "across every provider, however each account spelled its tags.",
      ),
    );
  }

  yield* Print.line(
    `${c.bold(safe(org.displayName))} ${c.dim(`· ${tags.length} virtual tag${tags.length === 1 ? "" : "s"}`)}`,
  );
  yield* Print.line();

  yield* Print.table(tags, [
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
  ]);

  yield* Print.line();
  yield* Print.line(
    c.dim(
      "Use a key as virtual_tag['key'] in --where, or group by it with " +
        "`infrawrench costs --group-by virtual_tag:<key>`. Unmatched is the share of spend no rule " +
        "matched (it took the default value, or is not set).",
    ),
  );
});

// Reading and reprocessing only. Editing a rule re-answers every past cost
// question the org has asked, so it belongs in the Settings form with its
// live preview, not in a flag.
export const virtualTags = Command.make(
  "virtual-tags",
  { query },
  Effect.fn("virtual-tags")(function* (input) {
    // `virtual-tags team` reads as "show me team"; accept it.
    if (input.query.length > 0) return yield* showTag(input.query.join(" "));
    yield* listTags();
  }),
).pipe(
  Command.withDescription(
    "The org's virtual tags (keys computed from ordered rules) with status and unmatched share",
  ),
  Command.withSubcommands([show, reprocess]),
);
