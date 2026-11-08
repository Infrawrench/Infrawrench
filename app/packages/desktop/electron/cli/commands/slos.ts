// `infrawrench slos`: service-level objectives with their error budgets, and
// `infrawrench slos <id|name>` for one SLO's burn rates and charts.
//
// Cloud-only, like `probes`: SLOs are evaluated by the cloud poller over the
// cloud metric store. The CLI reads; writing SLOs lives on the web/desktop SLOs
// tab, where the probe and metric pickers are.
//
// Types come from `@infrawrench/client-core` type-only; the pure arithmetic
// (budget formatting, burndown) is loaded with a dynamic import, the main
// project's rule for client-core runtime code. Zero new runtime dependencies.
import { Effect, Option, Schema } from "effect";
import { Argument, Command } from "effect/cli";
import type { SloDetailResponse, SloListResponse } from "@infrawrench/client-core" with {
  "resolution-mode": "import",
};
import { CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import { CliFailure } from "../effect/errors";
import * as Print from "../effect/print";
import { CliSession } from "../effect/session";
import { spreadBody, wire } from "../effect/wire";
import { c, safe, type Column } from "../output";
import { sparkline } from "../charts";
import { formatChangeTime } from "../format";

type Core = typeof import("@infrawrench/client-core", { with: { "resolution-mode": "import" } });

const PATH = "/slos";

const BurnRate = Schema.optional(Schema.NullOr(Schema.Finite));

const Slo = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  enabled: Schema.Boolean,
  status: Schema.Literals(["exhausted", "fast_burn", "slow_burn", "ok", "unknown"]),
  sli: Schema.NullOr(Schema.Finite),
  targetPercent: Schema.Finite,
  windowDays: Schema.Finite,
  totalEvents: Schema.Finite,
  budgetRemaining: Schema.NullOr(Schema.Finite),
  budgetRemainingMinutes: Schema.NullOr(Schema.Finite),
  budgetTotalMinutes: Schema.Finite,
  burnRates: Schema.Struct({
    "5m": BurnRate,
    "30m": BurnRate,
    "1h": BurnRate,
    "6h": BurnRate,
    "3d": BurnRate,
  }),
  suggestFreeze: Schema.Boolean,
  lastEvalAt: Schema.NullOr(Schema.String),
  lastError: Schema.NullOr(Schema.String),
  // What `describeSloSource` reads.
  sliKind: Schema.Literals(["probe_availability", "probe_latency", "metric_threshold"]),
  probeName: Schema.NullOr(Schema.String),
  resourceName: Schema.NullOr(Schema.String),
  latencyThresholdMs: Schema.NullOr(Schema.Finite),
  metricKey: Schema.NullOr(Schema.String),
  comparator: Schema.NullOr(Schema.Literals(["<", "<=", ">", ">="])),
  threshold: Schema.NullOr(Schema.Finite),
});
type Slo = typeof Slo.Type;

const Listing = wire<SloListResponse>()(Schema.Struct({ slos: Schema.Array(Slo) }));

/** What finding an SLO by id or name reads. */
const NamedListing = wire<SloListResponse>()(
  Schema.Struct({ slos: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })) }),
);

/** The listing's rows as the server sent them, for `--json`. */
const RawListing = Schema.Struct({ slos: Schema.Array(Schema.Unknown) });

const Detail = wire<SloDetailResponse>()(
  Schema.Struct({
    slo: Slo,
    buckets: Schema.Array(
      Schema.Struct({ startMs: Schema.Finite, good: Schema.Finite, total: Schema.Finite }),
    ),
    activeFreeze: Schema.NullOr(Schema.Struct({ name: Schema.String })),
  }),
);

function statusCell(slo: Slo): string {
  if (!slo.enabled) return c.dim("○ disabled");
  switch (slo.status) {
    case "exhausted":
      return c.red("● budget spent");
    case "fast_burn":
      return c.red("● fast burn");
    case "slow_burn":
      return c.yellow("● slow burn");
    case "ok":
      return c.green("● ok");
    case "unknown":
      return c.dim("● no data");
  }
}

