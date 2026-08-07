// `infrawrench diff -a staging -b prod` — two accounts of the same provider
// compared side by side: resource types present in one and not the other,
// per-type count deltas, and the fields on which two corresponding resources
// disagree (instance class, engine version, a feature flag). The answer to
// "why does staging work and prod doesn't", with no provider knowledge
// anywhere in the comparison.
//
// Works in both modes:
//   - cloud (default) — GET /environment-diff, the same endpoint the web and
//     desktop Env diff screens use, computed over already-synced rows.
//   - --local — electron/local-environment-diff.ts enumerates both of this
//     machine's accounts through the plugin (the local workspace has no synced
//     store) and runs the identical shared computation. No cloud session
//     needed; a resource type whose list fails is excluded and reported rather
//     than read as an absence.
//
// The response shape comes from `@infrawrench/client-core` — the same
// definition the web and desktop panels render — so a server-side change
// breaks the CLI's build instead of its output. The import is type-only, so
// the CLI still ships zero new runtime dependencies.
import {
  CliError,
  listCloudAccounts,
  listLocalAccounts,
  orgFetch,
  resolveAccount,
  resolveOrg,
  type AccountInfo,
  type CliContext,
} from "../context";
import { computeLocalEnvironmentDiff } from "../../local-environment-diff";
import type { EnvironmentDiffEntry, EnvironmentDiffResponse } from "@infrawrench/client-core" with {
  "resolution-mode": "import",
};
import { c, printJson, println, printTable, type Column } from "../output";
import type { RangeFlags } from "../args";

/** How the two accounts were named on the command line. */
export interface DiffFlags {
  /** `-b` / `--against`: the compared account. `-a` supplies the baseline. */
  against?: string | undefined;
  /** `--all`: compare identity/timestamp fields too, instead of hiding them. */
  all: boolean;
}

const STATUS_LABELS = {
  "only-in-a": "only in A",
  "only-in-b": "only in B",
  changed: "differs",
} as const;

function statusColor(status: EnvironmentDiffEntry["status"]): (s: string) => string {
  if (status === "only-in-a") return c.yellow;
  if (status === "only-in-b") return c.cyan;
  return c.magenta;
}

/** Render a diff value for a terminal cell; objects collapse to JSON. */
function formatValue(value: unknown): string {
  if (value === null || value === undefined) return c.dim("—");
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
}

export async function cmdDiff(
  ctx: CliContext,
  positionals: string[],
  flags: DiffFlags,
  range: RangeFlags,
): Promise<void> {
  // `infrawrench diff staging prod` reads better than the flags for the common
  // case; `-a`/`-b` win when both are given, so a script can be explicit.
  const wantedA = ctx.flags.account ?? positionals[0];
  const wantedB = flags.against ?? positionals[1];
  if (!wantedA || !wantedB) {
    throw new CliError(
      "Two accounts are required — `infrawrench diff -a staging -b prod` " +
        "(or `infrawrench diff staging prod`).",
      2,
    );
  }

  const scope = ctx.flags.local
    ? { label: "Local workspace", accounts: await listLocalAccounts(), org: null }
    : await (async () => {
        const org = await resolveOrg(ctx);
        return { label: org.displayName, accounts: await listCloudAccounts(org.id), org };
      })();

  const accountA = resolveAccount(scope.accounts, wantedA);
  const accountB = resolveAccount(scope.accounts, wantedB);
  if (accountA.id === accountB.id) {
    throw new CliError(`"${wantedA}" and "${wantedB}" are the same account.`, 2);
  }
  if (accountA.pluginId !== accountB.pluginId) {
    throw new CliError(
      `"${accountA.displayName}" (${accountA.pluginId}) and "${accountB.displayName}" ` +
        `(${accountB.pluginId}) use different providers — a diff compares two accounts of the ` +
        `same provider.`,
      2,
    );
  }

  const response = scope.org
    ? await fetchCloudDiff(scope.org.id, accountA, accountB, flags, range)
    : await computeLocalEnvironmentDiff(accountA, accountB, {
        resourceTypeId: range.type,
        includeIdentityFields: flags.all,
      });

  if (ctx.flags.output === "json") {
    printJson({ ...(scope.org ? { org: scope.org.id } : {}), ...response });
    return;
  }

  printDiff(scope.label, response);
}

