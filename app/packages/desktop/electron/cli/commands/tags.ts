// `infrawrench tags`: the org tag policy, per-account compliance, and
// untagged spend; `infrawrench showback`; spend by cost centre. Both are
// reads over the same endpoints the web/desktop Costs panel uses, and the
// wire shapes come from `@infrawrench/client-core` type-only, so the CLI
// keeps its zero-runtime-dependency rule.
import { Effect, Schema } from "effect";
import { Command } from "effect/cli";
import type {
  ShowbackReport,
  TagComplianceReport,
  UntaggedSpendReport,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import { CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import { CliFailure } from "../effect/errors";
import * as Print from "../effect/print";
import { dateRange, resolveDateRange } from "../effect/range-flags";
import { CliSession } from "../effect/session";
import { spreadBody, wire } from "../effect/wire";
import { c, formatMoney, safe } from "../output";
import { barChart } from "../charts";

const Money = Schema.Record(Schema.String, Schema.Finite);

const Compliance = wire<TagComplianceReport>()(
  Schema.Struct({
    policy: Schema.Struct({
      requiredTags: Schema.Array(
        Schema.Struct({
          key: Schema.String,
          allowedValues: Schema.optional(Schema.Array(Schema.String)),
        }),
      ),
      enforceOnCreate: Schema.Boolean,
    }),
    accounts: Schema.Array(
      Schema.Struct({
        pluginId: Schema.String,
        displayName: Schema.String,
        totalResources: Schema.Finite,
        evaluated: Schema.Finite,
        compliant: Schema.Finite,
        score: Schema.NullOr(Schema.Finite),
      }),
    ),
  }),
);

const Untagged = wire<UntaggedSpendReport>()(
  Schema.Struct({
    currencies: Schema.Array(Schema.String),
    totals: Money,
    untaggedTotals: Money,
    topUntagged: Schema.Array(
      Schema.Struct({
        accountLabel: Schema.String,
        service: Schema.String,
        currency: Schema.String,
        amount: Schema.Finite,
      }),
    ),
  }),
);

const Showback = wire<ShowbackReport>()(
  Schema.Struct({
    centres: Schema.Array(
      Schema.Struct({
        costCentreId: Schema.NullOr(Schema.String),
        name: Schema.String,
        totals: Money,
        subtreeTotals: Money,
        parentId: Schema.NullOr(Schema.String),
        depth: Schema.Finite,
      }),
    ),
  }),
);

/**
 * Tag policy + compliance + untagged spend, in one screen: what the org
 * requires, which accounts carry it, and what the gap costs.
 */
export const tags = Command.make(
  "tags",
  dateRange,
  Effect.fn("tags")(function* (input) {
    const session = yield* CliSession;
    const api = yield* CloudApi;
    if (session.local) {
      return yield* new CliFailure({
        message:
          "Tag policy and compliance are org-level cloud state. There is no local tag policy.",
      });
    }
    const org = yield* currentOrg;
    const { from, to } = resolveDateRange(input);

    const compliancePath = "/tag-policy/compliance";
    const untaggedPath = `/costs/untagged?from=${from}&to=${to}`;
    const [complianceBody, untaggedBody] = yield* Effect.all(
      [api.json(org.id, compliancePath), api.json(org.id, untaggedPath)],
      { concurrency: "unbounded" },
    );

    if (session.output === "json") {
      const head = yield* spreadBody({ org: org.id, from, to }, complianceBody, compliancePath);
      return yield* Print.json({ ...head, untagged: untaggedBody });
    }
    const { policy, accounts } = yield* decodeBody(Compliance, compliancePath)(complianceBody);
    const untagged = yield* decodeBody(Untagged, untaggedPath)(untaggedBody);

    if (policy.requiredTags.length === 0) {
      return yield* Print.line(
        c.dim(
          "No tag policy configured. An org admin can require tags like owner and env on every resource under Settings → Tag Policy in the web app.",
        ),
      );
    }

    const required = policy.requiredTags
      .map((t) => (t.allowedValues?.length ? `${t.key}(${t.allowedValues.join("|")})` : t.key))
      .join(", ");
    yield* Print.line(
      `${c.bold(safe(org.displayName))} ${c.dim("· requires")} ${c.bold(safe(required))}` +
        (policy.enforceOnCreate ? ` ${c.yellow("[enforced at create]")}` : ""),
    );
    yield* Print.line();

    if (accounts.length === 0) {
      yield* Print.line(c.dim("No accounts connected."));
    } else {
      yield* Print.table(accounts, [
        {
          header: "account",
          value: (a) => `${c.bold(safe(a.displayName))} ${c.dim(safe(a.pluginId))}`,
        },
        {
          header: "taggable",
          value: (a) =>
            a.totalResources > a.evaluated
              ? `${a.evaluated} ${c.dim(`of ${a.totalResources}`)}`
              : String(a.evaluated),
          align: "right",
        },
        { header: "compliant", value: (a) => String(a.compliant), align: "right" },
        {
          header: "score",
          value: (a) => {
            if (a.score === null) return c.dim("—");
            const paint = a.score >= 90 ? c.green : a.score >= 50 ? c.yellow : c.red;
            return paint(`${a.score}%`);
          },
          align: "right",
        },
      ]);
    }

    yield* Print.line();
    if (untagged.currencies.length === 0) {
      return yield* Print.line(c.dim(`No spend collected between ${from} and ${to}.`));
    }
    for (const currency of untagged.currencies) {
      const total = untagged.totals[currency] ?? 0;
      const missing = untagged.untaggedTotals[currency] ?? 0;
      yield* Print.line(
        `${c.bold(formatMoney(missing, currency))} of ${formatMoney(total, currency)} ${c.dim(
          `missing a required tag · ${from} → ${to}`,
        )}`,
      );
    }
    const top = untagged.topUntagged.slice(0, 8);
    if (top.length > 0) {
      yield* Print.line();
      const items = top.map((row, idx) => ({
        label: safe(row.service ? `${row.accountLabel} · ${row.service}` : row.accountLabel),
        value: row.amount,
        display: formatMoney(row.amount, row.currency),
        colorIndex: idx,
      }));
      for (const line of barChart(items, 32)) yield* Print.line(line);
    }
  }),
).pipe(Command.withDescription("Org tag policy, per-account compliance and untagged spend"));

/** Spend grouped by cost centre through the org's allocation rules. */
export const showback = Command.make(
  "showback",
  dateRange,
  Effect.fn("showback")(function* (input) {
    const session = yield* CliSession;
    const api = yield* CloudApi;
    if (session.local) {
      return yield* new CliFailure({
        message: "Showback runs over your org's collected cloud spend. Cloud mode only.",
      });
    }
    const org = yield* currentOrg;
    const { from, to } = resolveDateRange(input);
    const path = `/costs/showback?from=${from}&to=${to}`;
    const body = yield* api.json(org.id, path);

    if (session.output === "json") {
      return yield* Print.json(yield* spreadBody({ org: org.id }, body, path));
    }
    const report = yield* decodeBody(Showback, path)(body);

    yield* Print.line(`${c.bold(safe(org.displayName))} ${c.dim(`· showback, ${from} → ${to}`)}`);
    yield* Print.line();

    if (report.centres.length === 0) {
      return yield* Print.line(
        c.dim(
          "No cost centres defined. Build the centre tree under Settings → Cost Centres and map spend onto it with allocation rules under Settings → Tag Policy in the web app; unmatched spend reports as Unallocated.",
        ),
      );
    }

    // Cost centres nest, so the bars are indented into the tree the report
    // already comes back in (depth-first, Unallocated last). A parent's bar is
    // its **subtree** total (the number someone runs `showback` to read) and
    // its own directly-allocated spend is noted after it when the two differ, so
    // "Engineering, of which the division itself" stays legible. Bars therefore
    // deliberately do not sum to the org total; the leaves do.
    const hasChildren = (id: string | null) =>
      id !== null && report.centres.some((other) => other.parentId === id);

    const items = report.centres.flatMap((centre, index) => {
      const rolled = hasChildren(centre.costCentreId);
      const primary = rolled ? centre.subtreeTotals : centre.totals;
      const indent = "  ".repeat(centre.depth);
      return Object.entries(primary).map(([currency, amount]) => {
        const own = centre.totals[currency] ?? 0;
        const suffix =
          rolled && own !== amount ? c.dim(` (own ${formatMoney(own, currency)})`) : "";
        const name =
          centre.costCentreId === null ? c.dim("unallocated") : `${safe(centre.name)}${suffix}`;
        return {
          label: `${indent}${name}`,
          value: amount,
          display: formatMoney(amount, currency),
          colorIndex: centre.costCentreId === null ? 7 : index,
        };
      });
    });
    if (items.length === 0) {
      return yield* Print.line(c.dim("No spend collected in this period."));
    }
    for (const line of barChart(items, 32)) yield* Print.line(line);
  }),
).pipe(
  Command.withDescription(
    "Spend by cost centre via the org's allocation rules, as an indented tree",
  ),
);
