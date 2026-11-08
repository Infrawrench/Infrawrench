// `infrawrench seats`; paid SaaS seats (Copilot, Cursor, GitLab, Okta, ...)
// worth acting on: inactive for the org's threshold, the same person paying
// for two tools in one category, or a cheaper tier their usage fits.
//
//   seats                 the findings, with remediation commands
//   seats all             every seat and how its activity was determined
//   seats remove <id>     remove a flagged seat through its provider [-y]
//   seats refresh         re-collect seats now
//
// Cloud only: the inventory is collected by the cloud poller from the org's
// connected accounts. The response schemas are checked against
// `@infrawrench/client-core` by `wire`, so a server-side change breaks the
// CLI's build rather than its output, and the CLI ships no new runtime
// dependency.
import { Effect, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import type { SeatListResponse, SeatRemovalResponse } from "@infrawrench/client-core" with {
  "resolution-mode": "import",
};
import { CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import { CliFailure } from "../effect/errors";
import * as Print from "../effect/print";
import { CliSession } from "../effect/session";
import { knownOr, spreadBody, Unrecognized, wire } from "../effect/wire";
import { c, safe, type Column } from "../output";
import { confirm } from "../effect/prompt";
import { printRemediation, Remediation } from "../remediation";

const PATH = "/seats";

const Total = Schema.Struct({ currency: Schema.String, monthly: Schema.Finite });

const Seat = Schema.Struct({
  id: Schema.String,
  accountName: Schema.String,
  memberId: Schema.String,
  name: Schema.NullOr(Schema.String),
  email: Schema.NullOr(Schema.String),
  login: Schema.NullOr(Schema.String),
  product: Schema.String,
  seatType: Schema.String,
  monthlyPrice: Schema.NullOr(Schema.Finite),
  currency: Schema.NullOr(Schema.String),
  priceSource: Schema.NullOr(Schema.String),
  // The evidence column falls back to the raw word for a basis it does not know.
  activityBasis: Schema.String,
  lastActiveAt: Schema.NullOr(Schema.String),
  removable: Schema.Boolean,
  removalNote: Schema.NullOr(Schema.String),
  status: Schema.String,
  daysInactive: Schema.NullOr(Schema.Finite),
  neverActive: Schema.Boolean,
});
type Seat = typeof Seat.Type;

const Finding = Schema.Struct({
  kind: knownOr(["inactive", "duplicate", "downgrade"]),
  seatId: Schema.String,
  monthlySaving: Schema.NullOr(Schema.Finite),
  currency: Schema.NullOr(Schema.String),
  duplicate: Schema.optional(
    Schema.Struct({ keptProduct: Schema.String, keptAccountName: Schema.String }),
  ),
  targetSeatType: Schema.optional(Schema.String),
  remediation: Schema.optional(Schema.NullOr(Remediation)),
});
type Finding = typeof Finding.Type;

const Listing = wire<SeatListResponse>()(
  Schema.Struct({
    inactiveDays: Schema.Finite,
    seats: Schema.Array(Seat),
    findings: Schema.Array(Finding),
    savingsMonthly: Schema.Array(Total),
    spendMonthly: Schema.Array(Total),
    counts: Schema.Struct({ seats: Schema.Finite, unknownActivity: Schema.Finite }),
    accounts: Schema.Array(
      Schema.Struct({
        accountName: Schema.String,
        lastPolledAt: Schema.NullOr(Schema.String),
        lastError: Schema.NullOr(Schema.String),
      }),
    ),
  }),
);
type Listing = typeof Listing.Type;

const Removal = wire<SeatRemovalResponse>()(
  Schema.Struct({ effective: Schema.String, message: Schema.NullOr(Schema.String) }),
);

/** `seats all --json` prints two of the listing's fields, as the server sent them. */
const AllEnvelope = Schema.Struct({ inactiveDays: Schema.Unknown, seats: Schema.Unknown });

const Refresh = Schema.Struct({ queued: Schema.Finite });

const requireCloud = Effect.gen(function* () {
  const session = yield* CliSession;
  if (session.local) {
    return yield* new CliFailure({ message: "Seats are collected in the cloud; drop --local." });
  }
});

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

function totals(list: ReadonlyArray<typeof Total.Type>): string {
  return list.map((t) => `${money(t.monthly, t.currency)}/mo`).join(" + ");
}

function holder(seat: Seat): string {
  return seat.name || seat.email || seat.login || seat.memberId;
}

function activityText(seat: Seat): string {
  if (seat.activityBasis === "none") return c.dim("not reported");
  if (seat.status === "unknown") return c.dim("unknown");
  if (seat.neverActive) {
    return seat.daysInactive !== null ? `never (${seat.daysInactive}d held)` : "never";
  }
  if (seat.lastActiveAt) return `${seat.lastActiveAt.slice(0, 10)} (${seat.daysInactive ?? 0}d)`;
  return c.dim("none");
}

const BASIS: Partial<Record<string, string>> = {
  "last-activity": "last use",
  "last-login": "last sign-in",
  "usage-window": "daily usage",
  none: "not reported",
} satisfies Record<SeatListResponse["seats"][number]["activityBasis"], string>;

function findingText(f: Finding, seat: Seat, days: number): string {
  if (f.kind instanceof Unrecognized) return safe(f.kind.raw);
  switch (f.kind) {
    case "inactive":
      return c.yellow(`unused ${days}d+`);
    case "duplicate":
      return `also on ${f.duplicate?.keptProduct ?? "?"} (${f.duplicate?.keptAccountName ?? "?"})`;
    case "downgrade":
      return `${seat.seatType} -> ${f.targetSeatType ?? "?"}`;
  }
}

function priceText(amount: number | null, currency: string | null, seat: Seat): string {
  if (amount === null || currency === null) return c.dim("not priced");
  const source = seat.priceSource === "list-price" ? "list" : (seat.priceSource ?? "");
  return `${money(amount, currency)}/mo ${c.dim(source)}`;
}

const printAccountProblems = Effect.fnUntraced(function* (response: Listing) {
  for (const a of response.accounts) {
    if (a.lastError) {
      yield* Print.line(
        c.yellow(`Couldn't read seats from ${safe(a.accountName)}: ${safe(a.lastError)}`),
      );
    } else if (a.lastPolledAt === null) {
      yield* Print.line(c.dim(`Waiting for the first seat read from ${safe(a.accountName)}.`));
    }
  }
});

const all = Command.make(
  "all",
  {},
  Effect.fn("seats.all")(function* () {
    yield* requireCloud;
    const session = yield* CliSession;
    const api = yield* CloudApi;
    const org = yield* currentOrg;
    const body = yield* api.json(org.id, PATH);
    if (session.output === "json") {
      const { inactiveDays, seats } = yield* decodeBody(AllEnvelope, PATH)(body);
      return yield* Print.json({ org: org.id, inactiveDays, seats });
    }
    const response = yield* decodeBody(Listing, PATH)(body);
    const columns: Column<Seat>[] = [
      { header: "who", value: (s) => safe(holder(s)) },
      { header: "email", value: (s) => c.dim(safe(s.email ?? "")) },
      { header: "seat", value: (s) => safe(`${s.product} · ${s.seatType}`) },
      { header: "account", value: (s) => c.dim(safe(s.accountName)) },
      { header: "status", value: (s) => s.status },
      { header: "last active", value: (s) => activityText(s) },
      { header: "evidence", value: (s) => c.dim(BASIS[s.activityBasis] ?? safe(s.activityBasis)) },
      { header: "price", value: (s) => priceText(s.monthlyPrice, s.currency, s) },
    ];
    yield* Print.table(response.seats, columns);
    yield* printAccountProblems(response);
  }),
).pipe(Command.withDescription("Every seat and how its activity was determined"));

const remove = Command.make(
  "remove",
  {
    seatId: Argument.String("seat id").pipe(
      Argument.withDescription("The seat, as the findings' id column prints it"),
      Argument.optional,
    ),
    yes: Flag.Boolean("yes").pipe(
      Flag.withAlias("y"),
      Flag.withDescription("Remove without asking"),
      Flag.withDefault(false),
      Flag.withoutNegation,
    ),
  },
  Effect.fn("seats.remove")(function* (input) {
    yield* requireCloud;
    const session = yield* CliSession;
    const api = yield* CloudApi;
    const org = yield* currentOrg;
    if (Option.isNone(input.seatId)) {
      return yield* new CliFailure({ message: "Usage: infrawrench seats remove <seat id> [-y]" });
    }
    const seatId = input.seatId.value;
    const list = yield* api.decode(Listing, org.id, PATH);
    const seat = list.seats.find((s) => s.id === seatId);
    if (!seat) {
      return yield* new CliFailure({
        message: `No seat ${seatId}. List them with: infrawrench seats`,
      });
    }
    if (!input.yes) {
      const note = seat.removalNote ? ` ${seat.removalNote}` : "";
      const ok = yield* confirm(
        `Remove the ${safe(seat.product)} seat for ${safe(holder(seat))} on ${safe(seat.accountName)}?${safe(note)}`,
      );
      if (!ok) return;
    }
    const path = `/seats/${encodeURIComponent(seatId)}/remove`;
    const body = yield* api.json(org.id, path, { method: "POST" });
    if (session.output === "json") {
      return yield* Print.json(yield* spreadBody({ org: org.id, seatId }, body, path));
    }
    const result = yield* decodeBody(Removal, path)(body);
    yield* Print.line(
      result.message
        ? safe(result.message)
        : result.effective === "end-of-cycle"
          ? "Removed. The provider bills it until the end of the cycle."
          : "Removed.",
    );
  }),
).pipe(Command.withDescription("Remove a flagged seat through its provider"));

const refresh = Command.make(
  "refresh",
  {},
  Effect.fn("seats.refresh")(function* () {
    yield* requireCloud;
    const session = yield* CliSession;
    const api = yield* CloudApi;
    const org = yield* currentOrg;
    const { queued } = yield* api.decode(Refresh, org.id, "/seats/refresh", { method: "POST" });
    if (session.output === "json") return yield* Print.json({ org: org.id, queued });
    yield* Print.line(`Re-collecting seats for ${queued} account(s); this takes a few minutes.`);
  }),
).pipe(Command.withDescription("Re-collect seats now"));

export const seats = Command.make(
  "seats",
  {},
  Effect.fn("seats")(function* () {
    yield* requireCloud;
    const session = yield* CliSession;
    const api = yield* CloudApi;
    const org = yield* currentOrg;
    const body = yield* api.json(org.id, PATH);
    if (session.output === "json")
      return yield* Print.json(yield* spreadBody({ org: org.id }, body, PATH));
    const response = yield* decodeBody(Listing, PATH)(body);
    if (response.accounts.length === 0) {
      return yield* Print.line(
        c.dim(
          "No connected account reports seats. Connect GitHub (Copilot), Cursor, GitLab, Okta, Claude Enterprise, Docker Hub or Tailscale.",
        ),
      );
    }
    const header = [
      response.savingsMonthly.length > 0 ? `to save ${totals(response.savingsMonthly)}` : "",
      response.spendMonthly.length > 0 ? c.dim(`seats cost ${totals(response.spendMonthly)}`) : "",
    ]
      .filter(Boolean)
      .join(c.dim(" · "));
    yield* Print.line(
      `${c.bold(safe(org.displayName))} ${c.dim(`· ${response.counts.seats} seats, threshold ${response.inactiveDays}d`)}  ${header}`,
    );
    if (response.counts.unknownActivity > 0) {
      yield* Print.line(
        c.dim(
          `${response.counts.unknownActivity} seat(s) on providers that report no usable activity are never flagged.`,
        ),
      );
    }
    yield* printAccountProblems(response);
    yield* Print.line();
    if (response.findings.length === 0) {
      return yield* Print.line(
        c.dim("No seat is inactive, duplicated or on a dearer tier than it needs."),
      );
    }

    const byId = new Map(response.seats.map((s) => [s.id, s]));
    const rows = response.findings.flatMap((f) => {
      const seat = byId.get(f.seatId);
      return seat ? [{ f, seat }] : [];
    });
    const columns: Column<{ f: Finding; seat: Seat }>[] = [
      { header: "finding", value: (r) => findingText(r.f, r.seat, response.inactiveDays) },
      { header: "who", value: (r) => safe(holder(r.seat)) },
      { header: "seat", value: (r) => safe(`${r.seat.product} · ${r.seat.seatType}`) },
      { header: "account", value: (r) => c.dim(safe(r.seat.accountName)) },
      { header: "last active", value: (r) => activityText(r.seat) },
      { header: "saves", value: (r) => priceText(r.f.monthlySaving, r.f.currency, r.seat) },
      { header: "id", value: (r) => c.dim(r.seat.removable ? r.seat.id : "-") },
    ];
    yield* Print.table(rows, columns);
    yield* Effect.sync(() =>
      printRemediation(
        rows.map((r) => ({
          displayName: `${holder(r.seat)} (${r.seat.product})`,
          remediation: r.f.remediation,
        })),
      ),
    );
    yield* Print.line();
    yield* Print.line(
      c.dim("Remove a flagged seat through its provider: infrawrench seats remove <id>"),
    );
  }),
).pipe(
  Command.withDescription(
    "Paid SaaS seats worth acting on: inactive, duplicated across tools, or on a dearer tier than needed",
  ),
  Command.withSubcommands([all, remove, refresh]),
);
