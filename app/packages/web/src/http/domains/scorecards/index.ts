/**
 * Scorecards: `/api/org/:orgId/scorecards`, the handlers. Scoring itself runs
 * hourly in the poller (`server-core/src/scorecards/`).
 *
 * The first read seeds the default scorecard for orgs created before
 * scorecards existed (once; a deleted default stays deleted). The org grade
 * (`/org`, `/org/history`) never seeds it: a read of the grade must not
 * create configuration.
 */
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import {
  ORG_SCORECARD_RETENTION_DAYS,
  isServiceTier,
  scorecardCheckTypeDef,
  type ScorecardCheck,
  type ScorecardInput,
  type ScorecardLevel,
} from "@infrawrench/client-core";
import {
  ScorecardInputError,
  createScorecardRecord,
  deleteScorecardRecord,
  ensureDefaultScorecard,
  getScorecardRecord,
  listScorecardRecords,
  listScorecardResults,
  scorecardToWire,
  updateScorecardRecord,
} from "@infrawrench/server-core/scorecards/store";
import { evaluateOrgScorecards } from "@infrawrench/server-core/scorecards/eval";
import {
  getOrgScorecard,
  listOrgScorecardTrend,
} from "@infrawrench/server-core/scorecards/org-snapshots";
import { listServiceRecords } from "@infrawrench/server-core/service-catalog/store";
import {
  badRequest,
  notFound,
  OrgScorecard,
  OrgScorecardHistory,
  Scorecard,
  ScorecardList,
  ScorecardOverview,
  ScorecardsApi,
} from "@infrawrench/api-contract";
import { logAudit } from "../../../services/audit";
import { makeDomain } from "../../domain";
import { fireAndForget, legacy } from "../../legacy";
import { readObjectBody } from "../../request-body";
import { refusalCall, inputRefusals, refusalsOf } from "../../refusals";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";

type Body = { readonly [key: string]: unknown };

const scorecardStore = refusalsOf(ScorecardInputError, {
  logPrefix: "[scorecards]",
  failure: "Scorecard operation failed",
});

const isRecord = (v: unknown): v is Body => typeof v === "object" && v !== null;

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

/**
 * One check off the body, with the defaults the route always filled in (an
 * empty id, weight 1, no params). A type the registry does not know, or a
 * declared parameter that is neither a number nor a list of strings, is
 * refused with the sentence `validateScorecardInput` uses for it; the store
 * runs that validator over everything else.
 */
function pickCheck(c: Body): ScorecardCheck | string {
  const type = c["type"];
  const def = typeof type === "string" ? scorecardCheckTypeDef(type) : undefined;
  if (!def) return `Unknown check type "${String(type)}".`;
  const rawParams = c["params"];
  const params: Record<string, number | string[]> = {};
  if (isRecord(rawParams) && !Array.isArray(rawParams)) {
    for (const [key, value] of Object.entries(rawParams)) {
      if (typeof value === "number" || isStringArray(value)) {
        params[key] = value;
        continue;
      }
      // A key the type does not declare was never read; one it does is refused.
      const param = def.params.find((p) => p.key === key);
      if (!param) continue;
      return param.kind === "number"
        ? `${def.label}: ${param.label} must be a number.`
        : `${def.label}: ${param.label} must be a list.`;
    }
  }
  return {
    id: typeof c["id"] === "string" ? c["id"] : "",
    type: def.type,
    name: typeof c["name"] === "string" ? c["name"] : null,
    weight: typeof c["weight"] === "number" ? c["weight"] : 1,
    params,
  };
}

function pickLevel(l: Body): ScorecardLevel {
  return {
    key: typeof l["key"] === "string" ? l["key"] : "",
    name: typeof l["name"] === "string" ? l["name"] : "",
    minScore: typeof l["minScore"] === "number" ? l["minScore"] : Number.NaN,
    color: typeof l["color"] === "string" ? l["color"] : null,
  };
}

/** Pick the known fields off a request body; a malformed list is the sentence to refuse it with. */
function pickScorecardBody(body: Body): Partial<ScorecardInput> | string {
  const out: Partial<ScorecardInput> = {};
  const name = body["name"];
  if (typeof name === "string") out.name = name;
  const description = body["description"];
  if (description === null || typeof description === "string") out.description = description;
  const checks = body["checks"];
  if (checks !== undefined) {
    if (!Array.isArray(checks) || !checks.every(isRecord)) {
      return "checks must be an array of check objects";
    }
    const picked: ScorecardCheck[] = [];
    for (const raw of checks) {
      const check = pickCheck(raw);
      if (typeof check === "string") return check;
      picked.push(check);
    }
    out.checks = picked;
  }
  const levels = body["levels"];
  if (levels !== undefined) {
    if (!Array.isArray(levels) || !levels.every(isRecord)) {
      return "levels must be an array of level objects";
    }
    out.levels = levels.map(pickLevel);
  }
  const tiers = body["applicableTiers"];
  if (tiers !== undefined) {
    if (!Array.isArray(tiers) || !tiers.every(isServiceTier)) {
      return "applicableTiers must be an array of 1, 2, 3 or 4";
    }
    out.applicableTiers = tiers;
  }
  const alertOnLevelDrop = body["alertOnLevelDrop"];
  if (typeof alertOnLevelDrop === "boolean") out.alertOnLevelDrop = alertOnLevelDrop;
  const enabled = body["enabled"];
  if (typeof enabled === "boolean") out.enabled = enabled;
  return out;
}

