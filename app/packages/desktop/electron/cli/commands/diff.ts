// `infrawrench diff -a staging -b prod`; two accounts of the same provider
// compared side by side: resource types present in one and not the other,
// per-type count deltas, and the fields on which two corresponding resources
// disagree (instance class, engine version, a feature flag). The answer to
// "why does staging work and prod doesn't", with no provider knowledge
// anywhere in the comparison.
//
// Works in both modes:
//   - cloud (default): GET /environment-diff, the same endpoint the web and
//     desktop Env diff screens use, computed over already-synced rows.
//   - --local: electron/local-environment-diff.ts enumerates both of this
//     machine's accounts through the plugin (the local workspace has no synced
//     store) and runs the identical shared computation. No cloud session
//     needed; a resource type whose list fails is excluded and reported rather
//     than read as an absence.
//
// The response schema is checked against `@infrawrench/client-core` by
// `wire` (the same definition the web and desktop panels render), so a
// server-side change breaks the CLI's build instead of its output, and the
// CLI still ships no new runtime dependency.
import { Effect, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import type { EnvironmentDiffResponse } from "@infrawrench/client-core" with {
  "resolution-mode": "import",
};
import { computeLocalEnvironmentDiff } from "../../local-environment-diff";
import { listCloudAccounts, listLocalAccounts, resolveAccount } from "../context";
import { CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import { CliUsageError } from "../effect/errors";
import * as Print from "../effect/print";
import { type as typeFlag } from "../effect/range-flags";
import { CliSession } from "../effect/session";
import { knownOr, spreadBody, Unrecognized, wire } from "../effect/wire";
import { c, type Column } from "../output";

const Side = Schema.Struct({ accountName: Schema.String, resourceCount: Schema.Finite });
const Ref = Schema.NullOr(Schema.Struct({ displayName: Schema.String }));

const Diff = wire<EnvironmentDiffResponse>()(
  Schema.Struct({
    a: Side,
    b: Side,
    pluginName: Schema.String,
    types: Schema.Array(
      Schema.Struct({
        resourceTypeName: Schema.String,
        countA: Schema.Finite,
        countB: Schema.Finite,
        delta: Schema.Finite,
        changed: Schema.Finite,
        missingFrom: Schema.NullOr(Schema.String),
      }),
    ),
    entries: Schema.Array(
      Schema.Struct({
        key: Schema.String,
        resourceTypeId: Schema.String,
        resourceTypeName: Schema.String,
        status: knownOr(["only-in-a", "only-in-b", "changed"]),
        a: Ref,
        b: Ref,
        // A side the field is absent from has no key at all in the JSON.
        changes: Schema.Array(
          Schema.Struct({
            field: Schema.String,
            a: Schema.optional(Schema.Unknown),
            b: Schema.optional(Schema.Unknown),
          }),
        ),
        suppressedCount: Schema.Finite,
      }),
    ),
    totals: Schema.Struct({
      onlyInA: Schema.Finite,
      onlyInB: Schema.Finite,
      changed: Schema.Finite,
      identical: Schema.Finite,
      suppressedFieldChanges: Schema.Finite,
    }),
    unavailableTypes: Schema.Array(
      Schema.Struct({ resourceTypeName: Schema.String, message: Schema.String }),
    ),
    includeIdentityFields: Schema.Boolean,
  }),
);
type Diff = typeof Diff.Type;
type Entry = Diff["entries"][number];

const STATUS_LABELS = {
  "only-in-a": "only in A",
  "only-in-b": "only in B",
  changed: "differs",
} as const;

/** The status cell; a status this build does not know reads like "differs", its own word. */
function statusCell(status: Entry["status"]): string {
  if (status instanceof Unrecognized) return c.magenta(status.raw);
  if (status === "only-in-a") return c.yellow(STATUS_LABELS[status]);
  if (status === "only-in-b") return c.cyan(STATUS_LABELS[status]);
  return c.magenta(STATUS_LABELS[status]);
}

/** Render a diff value for a terminal cell; objects collapse to JSON. */
function formatValue(value: unknown): string {
  if (value === null || value === undefined) return c.dim("—");
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
}

export const diff = Command.make(
  "diff",
  {
    accounts: Argument.String("account").pipe(
      Argument.withDescription("The two accounts, A then B (instead of -a and -b)"),
      Argument.variadic({ max: 2 }),
    ),
    against: Flag.String("against").pipe(
      Flag.withAlias("b"),
      Flag.withMetavar("account"),
      Flag.withDescription("The second account (-a supplies the first)"),
      Flag.optional,
    ),
    all: Flag.Boolean("all").pipe(
      Flag.withDescription("Compare ids, addresses and timestamps too"),
      Flag.withDefault(false),
      Flag.withoutNegation,
    ),
    type: typeFlag.pipe(Flag.withDescription("Compare only this resource type")),
  },
  Effect.fn("diff")(function* (input) {
    const session = yield* CliSession;
    // `infrawrench diff staging prod` reads better than the flags for the
    // common case; `-a`/`-b` win when both are given, so a script can be
    // explicit.
    const wantedA = session.account ?? input.accounts[0];
    const wantedB = Option.getOrUndefined(input.against) ?? input.accounts[1];
    if (!wantedA || !wantedB) {
      return yield* new CliUsageError({
        message:
          "Two accounts are required. `infrawrench diff -a staging -b prod` " +
          "(or `infrawrench diff staging prod`).",
      });
    }

    const scope = session.local
      ? { label: "Local workspace", accounts: yield* Effect.promise(listLocalAccounts), org: null }
      : yield* Effect.gen(function* () {
          const org = yield* currentOrg;
          return {
            label: org.displayName,
            accounts: yield* Effect.promise(() => listCloudAccounts(org.id)),
            org,
          };
        });

    const accountA = yield* Effect.sync(() => resolveAccount(scope.accounts, wantedA));
    const accountB = yield* Effect.sync(() => resolveAccount(scope.accounts, wantedB));
    if (accountA.id === accountB.id) {
      return yield* new CliUsageError({
        message: `"${wantedA}" and "${wantedB}" are the same account.`,
      });
    }
    if (accountA.pluginId !== accountB.pluginId) {
      return yield* new CliUsageError({
        message:
          `"${accountA.displayName}" (${accountA.pluginId}) and "${accountB.displayName}" ` +
          `(${accountB.pluginId}) use different providers. A diff needs two accounts of the same provider.`,
      });
    }

    const type = Option.getOrUndefined(input.type);
    if (scope.org === null) {
      const response = yield* Effect.promise(() =>
        computeLocalEnvironmentDiff(accountA, accountB, {
          resourceTypeId: type,
          includeIdentityFields: input.all,
        }),
      );
      if (session.output === "json") return yield* Print.json({ ...response });
      return yield* printDiff(scope.label, response);
    }

    const api = yield* CloudApi;
    const params = new URLSearchParams({ a: accountA.id, b: accountB.id });
    if (type) params.set("resourceTypeId", type);
    if (input.all) params.set("includeIdentityFields", "true");
    const path = `/environment-diff?${params.toString()}`;
    const body = yield* api.json(scope.org.id, path);
    if (session.output === "json") {
      return yield* Print.json(yield* spreadBody({ org: scope.org.id }, body, path));
    }
    yield* printDiff(scope.label, yield* decodeBody(Diff, path)(body));
  }),
).pipe(
  Command.withDescription(
    "Compare two accounts of one provider: missing types, count deltas and differing fields",
  ),
);

const printDiff = Effect.fnUntraced(function* (scopeLabel: string, response: Diff) {
  const { a, b, totals } = response;
  yield* Print.line(
    `${c.bold(`${a.accountName} → ${b.accountName}`)} ` +
      `${c.dim(`· ${scopeLabel} · ${response.pluginName}`)}`,
  );
  yield* Print.line(
    c.dim(
      `${a.resourceCount} vs ${b.resourceCount} resources · ` +
        `${totals.onlyInA} only in A · ${totals.onlyInB} only in B · ` +
        `${totals.changed} differ · ${totals.identical} identical`,
    ),
  );

  if (response.unavailableTypes.length > 0) {
    yield* Print.line();
    for (const type of response.unavailableTypes) {
      yield* Print.line(
        c.yellow(
          `! couldn't list ${type.resourceTypeName}. Excluded from the comparison (${type.message})`,
        ),
      );
    }
  }

  yield* Print.line();
  yield* Print.line(c.bold("Inventory"));
  yield* Print.table(response.types, [
    { header: "type", value: (t) => t.resourceTypeName },
    { header: a.accountName, value: (t) => String(t.countA), align: "right" },
    { header: b.accountName, value: (t) => String(t.countB), align: "right" },
    {
      header: "delta",
      value: (t) =>
        t.delta === 0
          ? c.dim("0")
          : t.delta > 0
            ? c.cyan(`+${t.delta}`)
            : c.yellow(String(t.delta)),
      align: "right",
    },
    {
      header: "note",
      value: (t) =>
        t.missingFrom === "a"
          ? c.cyan(`missing from ${a.accountName}`)
          : t.missingFrom === "b"
            ? c.yellow(`missing from ${b.accountName}`)
            : t.changed > 0
              ? c.magenta(`${t.changed} differ`)
              : c.dim(""),
    },
  ]);

  if (response.entries.length === 0) {
    yield* Print.line();
    return yield* Print.line(
      c.dim(
        `The two inventories match. Every resource in ${a.accountName} has a counterpart in ` +
          `${b.accountName} with the same settings.`,
      ),
    );
  }

  // Entries arrive sorted by type, so a single pass groups them.
  let currentType: string | null = null;
  for (const entry of response.entries) {
    if (entry.resourceTypeId !== currentType) {
      currentType = entry.resourceTypeId;
      yield* Print.line();
      yield* Print.line(c.bold(entry.resourceTypeName));
    }
    const name = entry.a?.displayName ?? entry.b?.displayName ?? entry.key;
    const counterpart =
      entry.status === "changed"
        ? entry.b?.displayName && entry.b.displayName !== name
          ? c.dim(` (${entry.b.displayName})`)
          : ""
        : "";
    yield* Print.line(`  ${statusCell(entry.status)}  ${name}${counterpart}`);

    const changeColumns: Column<Entry["changes"][number]>[] = [
      { header: "field", value: (change) => change.field },
      { header: a.accountName, value: (change) => c.yellow(formatValue(change.a)) },
      { header: b.accountName, value: (change) => c.cyan(formatValue(change.b)) },
    ];
    if (entry.changes.length > 0) {
      yield* Print.table(entry.changes, changeColumns, { indent: 4 });
    }
    if (entry.suppressedCount > 0) {
      yield* Print.line(
        c.dim(
          `    + ${entry.suppressedCount} id/address/timestamp difference` +
            `${entry.suppressedCount === 1 ? "" : "s"} hidden (--all shows them)`,
        ),
      );
    }
  }

  yield* Print.line();
  yield* Print.line(
    c.dim(
      "Resources are paired by type and by name with environment words removed, so api-staging " +
        "lines up with api-prod. " +
        (response.includeIdentityFields
          ? "Ids, addresses and timestamps are being compared, so most rows will differ."
          : `${totals.suppressedFieldChanges} id, address and timestamp difference` +
            `${totals.suppressedFieldChanges === 1 ? "" : "s"} hidden. Every resource has ` +
            `different ones; pass --all to see them.`),
    ),
  );
});
