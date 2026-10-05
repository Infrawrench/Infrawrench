import { CliError, orgFetch, resolveOrg, type CliContext } from "../context";
import type {
  RealizedSavingsGrouping,
  RealizedSavingsReport,
  SavingsEvent,
  SavingsEventResult,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import { barChart } from "../charts";
import { c, printJson, println, printTable, type Column } from "../output";

/** Money in its own currency; never summed across currencies. */
function money(value: number, currency: string): string {
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

const KIND_LABELS: Record<string, string> = {
  rightsizing: "right-sizing",
  orphan_deletion: "orphan cleanup",
  sleep_schedule: "sleep schedule",
  commitment: "commitments",
  manual: "manual",
};

const BASIS_LABELS: Record<string, string> = {
  billing: "billing",
  estimate: "estimate",
  manual: "as logged",
  unmeasured: "unmeasured",
};

const GROUPINGS: readonly RealizedSavingsGrouping[] = ["month", "kind", "costCentre", "account"];

/** `--group-by month|kind|cost-centre|account`. */
function parseGrouping(text: string | undefined): RealizedSavingsGrouping {
  if (!text) return "month";
  const normalized = text === "cost-centre" || text === "centre" ? "costCentre" : text;
  if ((GROUPINGS as readonly string[]).includes(normalized)) {
    return normalized as RealizedSavingsGrouping;
  }
  throw new CliError(`--group-by must be month, kind, cost-centre or account, got "${text}"`, 2);
}

function rowsFor(
  report: RealizedSavingsReport,
  grouping: RealizedSavingsGrouping,
  currency: string,
) {
  if (grouping === "month") {
    return report.byMonth
      .filter((m) => m.currency === currency)
      .map((m) => ({ label: m.month, realized: m.realized, projected: m.projected }));
  }
  const buckets =
    grouping === "kind"
      ? report.byKind
      : grouping === "costCentre"
        ? report.byCostCentre
        : report.byAccount;
  return buckets
    .filter((b) => b.currency === currency)
    .map((b) => ({
      label: grouping === "kind" ? (KIND_LABELS[b.key] ?? b.key) : b.label,
      realized: b.realized,
      projected: b.projected,
    }));
}

/**
 * `infrawrench savings`: what the optimization actions taken actually saved,
 * against each resource's own pre-action spend, beside the projection.
 *
 * `--from`/`--to` pick the range (default: the last 12 months through
 * yesterday); `--group-by` the breakdown chart. `--json` emits the report as
 * the API returns it.
 */
export async function cmdSavings(
  ctx: CliContext,
  options: { from?: string | undefined; to?: string | undefined; groupBy?: string | undefined },
): Promise<void> {
  const grouping = parseGrouping(options.groupBy);
  const org = await resolveOrg(ctx);
  const params = new URLSearchParams();
  if (options.from) params.set("from", options.from);
  if (options.to) params.set("to", options.to);
  const qs = params.toString();
  const report = await orgFetch<RealizedSavingsReport>(
    org.id,
    `/savings/realized${qs ? `?${qs}` : ""}`,
  );

  if (ctx.flags.output === "json") {
    printJson({ org: org.id, ...report });
    return;
  }

  println(
    `${c.bold(org.displayName)} ${c.dim(
      `· realized savings ${report.from} → ${report.to} · horizon ${report.settings.horizonMonths} months`,
    )}`,
  );
  println();

  if (report.events.length === 0) {
    println(
      c.dim(
        "No savings recorded. Resizes, orphan cleanups and sleep schedules are recorded as they happen (in the app or detected on sync); log anything else with `infrawrench savings log`.",
      ),
    );
    return;
  }

  for (const t of report.totals) {
    const share = t.projected > 0 ? ` (${Math.round((t.realized / t.projected) * 100)}%)` : "";
    println(
      `${c.bold(money(t.realized, t.currency))} realized ${c.dim(
        `of ${money(t.projected, t.currency)} projected${share}`,
      )}`,
    );
  }

  const primary = report.totals[0];
  if (primary) {
    println();
    println(
      c.dim(`by ${grouping === "costCentre" ? "cost centre" : grouping} (${primary.currency})`),
    );
    const rows = rowsFor(report, grouping, primary.currency);
    for (const line of barChart(
      rows.map((r) => ({
        label: r.label,
        value: r.realized,
        display: `${money(r.realized, primary.currency)} ${c.dim(`/ ${money(r.projected, primary.currency)}`)}`,
      })),
    )) {
      println(line);
    }
  }

  println();
  const columns: Column<SavingsEventResult>[] = [
    { header: "since", value: (e) => e.occurredOn },
    { header: "action", value: (e) => e.title },
    { header: "type", value: (e) => c.dim(KIND_LABELS[e.kind] ?? e.kind) },
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
    { header: "basis", value: (e) => c.dim(BASIS_LABELS[e.basis] ?? e.basis) },
    {
      header: "note",
      value: (e) =>
        e.shortfall
          ? c.yellow(e.shortfall.kind === "grew_back" ? "grew back" : "short of projection")
          : c.dim(e.status),
    },
  ];
  printTable(report.events, columns);

  if (report.shortfallCount > 0 || report.unmeasuredCount > 0) {
    println();
    if (report.shortfallCount > 0) {
      println(c.yellow(`${report.shortfallCount} action(s) realizing less than projected.`));
    }
    if (report.unmeasuredCount > 0) {
      println(c.dim(`${report.unmeasuredCount} action(s) not measurable yet (not counted).`));
    }
  }
}

/**
 * `infrawrench savings log "<what was done>" --amount 120 --currency USD
 * [--from 2026-09-01] [--note "..."]`: record a saving Infrawrench could not
 * observe. `--from` is the day it began (default today).
 */
export async function cmdSavingsLog(
  ctx: CliContext,
  title: string,
  options: {
    amount?: string | undefined;
    currency?: string | undefined;
    from?: string | undefined;
    note?: string | undefined;
    resource?: string | undefined;
  },
): Promise<void> {
  if (!title.trim()) {
    throw new CliError(
      'Say what was done: infrawrench savings log "Cancelled the old CDN" --amount 120',
      2,
    );
  }
  const amount = Number(options.amount);
  if (!options.amount || !Number.isFinite(amount) || amount <= 0) {
    throw new CliError("--amount must be the monthly saving, a number above zero", 2);
  }
  const org = await resolveOrg(ctx);
  const created = await orgFetch<SavingsEvent>(org.id, "/savings/events", {
    method: "POST",
    body: JSON.stringify({
      title: title.trim(),
      projectedMonthlyAmount: amount,
      currency: (options.currency ?? "USD").toUpperCase(),
      occurredOn: options.from ?? new Date().toISOString().slice(0, 10),
      ...(options.note ? { note: options.note } : {}),
      ...(options.resource ? { resourceId: options.resource } : {}),
    }),
  });
  if (ctx.flags.output === "json") {
    printJson({ org: org.id, event: created });
    return;
  }
  println(
    `Logged ${c.bold(created.title)} ${c.dim(
      `· ${money(created.projectedMonthlyAmount ?? amount, created.currency ?? "USD")}/mo from ${created.occurredOn}`,
    )}`,
  );
}
