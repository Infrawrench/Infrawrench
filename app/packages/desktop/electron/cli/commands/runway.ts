import type { RunwayListResponse } from "@infrawrench/client-core" with {
  "resolution-mode": "import",
};
import { Effect, Schema } from "effect";
import { Command, Flag } from "effect/cli";
import { CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import * as Print from "../effect/print";
import { CliSession } from "../effect/session";
import { spreadBody, wire } from "../effect/wire";
import { c, type Column } from "../output";

const PATH = "/quotas/runway";

// `status`, `kind` and `confidence` stay strings: a newer server's value
// renders uncolored rather than failing the listing (the `credits` stance).
const Runway = wire<RunwayListResponse>()(
  Schema.Struct({
    rows: Schema.Array(
      Schema.Struct({
        resourceName: Schema.String,
        accountName: Schema.String,
        label: Schema.String,
        unit: Schema.NullOr(Schema.String),
        used: Schema.Finite,
        limit: Schema.Finite,
        utilization: Schema.Finite,
        limitSource: Schema.String,
        plan: Schema.NullOr(Schema.String),
        kind: Schema.String,
        forecast: Schema.Struct({
          perDay: Schema.NullOr(Schema.Finite),
          daysLeft: Schema.NullOr(Schema.Finite),
          confidence: Schema.String,
        }),
        cycle: Schema.NullOr(
          Schema.Struct({
            end: Schema.String,
            projectedUtilization: Schema.NullOr(Schema.Finite),
          }),
        ),
        status: Schema.String,
      }),
    ),
    runwayDays: Schema.Finite,
    allowanceThreshold: Schema.Finite,
    windowDays: Schema.Finite,
  }),
);
type Row = (typeof Runway.Type)["rows"][number];

const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];

/** The row's unit: binary sizes for bytes, the provider's word otherwise. */
function amount(value: number, unit: string | null): string {
  if (unit === "bytes") {
    let v = Math.abs(value);
    let i = 0;
    while (v >= 1024 && i < BYTE_UNITS.length - 1) {
      v /= 1024;
      i++;
    }
    return `${value < 0 ? "-" : ""}${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${BYTE_UNITS[i]}`;
  }
  const rounded = Math.abs(value) >= 100 ? Math.round(value) : Math.round(value * 100) / 100;
  const num = rounded.toLocaleString("en-US");
  if (!unit) return num;
  return unit === "%" ? `${num}%` : `${num} ${unit}`;
}

function percent(fraction: number): string {
  const pct = fraction * 100;
  return pct > 0 && pct < 1 ? "<1%" : `${Math.round(pct)}%`;
}

/** Coarsening countdown, the `credits` runway's steps. */
function days(n: number): string {
  if (n < 1) return "< 1 day";
  if (n < 14) return `${Math.round(n)}d`;
  if (n < 60) return `${Math.round(n / 7)}w`;
  return `${Math.round(n / 30)}mo`;
}

function tone(row: Row, text: string): string {
  switch (row.status) {
    case "full":
      return c.red(text);
    case "critical":
      return c.yellow(text);
    case "watch":
      return c.dim(text);
    default:
      return text;
  }
}

/** The countdown cell, or why there is none. */
function runwayCell(row: Row): string {
  if (row.status === "full") return c.red("at the limit");
  if (row.forecast.confidence === "short") return c.dim("not enough history");
  const noisy = row.forecast.confidence === "noisy" ? " (noisy)" : "";
  if (row.kind === "allowance" && row.cycle) {
    const resets = row.cycle.end.slice(0, 10);
    if (row.forecast.daysLeft !== null) {
      return tone(row, `out in ${days(row.forecast.daysLeft)}, resets ${resets}${noisy}`);
    }
    const projected =
      row.cycle.projectedUtilization === null ? "n/a" : percent(row.cycle.projectedUtilization);
    return tone(row, `${projected} by ${resets}${noisy}`);
  }
  if (row.forecast.daysLeft !== null) return tone(row, `${days(row.forecast.daysLeft)}${noisy}`);
  if ((row.forecast.perDay ?? 0) > 0) return c.dim("over a year");
  return c.dim("not rising");
}

const atRisk = Flag.Boolean("at-risk").pipe(
  Flag.withDescription("Only rows at the limit, running out, or on a noisy trend toward it"),
  Flag.withDefault(false),
  Flag.withoutNegation,
);

/**
 * `infrawrench runway`: every resource usage a plugin declares against the
 * limit that will stop it (a disk, a plan's storage cap, a monthly allowance),
 * soonest to run out first.
 *
 * `--json` prints the server's response as it is, so a morning check can page
 * on `status == "critical"` without parsing the table.
 */
export const runway = Command.make(
  "runway",
  { atRisk },
  Effect.fn("runway")(function* ({ atRisk: onlyAtRisk }) {
    const session = yield* CliSession;
    const api = yield* CloudApi;
    const org = yield* currentOrg;
    const body = yield* api.json(org.id, PATH);

    if (session.output === "json") {
      return yield* Print.json(yield* spreadBody({ org: org.id }, body, PATH));
    }
    const feed = yield* decodeBody(Runway, PATH)(body);
    const rows = onlyAtRisk ? feed.rows.filter((r) => r.status !== "ok") : feed.rows;

    if (feed.rows.length === 0) {
      return yield* Print.line(
        c.dim(
          "No resources with a tracked usage and limit yet. Readings are recorded on each sync, for resource types whose plugin declares one.",
        ),
      );
    }

    const runningOut = feed.rows.filter((r) => r.status === "full" || r.status === "critical");
    yield* Print.line(
      `${c.bold(org.displayName)} ${c.dim(
        `· ${feed.rows.length} usage${feed.rows.length === 1 ? "" : "s"}` +
          (runningOut.length > 0 ? `, ${runningOut.length} running out` : "") +
          ` · alerts within ${feed.runwayDays}d or past ${percent(feed.allowanceThreshold)} of an allowance`,
      )}`,
    );
    yield* Print.line();

    if (rows.length === 0) {
      return yield* Print.line(c.dim("Nothing is running out."));
    }

    const columns: Column<Row>[] = [
      { header: "resource", value: (r) => r.resourceName },
      { header: "account", value: (r) => c.dim(r.accountName) },
      {
        header: "usage",
        value: (r) => (r.kind === "allowance" ? `${r.label} ${c.dim("(monthly)")}` : r.label),
      },
      {
        header: "used",
        value: (r) =>
          `${amount(r.used, r.unit)} / ${amount(r.limit, r.unit)}` +
          (r.limitSource === "plan" && r.plan ? c.dim(` (${r.plan} plan)`) : ""),
      },
      { header: "%", value: (r) => tone(r, percent(r.utilization)) },
      { header: "runway", value: (r) => runwayCell(r) },
    ];
    yield* Print.table(rows, columns);
  }),
).pipe(
  Command.withDescription(
    "Resource usage against its limit (disks, plan caps, monthly allowances), soonest to run out first",
  ),
);
