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
// The response schemas are checked against `@infrawrench/client-core` by
// `wire`; the CLI project is CJS and imports that package's runtime code
// dynamically. Pure presentation lives in `../format` where it is unit-tested.
import { Effect, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import type {
  ScorecardListResponse,
  ServiceDetailResponse,
  ServiceListResponse,
  ServiceScorecardsResponse,
  ServiceSummaryResponse,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import { sparkline } from "../charts";
import { bestEffort, CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import { CliFailure, CliUsageError } from "../effect/errors";
import * as Print from "../effect/print";
import { boundedInt } from "../effect/range-flags";
import { CliSession } from "../effect/session";
import { knownOr, Unrecognized, wire } from "../effect/wire";
import {
  formatChangeTime,
  formatCheckStatus,
  formatScoreCell,
  formatServiceCostLine,
  formatServiceOwners,
  formatServiceTier,
  matchService,
} from "../format";
import { c, formatMoney, safe, type Column } from "../output";

type Core = typeof import("@infrawrench/client-core", { with: { "resolution-mode": "import" } });
const loadCore = Effect.promise((): Promise<Core> => import("@infrawrench/client-core"));

const SERVICES_PATH = "/services";
const SCORECARDS_PATH = "/scorecards";

const Person = Schema.Struct({
  userId: Schema.String,
  name: Schema.NullOr(Schema.String),
  email: Schema.NullOr(Schema.String),
});

const Score = Schema.Struct({
  scorecardId: Schema.String,
  scorecardName: Schema.String,
  score: Schema.NullOr(Schema.Finite),
  level: Schema.NullOr(Schema.String),
  levelName: Schema.NullOr(Schema.String),
});

const Rule = Schema.Struct({
  kind: knownOr(["tag", "virtual_tag", "name"]),
  key: Schema.NullOr(Schema.String),
  value: Schema.NullOr(Schema.String),
  nameMatch: Schema.NullOr(knownOr(["contains", "prefix", "suffix", "exact"])),
  pluginId: Schema.NullOr(Schema.String),
  accountId: Schema.NullOr(Schema.String),
});

const Service = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  slug: Schema.String,
  description: Schema.NullOr(Schema.String),
  // A tier this build does not know reads as its number.
  tier: Schema.NullOr(Schema.Finite),
  ownerTeam: Schema.NullOr(Schema.String),
  owners: Schema.Array(Person),
  links: Schema.Array(Schema.Struct({ label: Schema.String, url: Schema.String })),
  rules: Schema.Array(Rule),
  memberCount: Schema.Finite,
  scores: Schema.Array(Score),
});
type Service = typeof Service.Type;

const Services = wire<ServiceListResponse>()(Schema.Struct({ services: Schema.Array(Service) }));
const ServicesEnvelope = Schema.Struct({ services: Schema.Array(Schema.Unknown) });

const Scorecards = wire<ScorecardListResponse>()(
  Schema.Struct({
    scorecards: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        levels: Schema.Array(Schema.Struct({ key: Schema.String, minScore: Schema.Finite })),
      }),
    ),
  }),
);
type Scorecard = (typeof Scorecards.Type)["scorecards"][number];

const Member = Schema.Struct({
  accountId: Schema.String,
  accountName: Schema.NullOr(Schema.String),
  pluginId: Schema.String,
  resourceTypeId: Schema.String,
  resourceName: Schema.String,
  source: Schema.String,
  ruleIndex: Schema.NullOr(Schema.Finite),
  missing: Schema.Boolean,
});
type Member = typeof Member.Type;

const Detail = wire<ServiceDetailResponse>()(
  Schema.Struct({
    service: Service,
    members: Schema.Array(Member),
    excluded: Schema.Array(Member),
  }),
);

const CheckStatus = knownOr(["pass", "fail", "not_applicable", "error"]);