function budgetCell(core: Core, slo: Slo): string {
  if (slo.budgetRemaining === null || slo.budgetRemainingMinutes === null) return c.dim("-");
  if (slo.budgetRemaining <= 0) {
    return c.red(`over by ${core.formatBudgetDuration(slo.budgetRemainingMinutes)}`);
  }
  const text = `${Number((slo.budgetRemaining * 100).toFixed(1))}% (${core.formatBudgetDuration(slo.budgetRemainingMinutes)})`;
  return slo.budgetRemaining < 0.25 ? c.yellow(text) : text;
}

const printSloDetail = Effect.fn("slos.detail")(function* (
  core: Core,
  orgId: string,
  sloId: string,
) {
  const session = yield* CliSession;
  const api = yield* CloudApi;
  const path = `/slos/${encodeURIComponent(sloId)}`;
  const body = yield* api.json(orgId, path);
  if (session.output === "json")
    return yield* Print.json(yield* spreadBody({ org: orgId }, body, path));
  const { slo, buckets, activeFreeze } = yield* decodeBody(Detail, path)(body);
  yield* Print.line(`${c.bold(safe(slo.name))}  ${statusCell(slo)}`);
  yield* Print.line(
    c.dim(
      `${safe(core.describeSloSource(slo))} · ${core.formatSloTarget(slo.targetPercent)} over ${slo.windowDays} days`,
    ),
  );
  if (slo.description) yield* Print.line(safe(slo.description));
  yield* Print.line();

  const facts = [
    `SLI ${slo.sli === null ? c.dim("no data") : core.formatSloPercent(slo.sli)}`,
    `budget ${budgetCell(core, slo)} of ${core.formatBudgetDuration(slo.budgetTotalMinutes)}`,
    `${Math.round(slo.totalEvents)} minutes measured`,
  ];
  if (slo.lastEvalAt) facts.push(c.dim(`evaluated ${formatChangeTime(slo.lastEvalAt)}`));
  yield* Print.line(facts.join(c.dim(" · ")));
  if (slo.lastError) yield* Print.line(c.yellow(safe(slo.lastError)));
  if (slo.status === "exhausted" && slo.suggestFreeze && !activeFreeze) {
    yield* Print.line(
      c.red("Error budget spent: consider a change freeze (start one from the SLOs tab)."),
    );
  }
  if (activeFreeze) yield* Print.line(c.dim(`change freeze in effect: ${safe(activeFreeze.name)}`));

  yield* Print.line();
  yield* Print.line(c.bold("burn rates"));
  yield* Print.line(
    core.SLO_BURN_WINDOWS.map((w) => {
      const r = slo.burnRates[w];
      return `${c.dim(w)} ${r === null || r === undefined ? c.dim("-") : core.formatBurnRate(r)}`;
    }).join("   "),
  );
  for (const policy of core.SLO_BURN_POLICIES) {
    const threshold = core.sloBurnRateThreshold(policy, slo.windowDays);
    yield* Print.line(
      c.dim(
        `${policy.severity === "page" ? "page" : "ticket"} when ${policy.longWindow} and ${policy.shortWindow} both ≥ ${core.formatBurnRate(threshold)}`,
      ),
    );
  }

  const history = core.buildSloHistory(buckets, slo.targetPercent);
  yield* Print.line();
  if (history.dailySli.length === 0) {
    return yield* Print.line(c.dim("No events in the window yet."));
  }
  const daily = history.dailySli.map((p) => p.value);
  yield* Print.line(`${c.dim("SLI per day     ")} ${sparkline(daily, Math.min(daily.length, 60))}`);
  const burndown = history.budgetBurndown.map((p) => p.value);
  const [first] = burndown;
  const last = burndown[burndown.length - 1];
  if (first !== undefined && last !== undefined) {
    yield* Print.line(
      `${c.dim("budget burndown ")} ${sparkline(burndown, Math.min(burndown.length, 60))}`,
    );
    yield* Print.line(c.dim(`budget ${Math.round(first)}% → ${Math.round(last)}% over the window`));
  }
});

