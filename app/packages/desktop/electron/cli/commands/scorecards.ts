// `infrawrench scorecards`: the org grade (overall grade, 90-day trend and the
// seven pillars it reads) above the service × scorecard matrix (rows services,
// columns scorecards, each cell the score and level), and
// `infrawrench scorecards <id|name>` for one scorecard's definition plus every
// service's result on it, best first, with a 90-day score sparkline.
//
// Cloud-only and read-only: scorecards are evaluated by the cloud poller and
// edited from the web/desktop Scorecards tab.
//
// `--json` shapes:
//   scorecards         → { org, orgGrade, scorecards, services, results }
//                        `orgGrade` is GET /scorecards/org (null when it could not be read),
//                        the rest GET /scorecards/overview.
//   scorecards <name>  → { org, scorecard, services, results, history }
//                        `history` is service id → daily points for this scorecard.
//
// The response schemas are checked against `@infrawrench/client-core` by
// `wire`; its runtime helpers are loaded with a dynamic import (the CLI
// project is CJS).
import { Effect, Schema } from "effect";
import { Argument, Command } from "effect/cli";
import type {
  OrgScorecardGrade,
  OrgScorecardResponse,
  ScorecardOverviewResponse,
  ServiceScorecardsResponse,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import { rangedSparkline, sparkline } from "../charts";
import { bestEffort, CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import { CliFailure } from "../effect/errors";
import * as Print from "../effect/print";
import { CliSession } from "../effect/session";
import { knownOr, Unrecognized, wire } from "../effect/wire";
import {
  formatChangeTime,
  formatScoreCell,
  formatScorecardParams,
  formatServiceTier,
  matchIdPrefix,
  orderScoreRows,
} from "../format";
import { c, safe, type Column } from "../output";

type Core = typeof import("@infrawrench/client-core", { with: { "resolution-mode": "import" } });
const loadCore = Effect.promise((): Promise<Core> => import("@infrawrench/client-core"));

const OVERVIEW_PATH = "/scorecards/overview";
const ORG_GRADE_PATH = "/scorecards/org";

/** Above this many services the per-service history requests are skipped. */
const HISTORY_FETCH_LIMIT = 100;
const HISTORY_CONCURRENCY = 8;

const Level = Schema.Struct({
  key: Schema.String,
  name: Schema.String,
  minScore: Schema.Finite,
  color: Schema.NullOr(Schema.String),
});

const CheckType = knownOr([
  "has_owner",
  "has_on_call",
  "slo_within_budget",
  "has_runbook",
  "backups_verified",
  "no_critical_posture",
  "no_orphans",
  "required_tags",
  "cost_within_budget",
  "no_critical_vulnerabilities",
  "change_failure_rate",
]);

const Check = Schema.Struct({
  type: CheckType,
  name: Schema.NullOr(Schema.String),
  weight: Schema.Finite,
  params: Schema.Record(Schema.String, Schema.Union([Schema.Finite, Schema.Array(Schema.String)])),
});
type Check = typeof Check.Type;

const Scorecard = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  checks: Schema.Array(Check),
  levels: Schema.Array(Level),
  // A tier this build does not know reads as its number.
  applicableTiers: Schema.Array(Schema.Finite),
  alertOnLevelDrop: Schema.Boolean,
  enabled: Schema.Boolean,
  isDefault: Schema.Boolean,
  lastEvaluatedAt: Schema.NullOr(Schema.String),
});
type Scorecard = typeof Scorecard.Type;

const OverviewService = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  tier: Schema.NullOr(Schema.Finite),
});
type OverviewService = typeof OverviewService.Type;

const Result = Schema.Struct({
  scorecardId: Schema.String,
  serviceId: Schema.String,
  score: Schema.NullOr(Schema.Finite),
  level: Schema.NullOr(Schema.String),
  levelName: Schema.NullOr(Schema.String),
  // A status this build does not know is neither failing nor passing here.
  checks: Schema.Array(Schema.Struct({ name: Schema.String, status: Schema.String })),
});
type Result = typeof Result.Type;

