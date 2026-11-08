// `infrawrench ai-spend`: billed AI spend split by caller (team, user,
// feature…), with per-source match rates and per-provider coverage, and
// `infrawrench ai-spend sources`: the configured request-log sources and their
// collection state. Reads over the same endpoints the Settings → AI
// Attribution page uses; wire shapes are client-core types, imported type-only
// so the CLI keeps its zero-runtime-dependency rule.
import { Effect, Option, Schema } from "effect";
import { Argument, Command } from "effect/cli";
import type {
  AiAttributionDimension,
  AiAttributionStats,
  AiRequestSource,
  AiSpendBreakdown,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import { CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import { CliFailure } from "../effect/errors";
import * as Print from "../effect/print";
import { dateRange, resolveDateRange } from "../effect/range-flags";
import { CliSession } from "../effect/session";
import { wire } from "../effect/wire";
import { c, formatMoney, safe } from "../output";
import { barChart } from "../charts";

const Dimensions = wire<{ dimensions: AiAttributionDimension[] }>()(
  Schema.Struct({ dimensions: Schema.Array(Schema.Struct({ key: Schema.String })) }),
);
const RawDimensions = Schema.Struct({ dimensions: Schema.Array(Schema.Unknown) });

const Stats = wire<AiAttributionStats>()(
  Schema.Struct({
    providers: Schema.Array(
      Schema.Struct({
        provider: Schema.String,
        currency: Schema.String,
        billedAmount: Schema.Finite,
        attributedAmount: Schema.Finite,
        unattributedAmount: Schema.Finite,
      }),
    ),
    sources: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        requests: Schema.Finite,
        matchedRequests: Schema.Finite,
        ambiguousRequests: Schema.Finite,
        unmatchedRequests: Schema.Finite,
        coveragePercent: Schema.NullOr(Schema.Finite),
      }),
    ),
  }),
);

const Spend = wire<AiSpendBreakdown>()(
  Schema.Struct({
    tagKey: Schema.String,
    rows: Schema.Array(
      Schema.Struct({ value: Schema.String, currency: Schema.String, amount: Schema.Finite }),
    ),
  }),
);

const Sources = wire<{ sources: AiRequestSource[] }>()(
  Schema.Struct({
    sources: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        enabled: Schema.Boolean,
        sourceKindId: Schema.String,
        accountName: Schema.NullOr(Schema.String),
        collectedThrough: Schema.NullOr(Schema.String),
        lastError: Schema.NullOr(Schema.String),
      }),
    ),
  }),
);
const RawSources = Schema.Struct({ sources: Schema.Array(Schema.Unknown) });

function pct(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "n/a" : `${Math.round(value * 10) / 10}%`;
}

const sources = Command.make(
  "sources",
  {},
  Effect.fn("ai-spend.sources")(function* () {
    const session = yield* CliSession;
    const api = yield* CloudApi;
    if (session.local) {
      return yield* new CliFailure({
        message: "Request-log sources are org-level cloud state, so this is cloud mode only.",
      });
    }
    const org = yield* currentOrg;
    const path = "/ai-attribution/sources";
    const body = yield* api.json(org.id, path);
    if (session.output === "json") {
      const raw = yield* decodeBody(RawSources, path)(body);
      return yield* Print.json({ org: org.id, sources: raw.sources });
    }
    const list = (yield* decodeBody(Sources, path)(body)).sources;
    if (list.length === 0) {
      return yield* Print.line(
        c.dim("No request-log sources. Add one under Settings → AI Attribution."),
      );
    }
    yield* Print.table(list, [
      {
        header: "name",
        value: (s) => (s.enabled ? c.bold(safe(s.name)) : c.dim(`${safe(s.name)} (paused)`)),
      },
      {
        header: "kind",
        value: (s) =>
          s.accountName
            ? `${safe(s.sourceKindId)} ${c.dim(safe(s.accountName))}`
            : safe(s.sourceKindId),
      },
      {
        header: "collected through",
        value: (s) => (s.collectedThrough === null ? c.dim("not yet") : safe(s.collectedThrough)),
      },
      { header: "status", value: (s) => (s.lastError ? c.red(safe(s.lastError)) : c.green("ok")) },
    ]);
  }),
).pipe(Command.withDescription("The org's AI request-log sources and their collection state"));

