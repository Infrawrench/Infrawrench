/**
 * Audit log: `/api/org/:orgId/audit-logs`, the endpoint definitions.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { RequiredPermission, SuccessDescription } from "../../annotations";
import { withApiDefaults } from "../../domain";
import { OrgAuth } from "../../middleware-tags";
import { Email, IsoDateTime, JsonObject, OrgParams, Uuid } from "../../schemas/common";
import { documentedAs } from "../../schemas/documented";

const AuditEntry = Schema.Struct({
  id: Uuid,
  userId: Schema.NullOr(Uuid),
  apiKeyId: Schema.NullOr(Uuid),
  action: Schema.String,
  entityType: Schema.String,
  entityId: Schema.String,
  metadata: Schema.NullOr(JsonObject),
  ipAddress: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  userName: Schema.NullOr(Schema.String),
  userEmail: Schema.NullOr(Email),
  /**
   * The key's name and display prefix, resolved at read time. Null for entries
   * a person made in the browser, and for a key row that has since been
   * deleted: `apiKeyId` outlives both.
   */
  apiKeyName: Schema.NullOr(Schema.String),
  apiKeyPrefix: Schema.NullOr(Schema.String),
}).annotate({ identifier: "AuditEntry" });

export const AuditResponse = Schema.Struct({
  entries: Schema.Array(AuditEntry),
  total: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
}).annotate({ identifier: "AuditResponse" });

/**
 * The filters are read raw, as they always were: the handler parses `page`
 * and `pageSize` with `parseInt` and passes the rest to the query unchecked.
 */
const raw = <S extends Schema.Top>(doc: S) => Schema.optionalKey(documentedAs(doc));

export class AuditGroup extends HttpApiGroup.make("audit")
  .add(
    HttpApiEndpoint.get("list", "/", {
      params: OrgParams,
      query: {
        page: raw(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
        pageSize: raw(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
        action: raw(Schema.String),
        entityType: raw(Schema.String),
        userId: raw(Uuid),
        // Narrower than `userId`: a person and every key they minted share one
        // user id, so filtering by owner cannot isolate a single credential.
        apiKeyId: raw(Uuid),
        from: raw(IsoDateTime),
        to: raw(IsoDateTime),
      },
      success: AuditResponse,
    })
      .annotate(RequiredPermission, "audit:read")
      .annotate(OpenApi.Summary, "List audit log entries (paginated, filterable)")
      .annotate(SuccessDescription, "Audit entries"),
  )
  .prefix("/api/org/:orgId/audit-logs")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Audit") {}

export class AuditApi extends withApiDefaults(HttpApi.make("audit").add(AuditGroup)) {}