const Overview = wire<ScorecardOverviewResponse>()(
  Schema.Struct({
    scorecards: Schema.Array(Scorecard),
    services: Schema.Array(OverviewService),
    results: Schema.Array(Result),
  }),
);
type Overview = typeof Overview.Type;

/** The overview as the server sent it, element for element, for `--json`. */
const OverviewEnvelope = Schema.Struct({
  scorecards: Schema.Array(Schema.Unknown),
  services: Schema.Array(Schema.Unknown),
  results: Schema.Array(Schema.Unknown),
});

const OrgGrade = wire<OrgScorecardResponse>()(
  Schema.Struct({
    score: Schema.NullOr(Schema.Finite),
    // Coloured by `gradeColor`, which has a fallback for a grade it does not know.
    grade: Schema.NullOr(Schema.String),
    pillars: Schema.Array(
      Schema.Struct({
        // Labelled through `PILLAR_LABELS`, which falls back on the id.
        id: Schema.String,
        score: Schema.NullOr(Schema.Finite),
        weight: Schema.Finite,
        headline: Schema.String,
        unassessedReason: Schema.NullOr(Schema.String),
        nextStep: Schema.NullOr(Schema.String),
      }),
    ),
    failedPillars: Schema.Array(Schema.String),
    trend: Schema.Array(Schema.Struct({ day: Schema.String, score: Schema.Finite })),
  }),
);
type OrgGrade = typeof OrgGrade.Type;

const History = wire<ServiceScorecardsResponse>()(
  Schema.Struct({
    history: Schema.Record(
      Schema.String,
      Schema.Array(Schema.Struct({ score: Schema.NullOr(Schema.Finite) })),
    ),
  }),
);
const HistoryEnvelope = Schema.Struct({
  history: Schema.Record(Schema.String, Schema.Unknown),
});

/** One service's points on the scorecard: decoded for the sparkline, raw for `--json`. */
interface ServiceHistory {
  readonly points: ReadonlyArray<{ readonly score: number | null }>;
  readonly raw: unknown;
}

function cell(card: Scorecard, result: Result | undefined): string {
  if (!result) return formatScoreCell(null, -1, 0);
  const sorted = [...card.levels].sort((a, b) => a.minScore - b.minScore);
  return formatScoreCell(
    result,
    result.level === null ? -1 : sorted.findIndex((l) => l.key === result.level),
    sorted.length,
  );
}

const requireCloud = Effect.gen(function* () {
  const session = yield* CliSession;
  if (session.local) {
    return yield* new CliFailure({
      message:
        "Scorecards live in Infrawrench Cloud, where the poller evaluates them. Drop --local.",
    });
  }
});

function gradeColor(grade: string): (s: string) => string {
  if (grade === "A" || grade === "B") return c.green;
  if (grade === "C") return c.yellow;
  return c.red;
}

/** A pillar's label; one this build does not know, by its id. */
const pillarLabel = (core: Core, id: string): string => {
  const labels: Partial<Record<string, string>> = core.ORG_SCORECARD_PILLAR_LABELS;
  return labels[id] ?? id;
};

/**
 * `orgScorecardTrendDelta` reads each point's score only: the grade and the
 * per-pillar breakdown it also types stand in as values it does not read.
 */
const UNREAD_GRADE: OrgScorecardGrade = "F";