export const slos = Command.make(
  "slos",
  {
    slo: Argument.String("id|name").pipe(
      Argument.withDescription("One SLO, for its burn rates and charts"),
      Argument.optional,
    ),
  },
  Effect.fn("slos")(function* ({ slo: sloArg }) {
    const session = yield* CliSession;
    const api = yield* CloudApi;
    if (session.local) {
      return yield* new CliFailure({
        message:
          "SLOs live in Infrawrench Cloud. The poller evaluates them over the cloud metric store. Drop --local.",
      });
    }
    const core: Core = yield* Effect.promise(() => import("@infrawrench/client-core"));
    const org = yield* currentOrg;
    const body = yield* api.json(org.id, PATH);

    if (Option.isSome(sloArg)) {
      const wanted = sloArg.value;
      const { slos } = yield* decodeBody(NamedListing, PATH)(body);
      const needle = wanted.toLowerCase();
      const slo =
        slos.find((s) => s.id === wanted) ??
        slos.find((s) => s.name.toLowerCase() === needle) ??
        slos.find((s) => s.name.toLowerCase().includes(needle));
      if (!slo) {
        return yield* new CliFailure({
          message: `No SLO matches "${wanted}". Run \`infrawrench slos\` to list.`,
        });
      }
      return yield* printSloDetail(core, org.id, slo.id);
    }

    if (session.output === "json") {
      const { slos } = yield* decodeBody(RawListing, PATH)(body);
      return yield* Print.json({ org: org.id, slos });
    }
    const { slos } = yield* decodeBody(Listing, PATH)(body);

    if (slos.length === 0) {
      return yield* Print.line(
        c.dim("No SLOs yet. Create one from the SLOs tab, from a probe or a resource metric."),
      );
    }

    const sorted = [...slos].sort(
      (a, b) => core.compareSloStatus(a.status, b.status) || a.name.localeCompare(b.name),
    );
    const burning = slos.filter(
      (s) => s.enabled && (s.status === "exhausted" || s.status === "fast_burn"),
    ).length;
    yield* Print.line(
      `${c.bold(safe(org.displayName))} ${c.dim(`· ${slos.length} SLO${slos.length === 1 ? "" : "s"}`)}${
        burning > 0 ? `  ${c.red(`${burning} burning or spent`)}` : ""
      }`,
    );
    yield* Print.line();

    const columns: Column<Slo>[] = [
      { header: "", value: (s) => statusCell(s) },
      { header: "slo", value: (s) => safe(s.name) },
      {
        header: "sli / target",
        value: (s) =>
          `${s.sli === null ? c.dim("-") : core.formatSloPercent(s.sli)} ${c.dim(`/ ${core.formatSloTarget(s.targetPercent)}`)}`,
        align: "right",
      },
      { header: "window", value: (s) => c.dim(`${s.windowDays}d`), align: "right" },
      { header: "budget left", value: (s) => budgetCell(core, s), align: "right" },
      {
        header: "burn 1h",
        value: (s) => {
          const r = s.burnRates["1h"];
          return r === null || r === undefined ? c.dim("-") : core.formatBurnRate(r);
        },
        align: "right",
      },
      { header: "source", value: (s) => c.dim(safe(core.describeSloSource(s))) },
    ];
    yield* Print.table(sorted, columns);
    yield* Print.line();
    yield* Print.line(
      c.dim("`infrawrench slos <id|name>` shows one SLO's burn rates and budget burndown."),
    );
  }),
).pipe(
  Command.withDescription(
    "Service-level objectives: SLI against target, error budget left and burn rate (give an id or name for its charts)",
  ),
);
