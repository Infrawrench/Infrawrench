// `infrawrench orphans`: likely-wasted resources (unattached volumes,
// unassigned IPs) with the plugin's reason for flagging each one.
//
// Works in both modes, because the classification is declarative and runs over
// stored state rather than a live provider call:
//   - cloud (default): GET /orphans, the same endpoint the web + desktop Costs
//     panels' Potential savings section uses, with trailing per-resource spend
//     where the org collects it.
//   - --local: electron/local-orphans.ts scans this machine's SQLite
//     workspace. No credentials, no network. Spend is collected by the cloud,
//     so local rows carry no cost and the column is dropped rather than
//     printed as zero.
//
// The response shape comes from `@infrawrench/plugin-base` (the same
// definition the web and desktop savings sections use) so a server-side change
// breaks the CLI's build instead of its output. The import is type-only, so
// the CLI still ships zero new runtime dependencies.
import { Effect, Schema } from "effect";
import { Command } from "effect/cli";
import { listLocalOrphans } from "../../local-orphans";
import type { OrphanListResponse } from "@infrawrench/plugin-base" with {
  "resolution-mode": "import",
};
import { CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import * as Print from "../effect/print";
import { CliSession } from "../effect/session";
import { spreadBody, wire } from "../effect/wire";
import { describeIdleEvidence } from "../format";
import { c, formatMoney, safe, type Column } from "../output";
import { printRemediation, Remediation } from "../remediation";

const PATH = "/orphans";

const Money = Schema.Struct({ amount: Schema.Finite, currency: Schema.String });

const Evidence = Schema.Struct({
  metric: Schema.String,
  label: Schema.String,
  statistic: Schema.String,
  value: Schema.NullOr(Schema.Finite),
  unit: Schema.String,
  threshold: Schema.optional(Schema.NullOr(Schema.Finite)),
  comparison: Schema.optional(Schema.Literals(["atMost", "atLeast"])),
});

const Flagged = Schema.Struct({
  displayName: Schema.String,
  resourceTypeName: Schema.String,
  reason: Schema.String,
  owner: Schema.NullOr(Schema.Struct({ displayName: Schema.String, isLabel: Schema.Boolean })),
  cost: Schema.NullOr(Money),
  estimate: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        monthlyAmount: Schema.Finite,
        currency: Schema.String,
        note: Schema.optional(Schema.String),
      }),
    ),
  ),
  idle: Schema.optional(
    Schema.Struct({
      ruleLabel: Schema.String,
      lookbackDays: Schema.Finite,
      detectedAt: Schema.String,
      evidence: Schema.Array(Evidence),
    }),
  ),
  remediation: Schema.optional(Schema.NullOr(Remediation)),
});
type FlaggedResource = typeof Flagged.Type;

const Listing = wire<OrphanListResponse>()(
  Schema.Struct({
    accounts: Schema.Array(
      Schema.Struct({
        accountName: Schema.String,
        pluginName: Schema.String,
        resources: Schema.Array(Flagged),
      }),
    ),
    totalCount: Schema.Finite,
    unownedCount: Schema.Finite,
    costWindowDays: Schema.Finite,
    costBasis: Schema.optional(Schema.String),
  }),
);

/** The scan in scope: the local workspace, or the `--org` org's. */
const loadListing = Effect.fn("orphans.load")(function* () {
  const session = yield* CliSession;
  if (session.local) {
    const response = yield* Effect.promise(listLocalOrphans);
    return { label: "Local workspace", json: { ...response }, response };
  }
  const api = yield* CloudApi;
  const org = yield* currentOrg;
  const body = yield* api.json(org.id, PATH);
  return {
    label: org.displayName,
    json: yield* spreadBody({ org: org.id }, body, PATH),
    response: yield* decodeBody(Listing, PATH)(body),
  };
});

