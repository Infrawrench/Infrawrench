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
import {
  CliError,
  listCloudAccounts,
  orgFetch,
  resolveAccount,
  resolveOrg,
  type CliContext,
} from "../context";
import type {
  SavingsFinding,
  SavingsFindingMoney,
  SavingsFindingStatusResult,
  SavingsFindingsResponse,
  SavingsView,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import { c, formatMoney, printJson, println, printTable, safe, type Column } from "../output";

const STATUSES = ["ready", "in_progress", "completed", "archived"] as const;
const STATUS_TABS = ["open", ...STATUSES, "all"] as const;
const KINDS = ["orphan", "oversized", "extended_support", "seat"] as const;
const SORT_FIELDS = ["savings", "detected", "name", "status_changed"] as const;

const STATUS_LABELS: Record<string, string> = {
  ready: "ready for review",
  in_progress: "in progress",
  completed: "completed",
  archived: "archived",
};

const KIND_LABELS: Record<string, string> = {
  orphan: "orphaned",
  oversized: "oversized",
  extended_support: "extended support",
  seat: "unused seat",
};

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

function totals(list: readonly SavingsFindingMoney[] | null | undefined): string {
  if (!list?.length) return "none";
  return list.map((m) => formatMoney(m.amount, m.currency)).join(" + ");
}

function oneOf<T extends string>(flag: string, value: string, allowed: readonly T[]): T {
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new CliError(`--${flag} must be one of ${allowed.join(", ")}, got "${value}"`, 2);
}

export interface SavingsFindingsFlags {
  status: string | undefined;
  kind: string | undefined;
  provider: string | undefined;
  region: string | undefined;
  tag: string | undefined;
  minSavings: string | undefined;
  view: string | undefined;
  sort: string | undefined;
  search: string | undefined;
  from: string | undefined;
  to: string | undefined;
}

export async function cmdSavingsFindings(
  ctx: CliContext,
  flags: SavingsFindingsFlags,
): Promise<void> {
  const org = await resolveOrg(ctx);
  const q = new URLSearchParams();
  if (flags.view) q.set("view", flags.view);
  // Without a view the CLI opens on the open findings, the UI's default tab.
  const status = flags.status ?? (flags.view ? undefined : "open");
  if (status) q.set("status", oneOf("status", status, STATUS_TABS));
  if (flags.kind) {
    q.set(
      "kind",
      flags.kind
        .split(",")
        .map((k) => oneOf("kind", k.trim(), KINDS))
        .join(","),
    );
  }
  if (flags.provider) q.set("provider", flags.provider);
  if (flags.region) q.set("region", flags.region);
  if (ctx.flags.account) {
    const account = resolveAccount(await listCloudAccounts(org.id), ctx.flags.account);
    q.set("account", account.id);
  }
  if (flags.tag) q.append("tag", flags.tag);
  if (flags.minSavings) {
    const n = Number(flags.minSavings);
    if (!Number.isFinite(n) || n < 0) {
      throw new CliError(`--min-savings must be a monthly amount, got "${flags.minSavings}"`, 2);
    }
    q.set("minSavings", String(n));
  }
  if (flags.from) q.set("detectedFrom", flags.from);
  if (flags.to) q.set("detectedTo", flags.to);
  if (flags.search) q.set("q", flags.search);
  if (flags.sort) {
    const [field = "", direction = field === "name" ? "asc" : "desc"] = flags.sort.split(":");
    q.set(
      "sort",
      `${oneOf("sort", field, SORT_FIELDS)}:${oneOf("sort", direction, ["asc", "desc"] as const)}`,
    );
  }

  const qs = q.toString();
  const response = await orgFetch<SavingsFindingsResponse>(
    org.id,
    `/savings/findings${qs ? `?${qs}` : ""}`,
  );
  if (ctx.flags.output === "json") {
    printJson({ org: org.id, ...response });
    return;
  }

  const { summary } = response;
  const rate = summary.savingsRate?.[0];
  println(
    `${c.bold(org.displayName)} ${c.dim(
      `· ${response.findings.length} finding${response.findings.length === 1 ? "" : "s"}${status ? ` · ${status.replace("_", " ")}` : ""}`,
    )}`,
  );
  println(
    `${c.bold(totals(summary.potentialMonthly))}${c.dim("/mo potential")}` +
      (summary.realized
        ? `   ${c.bold(totals(summary.realized))}${c.dim(` realized in ${summary.realizedWindowDays}d`)}`
        : "") +
      (rate ? `   ${c.bold(`${Math.round(rate.rate * 100)}%`)}${c.dim(" savings rate")}` : ""),
  );
  println(
    c.dim(
      `${summary.counts.ready} ready · ${summary.counts.in_progress} in progress · ${summary.counts.completed} completed · ${summary.counts.archived} archived` +
        (summary.unpricedOpenCount ? ` · ${summary.unpricedOpenCount} open unpriced` : ""),
    ),
  );
  for (const u of response.unavailable) {
    println(
      c.yellow(`${KIND_LABELS[u.kind] ?? u.kind} findings could not be computed: ${u.error}`),
    );
  }
  println();

  const columns: Column<SavingsFinding>[] = [
    { header: "key", value: (f) => c.dim(f.key) },
    { header: "finding", value: (f) => safe(f.title) },
    { header: "kind", value: (f) => c.dim(KIND_LABELS[f.kind] ?? f.kind) },
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
        statusColor(f.status)(STATUS_LABELS[f.status] ?? f.status) +
        (f.resolution === "resolved" ? c.dim(" (auto)") : "") +
        (f.statusNote ? c.dim(` · ${safe(f.statusNote)}`) : ""),
    },
  ];
  printTable(response.findings, columns);
  if (response.findings.length > 0) {
    println();
    println(
      c.dim("Change a status: infrawrench savings findings set <key>... --status in_progress"),
    );
  }
}

