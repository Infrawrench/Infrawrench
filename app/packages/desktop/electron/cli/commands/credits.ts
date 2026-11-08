import type { CreditBurndown } from "@infrawrench/client-core" with {
  "resolution-mode": "import",
};
import { Effect, Schema } from "effect";
import { Command } from "effect/cli";
import { CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import * as Print from "../effect/print";
import { CliSession } from "../effect/session";
import { spreadBody, wire } from "../effect/wire";
import { c, type Column } from "../output";

const PATH = "/credits";

// `urgency` stays a string: the runway cell renders an unknown one uncolored.
const Burndown = wire<CreditBurndown>()(
  Schema.Struct({
    pots: Schema.Array(
      Schema.Struct({
        accountName: Schema.String,
        label: Schema.String,
        remaining: Schema.Finite,
        currency: Schema.String,
        burnPerDay: Schema.NullOr(Schema.Finite),
        topUps: Schema.Finite,
        runwayDays: Schema.NullOr(Schema.Finite),
        neverEmpties: Schema.Boolean,
        limitedByExpiry: Schema.Boolean,
        urgency: Schema.String,
      }),
    ),
    failures: Schema.Array(
      Schema.Struct({
        accountName: Schema.String,
        error: Schema.String,
        helpLabel: Schema.NullOr(Schema.String),
        helpUrl: Schema.NullOr(Schema.String),
      }),
    ),
    burnWindowDays: Schema.Finite,
  }),
);
type Pot = (typeof Burndown.Type)["pots"][number];

/** Money in the pot's own currency; never summed across currencies. */
function amount(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: Math.abs(value) < 10 ? 2 : 0,
    }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}

/**
 * The runway cell, coarsening as it grows.
 *
 * "213 days" implies a burn measured to a precision a 30-day window cannot
 * support; "7 months" is the honest rendering of the same estimate.
 */
function runwayCell(pot: Pot): string {
  if (pot.neverEmpties) return c.dim("no spend observed");
  if (pot.runwayDays === null) return c.dim("not enough history");
  const days = pot.runwayDays;
  const text =
    days <= 0
      ? "exhausted"
      : days < 1
        ? "< 1 day"
        : days < 14
          ? `${Math.round(days)}d`
          : days < 60
            ? `${Math.round(days / 7)}w`
            : days < 730
              ? `${Math.round(days / 30)}mo`
              : "2y+";
  switch (pot.urgency) {
    case "critical":
      return c.red(text);
    case "warning":
      return c.yellow(text);
    default:
      return text;
  }
}

/**
 * `infrawrench credits`: prepaid balances and how long they last.
 *
 * Worth having in the CLI specifically because this is the number that turns
 * into an outage rather than an invoice: a prepaid pot that empties stops
 * answering, and `--json` in a morning check is how you find out before your
 * inference calls start 402-ing.
 */
export const credits = Command.make(
  "credits",
  {},
  Effect.fn("credits")(function* () {
    const session = yield* CliSession;
    const api = yield* CloudApi;
    const org = yield* currentOrg;
    const body = yield* api.json(org.id, PATH);

    if (session.output === "json") {
      return yield* Print.json(yield* spreadBody({ org: org.id }, body, PATH));
    }
    const feed = yield* decodeBody(Burndown, PATH)(body);

    if (feed.pots.length === 0 && feed.failures.length === 0) {
      return yield* Print.line(
        c.dim(
          "No prepaid credit balances tracked. Only providers that expose a balance can be tracked; most bill in arrears and have no pot to burn down.",
        ),
      );
    }

    const atRisk = feed.pots.filter(
      (p) => p.urgency === "critical" || p.urgency === "warning",
    ).length;
    yield* Print.line(
      `${c.bold(org.displayName)} ${c.dim(
        `· ${feed.pots.length} balance${feed.pots.length === 1 ? "" : "s"}` +
          (atRisk > 0 ? `, ${atRisk} running low` : "") +
          ` · burn measured over ${feed.burnWindowDays}d`,
      )}`,
    );
    yield* Print.line();

    if (feed.pots.length > 0) {
      const columns: Column<Pot>[] = [
        { header: "account", value: (p) => p.accountName },
        { header: "pot", value: (p) => c.dim(p.label) },
        { header: "remaining", value: (p) => amount(p.remaining, p.currency) },
        {
          header: "burn/day",
          value: (p) => (p.burnPerDay === null ? c.dim("—") : amount(p.burnPerDay, p.currency)),
        },
        { header: "runway", value: (p) => runwayCell(p) },
        {
          header: "note",
          value: (p) =>
            p.limitedByExpiry
              ? c.yellow("credit expires first")
              : p.topUps > 0
                ? c.dim(`${p.topUps} top-up${p.topUps === 1 ? "" : "s"} in window`)
                : c.dim("—"),
        },
      ];
      yield* Print.table(feed.pots, columns);
    }

    for (const failure of feed.failures) {
      yield* Print.line();
      yield* Print.line(c.yellow(`${failure.accountName}: ${failure.error}`));
      if (failure.helpUrl) {
        yield* Print.line(c.dim(`  ${failure.helpLabel ?? "More"}: ${failure.helpUrl}`));
      }
    }
  }),
).pipe(Command.withDescription('Prepaid balances with burn rate and runway ("6 days left")'));