/** The org grade block printed above the matrix. */
const printOrgGrade = Effect.fnUntraced(function* (
  core: Core,
  orgName: string,
  grade: OrgGrade | null,
) {
  if (!grade) {
    yield* Print.line(
      c.dim("Org grade: could not be read right now. The matrix below is unaffected."),
    );
    return yield* Print.line();
  }
  if (grade.score === null || grade.grade === null) {
    yield* Print.line(
      `${c.bold("Org grade")} ${c.dim(`· ${orgName} · nothing could be assessed yet; connect an account and let it sync`)}`,
    );
    return yield* Print.line();
  }
  const delta = core.orgScorecardTrendDelta(
    grade.trend.map((p) => ({ day: p.day, score: p.score, grade: UNREAD_GRADE, pillars: {} })),
    grade.score,
  );
  const since =
    delta !== null && delta !== 0 && grade.trend[0]
      ? `  ${(delta > 0 ? c.green : c.red)(`${delta > 0 ? "+" : ""}${delta}`)} ${c.dim(`since ${grade.trend[0].day}`)}`
      : "";
  yield* Print.line(
    `${c.bold("Org grade")}  ${c.bold(gradeColor(grade.grade)(safe(grade.grade)))} ${grade.score}${since}  ${c.dim(`· ${orgName}`)}`,
  );
  if (grade.trend.length > 1) {
    yield* Print.line(
      `  ${c.dim(
        rangedSparkline(
          grade.trend.map((p) => p.score),
          0,
          100,
          Math.min(grade.trend.length, 30),
        ),
      )} ${c.dim(`${grade.trend.length} daily readings`)}`,
    );
  }
  const drag = core.orgScorecardBiggestDrag(grade.pillars);
  if (drag) {
    yield* Print.line(
      `  ${c.dim("biggest drag:")} ${safe(pillarLabel(core, drag.id))}${drag.nextStep ? c.dim(` · ${safe(drag.nextStep)}`) : ""}`,
    );
  }
  const failed = grade.failedPillars.length;
  if (failed > 0) {
    yield* Print.line(
      c.yellow(
        `  ${failed} pillar${failed === 1 ? "" : "s"} could not be read and ${failed === 1 ? "is" : "are"} excluded, not counted against the grade`,
      ),
    );
  }
  yield* Print.line();
  yield* Print.table(
    grade.pillars,
    [
      { header: "pillar", value: (p) => safe(pillarLabel(core, p.id)) },
      { header: "weight", value: (p) => String(p.weight), align: "right" },
      {
        header: "score",
        value: (p) => (p.score === null ? c.dim("n/a") : String(p.score)),
        align: "right",
      },
      {
        header: "reading",
        value: (p) =>
          p.score === null ? c.dim(safe(p.unassessedReason ?? p.headline)) : safe(p.headline),
      },
    ],
    { indent: 2 },
  );
  yield* Print.line();
});

/** The matrix view: the org grade, then every service against every scorecard. */
const printMatrix = Effect.fnUntraced(function* (
  org: { readonly id: string; readonly displayName: string },
  overviewBody: unknown,
  overview: Overview,
  gradeBody: unknown,
) {
  const session = yield* CliSession;
  if (session.output === "json") {
    // `{ org, orgGrade, ...overview }`, each part as the server sent it.
    const rest = yield* decodeBody(
      Schema.Record(Schema.String, Schema.Unknown),
      OVERVIEW_PATH,
    )(overviewBody);
    return yield* Print.json({ org: org.id, orgGrade: gradeBody, ...rest });
  }

  const core = yield* loadCore;
  // A grade body that does not decode reads as one that could not be fetched.
  const grade =
    gradeBody === null
      ? null
      : yield* decodeBody(OrgGrade, ORG_GRADE_PATH)(gradeBody).pipe(bestEffort(() => null));
  yield* printOrgGrade(core, safe(org.displayName), grade);

  const { scorecards, services, results } = overview;
  if (scorecards.length === 0) {
    return yield* Print.line(c.dim("No scorecards. Create one from the Scorecards tab."));
  }
  if (services.length === 0) {
    return yield* Print.line(c.dim("No services to score yet. Create one from the Services tab."));
  }
  const byCell = new Map(results.map((r) => [`${r.serviceId}:${r.scorecardId}`, r]));
  const rows = [...services].sort(
    (a, b) => (a.tier ?? 9) - (b.tier ?? 9) || a.name.localeCompare(b.name),
  );

  yield* Print.line(
    `${c.bold(safe(org.displayName))} ${c.dim(`· ${services.length} service${services.length === 1 ? "" : "s"} × ${scorecards.length} scorecard${scorecards.length === 1 ? "" : "s"}`)}`,
  );
  yield* Print.line();
  const columns: Column<OverviewService>[] = [
    { header: "service", value: (s) => safe(s.name) },
    { header: "tier", value: (s) => formatServiceTier(s.tier) },
    ...scorecards.map((card): Column<OverviewService> => ({
      header: card.enabled ? safe(card.name) : `${safe(card.name)} (off)`,
      value: (s) => cell(card, byCell.get(`${s.id}:${card.id}`)),
    })),
  ];
  yield* Print.table(rows, columns);
  yield* Print.line();
  yield* Print.line(
    c.dim(
      "n/a: the scorecard does not apply to the service's tier. `infrawrench scorecards <name>` shows one scorecard's checks.",
    ),
  );
});

