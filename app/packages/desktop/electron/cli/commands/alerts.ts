// `infrawrench alerts`: metric threshold alert rules ("CPU > 90% for 15m")
// and `infrawrench alerts events`, their recent firings.
//
// Cloud-only, like `oversized`: rules are evaluated by the cloud poller
// against the cloud metrics warehouse, so a local workspace has nothing to
// list. The CLI lists; creating and editing rules lives on the web/desktop
// Metric alerts page.
//
// The response shapes come from `@infrawrench/client-core` (the same
// definitions every other surface renders) so a server-side change breaks
// the CLI's build instead of its output. The imports are type-only, so the
// CLI still ships zero new runtime dependencies.
import { Effect, Option, Schema } from "effect";
import { Command, Flag } from "effect/cli";
import type { MetricAlertEvent, MetricAlertRuleWithStatus } from "@infrawrench/client-core" with {
  "resolution-mode": "import",
};
import { CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import { CliFailure } from "../effect/errors";
import * as Print from "../effect/print";
import { limit } from "../effect/range-flags";
import { CliSession } from "../effect/session";
import { wire } from "../effect/wire";
import { c, safe, type Column } from "../output";
import { formatChangeTime, formatMetricAlertCondition, formatMetricAlertSelector } from "../format";

const Rule = Schema.Struct({
  name: Schema.String,
  enabled: Schema.Boolean,
  metricKey: Schema.String,
  comparator: Schema.String,
  threshold: Schema.Finite,
  forMinutes: Schema.Finite,
  pluginId: Schema.NullOr(Schema.String),
  resourceTypeId: Schema.NullOr(Schema.String),
  tagKey: Schema.NullOr(Schema.String),
  tagValue: Schema.NullOr(Schema.String),
  firingCount: Schema.Finite,
  matchingResourceCount: Schema.Finite,
});
type Rule = typeof Rule.Type;

const Rules = wire<MetricAlertRuleWithStatus[]>()(Schema.Array(Rule));

const Event = Schema.Struct({
  ruleName: Schema.String,
  resourceName: Schema.String,
  status: Schema.String,
  observedValue: Schema.Finite,
  firedAt: Schema.String,
  resolvedAt: Schema.NullOr(Schema.String),
});
type Event = typeof Event.Type;

const Events = wire<MetricAlertEvent[]>()(Schema.Array(Event));

/** Any JSON array, its elements as the server sent them. */
const RawArray = Schema.Array(Schema.Unknown);

const requireCloud = Effect.gen(function* () {
  const session = yield* CliSession;
  if (session.local) {
    return yield* new CliFailure({
      message:
        "Metric alerts live in Infrawrench Cloud. The poller evaluates them server-side. Drop --local.",
    });
  }
});

const listRules = Effect.fn("alerts")(function* () {
  const session = yield* CliSession;
  const api = yield* CloudApi;
  yield* requireCloud;
  const org = yield* currentOrg;
  const path = "/metric-alerts";
  const body = yield* api.json(org.id, path);

  if (session.output === "json") {
    return yield* Print.json({ org: org.id, rules: yield* decodeBody(RawArray, path)(body) });
  }
  const rules = yield* decodeBody(Rules, path)(body);

  if (rules.length === 0) {
    return yield* Print.line(
      c.dim(
        'No metric alert rules yet. Create one from the Metric alerts page, e.g. "CPU % > 90 for 15m on plugin aws".',
      ),
    );
  }

  const firingTotal = rules.reduce((sum, r) => sum + r.firingCount, 0);
  yield* Print.line(
    `${c.bold(safe(org.displayName))} ${c.dim(
      `· ${rules.length} rule${rules.length === 1 ? "" : "s"} · ${firingTotal} firing${firingTotal === 1 ? "" : "s"}`,
    )}`,
  );
  yield* Print.line();

  const columns: Column<Rule>[] = [
    {
      header: "",
      value: (r) => (r.firingCount > 0 ? c.red("●") : r.enabled ? c.green("●") : c.dim("○")),
    },
    { header: "rule", value: (r) => safe(r.name) },
    { header: "condition", value: (r) => safe(formatMetricAlertCondition(r)) },
    { header: "resources", value: (r) => c.dim(safe(formatMetricAlertSelector(r))) },
    { header: "matches", value: (r) => String(r.matchingResourceCount), align: "right" },
    {
      header: "firing",
      value: (r) => (r.firingCount > 0 ? c.red(String(r.firingCount)) : c.dim("0")),
      align: "right",
    },
  ];
  yield* Print.table(rules, columns);

  yield* Print.line();
  yield* Print.line(
    c.dim(
      "Rules match resources by query (provider + type + tag), so resources created later are covered automatically. `infrawrench alerts events` shows recent firings.",
    ),
  );
});

const events = Command.make(
  "events",
  { limit: limit.pipe(Flag.withDescription("Firings to show (max 200)")) },
  Effect.fn("alerts.events")(function* (input) {
    const session = yield* CliSession;
    const api = yield* CloudApi;
    yield* requireCloud;
    const org = yield* currentOrg;
    const params = new URLSearchParams();
    if (Option.isSome(input.limit)) params.set("limit", String(Math.min(input.limit.value, 200)));
    const qs = params.toString();
    const path = `/metric-alerts/events${qs ? `?${qs}` : ""}`;
    const body = yield* api.json(org.id, path);

    if (session.output === "json") {
      return yield* Print.json({ org: org.id, events: yield* decodeBody(RawArray, path)(body) });
    }
    const list = yield* decodeBody(Events, path)(body);

    if (list.length === 0) {
      return yield* Print.line(c.dim("No metric alert firings recorded."));
    }

    yield* Print.line(
      `${c.bold(safe(org.displayName))} ${c.dim(`· ${list.length} firing${list.length === 1 ? "" : "s"}, newest first`)}`,
    );
    yield* Print.line();

    const columns: Column<Event>[] = [
      { header: "rule", value: (e) => safe(e.ruleName) },
      { header: "resource", value: (e) => safe(e.resourceName) },
      {
        header: "observed",
        value: (e) => String(Number(e.observedValue.toFixed(2))),
        align: "right",
      },
      { header: "fired", value: (e) => c.dim(formatChangeTime(e.firedAt)) },
      {
        header: "status",
        value: (e) =>
          e.status === "firing"
            ? c.red("firing")
            : c.green(`resolved${e.resolvedAt ? ` ${formatChangeTime(e.resolvedAt)}` : ""}`),
      },
    ];
    yield* Print.table(list, columns);
  }),
).pipe(Command.withDescription("Recent metric alert firings and recoveries"));

export const alerts = Command.make("alerts", {}, listRules).pipe(
  Command.withDescription(
    'Metric threshold alert rules ("CPU > 90% for 15m") with live firing status',
  ),
  Command.withSubcommands([events]),
);
