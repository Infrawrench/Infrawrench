/**
 * Tag policy: `/api/org/:orgId/tag-policy`, the endpoint definitions.
 *
 * The org's required tags, readable by anyone who can see resources (the
 * create form pre-fills them, and the compliance report is meaningless
 * without them) and writable on `org:settings:write`. The policy body is the
 * shared schema the settings form validates with (`@infrawrench/api-contract/schemas`).
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { TagPolicy } from "../schemas";
import { InvalidRequestMessage, RequiredPermission, SuccessDescription } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { BadRequest } from "../http/errors";
import { OrgAuth } from "../http/middleware-tags";
import { OrgParams } from "../http/schemas/common";

export const AccountTagCompliance = Schema.Struct({
  accountId: Schema.String,
  pluginId: Schema.String,
  displayName: Schema.String,
  totalResources: Schema.Int,
  evaluated: Schema.Int.annotate({
    description: "Resources whose stored record exposes a tag map (the scoreable set).",
  }),
  compliant: Schema.Int,
  score: Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 }))).annotate({
    description: "Percent of evaluated resources carrying every required tag; null when none.",
  }),
}).annotate({ identifier: "AccountTagCompliance" });

export const TagComplianceReport = Schema.Struct({
  policy: TagPolicy,
  accounts: Schema.Array(AccountTagCompliance),
}).annotate({ identifier: "TagComplianceReport" });

export class TagPolicyGroup extends HttpApiGroup.make("tagPolicy")
  .add(
    HttpApiEndpoint.get("get", "/", {
      params: OrgParams,
      success: TagPolicy,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "The org's required-tag policy")
      .annotate(SuccessDescription, "Tag policy"),
    HttpApiEndpoint.put("set", "/", {
      params: OrgParams,
      payload: TagPolicy,
      success: TagPolicy,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Replace the org's tag policy")
      .annotate(
        OpenApi.Description,
        "Sets the required tag keys (each optionally restricted to allowed values) and whether " +
          "resource creation is blocked when they are missing. Keys are matched case-insensitively " +
          "against the generic `tags`/`labels` field convention.",
      )
      .annotate(SuccessDescription, "Saved")
      .annotate(InvalidRequestMessage, "Invalid tag policy"),
    HttpApiEndpoint.get("compliance", "/compliance", {
      params: OrgParams,
      success: TagComplianceReport,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "Per-account tag compliance scores")
      .annotate(
        OpenApi.Description,
        "For each account: how many of its resources expose tags and how many of those carry " +
          "every required tag with an allowed value. `score` is over the evaluated (tag-capable) " +
          "set so untaggable resource types don't drag it.",
      )
      .annotate(SuccessDescription, "Compliance report"),
  )
  .prefix("/api/org/:orgId/tag-policy")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Tag Policy") {}

export class TagPolicyApi extends withApiDefaults(HttpApi.make("tag-policy").add(TagPolicyGroup)) {}
