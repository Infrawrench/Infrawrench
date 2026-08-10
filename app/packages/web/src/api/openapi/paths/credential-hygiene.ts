import { z } from "../zod";
import { strict, ErrorResponses, OrgIdParam, IsoDateTime } from "../common";
import type { BuildContext } from "../context";

export function registerCredentialHygienePaths(ctx: BuildContext) {
  const { registry } = ctx;

  const HygieneFinding = strict({
    id: z.string().describe("Stable across runs, so a client can remember what has been reviewed."),
    kind: z.enum([
      "api_key_never_used",
      "api_key_idle",
      "api_key_expired_not_revoked",
      "api_key_wildcard_scope",
      "api_key_unused_scopes",
      "ssh_key_never_used",
      "ssh_key_idle",
      "member_unused_permissions",
    ]),
    severity: z.enum(["high", "medium", "low"]),
    title: z.string(),
    detail: z.string().describe("The evidence behind the finding."),
    recommendation: z.string(),
    entityType: z.enum(["api-key", "ssh-key", "member"]),
    entityId: z.string(),
    entityName: z.string(),
    facts: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
      .describe("Structured detail for table columns and reports."),
  }).openapi("HygieneFinding");

  const HygieneReport = strict({
    generatedAt: IsoDateTime,
    windowDays: z.number().int(),
    auditHistoryDays: z
      .number()
      .int()
      .nullable()
      .describe("How much audit history the organization actually has; null when it has none."),
    permissionFindingsWithheld: z
      .boolean()
      .describe(
        "True when there was not enough audit history for the unused-permission finding to mean " +
          "anything, so it was withheld rather than guessed at.",
      ),
    findings: z.array(HygieneFinding),
    counts: strict({
      high: z.number().int(),
      medium: z.number().int(),
      low: z.number().int(),
      total: z.number().int(),
    }),
  }).openapi("HygieneReport");

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/credential-hygiene",
    tags: ["Credential hygiene"],
    summary: "Credential hygiene report",
    description:
      "API keys nobody uses, SSH keys nothing references, and members holding write permissions " +
      "they have never exercised — derived entirely from data the server already holds. No " +
      "provider call and nothing to enable.\n\n" +
      "**The audit log only witnesses writes.** Reading a resource list or a cost graph leaves " +
      "no audit row by design, so this report draws no conclusion about read permissions: an " +
      "absence of evidence about them proves nothing. `permissionFindingsWithheld` is set when " +
      "the organization does not yet have enough audit history for the unused-permission " +
      "finding to be meaningful. Both are load-bearing — a governance report that overclaims is " +
      "worse than none.\n\n" +
      "Gated on `audit:read` rather than a permission of its own: every fact here is already " +
      "reachable by anyone who can read the audit log, so this is a lens rather than a new " +
      "disclosure.",
    request: {
      params: OrgIdParam,
      query: strict({
        windowDays: z.coerce
          .number()
          .int()
          .min(7)
          .max(365)
          .optional()
          .describe("Activity window. Defaults to 90."),
      }),
    },
    responses: {
      200: {
        description: "The report",
        content: { "application/json": { schema: HygieneReport } },
      },
      400: ErrorResponses[400],
    },
  });
}