/** `savings findings set <key>... --status <s> [--note]`. */
export async function cmdSavingsFindingsSet(
  ctx: CliContext,
  keys: string[],
  flags: { status: string | undefined; note: string | undefined },
): Promise<void> {
  if (keys.length === 0) {
    throw new CliError(
      "Name the findings by key: infrawrench savings findings set orphan:<id> --status archived",
      2,
    );
  }
  if (!flags.status) throw new CliError(`--status is required (${STATUSES.join(", ")})`, 2);
  const status = oneOf("status", flags.status, STATUSES);
  const org = await resolveOrg(ctx);
  const result = await orgFetch<SavingsFindingStatusResult>(org.id, "/savings/findings/status", {
    method: "POST",
    body: JSON.stringify({ keys, status, ...(flags.note ? { note: flags.note } : {}) }),
  });
  if (ctx.flags.output === "json") {
    printJson({ org: org.id, ...result });
    return;
  }
  println(
    `Moved ${c.bold(String(result.updated.length))} finding${result.updated.length === 1 ? "" : "s"} to ${statusColor(status)(STATUS_LABELS[status] ?? status)}.`,
  );
  if (result.missing.length > 0) {
    println(c.yellow(`Not found: ${result.missing.join(", ")}`));
  }
}

/** `savings views`: the saved views the caller can see. */
export async function cmdSavingsViews(ctx: CliContext): Promise<void> {
  const org = await resolveOrg(ctx);
  const views = await orgFetch<SavingsView[]>(org.id, "/savings-views");
  if (ctx.flags.output === "json") {
    printJson({ org: org.id, views });
    return;
  }
  const describe = (v: SavingsView): string => {
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
  printTable(views, [
    { header: "name", value: (v) => c.bold(safe(v.name)) },
    { header: "status", value: (v) => v.status.replace("_", " ") },
    { header: "filter", value: (v) => c.dim(safe(describe(v))) },
    { header: "sort", value: (v) => c.dim(`${v.sort.field} ${v.sort.direction}`) },
  ]);
  if (views.length > 0) {
    println();
    println(c.dim('Open one: infrawrench savings findings --view "<name>"'));
  }
}
