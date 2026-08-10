import { z } from "../zod";
import { strict, OrgIdParam, Uuid, IsoDateTime, JsonObject, Email } from "../common";
import type { BuildContext } from "../context";

const AuditEntry = strict({
  id: Uuid,
  userId: Uuid.nullable(),
  apiKeyId: Uuid.nullable(),
  action: z.string(),
  entityType: z.string(),
  entityId: z.string(),
  metadata: JsonObject.nullable(),
  ipAddress: z.string().nullable(),
  createdAt: IsoDateTime,
  userName: z.string().nullable(),
  userEmail: Email.nullable(),
  /**
   * The key's name and display prefix, resolved at read time. Null for entries
   * a person made in the browser, and for a key row that has since been
   * deleted — `apiKeyId` outlives both.
   */
  apiKeyName: z.string().nullable(),
  apiKeyPrefix: z.string().nullable(),
}).openapi("AuditEntry");

const AuditResponse = strict({
  entries: z.array(AuditEntry),
  total: z.number().int().nonnegative(),
}).openapi("AuditResponse");

export function registerAuditPaths(ctx: BuildContext) {
  ctx.registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/audit-logs",
    tags: ["Audit"],
    summary: "List audit log entries (paginated, filterable)",
    request: {
      params: OrgIdParam,
      query: strict({
        page: z.coerce
          .number()
          .int()
          .min(1)
          .optional()
          .openapi({ param: { name: "page", in: "query" } }),
        pageSize: z.coerce
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .openapi({
            param: { name: "pageSize", in: "query" },
          }),
        action: z
          .string()
          .optional()
          .openapi({ param: { name: "action", in: "query" } }),
        entityType: z
          .string()
          .optional()
          .openapi({ param: { name: "entityType", in: "query" } }),
        userId: Uuid.optional().openapi({ param: { name: "userId", in: "query" } }),
        // Narrower than `userId`: a person and every key they minted share one
        // user id, so filtering by owner cannot isolate a single credential.
        apiKeyId: Uuid.optional().openapi({ param: { name: "apiKeyId", in: "query" } }),
        from: IsoDateTime.optional().openapi({ param: { name: "from", in: "query" } }),
        to: IsoDateTime.optional().openapi({ param: { name: "to", in: "query" } }),
      }),
    },
    responses: {
      200: {
        description: "Audit entries",
        content: { "application/json": { schema: AuditResponse } },
      },
    },
  });
}
