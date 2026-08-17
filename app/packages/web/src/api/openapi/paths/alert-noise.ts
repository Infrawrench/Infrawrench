import { z } from "../zod";
import { strict, ErrorResponses, OrgIdParam, IsoDateTime } from "../common";
import type { BuildContext } from "../context";

export function registerAlertNoisePaths(ctx: BuildContext) {
  const { registry } = ctx;

  const NoiseGroup = strict({
    key: z.string(),
    label: z.string(),
    kind: z.enum(["rule", "trigger"]),
    count: z.number().int(),
    actionable: z
      .number()
      .int()
      .describe(
        "Deliveries that asked for an acknowledgement. Only those can be ignored — a rule with " +
          "no escalation armed shows no button, and counting it as ignored would indict an " +
          "organization for the product's own design.",
      ),
    acknowledged: z.number().int(),
    acknowledgedRate: z
      .number()
      .nullable()
      .describe(
        "Share of *actionable* deliveries acknowledged, 0–1. Null when none asked for a " +
          "response — not the same as 0%, and rendering it as 0% would be this report's own " +
          "version of the lie it exists to catch.",
      ),
    medianAckMinutes: z.number().nullable(),
    firstAt: IsoDateTime,
    lastAt: IsoDateTime,
    severities: z.record(z.string(), z.number().int()),
  }).openapi("AlertNoiseGroup");

  const NoisyFinding = strict({
    key: z.string(),
    label: z.string(),
    reason: z.enum(["never-acknowledged", "mostly-ignored", "very-frequent"]),
    count: z.number().int(),
    acknowledgedRate: z.number().nullable(),
    suggestion: z
      .string()
      .describe(
        "One sentence a person can act on. **Never an action taken automatically** — a system " +
          "that silences its own alerts on a heuristic is one nobody can trust.",
      ),
  }).openapi("AlertNoisyFinding");

  const NoiseReport = strict({
    from: IsoDateTime,
    to: IsoDateTime,
    totalDeliveries: z.number().int(),
    actionableDeliveries: z.number().int(),
    acknowledgedDeliveries: z.number().int(),
    byRule: z
      .array(NoiseGroup)
      .describe("Loudest first. Deliveries that matched no rule are one group."),
    byTrigger: z.array(NoiseGroup),
    noisy: z
      .array(NoisyFinding)
      .describe("Flagged groups, worst first. Always a subset of byRule."),
    generatedAt: IsoDateTime,
  }).openapi("AlertNoiseReport");

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/alert-rules/noise",
    tags: ["Alert routing"],
    summary: "Which alerts nobody acts on",
    description:
      "Routing decides where an alert goes. This asks the question that decides whether the whole " +
      "system works: **are these being read?** An organization with one rule that fires 400 times " +
      "a month and has never been acknowledged does not have a monitoring system — it has a " +
      "filter people have learned to ignore, and the alert that mattered went into the same " +
      "channel.\n\n" +
      "Only an explicit acknowledgement counts as engagement; `sent` means the message left the " +
      "building. A group below 10 deliveries is never flagged, because three unacknowledged " +
      "alerts is not evidence and a report that cried noise at every new rule would be the " +
      "second thing people learn to ignore.\n\n" +
      "Read-only by construction: it says a rule is noisy and never disables one.",
    request: {
      params: OrgIdParam,
      query: z.object({
        windowDays: z.coerce.number().int().min(1).max(180).optional().describe("Defaults to 30."),
      }),
    },
    responses: {
      200: {
        description: "The report",
        content: { "application/json": { schema: NoiseReport } },
      },
      400: ErrorResponses[400],
    },
  });
}