export const orphans = Command.make(
  "orphans",
  {},
  Effect.fn("orphans")(function* () {
    const session = yield* CliSession;
    const scope = yield* loadListing();
    const { response } = scope;
    // Cost annotation comes from collected billing rows, which only the cloud
    // has. Saying "$0.00" for every local row would be a lie; drop the column.
    const showCost = response.costBasis !== "unavailable";
    // Ownership is a cloud record too. A local scan reports everything
    // unattributed because it knows of no owners, which is not the same claim
    // as "nobody owns these", so the column comes off rather than printing
    // "unowned" against every row.
    const showOwner = showCost;

    if (session.output === "json") return yield* Print.json(scope.json);

    if (response.accounts.length === 0) {
      yield* Print.line(
        c.dim(
          "Nothing looks wasted. Resources are flagged when a plugin heuristic matches. An empty list is the good outcome.",
        ),
      );
      if (!showCost) {
        yield* Print.line(
          c.dim(
            "This scan covered the local workspace only; drop --local to classify what your cloud accounts sync.",
          ),
        );
      }
      return;
    }

    yield* Print.line(
      `${c.bold(scope.label)} ${c.dim(`· ${response.totalCount} flagged resource${response.totalCount === 1 ? "" : "s"}`)}`,
    );

    const columns: Column<FlaggedResource>[] = [
      { header: "resource", value: (r) => r.displayName },
      { header: "type", value: (r) => c.dim(r.resourceTypeName) },
      { header: "reason", value: (r) => r.reason },
    ];
    if (showOwner) {
      columns.push({
        header: "owner",
        // "unowned" is printed, not blanked: it is the finding, and a blank cell
        // in a terminal table reads as "not looked up".
        value: (r) =>
          r.owner === null
            ? c.dim("unowned")
            : r.owner.isLabel
              ? `${r.owner.displayName} ${c.dim("(team)")}`
              : r.owner.displayName,
      });
    }
    if (showCost) {
      columns.push({
        header: `cost (${response.costWindowDays}d)`,
        // An idle rule's list-price estimate stands in when no billing row
        // matched, marked so it never reads as the bill.
        value: (r) =>
          r.cost
            ? formatMoney(r.cost.amount, r.cost.currency)
            : r.estimate
              ? `${formatMoney(r.estimate.monthlyAmount, r.estimate.currency)}${c.dim("/mo est.")}`
              : c.dim("—"),
        align: "right",
      });
    }

    for (const group of response.accounts) {
      yield* Print.line();
      yield* Print.line(`${c.bold(group.accountName)} ${c.dim(`· ${group.pluginName}`)}`);
      yield* Print.table(group.resources, columns);
    }

    // Metric evidence behind every idle row, so the claim can be checked
    // before anything is deleted.
    const flagged = response.accounts.flatMap((g) => g.resources);
    const idleRows = flagged.flatMap((r) => (r.idle ? [{ row: r, idle: r.idle }] : []));
    if (idleRows.length > 0) {
      yield* Print.line();
      yield* Print.line(c.bold("Idle evidence"));
      for (const { row: r, idle } of idleRows) {
        yield* Print.line(
          `  ${safe(r.displayName)} ${c.dim(`· ${safe(idle.ruleLabel)} · ${idle.lookbackDays} days · since ${idle.detectedAt.slice(0, 10)}`)}`,
        );
        for (const e of idle.evidence) yield* Print.line(`    ${safe(describeIdleEvidence(e))}`);
        if (!r.cost && r.estimate?.note) {
          yield* Print.line(c.dim(`    estimate: ${safe(r.estimate.note)}`));
        }
      }
    }

    yield* Effect.sync(() => printRemediation(flagged));

    if (showOwner && response.unownedCount > 0) {
      yield* Print.line();
      yield* Print.line(
        c.dim(
          `${response.unownedCount} of ${response.totalCount} have no recorded owner. Nobody to ask before deleting, and nobody an alert can reach.`,
        ),
      );
    }

    yield* Print.line();
    yield* Print.line(
      c.dim(
        showCost
          ? "Cost figures are best-effort per-resource billing matches; most providers don't report them. Figures marked est. are list prices for the resource's configuration. Confirm a resource is unused before deleting it."
          : "Spend is collected by Infrawrench Cloud, so a local scan has no cost column. The flags never depend on billing data. Confirm a resource is unused before deleting it.",
      ),
    );
  }),
).pipe(
  Command.withDescription(
    "Likely-wasted resources with reasons, evidence, cost and remediation commands",
  ),
);
