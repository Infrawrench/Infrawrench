/**
 * Per-object sharing: `/api/org/:orgId/sharing/:objectType/:objectId`, the
 * endpoint definitions.
 *
 * The permission depends on the object type in the path (`costs:*` for
 * reports and folders, `dashboards:*` for dashboards, ...), so the handler
 * owns the check: an unknown type is a 400 before any permission is looked
 * at, as it always was. The path's `objectType` is therefore read as sent and
 * documented as the enum.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import {
  OBJECT_ACCESS_LEVELS,
  ORG_ACCESS_LEVELS,
  SHAREABLE_OBJECT_TYPES,
  SHARING_GRANT_PRINCIPAL_KINDS,
} from "@infrawrench/client-core";
import { maxLength, minLength } from "../schemas";
import { SuccessDescription } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { BadRequest, Forbidden, NotFound } from "../http/errors";
import { OrgAuth } from "../http/middleware-tags";
import { Ok, OrgId } from "../http/schemas/common";
import { documentedAs, optionalRequestBody } from "../http/schemas/documented";

export const ShareableObjectType = Schema.Literals(SHAREABLE_OBJECT_TYPES).annotate({
  identifier: "ShareableObjectType",
});

const ObjectAccessLevel = Schema.Literals(OBJECT_ACCESS_LEVELS).annotate({
  identifier: "ObjectAccessLevel",
});

const OrgAccessLevel = Schema.Literals(ORG_ACCESS_LEVELS).annotate({
  identifier: "OrgAccessLevel",
  description:
    "What everyone in the organization can do with the object. `editor` is the default for an object nobody has shared.",
});

const EffectiveLevel = Schema.Literals(["owner", "editor", "viewer", "none"]);

const GrantPrincipalKind = Schema.Literals(SHARING_GRANT_PRINCIPAL_KINDS);

const ObjectAccessGrant = Schema.Struct({
  principalKind: GrantPrincipalKind,
  principalId: Schema.String,
  principalLabel: Schema.NullOr(Schema.String),
  level: ObjectAccessLevel,
  implicit: Schema.Boolean.annotate({
    description: "The report creator's ownership, implied rather than stored. Never send it back.",
  }),
}).annotate({ identifier: "ObjectAccessGrant" });

export const ObjectSharing = Schema.Struct({
  objectType: ShareableObjectType,
  objectId: Schema.String,
  orgAccess: OrgAccessLevel,
  grants: Schema.Array(ObjectAccessGrant),
  callerLevel: EffectiveLevel.annotate({ description: "What the caller can do with this object." }),
  inheritedFrom: Schema.NullOr(
    Schema.Struct({
      folderId: Schema.String,
      folderName: Schema.String,
      level: EffectiveLevel,
    }),
  ).annotate({
    description: "Access the containing folder's explicit sharing already gives the caller.",
  }),
}).annotate({ identifier: "ObjectSharing" });

/** Documented; the handler checks it field by field with its own sentences. */
export const ObjectSharingInput = Schema.Struct({
  orgAccess: OrgAccessLevel,
  grants: Schema.Array(
    Schema.Struct({
      principalKind: GrantPrincipalKind,
      principalId: Schema.String.check(minLength(1)),
      level: ObjectAccessLevel,
    }),
  ).check(maxLength(100)),
}).annotate({ identifier: "ObjectSharingInput" });

const SharingParams = {
  orgId: OrgId,
  objectType: documentedAs(ShareableObjectType),
  objectId: Schema.String,
};

export class SharingGroup extends HttpApiGroup.make("sharing")
  .add(
    HttpApiEndpoint.get("get", "/:objectType/:objectId", {
      params: SharingParams,
      success: ObjectSharing,
      error: [BadRequest, Forbidden, NotFound],
    })
      .annotate(OpenApi.Summary, "Get an object's sharing")
      .annotate(
        OpenApi.Description,
        "Who can open or edit a cost report, report folder or dashboard. Needs viewer on the object and the family's read permission (`costs:read` / `dashboards:read`).",
      )
      .annotate(SuccessDescription, "Sharing"),
    HttpApiEndpoint.put("replace", "/:objectType/:objectId", {
      params: SharingParams,
      payload: ObjectSharingInput,
      success: ObjectSharing,
      error: [BadRequest, Forbidden, NotFound],
    })
      .annotate(OpenApi.Summary, "Replace an object's sharing")
      .annotate(
        OpenApi.Description,
        "Replaces the org-wide default and every grant. Owner on the object plus the family's write permission. At least one owner must remain.",
      )
      .annotate(SuccessDescription, "Sharing")
      .annotate(OpenApi.Transform, optionalRequestBody),
    HttpApiEndpoint.delete("reset", "/:objectType/:objectId", {
      params: SharingParams,
      success: Ok,
      error: [BadRequest, Forbidden, NotFound],
    })
      .annotate(OpenApi.Summary, "Reset an object's sharing to the default")
      .annotate(
        OpenApi.Description,
        "Removes every grant and the org-wide setting, so everyone in the organization can edit again. Owner only. A report's creator remains its owner.",
      )
      .annotate(SuccessDescription, "Reset"),
  )
  .prefix("/api/org/:orgId/sharing")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Costs") {}

export class SharingApi extends withApiDefaults(HttpApi.make("sharing").add(SharingGroup)) {}
