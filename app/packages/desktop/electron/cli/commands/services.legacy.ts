// `infrawrench services`: the org's services (a named set of resources across
// providers, with owners, a tier and the reliability objects linked to it),
// and `infrawrench services show <id|slug|name>` for one service's summary.
//
// Cloud-only and read-only: services are written from the web/desktop
// Services tab, where the resource and rule pickers are.
//
// `--json` shapes:
//   services list  → { org, services }                      (Service[])
//   services show  → { org, service, members, excluded, summary, scorecards, history }
//                    `summary` is GET /services/:id/summary without its
//                    `service` and `scorecards` (those are top-level);
//                    `scorecards` is the ScorecardResult[] with every
//                    check; `history` is scorecard id → daily points.
//
// Types come from `@infrawrench/client-core` type-only; the CLI project is CJS
// and imports that package's runtime code dynamically. Pure presentation
// lives in `../format` where it is unit-tested.
import { CliError, orgFetch, resolveOrg, type CliContext } from "../context";
import type {
  Scorecard,
  ScorecardListResponse,
  ScorecardResult,
  Service,
  ServiceDetailResponse,
  ServiceListResponse,
  ServiceMember,
  ServiceScorecardsResponse,
  ServiceSloStanding,
  ServiceSummaryResponse,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import { c, formatMoney, printJson, println, printTable, safe, type Column } from "../output";
import { sparkline } from "../charts";
import {
  formatChangeTime,
  formatCheckStatus,
  formatScoreCell,
  formatServiceCostLine,
  formatServiceOwners,
  formatServiceTier,
  matchService,
} from "../format";

type Core = typeof import("@infrawrench/client-core", { with: { "resolution-mode": "import" } });

/** Position of a level on a scorecard's ladder (lowest first); -1 when none. */
function levelRank(scorecard: Scorecard | undefined, level: string | null): number {
  if (!scorecard || level === null) return -1;
  return [...scorecard.levels]
    .sort((a, b) => a.minScore - b.minScore)
    .findIndex((l) => l.key === level);
}

function scoreCell(
  scorecards: ReadonlyMap<string, Scorecard>,
  result: {
    scorecardId: string;
    score: number | null;
    level: string | null;
    levelName: string | null;
  },
): string {
  const card = scorecards.get(result.scorecardId);
  return formatScoreCell(result, levelRank(card, result.level), card?.levels.length ?? 0);
}

async function listScorecards(orgId: string): Promise<Map<string, Scorecard>> {
  // Only for colouring levels: a failure here should not hide the services.
  try {
    const { scorecards } = await orgFetch<ScorecardListResponse>(orgId, "/scorecards");
    return new Map(scorecards.map((s) => [s.id, s]));
  } catch {
    return new Map();
  }
}

export async function cmdServices(
  ctx: CliContext,
  args: string[],
  tier: number | undefined,
): Promise<void> {
  if (ctx.flags.local) {
    throw new CliError(
      "Services live in Infrawrench Cloud, where membership rules are evaluated. Drop --local.",
    );
  }
  const [sub, ...rest] = args;
  const org = await resolveOrg(ctx);

  if (sub === undefined || sub === "list") {
    await printServiceList(ctx, org.id, org.displayName, tier);
    return;
  }
  // `services show <x>`, or the shorthand `services <x>`.
  const query = (sub === "show" ? rest : args).join(" ").trim();
  if (!query) {
    throw new CliError("Usage: infrawrench services show <id|slug|name>", 2);
  }
  const core: Core = await import("@infrawrench/client-core");
  const { services } = await orgFetch<ServiceListResponse>(org.id, "/services");
  const found = matchService(services, query);
  if (!found.match) {
    if (found.candidates.length > 1) {
      throw new CliError(
        `"${query}" matches ${found.candidates.length} services: ${found.candidates
          .map((s) => safe(s.slug))
          .join(", ")}. Use the slug.`,
      );
    }
    throw new CliError(`No service matches "${query}". Run \`infrawrench services\` to list.`);
  }
  await printServiceDetail(ctx, core, org.id, found.match);
}

async function printServiceList(
  ctx: CliContext,
  orgId: string,
  orgName: string,
  tier: number | undefined,
): Promise<void> {
  const [{ services: all }, scorecards] = await Promise.all([
    orgFetch<ServiceListResponse>(orgId, "/services"),
    listScorecards(orgId),
  ]);
  const services = tier === undefined ? all : all.filter((s) => s.tier === tier);

  if (ctx.flags.output === "json") {
    printJson({ org: orgId, services });
    return;
  }
  if (services.length === 0) {
    println(
      c.dim(
        tier === undefined
          ? "No services yet. Create one from the Services tab: name it, pick its resources or add a tag rule."
          : `No tier ${tier} services.`,
      ),
    );
    return;
  }

  const sorted = [...services].sort(
    (a, b) => (a.tier ?? 9) - (b.tier ?? 9) || a.name.localeCompare(b.name),
  );
  // One column per scorecard any listed service carries, in first-seen order.
  const cardColumns = new Map<string, string>();
  for (const s of sorted) {
    for (const badge of s.scores) {
      if (!cardColumns.has(badge.scorecardId))
        cardColumns.set(badge.scorecardId, badge.scorecardName);
    }
  }

  println(
    `${c.bold(safe(orgName))} ${c.dim(`· ${services.length} service${services.length === 1 ? "" : "s"}${tier === undefined ? "" : ` in tier ${tier}`}`)}`,
  );
  println();
  const columns: Column<Service>[] = [
    { header: "service", value: (s) => c.bold(safe(s.name)) },
    { header: "slug", value: (s) => c.dim(safe(s.slug)) },
    { header: "tier", value: (s) => formatServiceTier(s.tier) },
    { header: "owner", value: (s) => formatServiceOwners(s) },
    { header: "members", value: (s) => String(s.memberCount), align: "right" },
    ...[...cardColumns].map(([id, name]): Column<Service> => ({
      header: safe(name),
      value: (s) => {
        const badge = s.scores.find((b) => b.scorecardId === id);
        return badge ? scoreCell(scorecards, badge) : c.dim("n/a");
      },
    })),
  ];
  printTable(sorted, columns);
  println();
  println(c.dim("`infrawrench services show <slug>` prints one service's summary."));
}

function sloStatusCell(slo: ServiceSloStanding): string {
  switch (slo.status) {
    case "exhausted":
      return c.red("● budget spent");
    case "fast_burn":
      return c.red("● fast burn");
    case "slow_burn":
      return c.yellow("● slow burn");
    case "ok":
      return c.green("● ok");
    case "unknown":
      return c.dim("● no data");
  }
}

function memberSource(service: Service, m: ServiceMember): string {
  if (m.source === "manual") return "picked";
  const rule = m.ruleIndex === null ? undefined : service.rules[m.ruleIndex];
  return rule ? `rule ${m.ruleIndex! + 1}` : "rule";
}

function heading(text: string): void {
  println();
  println(c.bold(text));
}

async function printServiceDetail(
  ctx: CliContext,
  core: Core,
  orgId: string,
  match: Service,
): Promise<void> {
  const id = encodeURIComponent(match.id);
  const [detail, summary, history, scorecards] = await Promise.all([
    orgFetch<ServiceDetailResponse>(orgId, `/services/${id}`),
    orgFetch<ServiceSummaryResponse>(orgId, `/services/${id}/summary`),
    orgFetch<ServiceScorecardsResponse>(orgId, `/services/${id}/scorecards`).catch(
      (): ServiceScorecardsResponse => ({ results: [], history: {} }),
    ),
    listScorecards(orgId),
  ]);

  if (ctx.flags.output === "json") {
    const { service: _service, scorecards: results, ...rest } = summary;
    printJson({
      org: orgId,
      service: detail.service,
      members: detail.members,
      excluded: detail.excluded,
      summary: rest,
      scorecards: results,
      history: history.history,
    });
    return;
  }

  const service = detail.service;
  println(
    `${c.bold(safe(service.name))} ${c.dim(`(${safe(service.slug)})`)}  ${
      service.tier === null
        ? c.dim("not tiered")
        : `${core.SERVICE_TIER_LABELS[service.tier]} ${c.dim(`· ${core.SERVICE_TIER_DESCRIPTIONS[service.tier]}`)}`
    }`,
  );
  if (service.description) println(safe(service.description));
  println(`${c.dim("owners ")} ${formatServiceOwners(service)}`);
  for (const link of service.links) {
    println(`${c.dim("link   ")} ${safe(link.label)} ${c.dim(safe(link.url))}`);
  }

  // On-call: who holds the pager now and next.
  const onCall = summary.onCall;
  if (onCall) {
    const who = (p: { name: string | null; email: string | null; userId: string }) =>
      safe(p.name ?? p.email ?? p.userId);
    const parts = [
      onCall.current
        ? `${who(onCall.current)} ${c.dim(`until ${formatChangeTime(onCall.current.endsAt)} UTC`)}`
        : c.yellow("nobody on call"),
    ];
    if (onCall.next) parts.push(`${c.dim("next")} ${who(onCall.next)}`);
    println(
      `${c.dim("on-call")} ${parts.join(c.dim(" · "))} ${c.dim(`(${safe(onCall.scheduleName)}${onCall.enabled ? "" : ", disabled"})`)}`,
    );
  } else {
    println(`${c.dim("on-call")} ${c.dim("no schedule linked")}`);
  }

  println(
    `${c.dim(`cost ${summary.cost.windowDays}d`)} ${formatServiceCostLine(summary.cost, formatMoney)}${
      summary.cost.available
        ? c.dim(` · ${summary.cost.costedMembers} of ${summary.memberCount} members costed`)
        : ""
    }`,
  );

  // Scorecards, with each failing check's reason.
  heading("scorecards");
  if (summary.scorecards.length === 0) {
    println(c.dim("  No scorecard applies to this service."));
  }
  for (const result of summary.scorecards) {
    printScorecardResult(result, scorecards, history.history[result.scorecardId]);
  }

  heading("SLOs");
  if (summary.slos.length === 0) println(c.dim("  none linked"));
  else
    printTable(
      summary.slos,
      [
        { header: "", value: (s) => sloStatusCell(s) },
        { header: "slo", value: (s) => safe(s.name) },
        { header: "target", value: (s) => `${s.targetPercent}%`, align: "right" },
        {
          header: "budget left",
          value: (s) =>
            s.budgetRemaining === null
              ? c.dim("-")
              : `${Number((s.budgetRemaining * 100).toFixed(1))}%`,
          align: "right",
        },
      ],
      { indent: 2 },
    );

  heading("runbooks");
  if (summary.runbooks.length === 0) println(c.dim("  none linked"));
  for (const rb of summary.runbooks) {
    println(`  ${rb.enabled ? safe(rb.name) : c.dim(`${safe(rb.name)} (disabled)`)}`);
  }

  const f = summary.findings;
  heading("findings");
  const unavailable = new Set(f.unavailable);
  const count = (feed: "posture" | "orphans" | "backups", text: string) =>
    unavailable.has(feed) ? c.yellow(`${feed} unavailable`) : text;
  const p = f.posture.counts;
  println(
    `  ${[
      count(
        "posture",
        `posture ${p.critical > 0 ? c.red(`${p.critical} critical`) : "0 critical"} · ${
          p.high > 0 ? c.yellow(`${p.high} high`) : "0 high"
        } · ${p.medium} medium · ${p.low} low`,
      ),
      count(
        "orphans",
        `orphans ${f.orphans.length > 0 ? c.yellow(String(f.orphans.length)) : "0"}`,
      ),
      count(
        "backups",
        `backup gaps ${f.backups.length > 0 ? c.yellow(String(f.backups.length)) : "0"}`,
      ),
    ].join(c.dim("   "))}`,
  );
  for (const b of f.backups) {
    println(c.dim(`    ${safe(b.resourceName)}: ${safe(b.detail)}`));
  }
  for (const o of f.orphans) {
    println(c.dim(`    ${safe(o.resourceName)}: ${safe(o.reason)}`));
  }

  heading(`members (${detail.members.length})`);
  if (service.rules.length > 0) {
    service.rules.forEach((rule, i) =>
      println(c.dim(`  rule ${i + 1}: ${safe(core.describeServiceRule(rule))}`)),
    );
  }
  printTable(
    detail.members,
    [
      {
        header: "resource",
        value: (m) =>
          m.missing ? c.dim(`${safe(m.resourceName)} (deleted)`) : safe(m.resourceName),
      },
      { header: "type", value: (m) => c.dim(safe(m.resourceTypeId)) },
      { header: "provider", value: (m) => safe(m.pluginId) },
      { header: "account", value: (m) => safe(m.accountName ?? m.accountId) },
      { header: "source", value: (m) => memberSource(service, m) },
    ],
    { indent: 2 },
  );
  if (detail.excluded.length > 0) {
    println(
      c.dim(
        `  ${detail.excluded.length} rule-matched resource${detail.excluded.length === 1 ? "" : "s"} excluded: ${detail.excluded
          .map((m) => safe(m.resourceName))
          .join(", ")}`,
      ),
    );
  }

  heading("recent changes");
  printTable(
    summary.recentChanges,
    [
      { header: "when", value: (ch) => c.dim(formatChangeTime(ch.at)) },
      {
        header: "change",
        value: (ch) =>
          ch.changeKind === "deleted"
            ? c.red(ch.changeKind)
            : ch.changeKind === "created"
              ? c.green(ch.changeKind)
              : ch.changeKind,
      },
      { header: "resource", value: (ch) => safe(ch.resourceName) },
      { header: "fields", value: (ch) => c.dim(ch.fields.map((x) => safe(x)).join(", ")) },
    ],
    { indent: 2 },
  );
  if (detail.members.length === 0) {
    println();
    println(c.dim("No members yet: add resources or a rule from the Services tab."));
  }
}

function printScorecardResult(
  result: ScorecardResult,
  scorecards: ReadonlyMap<string, Scorecard>,
  history: ServiceScorecardsResponse["history"][string] | undefined,
): void {
  const points = (history ?? []).map((h) => h.score).filter((v): v is number => v !== null);
  const trend =
    points.length > 1 ? `  ${c.dim(sparkline(points, Math.min(points.length, 30)))}` : "";
  println(`  ${safe(result.scorecardName)}  ${scoreCell(scorecards, result)}${trend}`);
  for (const check of result.checks) {
    if (check.status === "pass" || check.status === "not_applicable") continue;
    println(
      `    ${formatCheckStatus(check.status)} ${safe(check.name)}${
        check.detail ? c.dim(`: ${safe(check.detail)}`) : ""
      }`,
    );
  }
  const passed = result.checks.filter((ch) => ch.status === "pass").length;
  const applicable = result.checks.filter((ch) => ch.status !== "not_applicable").length;
  println(c.dim(`    ${passed} of ${applicable} applicable checks pass`));
}
