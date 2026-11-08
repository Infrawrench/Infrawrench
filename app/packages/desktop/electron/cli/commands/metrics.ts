// `infrawrench metrics <resource-id>`: metric series rendered as terminal
// charts. Cloud resources answer from the metric store when they have pinned
// history and fall back to a live provider fetch server-side; local resources
// fetch live through the plugin in-process.
import { Effect, Option, Schema } from "effect";
import { Argument, Command } from "effect/cli";
import {
  fetchLocalMetrics,
  listCloudAccounts,
  listLocalAccounts,
  resolveAccount,
} from "../context";
import { CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import { CliFailure } from "../effect/errors";
import * as Print from "../effect/print";
import { from, lastDuration, series as seriesFlag, to } from "../effect/range-flags";
import { CliSession } from "../effect/session";
import { c, formatNumber, safe } from "../output";
import { lineChart, timeAxis } from "../charts";

const Series = Schema.Struct({
  label: Schema.String,
  unit: Schema.optional(Schema.String),
  points: Schema.Array(Schema.Struct({ value: Schema.Finite })),
});
type Series = typeof Series.Type;

const Metrics = Schema.Struct({ series: Schema.Array(Series) });

/** The series as the server sent them, for `--json`. */
const RawMetrics = Schema.Struct({ series: Schema.Array(Schema.Unknown) });

/** The series, each beside the value `--json` prints for it. */
interface Loaded {
  readonly series: ReadonlyArray<Series>;
  readonly raw: ReadonlyArray<unknown>;
}

const loadLocal = (
  accountId: string,
  resourceTypeId: string,
  resourceId: string,
  range: { startMs: number; endMs: number },
) =>
  Effect.promise(async (): Promise<Loaded> => {
    // Live from the plugin, the way the desktop's Metrics tab reads a local
    // resource. There is no local history store, so the provider decides how
    // far back the series go.
    const account = resolveAccount(await listLocalAccounts(), accountId);
    const series = await fetchLocalMetrics(account, resourceTypeId, resourceId, range);
    return { series, raw: series };
  });

const loadCloud = Effect.fnUntraced(function* (
  accountId: string,
  resourceTypeId: string,
  resourceId: string,
  range: { startMs: number; endMs: number },
) {
  const api = yield* CloudApi;
  const org = yield* currentOrg;
  const account = (yield* Effect.promise(() => listCloudAccounts(org.id))).find(
    (a) => a.id === accountId,
  );
  if (!account) {
    return yield* new CliFailure({
      message: `Account ${accountId} not found in ${org.displayName}.`,
    });
  }
  const path = `/resources/${encodeURIComponent(account.pluginId)}/${encodeURIComponent(resourceTypeId)}/metrics`;
  const body = yield* api.json(org.id, path, {
    method: "POST",
    body: JSON.stringify({ accountId, resourceId, ...range }),
  });
  const { series } = yield* decodeBody(Metrics, path)(body);
  const raw = yield* decodeBody(RawMetrics, path)(body);
  return { series, raw: raw.series } satisfies Loaded;
});

export const metrics = Command.make(
  "metrics",
  {
    resourceId: Argument.String("resource-id").pipe(
      Argument.withDescription("accountId:typeId:externalId (see `infrawrench resources`)"),
      Argument.optional,
    ),
    last: lastDuration,
    from,
    to,
    series: seriesFlag,
  },
  Effect.fn("metrics")(function* (input) {
    const session = yield* CliSession;
    const resourceId = Option.getOrElse(input.resourceId, () => "");
    if (!resourceId) {
      return yield* new CliFailure({
        message: "Usage: infrawrench metrics <resource-id> [--last 6h]",
      });
    }

    // {accountId}:{resourceTypeId}:{externalId}: the account resolves the plugin.
    const [accountId, resourceTypeId] = resourceId.split(":");
    if (!accountId || !resourceTypeId) {
      return yield* new CliFailure({
        message: `"${resourceId}" doesn't look like a resource id (accountId:typeId:externalId).`,
      });
    }

    const endMs = Option.match(input.to, { onNone: () => Date.now(), onSome: Date.parse });
    const startMs = Option.match(input.from, {
      onNone: () => endMs - Option.getOrElse(input.last, () => 3_600_000),
      onSome: Date.parse,
    });
    if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
      return yield* new CliFailure({ message: "Invalid --from/--to timestamp (use ISO 8601)." });
    }

    const range = { startMs, endMs };
    const loaded = session.local
      ? yield* loadLocal(accountId, resourceTypeId, resourceId, range)
      : yield* loadCloud(accountId, resourceTypeId, resourceId, range);

    const wanted = Option.map(input.series, (s) => s.toLowerCase());
    const kept = loaded.series.flatMap((s, i) =>
      Option.isNone(wanted) || s.label.toLowerCase().includes(wanted.value)
        ? [{ series: s, raw: loaded.raw[i] }]
        : [],
    );

    if (session.output === "json") {
      return yield* Print.json({ resourceId, startMs, endMs, series: kept.map((k) => k.raw) });
    }

    if (kept.length === 0) {
      return yield* Print.line(
        c.dim(
          loaded.series.length === 0
            ? "No metric points. The provider reported nothing for this resource and range."
            : `No series matches "${Option.getOrElse(input.series, () => "")}". Available: ${loaded.series.map((s) => safe(s.label)).join(", ")}`,
        ),
      );
    }

    const width = Math.min(72, Math.max(30, (process.stdout.columns ?? 80) - 14));
    for (const [idx, { series: s }] of kept.entries()) {
      if (idx > 0) yield* Print.line();
      const values = s.points.map((p) => p.value);
      const last = values[values.length - 1];
      const stats =
        last !== undefined
          ? ` ${c.dim("min")} ${formatNumber(Math.min(...values), s.unit)}  ${c.dim("max")} ${formatNumber(Math.max(...values), s.unit)}  ${c.dim("now")} ${formatNumber(last, s.unit)}`
          : "";
      yield* Print.line(`${c.bold(safe(s.label))}${stats}`);
      for (const line of lineChart(values, { width, height: 7, unit: s.unit, colorIndex: idx })) {
        yield* Print.line(line);
      }
      const axisPad = Math.max(
        ...[Math.min(...values, 0), Math.max(...values)].map((v) => formatNumber(v, s.unit).length),
        0,
      );
      yield* Print.line(timeAxis(startMs, endMs, width, axisPad));
    }
  }),
).pipe(Command.withDescription("Metric charts for a resource"));
