// `infrawrench extended-support`; resources on versions past (or about to
// leave) their provider's standard support, with the monthly surcharge an
// upgrade removes.
//
// Works in both modes, because the support calendars are plugin declarations
// evaluated over stored versions:
//   - cloud (default): GET /extended-support, the same endpoint the Costs
//     panel's Extended support section renders, including billed amounts
//     where the provider's billing can be attributed.
//   - --local: electron/local-extended-support.ts runs the shared computation
//     over this machine's SQLite workspace. List price only; no credentials,
//     no network.
//
// The response type comes from `@infrawrench/client-core` as a type-only
// import, so the CLI ships zero new runtime dependencies.
import { Effect, Schema } from "effect";
import { Command } from "effect/cli";
import { listLocalExtendedSupport } from "../../local-extended-support";
import type {
  ExtendedSupportListResponse,
  ExtendedSupportStatus,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import { CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import * as Print from "../effect/print";
import { CliSession } from "../effect/session";
import { spreadBody, wire } from "../effect/wire";
import { c, type Column } from "../output";

const PATH = "/extended-support";

const Total = Schema.Struct({ currency: Schema.String, monthly: Schema.Finite });
type Total = typeof Total.Type;

// `status` and `costBasis` stay strings: a status from a newer server renders
// uncolored rather than failing the whole listing.
const Finding = Schema.Struct({
  status: Schema.String,
  displayName: Schema.String,
  accountName: Schema.String,
  product: Schema.String,
  currentVersion: Schema.String,
  targetVersion: Schema.String,
  surchargeStartsOn: Schema.String,
  daysUntilSurcharge: Schema.Finite,
  extendedSupportEnds: Schema.NullOr(Schema.String),
  charged: Schema.Boolean,
  currency: Schema.NullOr(Schema.String),
  monthlySurcharge: Schema.NullOr(Schema.Finite),
  costBasis: Schema.String,
});
type Finding = typeof Finding.Type;

const Listing = wire<ExtendedSupportListResponse>()(
  Schema.Struct({
    findings: Schema.Array(Finding),
    totalCount: Schema.Finite,
    currentMonthly: Schema.Array(Total),
    upcomingMonthly: Schema.Array(Total),
    leadDays: Schema.Finite,
    billing: Schema.optional(
      Schema.Struct({
        accounts: Schema.Array(
          Schema.Struct({ accountName: Schema.String, status: Schema.String }),
        ),
        unattributed: Schema.Array(
          Schema.Struct({
            accountName: Schema.String,
            lineItem: Schema.String,
            region: Schema.optional(Schema.String),
            monthlyAmount: Schema.Finite,
            currency: Schema.String,
          }),
        ),
      }),
    ),
  }),
);

type Tone = (s: string) => string;

const STATUS_LABEL: Partial<Record<string, string>> = {
  "end-of-life": "past end of support",
  surcharged: "paying extended support",
  unsupported: "out of standard support",
  upcoming: "surcharge upcoming",
} satisfies Record<ExtendedSupportStatus, string>;

const STATUS_COLOR: Partial<Record<string, Tone>> = {
  "end-of-life": c.red,
  surcharged: c.yellow,
  unsupported: c.yellow,
  upcoming: c.dim,
} satisfies Record<ExtendedSupportStatus, Tone>;

/** Plain currency formatting; Intl is built into Node, so no dependency. */
function money(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: amount >= 100 ? 0 : 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

function totals(list: readonly Total[]): string {
  return list.map((t) => `${money(t.monthly, t.currency)}/mo`).join(" + ");
}

function whenText(f: Finding): string {
  if (f.status === "upcoming") return `starts ${f.surchargeStartsOn} (${f.daysUntilSurcharge}d)`;
  if (f.status === "end-of-life") return `ended ${f.extendedSupportEnds ?? "?"}`;
  return f.extendedSupportEnds
    ? `since ${f.surchargeStartsOn}, forced ${f.extendedSupportEnds}`
    : `since ${f.surchargeStartsOn}`;
}

function costText(f: Finding): string {
  if (f.monthlySurcharge === null || f.currency === null)
    return c.dim(f.charged ? "not priced" : "no surcharge");
  const basis =
    f.costBasis === "billed" ? "billed" : f.costBasis === "billed-share" ? "billed share" : "list";
  return `${money(f.monthlySurcharge, f.currency)}/mo ${c.dim(basis)}`;
}

/** The findings in scope: the local workspace, or the `--org` org's. */
const loadListing = Effect.fn("extended-support.load")(function* () {
  const session = yield* CliSession;
  if (session.local) {
    const response = yield* Effect.promise(() => listLocalExtendedSupport());
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

export const extendedSupport = Command.make(
  "extended-support",
  {},
  Effect.fn("extended-support")(function* () {
    const session = yield* CliSession;
    const scope = yield* loadListing();
    const { response } = scope;

    if (session.output === "json") return yield* Print.json(scope.json);

    if (response.findings.length === 0) {
      return yield* Print.line(
        c.dim(
          `Nothing is on an extended-support or end-of-life version (upcoming surcharges are listed ${response.leadDays} days ahead).`,
        ),
      );
    }

    const header = [
      response.currentMonthly.length > 0 ? `paying ${totals(response.currentMonthly)}` : "",
      response.upcomingMonthly.length > 0 ? `upcoming ${totals(response.upcomingMonthly)}` : "",
    ]
      .filter(Boolean)
      .join(c.dim(" · "));
    yield* Print.line(
      `${c.bold(scope.label)} ${c.dim(
        `· ${response.totalCount} resource${response.totalCount === 1 ? "" : "s"}`,
      )}  ${header}`,
    );
    yield* Print.line();

    const columns: Column<Finding>[] = [
      {
        header: "status",
        value: (f) =>
          (STATUS_COLOR[f.status] ?? ((s: string) => s))(STATUS_LABEL[f.status] ?? f.status),
      },
      { header: "resource", value: (f) => f.displayName },
      { header: "account", value: (f) => c.dim(f.accountName) },
      { header: "version", value: (f) => `${f.product} ${f.currentVersion} → ${f.targetVersion}` },
      { header: "when", value: (f) => whenText(f) },
      { header: "surcharge", value: (f) => costText(f), align: "right" },
    ];
    yield* Print.table(response.findings, columns);

    const failed = response.billing?.accounts.filter((a) => a.status === "failed") ?? [];
    if (failed.length > 0) {
      yield* Print.line();
      yield* Print.line(
        c.yellow(
          `Billing unreadable for ${failed.map((a) => a.accountName).join(", ")}; those rows are list price.`,
        ),
      );
    }
    for (const u of response.billing?.unattributed ?? []) {
      yield* Print.line(
        c.dim(
          `Unattributed billed line: ${u.accountName} ${u.lineItem}${u.region ? ` ${u.region}` : ""} ${money(u.monthlyAmount, u.currency)}/mo`,
        ),
      );
    }

    yield* Print.line();
    yield* Print.line(
      c.dim(
        session.local
          ? "Local workspace, list price only. Upgrade guides are in --json (upgradeUrl)."
          : "Billed amounts where the provider's billing names the charge, list price otherwise. Upgrade guides are in --json (upgradeUrl).",
      ),
    );
  }),
).pipe(
  Command.withDescription(
    "Clusters and databases on versions billed at extended-support or end-of-life rates",
  ),
);
