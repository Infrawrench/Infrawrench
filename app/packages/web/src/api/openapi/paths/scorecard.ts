import { z } from "../zod";
import { strict, ErrorResponses, OrgIdParam, IsoDateTime } from "../common";
import type { BuildContext } from "../context";

const ScorecardPillarId = z
  .enum(["security", "recoverability", "deadlines", "headroom", "access", "ownership"])
  .openapi({
    description:
      "Which radar the pillar reads. Each is a view of a feed that already exists, never a " +
      "re-derivation — so a scorecard number can never disagree with the page it links to.",
  });

const ScorecardGrade = z.enum(["A", "B", "C", "D", "F"]);

export function registerScorecardPaths(ctx: BuildContext) {
  const { registry } = ctx;

  const ScorecardFact = strict({
    label: z.string(),
    value: z.string(),
    bad: z.boolean().optional().describe("True when this is the number that hurts."),
  }).openapi("ScorecardFact");

  const ScorecardPillar = strict({
    id: ScorecardPillarId,
    score: z
      .number()
      .int()
      .min(0)
      .max(100)
      .nullable()
      .describe(
        "Null when the pillar could not be assessed — **never zero**. An organization with no " +
          "quota-reporting provider has no headroom score, not a headroom score of nought, and " +
          "an unassessed pillar is excluded from the overall rather than counted as failure.",
      ),
    weight: z
      .number()
      .int()
      .describe(
        "Relative weight in the overall. Fixed in this version: security 30, recoverability 25, " +
          "deadlines 15, access 15, headroom 10, ownership 5. Weights renormalize over the " +
          "pillars that were assessed, so connecting a new provider cannot make yesterday's " +
          "score look like a regression.",
      ),
    headline: z.string().describe("What the score measures over, in one line."),
    unassessedReason: z
      .string()
      .nullable()
      .describe("Why there is no score, phrased so a reader can act on it. Null when scored."),
    nextStep: z
      .string()
      .nullable()
      .describe("The single most valuable thing to fix. Null when clean or unassessed."),
    facts: z.array(ScorecardFact),
  }).openapi("ScorecardPillar");

  const ScorecardTrendPoint = strict({
    day: z.string().openapi({ example: "2026-08-17" }).describe("UTC calendar day."),
    score: z.number().int().min(0).max(100),
    grade: ScorecardGrade,
    pillars: z
      .record(z.string(), z.number().int())
      .describe(
        "Per-pillar scores that day. A pillar unassessed then is **absent**, not zero — a " +
          "history that cannot tell 'we scored badly' from 'we could not look' would put back " +
          "into the trend line the lie the live computation refuses to tell.",
      ),
  }).openapi("ScorecardTrendPoint");

  const ScorecardResponse = strict({
    score: z
      .number()
      .int()
      .min(0)
      .max(100)
      .nullable()
      .describe(
        "Weighted mean over the assessed pillars, or null when none could be assessed — a brand " +
          "new organization has no infrastructure to grade, and an F on its first day would be " +
          "a lie told to someone who has done nothing wrong.",
      ),
    grade: ScorecardGrade.nullable(),
    pillars: z.array(ScorecardPillar),
    failedPillars: z
      .array(ScorecardPillarId)
      .describe(
        "Pillars whose computation threw, as opposed to having no data. Excluded from the " +
          "overall exactly as unassessed ones are, but named separately: one is a fact about " +
          "the organization and the other is a fact about us.",
      ),
    trend: z.array(ScorecardTrendPoint).describe("Stored daily readings, oldest first."),
    generatedAt: IsoDateTime,
  }).openapi("ScorecardResponse");

  const ScorecardTrendResponse = strict({
    trend: z.array(ScorecardTrendPoint),
  }).openapi("ScorecardTrendResponse");

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/scorecard",
    tags: ["Scorecard"],
    summary: "Grade the organization's infrastructure",
    description:
      "One weighted reading over six radars the product already computes: security posture, " +
      "backup coverage, declared deadlines, quota headroom, the cross-cloud access review, and " +
      "resource ownership. Nothing is re-derived — each pillar reads the same feed its page " +
      "does, so the two can never disagree.\n\n" +
      "Two rules keep the number honest. An unassessed pillar is **excluded**, never scored " +
      "zero. And weights renormalize over what was assessed, so gaining a measurable pillar " +
      "cannot read as a regression.\n\n" +
      "The trend comes from daily snapshots taken by the poller; it is empty until the first " +
      "one is recorded, and days when nothing could be scored are absent rather than zero.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "The scorecard, its pillars and its history",
        content: { "application/json": { schema: ScorecardResponse } },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/scorecard/trend",
    tags: ["Scorecard"],
    summary: "List stored scorecard readings",
    description:
      "History alone — the cheap half. A dashboard tile that wants only the sparkline should " +
      "not pay for six feed computations.",
    request: {
      params: OrgIdParam,
      query: z.object({
        days: z.coerce
          .number()
          .int()
          .min(1)
          .max(400)
          .optional()
          .describe("How far back to read. Defaults to 90; readings are kept for 400 days."),
      }),
    },
    responses: {
      200: {
        description: "Stored readings, oldest first",
        content: { "application/json": { schema: ScorecardTrendResponse } },
      },
      400: ErrorResponses[400],
    },
  });
}