/** The matrix: every service, every scorecard, the current result in each cell. */
async function overview(organizationId: string) {
  const [cards, rows, results] = await Promise.all([
    listScorecardRecords(organizationId),
    listServiceRecords(organizationId),
    listScorecardResults(organizationId),
  ]);
  return {
    scorecards: cards.map(scorecardToWire),
    services: rows.map((r) => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      tier: isServiceTier(r.tier) ? r.tier : null,
      ownerTeam: r.ownerTeam,
    })),
    results,
  };
}

const ScorecardsHandlers = HttpApiBuilder.group(ScorecardsApi, "scorecards", (handlers) =>
  handlers
    .handle("list", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const rows = yield* legacy(async () => {
          await ensureDefaultScorecard(organizationId);
          return listScorecardRecords(organizationId);
        });
        return yield* respond(ScorecardList)({ scorecards: rows.map(scorecardToWire) });
      }),
    )
    .handle("overview", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const matrix = yield* legacy(async () => {
          await ensureDefaultScorecard(organizationId);
          return overview(organizationId);
        });
        return yield* respond(ScorecardOverview)(matrix);
      }),
    )
    /**
     * The org grade: seven pillars, the weighted overall and the stored
     * history. Listed as a gateway route: the posture and backup pillars bind
     * plugin functions the edge Worker only stubs.
     */
    .handle("org", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const grade = yield* legacy(() => getOrgScorecard(organizationId));
        return yield* respond(OrgScorecard)(grade);
      }),
    )
    /**
     * The org grade's history alone, the cheap half: a tile that wants only
     * the sparkline should not pay for seven feed computations. Postgres
     * only, so it stays on the edge.
     */
    .handle("orgHistory", ({ query }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const days = query.days === undefined ? undefined : Number(query.days);
        if (
          days !== undefined &&
          (!Number.isInteger(days) || days < 1 || days > ORG_SCORECARD_RETENTION_DAYS)
        ) {
          return yield* badRequest(
            `days must be a whole number between 1 and ${ORG_SCORECARD_RETENTION_DAYS}`,
          );
        }
        const trend = yield* legacy(() =>
          listOrgScorecardTrend(organizationId, days === undefined ? {} : { days }),
        );
        return yield* respond(OrgScorecardHistory)({ trend });
      }),
    )
    .handle("get", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const row = yield* legacy(() => getScorecardRecord(organizationId, params.scorecardId));
        if (!row) return yield* notFound("Scorecard not found");
        return yield* respond(Scorecard)(scorecardToWire(row));
      }),
    )
    .handleRaw("create", ({ request }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const read = yield* readObjectBody(request);
        if (!read.ok) return yield* badRequest(read.error);
        const input = pickScorecardBody(read.body);
        if (typeof input === "string") return yield* badRequest(input);
        const created = yield* refusalCall(scorecardStore, inputRefusals, () =>
          createScorecardRecord(organizationId, input, session.userId),
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "scorecard.create",
            entityType: "scorecard",
            entityId: created.id,
            metadata: { name: created.name, checks: created.checks.length },
          }),
        );
        return yield* respond(Scorecard, { status: 201 })(scorecardToWire(created));
      }),
    )
    .handleRaw("update", ({ params, request }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const read = yield* readObjectBody(request);
        if (!read.ok) return yield* badRequest(read.error);
        const patch = pickScorecardBody(read.body);
        if (typeof patch === "string") return yield* badRequest(patch);
        if (Object.keys(patch).length === 0) return yield* badRequest("No changes supplied");
        const updated = yield* refusalCall(scorecardStore, inputRefusals, () =>
          updateScorecardRecord(organizationId, params.scorecardId, patch),
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "scorecard.update",
            entityType: "scorecard",
            entityId: updated.id,
            metadata: { name: updated.name, fields: Object.keys(patch) },
          }),
        );
        return yield* respond(Scorecard)(scorecardToWire(updated));
      }),
    )
    .handle("delete", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const deleted = yield* refusalCall(scorecardStore, inputRefusals, () =>
          deleteScorecardRecord(organizationId, params.scorecardId),
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "scorecard.delete",
            entityType: "scorecard",
            entityId: deleted.id,
            metadata: { name: deleted.name },
          }),
        );
      }),
    )
    /**
     * Score every service on this scorecard now, so the editor shows the
     * effect of a change without waiting for the hourly pass. Drops found
     * here are stored but not announced: the person who just edited the
     * checks caused them, and paging the org about it would be noise.
     */
    .handle("evaluate", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const row = yield* legacy(() => getScorecardRecord(organizationId, params.scorecardId));
        if (!row) return yield* notFound("Scorecard not found");
        const matrix = yield* refusalCall(scorecardStore, inputRefusals, async () => {
          await evaluateOrgScorecards(organizationId, { scorecardIds: [row.id], announce: false });
          return overview(organizationId);
        });
        return yield* respond(ScorecardOverview)(matrix);
      }),
    ),
);

export const scorecardsDomain = makeDomain("scorecards", ScorecardsApi, ScorecardsHandlers);
