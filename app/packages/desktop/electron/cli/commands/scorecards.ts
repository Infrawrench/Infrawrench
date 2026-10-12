// `infrawrench scorecards`: the service × scorecard matrix (rows services,
// columns scorecards, each cell the score and level), and
// `infrawrench scorecards <id|name>` for one scorecard's definition plus every
// service's result on it, best first, with a 90-day score sparkline.
//
// Cloud-only and read-only: scorecards are evaluated by the cloud poller and
// edited from the web/desktop Scorecards tab.
//
// `--json` shapes:
//   scorecards         → { org, scorecards, services, results }  (GET /scorecards/overview)
//   scorecards <name>  → { org, scorecard, services, results, history }
//                        `history` is service id → daily points for this scorecard.
//
// Types come from `@infrawrench/client-core` type-only; runtime helpers are
// loaded with a dynamic import (the CLI project is CJS).
import { CliError, orgFetch, resolveOrg, type CliContext } from "../context";
import type {
  Scorecard,
  ScorecardHistoryPoint,
  ScorecardOverviewResponse,
  ScorecardOverviewService,
  ScorecardResult,
  ServiceScorecardsResponse,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import { c, printJson, println, printTable, safe, type Column } from "../output";
import { sparkline } from "../charts";
import {
  formatChangeTime,
  formatScoreCell,
  formatScorecardParams,
  formatServiceTier,
  matchIdPrefix,
  orderScoreRows,
} from "../format";

type Core = typeof import("@infrawrench/client-core", { with: { "resolution-mode": "import" } });

/** Above this many services the per-service history requests are skipped. */
const HISTORY_FETCH_LIMIT = 100;
const HISTORY_CONCURRENCY = 8;

function cell(card: Scorecard, result: ScorecardResult | undefined): string {
  if (!result) return formatScoreCell(null, -1, 0);
  const sorted = [...card.levels].sort((a, b) => a.minScore - b.minScore);
  return formatScoreCell(
    result,
    result.level === null ? -1 : sorted.findIndex((l) => l.key === result.level),
    sorted.length,
  );
}

export async function cmdScorecards(ctx: CliContext, arg?: string): Promise<void> {
  if (ctx.flags.local) {
    throw new CliError(
      "Scorecards live in Infrawrench Cloud, where the poller evaluates them. Drop --local.",
    );
  }
  const org = await resolveOrg(ctx);
  const overview = await orgFetch<ScorecardOverviewResponse>(org.id, "/scorecards/overview");

  if (arg) {
    const byId = matchIdPrefix(overview.scorecards, arg);
    const needle = arg.toLowerCase();
    const card =
      byId.match ??
      overview.scorecards.find((s) => s.name.toLowerCase() === needle) ??
      overview.scorecards.find((s) => s.name.toLowerCase().includes(needle));
    if (!card) {
      throw new CliError(`No scorecard matches "${arg}". Run \`infrawrench scorecards\` to list.`);
    }
    const core: Core = await import("@infrawrench/client-core");
    await printScorecardDetail(ctx, core, org.id, card, overview);
    return;
  }

  if (ctx.flags.output === "json") {
    printJson({ org: org.id, ...overview });
    return;
  }

  const { scorecards, services, results } = overview;
  if (scorecards.length === 0) {
    println(c.dim("No scorecards. Create one from the Scorecards tab."));
    return;
  }
  if (services.length === 0) {
    println(c.dim("No services to score yet. Create one from the Services tab."));
    return;
  }
  const byCell = new Map(results.map((r) => [`${r.serviceId}:${r.scorecardId}`, r]));
  const rows = [...services].sort(
    (a, b) => (a.tier ?? 9) - (b.tier ?? 9) || a.name.localeCompare(b.name),
  );

  println(
    `${c.bold(safe(org.displayName))} ${c.dim(`· ${services.length} service${services.length === 1 ? "" : "s"} × ${scorecards.length} scorecard${scorecards.length === 1 ? "" : "s"}`)}`,
  );
  println();
  const columns: Column<ScorecardOverviewService>[] = [
    { header: "service", value: (s) => safe(s.name) },
    { header: "tier", value: (s) => formatServiceTier(s.tier) },
    ...scorecards.map((card): Column<ScorecardOverviewService> => ({
      header: card.enabled ? safe(card.name) : `${safe(card.name)} (off)`,
      value: (s) => cell(card, byCell.get(`${s.id}:${card.id}`)),
    })),
  ];
  printTable(rows, columns);
  println();
  println(
    c.dim(
      "n/a: the scorecard does not apply to the service's tier. `infrawrench scorecards <name>` shows one scorecard's checks.",
    ),
  );
}

async function fetchHistories(
  orgId: string,
  scorecardId: string,
  serviceIds: readonly string[],
): Promise<Record<string, ScorecardHistoryPoint[]>> {
  const out: Record<string, ScorecardHistoryPoint[]> = {};
  if (serviceIds.length > HISTORY_FETCH_LIMIT) return out;
  let next = 0;
  const worker = async () => {
    while (next < serviceIds.length) {
      const id = serviceIds[next++]!;
      try {
        const res = await orgFetch<ServiceScorecardsResponse>(
          orgId,
          `/services/${encodeURIComponent(id)}/scorecards`,
        );
        out[id] = res.history[scorecardId] ?? [];
      } catch {
        // A trend is a nicety; the current score is already printed.
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(HISTORY_CONCURRENCY, serviceIds.length) }, worker),
  );
  return out;
}

async function printScorecardDetail(
  ctx: CliContext,
  core: Core,
  orgId: string,
  card: Scorecard,
  overview: ScorecardOverviewResponse,
): Promise<void> {
  const results = overview.results.filter((r) => r.scorecardId === card.id);
  const servicesById = new Map(overview.services.map((s) => [s.id, s]));
  const scoredIds = results.map((r) => r.serviceId);
  const history = await fetchHistories(orgId, card.id, scoredIds);

  if (ctx.flags.output === "json") {
    printJson({
      org: orgId,
      scorecard: card,
      services: overview.services.filter((s) => scoredIds.includes(s.id)),
      results,
      history,
    });
    return;
  }

  println(
    `${c.bold(safe(card.name))}${card.isDefault ? c.dim(" (default)") : ""}  ${
      card.enabled ? c.green("enabled") : c.dim("disabled")
    }`,
  );
  if (card.description) println(safe(card.description));
  const facts = [
    card.applicableTiers.length === 0
      ? "applies to every service"
      : `applies to ${card.applicableTiers.map((t) => `tier ${t}`).join(", ")}`,
    card.alertOnLevelDrop ? "alerts on a level drop" : "no level-drop alert",
    card.lastEvaluatedAt
      ? `evaluated ${formatChangeTime(card.lastEvaluatedAt)} UTC`
      : "not evaluated yet",
  ];
  println(c.dim(facts.join(" · ")));

  println();
  println(c.bold("levels"));
  const levels = core.sortScorecardLevels(card.levels);
  println(
    `  ${levels.map((l) => `${safe(l.name)} ${c.dim(`≥ ${l.minScore}`)}`).join(c.dim("  ·  "))}`,
  );

  println();
  println(c.bold("checks"));
  const totalWeight = card.checks.reduce((sum, ch) => sum + ch.weight, 0);
  printTable(
    card.checks,
    [
      { header: "check", value: (ch) => safe(core.scorecardCheckName(ch)) },
      { header: "type", value: (ch) => c.dim(ch.type) },
      {
        header: "weight",
        value: (ch) => `${ch.weight}${c.dim(`/${totalWeight}`)}`,
        align: "right",
      },
      {
        header: "params",
        value: (ch) => {
          const def = core.scorecardCheckTypeDef(ch.type);
          const text = formatScorecardParams(
            ch.params,
            (key) => def?.params.find((p) => p.key === key)?.label ?? key,
          );
          return text ? c.dim(text) : c.dim("-");
        },
      },
    ],
    { indent: 2 },
  );

  println();
  println(c.bold(`services (${results.length})`));
  type Row = { result: ScorecardResult; name: string; score: number | null };
  const rows = orderScoreRows<Row>(
    results.map((r) => ({
      result: r,
      name: servicesById.get(r.serviceId)?.name ?? r.serviceId,
      score: r.score,
    })),
  );
  printTable(
    rows,
    [
      { header: "service", value: (row) => safe(row.name) },
      {
        header: "tier",
        value: (row) => formatServiceTier(servicesById.get(row.result.serviceId)?.tier ?? null),
      },
      { header: "score", value: (row) => cell(card, row.result) },
      {
        header: "90d",
        value: (row) => {
          const points = (history[row.result.serviceId] ?? [])
            .map((h) => h.score)
            .filter((v): v is number => v !== null);
          return points.length > 1
            ? c.dim(sparkline(points, Math.min(points.length, 24)))
            : c.dim("-");
        },
      },
      {
        header: "failing",
        value: (row) => {
          const failing = row.result.checks.filter(
            (ch) => ch.status === "fail" || ch.status === "error",
          );
          return failing.length === 0
            ? c.dim("-")
            : c.red(failing.map((ch) => safe(ch.name)).join(", "));
        },
      },
    ],
    { indent: 2 },
  );
  if (results.length > HISTORY_FETCH_LIMIT) {
    println(c.dim(`  (trends skipped above ${HISTORY_FETCH_LIMIT} services)`));
  }
  println();
  println(c.dim("`infrawrench services show <slug>` prints why each check failed."));
}