/**
 * Each scored service's daily points on one scorecard, at most
 * {@link HISTORY_CONCURRENCY} requests at a time. A trend is a nicety (the
 * current score is printed either way), so a history that cannot be read is
 * left out; above {@link HISTORY_FETCH_LIMIT} services none is asked for.
 */
const fetchHistories = Effect.fnUntraced(function* (
  orgId: string,
  scorecardId: string,
  serviceIds: ReadonlyArray<string>,
) {
  const api = yield* CloudApi;
  const out = new Map<string, ServiceHistory>();
  if (serviceIds.length > HISTORY_FETCH_LIMIT) return out;
  const fetched = yield* Effect.forEach(
    serviceIds,
    (id) => {
      const path = `/services/${encodeURIComponent(id)}/scorecards`;
      return api.json(orgId, path).pipe(
        Effect.flatMap((body) =>
          Effect.all([decodeBody(History, path)(body), decodeBody(HistoryEnvelope, path)(body)]),
        ),
        Effect.map(([decoded, raw]): [string, ServiceHistory] => [
          id,
          { points: decoded.history[scorecardId] ?? [], raw: raw.history[scorecardId] ?? [] },
        ]),
        bestEffort(() => null),
      );
    },
    { concurrency: HISTORY_CONCURRENCY },
  );
  for (const entry of fetched) if (entry) out.set(entry[0], entry[1]);
  return out;
});

/** A check's name; one whose type this build does not know, by its own name or the type. */
const checkName = (core: Core, check: Check): string =>
  check.type instanceof Unrecognized
    ? check.name?.trim() || check.type.raw
    : core.scorecardCheckName({ name: check.name, type: check.type });

const checkTypeName = (check: Check): string =>
  check.type instanceof Unrecognized ? check.type.raw : check.type;

