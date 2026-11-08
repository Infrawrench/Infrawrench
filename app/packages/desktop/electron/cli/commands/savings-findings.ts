// `infrawrench savings findings`: the savings findings workflow from a
// terminal. Every finder's findings (orphaned, oversized, extended support,
// unused seats) with their status, detected date and the summary tiles.
//
//   savings findings                 open findings, largest saving first
//   savings findings --status all    every status (or ready, in_progress, ...)
//   savings findings --view "Prod"   a saved view, by name or id
//   savings findings set <key>... --status archived [--note "..."]
//   savings views                    the saved views the caller can see
//
// Cloud only: statuses and views are kept server-side. Types are a type-only
// import from client-core, so the CLI ships no new runtime dependency; the
// query string is built here, mirroring client-core's `savingsFindingsQuery`.
//
// Both are subcommands of `savings` (`./savings.ts`).
import { Effect, Option, Schema } from "effect";
import { Argument, CliError, Command, Flag } from "effect/cli";
import type {
  SavingsFindingStatusResult,
  SavingsFindingsResponse,
  SavingsView,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import { cloudAccounts, findAccount } from "../context";
import { CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import { CliUsageError } from "../effect/errors";
import * as Print from "../effect/print";
import { from, to } from "../effect/range-flags";
import { CliSession } from "../effect/session";
import { spreadBody, wire } from "../effect/wire";
import { c, formatMoney, safe, type Column } from "../output";

const STATUSES = ["ready", "in_progress", "completed", "archived"] as const;
const STATUS_TABS = ["open", ...STATUSES, "all"] as const;
const KINDS = ["orphan", "oversized", "extended_support", "seat"] as const;
const SORT_FIELDS = ["savings", "detected", "name", "status_changed"] as const;

const STATUS_LABELS: Partial<Record<string, string>> = {
  ready: "ready for review",
  in_progress: "in progress",
  completed: "completed",
  archived: "archived",
};

const KIND_LABELS: Partial<Record<string, string>> = {
  orphan: "orphaned",
  oversized: "oversized",
  extended_support: "extended support",
  seat: "unused seat",
};

const kindLabel = (kind: string) => KIND_LABELS[kind] ?? safe(kind);

function statusColor(status: string): (s: string) => string {
  switch (status) {
    case "ready":
      return c.cyan;
    case "in_progress":
      return c.yellow;
    case "completed":
      return c.green;
    default:
      return c.dim;
  }
}

const MoneySchema = Schema.Struct({ amount: Schema.Finite, currency: Schema.String });

function totals(list: ReadonlyArray<typeof MoneySchema.Type> | null): string {
  if (!list?.length) return "none";
  return list.map((m) => formatMoney(m.amount, m.currency)).join(" + ");
}

/** `value`, if it is one of `allowed`, in the legacy parser's words otherwise. */
const oneOf = <T extends string>(
  flag: string,
  value: string,
  allowed: readonly T[],
): Effect.Effect<T, CliError.ValidationError> => {
  const known = allowed.find((a) => a === value);
  return known === undefined
    ? Effect.fail(
        new CliError.ValidationError({
          message: `--${flag} must be one of ${allowed.join(", ")}, got "${value}"`,
        }),
      )
    : Effect.succeed(known);
};

/** An optional string flag whose value `check` validates or rewrites. */
const checked = <A>(
  name: string,
  check: (text: string) => Effect.Effect<A, CliError.ValidationError>,
): Flag.Flag<Option.Option<A>> => Flag.String(name).pipe(Flag.mapEffect(check), Flag.optional);

const Finding = Schema.Struct({
  key: Schema.String,
  title: Schema.String,
  kind: Schema.String,
  accountName: Schema.NullOr(Schema.String),
  monthlySavings: Schema.NullOr(MoneySchema),
  detectedAt: Schema.String,
  status: Schema.String,
  resolution: Schema.NullOr(Schema.String),
  statusNote: Schema.NullOr(Schema.String),
});
type Finding = typeof Finding.Type;

const Findings = wire<SavingsFindingsResponse>()(
  Schema.Struct({
    findings: Schema.Array(Finding),
    summary: Schema.Struct({
      counts: Schema.Struct({
        ready: Schema.Finite,
        in_progress: Schema.Finite,
        completed: Schema.Finite,
        archived: Schema.Finite,
      }),
      potentialMonthly: Schema.Array(MoneySchema),
      unpricedOpenCount: Schema.Finite,
      realized: Schema.NullOr(Schema.Array(MoneySchema)),
      realizedWindowDays: Schema.Finite,
      savingsRate: Schema.NullOr(Schema.Array(Schema.Struct({ rate: Schema.Finite }))),
    }),
    unavailable: Schema.Array(Schema.Struct({ kind: Schema.String, error: Schema.String })),
  }),
);

const StatusResult = wire<SavingsFindingStatusResult>()(
  Schema.Struct({
    updated: Schema.Array(Schema.Unknown),
    missing: Schema.Array(Schema.String),
  }),
);

const Views = wire<SavingsView[]>()(
  Schema.Array(
    Schema.Struct({
      name: Schema.String,
      status: Schema.String,
      filter: Schema.Struct({
        kinds: Schema.optional(Schema.Array(Schema.String)),
        pluginIds: Schema.optional(Schema.Array(Schema.String)),
        accountIds: Schema.optional(Schema.Array(Schema.String)),
        regions: Schema.optional(Schema.Array(Schema.String)),
        tags: Schema.optional(
          Schema.Array(
            Schema.Struct({
              key: Schema.String,
              values: Schema.optional(Schema.Array(Schema.String)),
            }),
          ),
        ),
        minMonthlySavings: Schema.optional(Schema.NullOr(Schema.Finite)),
        detectedFrom: Schema.optional(Schema.NullOr(Schema.String)),
        detectedTo: Schema.optional(Schema.NullOr(Schema.String)),
        search: Schema.optional(Schema.NullOr(Schema.String)),
      }),
      sort: Schema.Struct({ field: Schema.String, direction: Schema.String }),
    }),
  ),
);
type View = (typeof Views.Type)[number];

const findingsFlags = {
  status: checked("status", (s) => oneOf("status", s, STATUS_TABS)).pipe(
    Flag.withDescription("open (default), ready, in_progress, completed, archived or all"),
  ),
  kind: checked("kind", (text) =>
    Effect.forEach(text.split(","), (k) => oneOf("kind", k.trim(), KINDS)).pipe(
      Effect.map((kinds) => kinds.join(",")),
    ),
  ).pipe(Flag.withDescription("orphan, oversized, extended_support or seat (comma-separated)")),
  provider: Flag.String("provider").pipe(Flag.withDescription("Only this provider"), Flag.optional),
  region: Flag.String("region").pipe(Flag.withDescription("Only this region"), Flag.optional),
  tag: Flag.String("tag").pipe(
    Flag.withMetavar("key[=value]"),
    Flag.withDescription("Only findings carrying this tag"),
    Flag.optional,
  ),
  minSavings: checked("min-savings", (text) => {
    const n = Number(text);
    return Number.isFinite(n) && n >= 0
      ? Effect.succeed(n)
      : Effect.fail(
          new CliError.ValidationError({
            message: `--min-savings must be a monthly amount, got "${text}"`,
          }),
        );
  }).pipe(Flag.withDescription("Only findings saving at least this much a month")),
  view: Flag.String("view").pipe(
    Flag.withMetavar("name|id"),
    Flag.withDescription("A saved view"),
    Flag.optional,
  ),
  sort: checked("sort", (text) => {
    const [field = "", direction = field === "name" ? "asc" : "desc"] = text.split(":");
    return Effect.all([
      oneOf("sort", field, SORT_FIELDS),
      oneOf("sort", direction, ["asc", "desc"] as const),
    ]).pipe(Effect.map(([f, d]) => `${f}:${d}`));
  }).pipe(
    Flag.withMetavar("field[:asc|desc]"),
    Flag.withDescription("savings, detected, name or status_changed"),
  ),
  search: Flag.String("search").pipe(
    Flag.withDescription("Substring over title, resource and account names"),
    Flag.optional,
  ),
  from: from.pipe(Flag.withDescription("Detected on or after this day")),
  to: to.pipe(Flag.withDescription("Detected on or before this day")),
};

/** `savings findings set <key>... --status <s> [--note]`. */
const setStatus = Command.make(
  "set",
  {
    keys: Argument.String("key").pipe(
      Argument.withDescription("Finding keys, as the listing prints them"),
      Argument.variadic(),
    ),
    status: Flag.String("status").pipe(
      Flag.withDescription("ready, in_progress, completed or archived"),
      Flag.optional,
    ),
    note: Flag.String("note").pipe(
      Flag.withDescription("Why, kept with the change"),
      Flag.optional,
    ),
  },
  Effect.fn("savings.findings.set")(function* (input) {
    const session = yield* CliSession;
    const api = yield* CloudApi;
    if (input.keys.length === 0) {
      return yield* new CliUsageError({
        message:
          "Name the findings by key: infrawrench savings findings set orphan:<id> --status archived",
      });
    }
    if (Option.isNone(input.status)) {
      return yield* new CliUsageError({
        message: `--status is required (${STATUSES.join(", ")})`,
      });
    }
    const status = yield* oneOf("status", input.status.value, STATUSES).pipe(
      Effect.mapError((e) => new CliUsageError({ message: e.message })),
    );
    const org = yield* currentOrg;
    const note = Option.getOrUndefined(input.note);
    const path = "/savings/findings/status";
    const body = yield* api.json(org.id, path, {
      method: "POST",
      body: JSON.stringify({ keys: input.keys, status, ...(note ? { note } : {}) }),
    });
    if (session.output === "json") {
      return yield* Print.json(yield* spreadBody({ org: org.id }, body, path));
    }
    const result = yield* decodeBody(StatusResult, path)(body);
    yield* Print.line(
      `Moved ${c.bold(String(result.updated.length))} finding${result.updated.length === 1 ? "" : "s"} to ${statusColor(status)(STATUS_LABELS[status] ?? status)}.`,
    );
    if (result.missing.length > 0) {
      yield* Print.line(c.yellow(`Not found: ${safe(result.missing.join(", "))}`));
    }
  }),
).pipe(Command.withDescription("Change findings' status"));

export const findings = Command.make(
  "findings",
  findingsFlags,
  Effect.fn("savings.findings")(function* (flags) {
    const session = yield* CliSession;
    const api = yield* CloudApi;
    const org = yield* currentOrg;
    const q = new URLSearchParams();
    const view = Option.getOrUndefined(flags.view);
    if (view) q.set("view", view);
    // Without a view the CLI opens on the open findings, the UI's default tab.
    const status = Option.getOrUndefined(flags.status) ?? (view ? undefined : "open");
    if (status) q.set("status", status);
    if (Option.isSome(flags.kind)) q.set("kind", flags.kind.value);
    if (Option.isSome(flags.provider)) q.set("provider", flags.provider.value);
    if (Option.isSome(flags.region)) q.set("region", flags.region.value);
    const wantedAccount = session.account;
    if (wantedAccount) {
      const account = yield* findAccount(yield* cloudAccounts(org.id), wantedAccount);
      q.set("account", account.id);
    }
    if (Option.isSome(flags.tag)) q.append("tag", flags.tag.value);
    if (Option.isSome(flags.minSavings)) q.set("minSavings", String(flags.minSavings.value));
    if (Option.isSome(flags.from)) q.set("detectedFrom", flags.from.value);
    if (Option.isSome(flags.to)) q.set("detectedTo", flags.to.value);
    if (Option.isSome(flags.search)) q.set("q", flags.search.value);
    if (Option.isSome(flags.sort)) q.set("sort", flags.sort.value);

    const qs = q.toString();
    const path = `/savings/findings${qs ? `?${qs}` : ""}`;
    const body = yield* api.json(org.id, path);
    if (session.output === "json") {
      return yield* Print.json(yield* spreadBody({ org: org.id }, body, path));
    }
    const response = yield* decodeBody(Findings, path)(body);

    const { summary } = response;
    const rate = summary.savingsRate?.[0];
    yield* Print.line(
      `${c.bold(safe(org.displayName))} ${c.dim(
        `· ${response.findings.length} finding${response.findings.length === 1 ? "" : "s"}${status ? ` · ${status.replace("_", " ")}` : ""}`,
      )}`,
    );
    yield* Print.line(
      `${c.bold(totals(summary.potentialMonthly))}${c.dim("/mo potential")}` +
        (summary.realized
          ? `   ${c.bold(totals(summary.realized))}${c.dim(` realized in ${summary.realizedWindowDays}d`)}`
          : "") +
        (rate ? `   ${c.bold(`${Math.round(rate.rate * 100)}%`)}${c.dim(" savings rate")}` : ""),
    );
    yield* Print.line(
      c.dim(
        `${summary.counts.ready} ready · ${summary.counts.in_progress} in progress · ${summary.counts.completed} completed · ${summary.counts.archived} archived` +
          (summary.unpricedOpenCount ? ` · ${summary.unpricedOpenCount} open unpriced` : ""),
      ),
    );
    for (const u of response.unavailable) {
      yield* Print.line(
        c.yellow(`${kindLabel(u.kind)} findings could not be computed: ${safe(u.error)}`),
      );
    }
    yield* Print.line();

    const columns: Column<Finding>[] = [
      { header: "key", value: (f) => c.dim(safe(f.key)) },
      { header: "finding", value: (f) => safe(f.title) },
      { header: "kind", value: (f) => c.dim(kindLabel(f.kind)) },
      { header: "account", value: (f) => safe(f.accountName ?? "") },
      {
        header: "saves/mo",
        align: "right",
        value: (f) =>
          f.monthlySavings
            ? formatMoney(f.monthlySavings.amount, f.monthlySavings.currency)
            : c.dim("?"),
      },
      { header: "detected", value: (f) => f.detectedAt.slice(0, 10) },
      {
        header: "status",
        value: (f) =>
          statusColor(f.status)(STATUS_LABELS[f.status] ?? safe(f.status)) +
          (f.resolution === "resolved" ? c.dim(" (auto)") : "") +
          (f.statusNote ? c.dim(` · ${safe(f.statusNote)}`) : ""),
      },
    ];
    yield* Print.table(response.findings, columns);
    if (response.findings.length > 0) {
      yield* Print.line();
      yield* Print.line(
        c.dim("Change a status: infrawrench savings findings set <key>... --status in_progress"),
      );
    }
  }),
).pipe(
  Command.withDescription("Every savings finding with its status, detected date and summary"),
  Command.withSubcommands([setStatus]),
);

const describeView = (v: View): string => {
  const f = v.filter;
  const parts = [
    f.kinds?.length ? f.kinds.map((k) => KIND_LABELS[k] ?? k).join("/") : null,
    f.pluginIds?.length ? f.pluginIds.join("/") : null,
    f.accountIds?.length ? `${f.accountIds.length} account(s)` : null,
    f.regions?.length ? f.regions.join("/") : null,
    f.tags?.length
      ? f.tags.map((t) => (t.values?.length ? `${t.key}=${t.values.join("|")}` : t.key)).join(" ")
      : null,
    f.minMonthlySavings ? `>= ${f.minMonthlySavings}/mo` : null,
    f.detectedFrom || f.detectedTo
      ? `detected ${f.detectedFrom ?? "…"}..${f.detectedTo ?? "…"}`
      : null,
    f.search ? `"${f.search}"` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "everything";
};

/** `savings views`: the saved views the caller can see. */
export const views = Command.make(
  "views",
  {},
  Effect.fn("savings.views")(function* () {
    const session = yield* CliSession;
    const api = yield* CloudApi;
    const org = yield* currentOrg;
    const path = "/savings-views";
    const body = yield* api.json(org.id, path);
    if (session.output === "json") {
      const raw = yield* decodeBody(Schema.Array(Schema.Unknown), path)(body);
      return yield* Print.json({ org: org.id, views: raw });
    }
    const list = yield* decodeBody(Views, path)(body);
    yield* Print.table(list, [
      { header: "name", value: (v) => c.bold(safe(v.name)) },
      { header: "status", value: (v) => safe(v.status.replace("_", " ")) },
      { header: "filter", value: (v) => c.dim(safe(describeView(v))) },
      { header: "sort", value: (v) => c.dim(safe(`${v.sort.field} ${v.sort.direction}`)) },
    ]);
    if (list.length > 0) {
      yield* Print.line();
      yield* Print.line(c.dim('Open one: infrawrench savings findings --view "<name>"'));
    }
  }),
).pipe(Command.withDescription("Saved views over the findings list"));
