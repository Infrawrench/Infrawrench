// `infrawrench idle-rules`: the metric-based idle rules the connected
// providers declare (idle NAT gateways, load balancers, caches, provisioned
// tables, empty clusters, unused custom metrics), with the org's effective
// thresholds and each account's last collection, so an empty `orphans` list
// can be told apart from a credential that cannot read metrics.
//
// `idle-rules rescan` makes every account due on the next poller tick.
// Cloud only: the poller reads the metrics. Settings are edited in the app
// (Costs, Potential savings, Idle rules) or through the Terraform provider.
import type { IdleFindingsOverview } from "@infrawrench/client-core" with {
  "resolution-mode": "import",
};
import { Effect, Schema } from "effect";
import { Command } from "effect/cli";
import { CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import * as Print from "../effect/print";
import { CliSession } from "../effect/session";
import { spreadBody, wire } from "../effect/wire";
import { formatIdleValue } from "../format";
import { c, safe } from "../output";

const PATH = "/idle-findings";

const Overview = wire<IdleFindingsOverview>()(
  Schema.Struct({
    settings: Schema.Struct({ enabled: Schema.Boolean, lookbackDays: Schema.Finite }),
    rules: Schema.Array(
      Schema.Struct({
        label: Schema.String,
        pluginName: Schema.String,
        enabled: Schema.Boolean,
        thresholds: Schema.Array(
          Schema.Struct({
            label: Schema.String,
            unit: Schema.String,
            default: Schema.Finite,
            value: Schema.Finite,
          }),
        ),
      }),
    ),
    accounts: Schema.Array(
      Schema.Struct({
        accountName: Schema.String,
        pluginName: Schema.String,
        lastPolledAt: Schema.NullOr(Schema.String),
        findingCount: Schema.Finite,
        lastError: Schema.NullOr(Schema.String),
        helpUrl: Schema.NullOr(Schema.String),
      }),
    ),
  }),
);

const list = Effect.fn("idle-rules")(function* () {
  const session = yield* CliSession;
  const api = yield* CloudApi;
  const org = yield* currentOrg;
  const body = yield* api.json(org.id, PATH);

  if (session.output === "json") {
    return yield* Print.json(yield* spreadBody({ org: org.id }, body, PATH));
  }
  const overview = yield* decodeBody(Overview, PATH)(body);

  const { settings } = overview;
  yield* Print.line(
    `${c.bold(org.displayName)} ${c.dim(
      `· idle rules ${settings.enabled ? "on" : "off"} · ${settings.lookbackDays}-day lookback`,
    )}`,
  );
  if (overview.rules.length === 0) {
    return yield* Print.line(c.dim("None of the loaded providers declare idle rules."));
  }

  yield* Print.table(overview.rules, [
    { header: "rule", value: (r) => safe(r.label) },
    { header: "provider", value: (r) => c.dim(safe(r.pluginName)) },
    {
      header: "on",
      value: (r) => (settings.enabled && r.enabled ? "yes" : c.dim("no")),
    },
    {
      header: "thresholds",
      value: (r) =>
        r.thresholds.length === 0
          ? c.dim("none")
          : r.thresholds
              .map(
                (t) =>
                  `${safe(t.label)} ${formatIdleValue(t.value, t.unit)}` +
                  (t.value !== t.default
                    ? c.dim(` (default ${formatIdleValue(t.default, t.unit)})`)
                    : ""),
              )
              .join("; "),
    },
  ]);

  if (overview.accounts.length > 0) {
    yield* Print.line();
    yield* Print.line(c.bold("Collection"));
    yield* Print.table(overview.accounts, [
      { header: "account", value: (a) => safe(a.accountName) },
      { header: "provider", value: (a) => c.dim(safe(a.pluginName)) },
      {
        header: "last read",
        value: (a) =>
          a.lastPolledAt ? a.lastPolledAt.slice(0, 16).replace("T", " ") : c.dim("not yet"),
      },
      { header: "flagged", value: (a) => String(a.findingCount), align: "right" },
      {
        header: "error",
        value: (a) =>
          a.lastError
            ? `${safe(a.lastError)}${a.helpUrl ? c.dim(` (${safe(a.helpUrl)})`) : ""}`
            : c.dim("none"),
      },
    ]);
  }
  yield* Print.line();
  yield* Print.line(
    c.dim(
      "Findings appear in `infrawrench orphans`. `infrawrench idle-rules rescan` re-reads now.",
    ),
  );
});

const rescan = Command.make(
  "rescan",
  {},
  Effect.fn("idle-rules.rescan")(function* () {
    const session = yield* CliSession;
    const api = yield* CloudApi;
    const org = yield* currentOrg;
    // The answer is `{ ok: true }`, which says nothing a 2xx did not.
    yield* api.json(org.id, "/idle-findings/rescan", { method: "POST" });
    if (session.output === "json") return yield* Print.json({ org: org.id, ok: true });
    yield* Print.line("Every account is due for an idle collection on the next poller tick.");
  }),
).pipe(Command.withDescription("Make every account due for an idle collection now"));

export const idleRules = Command.make("idle-rules", {}, list).pipe(
  Command.withDescription(
    "The metric-based idle rules, the org's thresholds and lookback, and each account's last collection",
  ),
  Command.withSubcommands([rescan]),
);
