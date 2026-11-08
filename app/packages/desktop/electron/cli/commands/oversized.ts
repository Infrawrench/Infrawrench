// `infrawrench oversized`; right-sizing recommendations: machines whose p95
// CPU/memory over the last 14 days of stored metrics sits well under their
// size, with the cheapest catalog size that still clears headroom and the
// live-priced monthly saving.
//
// Cloud-only, unlike `orphans`: the percentiles live in the cloud metrics
// warehouse and the size catalogs come from the providers with the org's
// credentials; a local workspace has neither. Applying a recommendation is a
// provider mutation (most providers want the machine stopped first), so the
// CLI lists and the web/desktop Apply button applies.
//
// The response shape comes from `@infrawrench/client-core` (the same
// definition every other surface renders) so a server-side change breaks the
// CLI's build instead of its output. The import is type-only, so the CLI
// still ships zero new runtime dependencies.
import type { RightsizingListResponse } from "@infrawrench/client-core" with {
  "resolution-mode": "import",
};
import { Effect, Schema } from "effect";
import { Command } from "effect/cli";
import { CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import * as Print from "../effect/print";
import { CliSession } from "../effect/session";
import { spreadBody, wire } from "../effect/wire";
import { c, formatCo2e, formatMoney, type Column } from "../output";
import { printRemediation, Remediation } from "../remediation";

const PATH = "/rightsizing";

const Size = Schema.Struct({ label: Schema.String });

const Rightsizing = wire<RightsizingListResponse>()(
  Schema.Struct({
    accounts: Schema.Array(
      Schema.Struct({
        accountName: Schema.String,
        pluginName: Schema.String,
        resources: Schema.Array(
          Schema.Struct({
            displayName: Schema.String,
            resourceTypeName: Schema.String,
            currentSize: Size,
            recommendedSize: Size,
            cpuP95: Schema.Finite,
            memoryP95: Schema.NullOr(Schema.Finite),
            memoryMeasured: Schema.Boolean,
            currency: Schema.String,
            monthlySaving: Schema.NullOr(Schema.Finite),
            monthlyKgCo2eSaving: Schema.NullOr(Schema.Finite),
            remediation: Schema.optional(Schema.NullOr(Remediation)),
          }),
        ),
      }),
    ),
    totalCount: Schema.Finite,
    windowDays: Schema.Finite,
  }),
);
type Oversized = (typeof Rightsizing.Type)["accounts"][number]["resources"][number];

export const oversized = Command.make(
  "oversized",
  {},
  Effect.fn("oversized")(function* () {
    const session = yield* CliSession;
    const api = yield* CloudApi;
    const org = yield* currentOrg;
    const body = yield* api.json(org.id, PATH);

    if (session.output === "json") {
      return yield* Print.json(yield* spreadBody({ org: org.id }, body, PATH));
    }
    const response = yield* decodeBody(Rightsizing, PATH)(body);

    if (response.accounts.length === 0) {
      return yield* Print.line(
        c.dim(
          "Nothing looks oversized. A machine is flagged when two weeks of stored metrics put its p95 CPU (and memory, where measured) well under its size. Metrics are stored for resources pinned to a dashboard.",
        ),
      );
    }

    yield* Print.line(
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
      {
        header: "co2e/mo",
        value: (r) =>
          r.monthlyKgCo2eSaving !== null && r.monthlyKgCo2eSaving > 0
            ? `~${formatCo2e(r.monthlyKgCo2eSaving)}`
            : c.dim("n/a"),
        align: "right",
      },
    ];

    for (const group of response.accounts) {
      yield* Print.line();
      yield* Print.line(`${c.bold(group.accountName)} ${c.dim(`· ${group.pluginName}`)}`);
      yield* Print.table(group.resources, columns);
    }

    yield* Effect.sync(() => printRemediation(response.accounts.flatMap((g) => g.resources)));

    yield* Print.line();
    yield* Print.line(
      c.dim(
        "Savings are quoted from each provider's live size catalog; CO2e is estimated from published grid figures (see `infrawrench carbon`). Apply a resize from the web or desktop Costs panel, or run the commands above yourself. The Apply button goes through the normal resource update (change freezes and audit logging apply), and most providers require the machine to be stopped first.",
      ),
    );
  }),
).pipe(
  Command.withDescription(
    "Machines whose 14-day p95 utilisation sits well under their size, with the smaller size and saving",
  ),
);