const ScorecardResult = Schema.Struct({
  scorecardId: Schema.String,
  scorecardName: Schema.String,
  score: Schema.NullOr(Schema.Finite),
  level: Schema.NullOr(Schema.String),
  levelName: Schema.NullOr(Schema.String),
  checks: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      status: CheckStatus,
      detail: Schema.NullOr(Schema.String),
    }),
  ),
});
type ScorecardResult = typeof ScorecardResult.Type;

const Summary = wire<ServiceSummaryResponse>()(
  Schema.Struct({
    memberCount: Schema.Finite,
    cost: Schema.Struct({
      windowDays: Schema.Finite,
      available: Schema.Boolean,
      totals: Schema.Array(Schema.Struct({ currency: Schema.String, amount: Schema.Finite })),
      costedMembers: Schema.Finite,
    }),
    slos: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        status: knownOr(["exhausted", "fast_burn", "slow_burn", "ok", "unknown"]),
        targetPercent: Schema.Finite,
        budgetRemaining: Schema.NullOr(Schema.Finite),
      }),
    ),
    runbooks: Schema.Array(Schema.Struct({ name: Schema.String, enabled: Schema.Boolean })),
    onCall: Schema.NullOr(
      Schema.Struct({
        scheduleName: Schema.String,
        enabled: Schema.Boolean,
        current: Schema.NullOr(
          Schema.Struct({
            userId: Schema.String,
            name: Schema.NullOr(Schema.String),
            email: Schema.NullOr(Schema.String),
            endsAt: Schema.String,
          }),
        ),
        next: Schema.NullOr(Person),
      }),
    ),
    findings: Schema.Struct({
      posture: Schema.Struct({
        counts: Schema.Struct({
          critical: Schema.Finite,
          high: Schema.Finite,
          medium: Schema.Finite,
          low: Schema.Finite,
        }),
      }),
      orphans: Schema.Array(Schema.Struct({ resourceName: Schema.String, reason: Schema.String })),
      backups: Schema.Array(Schema.Struct({ resourceName: Schema.String, detail: Schema.String })),
      unavailable: Schema.Array(Schema.String),
    }),
    recentChanges: Schema.Array(
      Schema.Struct({
        changeKind: Schema.String,
        resourceName: Schema.String,
        fields: Schema.Array(Schema.String),
        at: Schema.String,
      }),
    ),
    scorecards: Schema.Array(ScorecardResult),
  }),
);

const History = wire<ServiceScorecardsResponse>()(
  Schema.Struct({
    history: Schema.Record(
      Schema.String,
      Schema.Array(Schema.Struct({ score: Schema.NullOr(Schema.Finite) })),
    ),
  }),
);

/** The JSON parts `services show --json` prints, as the server sent them. */
const DetailEnvelope = Schema.Struct({
  service: Schema.Unknown,
  members: Schema.Unknown,
  excluded: Schema.Unknown,
});
const JsonObject = Schema.Record(Schema.String, Schema.Unknown);
const HistoryEnvelope = Schema.Struct({ history: Schema.Unknown });

const requireCloud = Effect.gen(function* () {
  const session = yield* CliSession;
  if (session.local) {
    return yield* new CliFailure({
      message:
        "Services live in Infrawrench Cloud, where membership rules are evaluated. Drop --local.",
    });
  }
});

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

/** The scorecards, for colouring levels: a failure here should not hide the services. */
const listScorecards = (orgId: string) =>
  Effect.gen(function* () {
    const api = yield* CloudApi;
    const { scorecards } = yield* api.decode(Scorecards, orgId, SCORECARDS_PATH);
    return new Map(scorecards.map((s) => [s.id, s]));
  }).pipe(bestEffort(() => new Map<string, Scorecard>()));

const tierFlag = boundedInt("tier", 1, 4).pipe(
  Flag.withMetavar("1-4"),
  Flag.withDescription("Only services of this criticality tier"),
  Flag.optional,
);