export const aiSpend = Command.make(
  "ai-spend",
  {
    dimension: Argument.String("dimension").pipe(
      Argument.withDescription("The caller dimension to split by (default: the first mapped)"),
      Argument.optional,
    ),
    ...dateRange,
  },
  Effect.fn("ai-spend")(function* (input) {
    const session = yield* CliSession;
    const api = yield* CloudApi;
    if (session.local) {
      return yield* new CliFailure({
        message:
          "AI attribution runs over your org's collected cloud spend, so it is cloud mode only.",
      });
    }
    const org = yield* currentOrg;
    const { from, to } = resolveDateRange(input);

    const dimensionsPath = "/ai-attribution/dimensions";
    const dimensionsBody = yield* api.json(org.id, dimensionsPath);
    const { dimensions } = yield* decodeBody(Dimensions, dimensionsPath)(dimensionsBody);
    const dimensionArg = Option.getOrUndefined(input.dimension);
    const dimension = dimensionArg ?? dimensions[0]?.key;
    if (dimensionArg && !dimensions.some((d) => d.key === dimensionArg)) {
      return yield* new CliFailure({
        message: `No caller dimension "${dimensionArg}". Known: ${dimensions.map((d) => d.key).join(", ") || "none"}.`,
      });
    }
    const statsPath = `/ai-attribution/stats?from=${from}&to=${to}`;
    const spendPath = dimension
      ? `/ai-attribution/spend?from=${from}&to=${to}&dimension=${encodeURIComponent(dimension)}`
      : null;
    const [statsBody, spendBody] = yield* Effect.all(
      [api.json(org.id, statsPath), spendPath ? api.json(org.id, spendPath) : Effect.succeed(null)],
      { concurrency: "unbounded" },
    );

    if (session.output === "json") {
      const raw = yield* decodeBody(RawDimensions, dimensionsPath)(dimensionsBody);
      return yield* Print.json({
        org: org.id,
        from,
        to,
        dimensions: raw.dimensions,
        stats: statsBody,
        spend: spendBody,
      });
    }
    const stats = yield* decodeBody(Stats, statsPath)(statsBody);

    yield* Print.line(
      `${c.bold(safe(org.displayName))} ${c.dim(`· AI spend by caller, ${from} → ${to}`)}`,
    );
    yield* Print.line();

    if (stats.providers.length === 0) {
      yield* Print.line(
        c.dim(
          "No AI spend attributed in this range. Add a request-log source and map metadata keys to dimensions under Settings → AI Attribution.",
        ),
      );
    } else {
      yield* Print.table(stats.providers, [
        { header: "provider", value: (p) => c.bold(safe(p.provider)) },
        {
          header: "billed",
          value: (p) => formatMoney(p.billedAmount, p.currency),
          align: "right",
        },
        {
          header: "attributed",
          value: (p) => formatMoney(p.attributedAmount, p.currency),
          align: "right",
        },
        {
          header: "unattributed",
          value: (p) => formatMoney(p.unattributedAmount, p.currency),
          align: "right",
        },
      ]);
    }

    if (stats.sources.length > 0) {
      yield* Print.line();
      yield* Print.table(stats.sources, [
        { header: "source", value: (s) => safe(s.name) },
        { header: "requests", value: (s) => s.requests.toLocaleString(), align: "right" },
        {
          header: "matched",
          value: (s) => pct(s.requests > 0 ? (s.matchedRequests / s.requests) * 100 : null),
          align: "right",
        },
        {
          header: "ambiguous",
          value: (s) => s.ambiguousRequests.toLocaleString(),
          align: "right",
        },
        {
          header: "unmatched",
          value: (s) => s.unmatchedRequests.toLocaleString(),
          align: "right",
        },
        { header: "bill covered", value: (s) => pct(s.coveragePercent), align: "right" },
      ]);
    }

    if (!spendPath || !dimension) {
      yield* Print.line();
      return yield* Print.line(
        c.dim("No caller dimensions mapped yet, so nothing is split by caller."),
      );
    }
    const spend = yield* decodeBody(Spend, spendPath)(spendBody);
    yield* Print.line();
    yield* Print.line(`${c.bold(safe(dimension))} ${c.dim(`(tag key ${safe(spend.tagKey)})`)}`);
    if (spend.rows.length === 0) {
      return yield* Print.line(c.dim("No attributed spend in this range."));
    }
    const items = spend.rows.slice(0, 15).map((row, idx) => ({
      label: safe(row.value) || "(no value)",
      value: row.amount,
      display: formatMoney(row.amount, row.currency),
      colorIndex: idx,
    }));
    for (const line of barChart(items, 32)) yield* Print.line(line);
  }),
).pipe(
  Command.withDescription(
    "Billed AI spend split by a caller dimension (team, user, feature…), with match rates",
  ),
  Command.withSubcommands([sources]),
);