/** One scorecard: its definition, then every service's result on it, best first. */
const printScorecardDetail = Effect.fnUntraced(function* (
  orgId: string,
  index: number,
  overview: Overview,
  raw: typeof OverviewEnvelope.Type,
) {
  const session = yield* CliSession;
  const card = overview.scorecards[index]!;
  const kept = overview.results.flatMap((r, i) => (r.scorecardId === card.id ? [i] : []));
  const results = kept.map((i) => overview.results[i]!);
  const servicesById = new Map(overview.services.map((s) => [s.id, s]));
  const scoredIds = results.map((r) => r.serviceId);
  const history = yield* fetchHistories(orgId, card.id, scoredIds);

  if (session.output === "json") {
    return yield* Print.json({
      org: orgId,
      scorecard: raw.scorecards[index],
      services: overview.services.flatMap((s, i) =>
        scoredIds.includes(s.id) ? [raw.services[i]] : [],
      ),
      results: kept.map((i) => raw.results[i]),
      history: Object.fromEntries([...history].map(([id, h]) => [id, h.raw])),
    });
  }

  const core = yield* loadCore;
  yield* Print.line(
    `${c.bold(safe(card.name))}${card.isDefault ? c.dim(" (default)") : ""}  ${
      card.enabled ? c.green("enabled") : c.dim("disabled")
    }`,
  );
  if (card.description) yield* Print.line(safe(card.description));
  const facts = [
    card.applicableTiers.length === 0
      ? "applies to every service"
      : `applies to ${card.applicableTiers.map((t) => `tier ${t}`).join(", ")}`,
    card.alertOnLevelDrop ? "alerts on a level drop" : "no level-drop alert",
    card.lastEvaluatedAt
      ? `evaluated ${formatChangeTime(card.lastEvaluatedAt)} UTC`
      : "not evaluated yet",
  ];
  yield* Print.line(c.dim(facts.join(" · ")));

  yield* Print.line();
  yield* Print.line(c.bold("levels"));
  const levels = core.sortScorecardLevels(card.levels);
  yield* Print.line(
    `  ${levels.map((l) => `${safe(l.name)} ${c.dim(`≥ ${l.minScore}`)}`).join(c.dim("  ·  "))}`,
  );

  yield* Print.line();
  yield* Print.line(c.bold("checks"));
  const totalWeight = card.checks.reduce((sum, ch) => sum + ch.weight, 0);
  yield* Print.table(
    card.checks,
    [
      { header: "check", value: (ch) => safe(checkName(core, ch)) },
      { header: "type", value: (ch) => c.dim(safe(checkTypeName(ch))) },
      {
        header: "weight",
        value: (ch) => `${ch.weight}${c.dim(`/${totalWeight}`)}`,
        align: "right",
      },
      {
        header: "params",
        value: (ch) => {
          const def = core.scorecardCheckTypeDef(checkTypeName(ch));
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

  yield* Print.line();
  yield* Print.line(c.bold(`services (${results.length})`));
  type Row = { result: Result; name: string; score: number | null };
  const rows = orderScoreRows<Row>(
    results.map((r) => ({
      result: r,
      name: servicesById.get(r.serviceId)?.name ?? r.serviceId,
      score: r.score,
    })),
  );
  yield* Print.table(
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
          const points = (history.get(row.result.serviceId)?.points ?? [])
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
    yield* Print.line(c.dim(`  (trends skipped above ${HISTORY_FETCH_LIMIT} services)`));
  }
  yield* Print.line();
  yield* Print.line(c.dim("`infrawrench services show <slug>` prints why each check failed."));
});

export const scorecards = Command.make(
  "scorecards",
  {
    scorecard: Argument.String("id|name").pipe(
      Argument.withDescription(
        "One scorecard, for its checks and each service's score (the words join into one name)",
      ),
      Argument.variadic(),
    ),
  },
  Effect.fn("scorecards")(function* (input) {
    yield* requireCloud;
    const api = yield* CloudApi;
    const org = yield* currentOrg;
    const arg = input.scorecard.join(" ") || undefined;
    const [overviewBody, gradeBody] = yield* Effect.all(
      [
        api.json(org.id, OVERVIEW_PATH),
        // Only the matrix view prints the grade. It computes seven feeds on the
        // server, and a failure there must not cost the matrix.
        arg === undefined
          ? api.json(org.id, ORG_GRADE_PATH).pipe(bestEffort(() => null))
          : Effect.succeed(null),
      ],
      { concurrency: "unbounded" },
    );
    const overview = yield* decodeBody(Overview, OVERVIEW_PATH)(overviewBody);

    if (arg === undefined) return yield* printMatrix(org, overviewBody, overview, gradeBody);

    const byId = matchIdPrefix(overview.scorecards, arg);
    const needle = arg.toLowerCase();
    const card =
      byId.match ??
      overview.scorecards.find((s) => s.name.toLowerCase() === needle) ??
      overview.scorecards.find((s) => s.name.toLowerCase().includes(needle));
    if (!card) {
      return yield* new CliFailure({
        message: `No scorecard matches "${arg}". Run \`infrawrench scorecards\` to list.`,
      });
    }
    const raw = yield* decodeBody(OverviewEnvelope, OVERVIEW_PATH)(overviewBody);
    yield* printScorecardDetail(org.id, overview.scorecards.indexOf(card), overview, raw);
  }),
).pipe(
  Command.withDescription(
    "The org grade above every service × scorecard (give an id/name for its checks and each service's 90-day trend)",
  ),
);