async function fetchCloudDiff(
  orgId: string,
  accountA: AccountInfo,
  accountB: AccountInfo,
  flags: DiffFlags,
  range: RangeFlags,
): Promise<EnvironmentDiffResponse> {
  const params = new URLSearchParams({ a: accountA.id, b: accountB.id });
  if (range.type) params.set("resourceTypeId", range.type);
  if (flags.all) params.set("includeIdentityFields", "true");
  return orgFetch<EnvironmentDiffResponse>(orgId, `/environment-diff?${params.toString()}`);
}

function printDiff(scopeLabel: string, response: EnvironmentDiffResponse): void {
  const { a, b, totals } = response;
  println(
    `${c.bold(`${a.accountName} → ${b.accountName}`)} ` +
      `${c.dim(`· ${scopeLabel} · ${response.pluginName}`)}`,
  );
  println(
    c.dim(
      `${a.resourceCount} vs ${b.resourceCount} resources · ` +
        `${totals.onlyInA} only in A · ${totals.onlyInB} only in B · ` +
        `${totals.changed} differ · ${totals.identical} identical`,
    ),
  );

  if (response.unavailableTypes.length > 0) {
    println();
    for (const type of response.unavailableTypes) {
      println(
        c.yellow(
          `! couldn't list ${type.resourceTypeName} — excluded from the comparison (${type.message})`,
        ),
      );
    }
  }

  println();
  println(c.bold("Inventory"));
  printTable(response.types, [
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
    println();
    println(
      c.dim(
        `The two inventories match — every resource in ${a.accountName} has a counterpart in ` +
          `${b.accountName} with the same settings.`,
      ),
    );
    return;
  }

  // Entries arrive sorted by type, so a single pass groups them.
  let currentType: string | null = null;
  for (const entry of response.entries) {
    if (entry.resourceTypeId !== currentType) {
      currentType = entry.resourceTypeId;
      println();
      println(c.bold(entry.resourceTypeName));
    }
    const status = statusColor(entry.status)(STATUS_LABELS[entry.status]);
    const name = entry.a?.displayName ?? entry.b?.displayName ?? entry.key;
    const counterpart =
      entry.status === "changed"
        ? entry.b?.displayName && entry.b.displayName !== name
          ? c.dim(` (${entry.b.displayName})`)
          : ""
        : "";
    println(`  ${status}  ${name}${counterpart}`);

    const changeColumns: Column<(typeof entry.changes)[number]>[] = [
      { header: "field", value: (change) => change.field },
      { header: a.accountName, value: (change) => c.yellow(formatValue(change.a)) },
      { header: b.accountName, value: (change) => c.cyan(formatValue(change.b)) },
    ];
    if (entry.changes.length > 0) printTable(entry.changes, changeColumns, { indent: 4 });
    if (entry.suppressedCount > 0) {
      println(
        c.dim(
          `    + ${entry.suppressedCount} id/address/timestamp difference` +
            `${entry.suppressedCount === 1 ? "" : "s"} hidden (--all shows them)`,
        ),
      );
    }
  }

  println();
  println(
    c.dim(
      "Resources are paired by type and by name with environment words removed, so api-staging " +
        "lines up with api-prod. " +
        (response.includeIdentityFields
          ? "Ids, addresses and timestamps are being compared, so most rows will differ."
          : `${totals.suppressedFieldChanges} id, address and timestamp difference` +
            `${totals.suppressedFieldChanges === 1 ? "" : "s"} hidden — every resource has ` +
            `different ones; pass --all to see them.`),
    ),
  );
}
