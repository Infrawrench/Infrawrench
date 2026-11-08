// `infrawrench savings`: what the optimization actions taken actually saved,
// against each resource's own pre-action spend, beside the projection;
// `savings log` records one Infrawrench could not observe. `savings findings`
// and `savings views` live in `./savings-findings.ts`.
import { Effect, Option, Schema } from "effect";
import { Argument, CliError, Command, Flag } from "effect/cli";
import type {
  RealizedSavingsGrouping,
  RealizedSavingsReport,
  SavingsEvent,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import { CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import { CliUsageError } from "../effect/errors";
import * as Print from "../effect/print";
import { currency, from, groupBy, resource, to } from "../effect/range-flags";
import { CliSession } from "../effect/session";
import { spreadBody, wire } from "../effect/wire";
import { barChart } from "../charts";
import { c, safe, type Column } from "../output";
import { findings, views } from "./savings-findings";

/** Money in its own currency; never summed across currencies. */
function money(value: number, currencyCode: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currencyCode,
      maximumFractionDigits: Math.abs(value) < 10 ? 2 : 0,
    }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currencyCode}`;
  }
}

const KIND_LABELS: Partial<Record<string, string>> = {
  rightsizing: "right-sizing",
  orphan_deletion: "orphan cleanup",
  sleep_schedule: "sleep schedule",
  commitment: "commitments",
  saas_seat: "SaaS seats",
  manual: "manual",
};

const BASIS_LABELS: Partial<Record<string, string>> = {
  billing: "billing",
  estimate: "estimate",
  manual: "as logged",
  unmeasured: "unmeasured",
};

const GROUPINGS: readonly RealizedSavingsGrouping[] = ["month", "kind", "costCentre", "account"];

/** `--group-by month|kind|cost-centre|account`. */
const grouping = groupBy.pipe(
  Flag.withMetavar("month|kind|cost-centre|account"),
  Flag.withDescription("The breakdown chart (default month)"),
  Flag.mapEffect((value) => {
    if (Option.isNone(value)) return Effect.succeed<RealizedSavingsGrouping>("month");
    const text = value.value;
    const normalized = text === "cost-centre" || text === "centre" ? "costCentre" : text;
    const known = GROUPINGS.find((g) => g === normalized);
    return known
      ? Effect.succeed(known)
      : Effect.fail(
          new CliError.ValidationError({
            message: `--group-by must be month, kind, cost-centre or account, got "${text}"`,
          }),
        );
  }),
);

const Bucket = Schema.Struct({
  key: Schema.String,
  label: Schema.String,
  currency: Schema.String,
  realized: Schema.Finite,
  projected: Schema.Finite,
});

const Event = Schema.Struct({
  occurredOn: Schema.String,
  title: Schema.String,
  kind: Schema.String,
  projectedMonthlyAmount: Schema.NullOr(Schema.Finite),
  currency: Schema.NullOr(Schema.String),
  realizedInRange: Schema.NullOr(Schema.Finite),
  realizedCurrency: Schema.NullOr(Schema.String),
  basis: Schema.String,
  status: Schema.String,
  shortfall: Schema.NullOr(Schema.Struct({ kind: Schema.String })),
});
type Event = typeof Event.Type;

const Report = wire<RealizedSavingsReport>()(
  Schema.Struct({
    from: Schema.String,
    to: Schema.String,
    settings: Schema.Struct({ horizonMonths: Schema.Finite }),
    totals: Schema.Array(
      Schema.Struct({ currency: Schema.String, realized: Schema.Finite, projected: Schema.Finite }),
    ),
    byMonth: Schema.Array(
      Schema.Struct({
        month: Schema.String,
        currency: Schema.String,
        realized: Schema.Finite,
        projected: Schema.Finite,
      }),
    ),
    byKind: Schema.Array(Bucket),
    byCostCentre: Schema.Array(Bucket),
    byAccount: Schema.Array(Bucket),
    events: Schema.Array(Event),
    shortfallCount: Schema.Finite,
    unmeasuredCount: Schema.Finite,
  }),
);
type Report = typeof Report.Type;

const Logged = wire<SavingsEvent>()(
  Schema.Struct({
    title: Schema.String,
    projectedMonthlyAmount: Schema.NullOr(Schema.Finite),
    currency: Schema.NullOr(Schema.String),
    occurredOn: Schema.String,
  }),
);

function rowsFor(report: Report, by: RealizedSavingsGrouping, currencyCode: string) {
  if (by === "month") {
    return report.byMonth
      .filter((m) => m.currency === currencyCode)
      .map((m) => ({ label: m.month, realized: m.realized, projected: m.projected }));
  }
  const buckets =
    by === "kind" ? report.byKind : by === "costCentre" ? report.byCostCentre : report.byAccount;
  return buckets
    .filter((b) => b.currency === currencyCode)
    .map((b) => ({
      label: by === "kind" ? (KIND_LABELS[b.key] ?? safe(b.key)) : safe(b.label),
      realized: b.realized,
      projected: b.projected,
    }));
}

/**
 * `infrawrench savings log "<what was done>" --amount 120 --currency USD
 * [--from 2026-09-01] [--note "..."]`: record a saving Infrawrench could not
 * observe. `--from` is the day it began (default today).
 */
const log = Command.make(
  "log",
  {
    title: Argument.String("what").pipe(
      Argument.withDescription("What was done (the words join into one title)"),
      Argument.variadic(),
    ),
    amount: Flag.String("amount").pipe(
      Flag.withMetavar("monthly"),
      Flag.withDescription("The monthly saving"),
      Flag.optional,
    ),
    currency: currency.pipe(Flag.withDescription("The saving's currency (default USD)")),
    from: from.pipe(Flag.withDescription("The day it began (default today)")),
    note: Flag.String("note").pipe(Flag.withDescription("Context kept with it"), Flag.optional),
    resource: resource.pipe(Flag.withDescription("The resource it was saved on")),
  },
  Effect.fn("savings.log")(function* (input) {
    const session = yield* CliSession;
    const api = yield* CloudApi;
    const title = input.title.join(" ");
    if (!title.trim()) {
      return yield* new CliUsageError({
        message: 'Say what was done: infrawrench savings log "Cancelled the old CDN" --amount 120',
      });
    }
    const amountText = Option.getOrUndefined(input.amount);
    const amount = Number(amountText);
    if (!amountText || !Number.isFinite(amount) || amount <= 0) {
      return yield* new CliUsageError({
        message: "--amount must be the monthly saving, a number above zero",
      });
    }
    const org = yield* currentOrg;
    const note = Option.getOrUndefined(input.note);
    const resourceId = Option.getOrUndefined(input.resource);
    const path = "/savings/events";
    const body = yield* api.json(org.id, path, {
      method: "POST",
      body: JSON.stringify({
        title: title.trim(),
        projectedMonthlyAmount: amount,
        currency: Option.getOrElse(input.currency, () => "USD").toUpperCase(),
        occurredOn: Option.getOrElse(input.from, () => new Date().toISOString().slice(0, 10)),
        ...(note ? { note } : {}),
        ...(resourceId ? { resourceId } : {}),
      }),
    });
    if (session.output === "json") return yield* Print.json({ org: org.id, event: body });
    const created = yield* decodeBody(Logged, path)(body);
    yield* Print.line(
      `Logged ${c.bold(safe(created.title))} ${c.dim(
        `· ${money(created.projectedMonthlyAmount ?? amount, created.currency ?? "USD")}/mo from ${created.occurredOn}`,
      )}`,
    );
  }),
).pipe(Command.withDescription("Log a saving by hand"));

/**
 * `infrawrench savings`: what the optimization actions taken actually saved.
 *
 * `--from`/`--to` pick the range (default: the last 12 months through
 * yesterday); `--group-by` the breakdown chart. `--json` emits the report as
 * the API returns it.
 */
export const savings = Command.make(
  "savings",
  {
    from: from.pipe(Flag.withDescription("Start of the range (default 12 months ago)")),
    to: to.pipe(Flag.withDescription("End of the range (default yesterday)")),
    groupBy: grouping,
  },
  Effect.fn("savings")(function* (input) {
    const session = yield* CliSession;
    const api = yield* CloudApi;
    const org = yield* currentOrg;
    const params = new URLSearchParams();
    if (Option.isSome(input.from) && input.from.value) params.set("from", input.from.value);
    if (Option.isSome(input.to) && input.to.value) params.set("to", input.to.value);
    const qs = params.toString();
    const path = `/savings/realized${qs ? `?${qs}` : ""}`;
    const body = yield* api.json(org.id, path);

    if (session.output === "json") {
      return yield* Print.json(yield* spreadBody({ org: org.id }, body, path));
    }
    const report = yield* decodeBody(Report, path)(body);

    yield* Print.line(
      `${c.bold(safe(org.displayName))} ${c.dim(
        `· realized savings ${report.from} → ${report.to} · horizon ${report.settings.horizonMonths} months`,
      )}`,
    );
    yield* Print.line();

    if (report.events.length === 0) {
      return yield* Print.line(
        c.dim(
          "No savings recorded. Resizes, orphan cleanups and sleep schedules are recorded as they happen (in the app or detected on sync); log anything else with `infrawrench savings log`.",
        ),
      );
    }

    for (const t of report.totals) {
      const share = t.projected > 0 ? ` (${Math.round((t.realized / t.projected) * 100)}%)` : "";
      yield* Print.line(
        `${c.bold(money(t.realized, t.currency))} realized ${c.dim(
          `of ${money(t.projected, t.currency)} projected${share}`,
        )}`,
      );
    }

    const primary = report.totals[0];
    if (primary) {
      const by = input.groupBy;
      yield* Print.line();
      yield* Print.line(
        c.dim(`by ${by === "costCentre" ? "cost centre" : by} (${primary.currency})`),
      );
      const rows = rowsFor(report, by, primary.currency);
      for (const line of barChart(
        rows.map((r) => ({
          label: r.label,
          value: r.realized,
          display: `${money(r.realized, primary.currency)} ${c.dim(`/ ${money(r.projected, primary.currency)}`)}`,
        })),
      )) {
        yield* Print.line(line);
      }
    }

    yield* Print.line();
    const columns: Column<Event>[] = [
      { header: "since", value: (e) => e.occurredOn },
      { header: "action", value: (e) => safe(e.title) },
      { header: "type", value: (e) => c.dim(KIND_LABELS[e.kind] ?? safe(e.kind)) },
      {
        header: "projected/mo",
        value: (e) =>
          e.projectedMonthlyAmount !== null && e.currency
            ? money(e.projectedMonthlyAmount, e.currency)
            : c.dim("—"),
      },
      {
        header: "realized",
        value: (e) =>
          e.realizedInRange === null
            ? c.dim("not measured")
            : money(e.realizedInRange, e.realizedCurrency ?? e.currency ?? "USD"),
      },
      { header: "basis", value: (e) => c.dim(BASIS_LABELS[e.basis] ?? safe(e.basis)) },
      {
        header: "note",
        value: (e) =>
          e.shortfall
            ? c.yellow(e.shortfall.kind === "grew_back" ? "grew back" : "short of projection")
            : c.dim(safe(e.status)),
      },
    ];
    yield* Print.table(report.events, columns);

    if (report.shortfallCount > 0 || report.unmeasuredCount > 0) {
      yield* Print.line();
      if (report.shortfallCount > 0) {
        yield* Print.line(
          c.yellow(`${report.shortfallCount} action(s) realizing less than projected.`),
        );
      }
      if (report.unmeasuredCount > 0) {
        yield* Print.line(
          c.dim(`${report.unmeasuredCount} action(s) not measurable yet (not counted).`),
        );
      }
    }
  }),
).pipe(
  Command.withDescription(
    "Realized savings: what resizes, cleanups, schedules and commitments actually saved",
  ),
  Command.withSubcommands([log, findings, views]),
);
