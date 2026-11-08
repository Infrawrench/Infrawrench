// `infrawrench carbon`: the org's estimated operational CO2e, the counterpart
// to `infrawrench costs` for the same estate.
//
// Cloud-only: the estimate resolves instance types to vCPUs through each
// provider's size catalogue with the org's credentials, which a local
// workspace does not hold for this path.
//
// The text output keeps the same three honesty rules the Costs page does: the
// count of what could *not* be estimated sits beside the total, the
// assumptions print under it, and nothing reads as measured.
//
// The response shape comes from `@infrawrench/client-core`; the import is
// type-only, so the CLI still ships zero new runtime dependencies.
import { Effect, Schema } from "effect";
import { Command, Flag } from "effect/cli";
import type { CarbonEstimate } from "@infrawrench/client-core" with {
  "resolution-mode": "import",
};
import { CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import * as Print from "../effect/print";
import { days, lastDays, resolveDayWindow } from "../effect/range-flags";
import { CliSession } from "../effect/session";
import { wire } from "../effect/wire";
import { c, formatCo2e, safe, type Column } from "../output";
import { barChart } from "../charts";

const REASONS: Partial<Record<string, string>> = {
  "unsupported-provider": "no published grid figures",
  "unknown-region": "region not in the coefficient set",
  "unknown-size": "no vCPU count synced",
};

const Group = Schema.Struct({ label: Schema.String, kgCo2e: Schema.Finite });

const Row = Schema.Struct({
  displayName: Schema.String,
  pluginId: Schema.String,
  region: Schema.String,
  vcpus: Schema.Finite,
  count: Schema.Finite,
  gridIntensity: Schema.Finite,
  kgCo2e: Schema.Finite,
});
type Row = typeof Row.Type;

// `reason` stays a string: an unknown one prints as itself.
const Estimate = wire<CarbonEstimate>()(
  Schema.Struct({
    windowDays: Schema.Finite,
    totalKgCo2e: Schema.Finite,
    totalKwh: Schema.Finite,
    estimatedCount: Schema.Finite,
    unestimated: Schema.Array(
      Schema.Struct({ displayName: Schema.String, pluginId: Schema.String, reason: Schema.String }),
    ),
    unestimatedCount: Schema.Finite,
    duplicateCount: Schema.Finite,
    byRegion: Schema.Array(Group),
    byProvider: Schema.Array(Group),
    rows: Schema.Array(Row),
    assumptions: Schema.Struct({
      cpuUtilization: Schema.Finite,
      coefficientVintage: Schema.String,
    }),
  }),
);

const bars = (groups: ReadonlyArray<typeof Group.Type>) =>
  barChart(
    groups.map((g) => ({ label: safe(g.label), value: g.kgCo2e, display: formatCo2e(g.kgCo2e) })),
  );

export const carbon = Command.make(
  "carbon",
  {
    days: days.pipe(Flag.withDescription("Estimate over this many days (default 30, max 365)")),
    last: lastDays,
  },
  Effect.fn("carbon")(function* (input) {
    const session = yield* CliSession;
    const api = yield* CloudApi;
    const org = yield* currentOrg;
    const windowDays = yield* resolveDayWindow(input, 30, 365);
    const path = `/carbon?windowDays=${windowDays}`;
    const body = yield* api.json(org.id, path);

    if (session.output === "json") return yield* Print.json(body);
    const estimate = yield* decodeBody(Estimate, path)(body);

    yield* Print.line(
      `${c.bold(`~${formatCo2e(estimate.totalKgCo2e)} CO2e`)} ${c.dim(
        `· estimated · ${safe(org.displayName)} · last ${estimate.windowDays}d · ${Math.round(estimate.totalKwh)} kWh`,
      )}`,
    );
    // Beside the total, not at the bottom: a figure covering a third of an
    // estate must not read as a complete answer.
    const gaps = estimate.unestimatedCount;
    yield* Print.line(
      `${estimate.estimatedCount} resource${estimate.estimatedCount === 1 ? "" : "s"} estimated · ${
        gaps > 0 ? c.yellow(`${gaps} could not be estimated`) : "none left out"
      }${estimate.duplicateCount > 0 ? c.dim(` · ${estimate.duplicateCount} nodes counted as their instance`) : ""}`,
    );

    if (estimate.byProvider.length > 0) {
      yield* Print.line();
      yield* Print.line(c.bold("By provider"));
      for (const line of bars(estimate.byProvider)) yield* Print.line(line);
    }

    if (estimate.byRegion.length > 0) {
      yield* Print.line();
      yield* Print.line(c.bold("By region"));
      for (const line of bars(estimate.byRegion.slice(0, 12))) yield* Print.line(line);
    }

    if (estimate.rows.length > 0) {
      yield* Print.line();
      yield* Print.line(c.bold("Heaviest resources"));
      const columns: Column<Row>[] = [
        { header: "resource", value: (r) => safe(r.displayName) },
        { header: "provider", value: (r) => c.dim(safe(r.pluginId)) },
        { header: "region", value: (r) => safe(r.region) },
        { header: "vcpu", value: (r) => String(r.vcpus * r.count), align: "right" },
        { header: "g/kWh", value: (r) => String(Math.round(r.gridIntensity)), align: "right" },
        { header: "co2e", value: (r) => formatCo2e(r.kgCo2e), align: "right" },
      ];
      yield* Print.table(estimate.rows.slice(0, 15), columns);
    }

    if (estimate.unestimated.length > 0) {
      yield* Print.line();
      yield* Print.line(c.bold("Not estimated, and why"));
      for (const row of estimate.unestimated.slice(0, 20)) {
        yield* Print.line(
          `  ${safe(row.displayName)} ${c.dim(`${safe(row.pluginId)} · ${REASONS[row.reason] ?? safe(row.reason)}`)}`,
        );
      }
      if (estimate.unestimatedCount > 20) {
        yield* Print.line(
          c.dim(`  … and ${estimate.unestimatedCount - 20} more (--output json for all)`),
        );
      }
    }

    yield* Print.line();
    const a = estimate.assumptions;
    yield* Print.line(
      c.dim(
        `Estimated, not measured. ${Math.round(a.cpuUtilization * 100)}% CPU utilisation assumed; grid figures ${safe(a.coefficientVintage)}; processors only.`,
      ),
    );
  }),
).pipe(
  Command.withDescription(
    "Estimated CO2e of the estate by provider, region and resource, with what could not be estimated",
  ),
);