const printServiceList = Effect.fnUntraced(function* (
  orgId: string,
  orgName: string,
  tier: number | undefined,
) {
  const session = yield* CliSession;
  const api = yield* CloudApi;
  const [body, scorecards] = yield* Effect.all(
    [api.json(orgId, SERVICES_PATH), listScorecards(orgId)],
    { concurrency: "unbounded" },
  );
  const raw = (yield* decodeBody(ServicesEnvelope, SERVICES_PATH)(body)).services;
  const { services: all } = yield* decodeBody(Services, SERVICES_PATH)(body);
  const kept = all.flatMap((s, i) => (tier === undefined || s.tier === tier ? [i] : []));
  const services = kept.map((i) => all[i]!);

  if (session.output === "json") {
    return yield* Print.json({ org: orgId, services: kept.map((i) => raw[i]) });
  }
  if (services.length === 0) {
    return yield* Print.line(
      c.dim(
        tier === undefined
          ? "No services yet. Create one from the Services tab: name it, pick its resources or add a tag rule."
          : `No tier ${tier} services.`,
      ),
    );
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

  yield* Print.line(
    `${c.bold(safe(orgName))} ${c.dim(`· ${services.length} service${services.length === 1 ? "" : "s"}${tier === undefined ? "" : ` in tier ${tier}`}`)}`,
  );
  yield* Print.line();
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
  yield* Print.table(sorted, columns);
  yield* Print.line();
  yield* Print.line(c.dim("`infrawrench services show <slug>` prints one service's summary."));
});

function sloStatusCell(status: (typeof Summary.Type)["slos"][number]["status"]): string {
  if (status instanceof Unrecognized) return c.dim(`● ${safe(status.raw)}`);
  switch (status) {
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

function memberSource(service: Service, m: Member): string {
  if (m.source === "manual") return "picked";
  const rule = m.ruleIndex === null ? undefined : service.rules[m.ruleIndex];
  return rule && m.ruleIndex !== null ? `rule ${m.ruleIndex + 1}` : "rule";
}

/** One membership rule in words; a kind or match this build does not know, by its name. */
function describeRule(core: Core, rule: typeof Rule.Type): string {
  const { kind, nameMatch } = rule;
  if (kind instanceof Unrecognized || nameMatch instanceof Unrecognized) {
    const word = kind instanceof Unrecognized ? kind.raw : kind;
    const match = nameMatch instanceof Unrecognized ? ` ${nameMatch.raw}` : "";
    return `${word}${match} ${[rule.key, rule.value].filter(Boolean).join("=")}`.trim();
  }
  return core.describeServiceRule({ ...rule, kind, nameMatch });
}

/** A tier's label and description, or the number for one this build does not know. */
function tierText(core: Core, tier: number): string {
  return core.isServiceTier(tier)
    ? `${core.SERVICE_TIER_LABELS[tier]} ${c.dim(`· ${core.SERVICE_TIER_DESCRIPTIONS[tier]}`)}`
    : `Tier ${tier}`;
}

const heading = (text: string) => Print.line().pipe(Effect.andThen(Print.line(c.bold(text))));

const printScorecardResult = Effect.fnUntraced(function* (
  result: ScorecardResult,
  scorecards: ReadonlyMap<string, Scorecard>,
  history: ReadonlyArray<{ readonly score: number | null }> | undefined,
) {
  const points = (history ?? []).map((h) => h.score).filter((v): v is number => v !== null);
  const trend =
    points.length > 1 ? `  ${c.dim(sparkline(points, Math.min(points.length, 30)))}` : "";
  yield* Print.line(`  ${safe(result.scorecardName)}  ${scoreCell(scorecards, result)}${trend}`);
  for (const check of result.checks) {
    if (check.status === "pass" || check.status === "not_applicable") continue;
    const status =
      check.status instanceof Unrecognized
        ? c.yellow(safe(check.status.raw))
        : formatCheckStatus(check.status);
    yield* Print.line(
      `    ${status} ${safe(check.name)}${check.detail ? c.dim(`: ${safe(check.detail)}`) : ""}`,
    );
  }
  const passed = result.checks.filter((ch) => ch.status === "pass").length;
  const applicable = result.checks.filter((ch) => ch.status !== "not_applicable").length;
  yield* Print.line(c.dim(`    ${passed} of ${applicable} applicable checks pass`));
});

const printServiceDetail = Effect.fnUntraced(function* (orgId: string, match: Service) {
  const session = yield* CliSession;
  const api = yield* CloudApi;
  const core = yield* loadCore;
  const id = encodeURIComponent(match.id);
  const detailPath = `/services/${id}`;
  const summaryPath = `/services/${id}/summary`;
  const historyPath = `/services/${id}/scorecards`;
  const [detailBody, summaryBody, historyBody, scorecards] = yield* Effect.all(
    [
      api.json(orgId, detailPath),
      api.json(orgId, summaryPath),
      api.json(orgId, historyPath).pipe(bestEffort(() => ({ results: [], history: {} }))),
      listScorecards(orgId),
    ],
    { concurrency: "unbounded" },
  );

  if (session.output === "json") {
    const detail = yield* decodeBody(DetailEnvelope, detailPath)(detailBody);
    const {
      service: _service,
      scorecards: results,
      ...rest
    } = yield* decodeBody(JsonObject, summaryPath)(summaryBody);
    const { history } = yield* decodeBody(HistoryEnvelope, historyPath)(historyBody);
    return yield* Print.json({
      org: orgId,
      service: detail.service,
      members: detail.members,
      excluded: detail.excluded,
      summary: rest,
      scorecards: results,
      history,
    });
  }

  const detail = yield* decodeBody(Detail, detailPath)(detailBody);
  const summary = yield* decodeBody(Summary, summaryPath)(summaryBody);
  const { history } = yield* decodeBody(History, historyPath)(historyBody);
  const service = detail.service;
  yield* Print.line(
    `${c.bold(safe(service.name))} ${c.dim(`(${safe(service.slug)})`)}  ${
      service.tier === null ? c.dim("not tiered") : tierText(core, service.tier)
    }`,
  );
  if (service.description) yield* Print.line(safe(service.description));
  yield* Print.line(`${c.dim("owners ")} ${formatServiceOwners(service)}`);
  for (const link of service.links) {
    yield* Print.line(`${c.dim("link   ")} ${safe(link.label)} ${c.dim(safe(link.url))}`);
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
    yield* Print.line(
      `${c.dim("on-call")} ${parts.join(c.dim(" · "))} ${c.dim(`(${safe(onCall.scheduleName)}${onCall.enabled ? "" : ", disabled"})`)}`,
    );
  } else {
    yield* Print.line(`${c.dim("on-call")} ${c.dim("no schedule linked")}`);
  }

  yield* Print.line(
    `${c.dim(`cost ${summary.cost.windowDays}d`)} ${formatServiceCostLine(summary.cost, formatMoney)}${
      summary.cost.available
        ? c.dim(` · ${summary.cost.costedMembers} of ${summary.memberCount} members costed`)
        : ""
    }`,
  );

  // Scorecards, with each failing check's reason.
  yield* heading("scorecards");
  if (summary.scorecards.length === 0) {
    yield* Print.line(c.dim("  No scorecard applies to this service."));
  }
  for (const result of summary.scorecards) {
    yield* printScorecardResult(result, scorecards, history[result.scorecardId]);
  }

  yield* heading("SLOs");
  if (summary.slos.length === 0) yield* Print.line(c.dim("  none linked"));
  else
    yield* Print.table(
      summary.slos,
      [
        { header: "", value: (s) => sloStatusCell(s.status) },
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

  yield* heading("runbooks");
  if (summary.runbooks.length === 0) yield* Print.line(c.dim("  none linked"));
  for (const rb of summary.runbooks) {
    yield* Print.line(`  ${rb.enabled ? safe(rb.name) : c.dim(`${safe(rb.name)} (disabled)`)}`);
  }

  const f = summary.findings;
  yield* heading("findings");
  const unavailable = new Set(f.unavailable);
  const count = (feed: "posture" | "orphans" | "backups", text: string) =>
    unavailable.has(feed) ? c.yellow(`${feed} unavailable`) : text;
  const p = f.posture.counts;
  yield* Print.line(
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
    yield* Print.line(c.dim(`    ${safe(b.resourceName)}: ${safe(b.detail)}`));
  }
  for (const o of f.orphans) {
    yield* Print.line(c.dim(`    ${safe(o.resourceName)}: ${safe(o.reason)}`));
  }

  yield* heading(`members (${detail.members.length})`);
  for (const [i, rule] of service.rules.entries()) {
    yield* Print.line(c.dim(`  rule ${i + 1}: ${safe(describeRule(core, rule))}`));
  }
  yield* Print.table(
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
    yield* Print.line(
      c.dim(
        `  ${detail.excluded.length} rule-matched resource${detail.excluded.length === 1 ? "" : "s"} excluded: ${detail.excluded
          .map((m) => safe(m.resourceName))
          .join(", ")}`,
      ),
    );
  }

  yield* heading("recent changes");
  yield* Print.table(
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
              : safe(ch.changeKind),
      },
      { header: "resource", value: (ch) => safe(ch.resourceName) },
      { header: "fields", value: (ch) => c.dim(ch.fields.map((x) => safe(x)).join(", ")) },
    ],
    { indent: 2 },
  );
  if (detail.members.length === 0) {
    yield* Print.line();
    yield* Print.line(c.dim("No members yet: add resources or a rule from the Services tab."));
  }
});

/** `services show <x>` (and the shorthand `services <x>`): one service's summary. */
const showService = Effect.fnUntraced(function* (words: ReadonlyArray<string>) {
  const api = yield* CloudApi;
  const org = yield* currentOrg;
  const query = words.join(" ").trim();
  if (!query) {
    return yield* new CliUsageError({ message: "Usage: infrawrench services show <id|slug|name>" });
  }
  const { services } = yield* api.decode(Services, org.id, SERVICES_PATH);
  const found = matchService(services, query);
  if (!found.match) {
    return yield* new CliFailure({
      message:
        found.candidates.length > 1
          ? `"${query}" matches ${found.candidates.length} services: ${found.candidates
              .map((s) => safe(s.slug))
              .join(", ")}. Use the slug.`
          : `No service matches "${query}". Run \`infrawrench services\` to list.`,
    });
  }
  yield* printServiceDetail(org.id, found.match);
});

const query = Argument.String("id|slug|name").pipe(
  Argument.withDescription("The service (the words join into one name)"),
  Argument.variadic(),
);

const list = Command.make(
  "list",
  { tier: tierFlag },
  Effect.fn("services.list")(function* (input) {
    yield* requireCloud;
    const org = yield* currentOrg;
    yield* printServiceList(org.id, org.displayName, Option.getOrUndefined(input.tier));
  }),
).pipe(Command.withDescription("Services: tier, owners, member count and level per scorecard"));

const show = Command.make(
  "show",
  { query },
  Effect.fn("services.show")(function* (input) {
    yield* requireCloud;
    yield* showService(input.query);
  }),
).pipe(
  Command.withDescription(
    "One service: owners, links, on-call, 30-day cost, SLOs, runbooks, findings, members, changes and failing checks",
  ),
);

export const services = Command.make(
  "services",
  { query, tier: tierFlag },
  Effect.fn("services")(function* (input) {
    yield* requireCloud;
    if (input.query.length > 0) return yield* showService(input.query);
    const org = yield* currentOrg;
    yield* printServiceList(org.id, org.displayName, Option.getOrUndefined(input.tier));
  }),
).pipe(
  Command.withDescription(
    "Services (resources grouped across providers): tier, owners, member count and level per scorecard; give an id, slug or name for one",
  ),
  Command.withSubcommands([list, show]),
);
