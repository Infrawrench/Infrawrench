/**
 * `/api/org/:orgId/features`: which rolled-out features (`ORG_FEATURES`) a
 * platform admin has turned on for the organization, so the apps can show
 * their entry points. Any member may read it.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { ORG_FEATURES } from "@infrawrench/client-core";
import { SuccessDescription } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { OrgAuth } from "../http/middleware-tags";
import { OrgParams } from "../http/schemas/common";

export const OrgFeatureName = Schema.Literals(ORG_FEATURES).annotate({
  identifier: "OrgFeatureName",
});

export const OrgFeatureList = Schema.Struct({
  features: Schema.Array(OrgFeatureName),
}).annotate({ identifier: "OrgFeatureList" });

export class OrgFeaturesGroup extends HttpApiGroup.make("orgFeatures")
  .add(
    HttpApiEndpoint.get("list", "/", {
      params: OrgParams,
      success: OrgFeatureList,
    })
      .annotate(OpenApi.Summary, "List the organization's rolled-out features")
      .annotate(
        OpenApi.Description,
        "Features still being rolled out are turned on per organization by a platform admin. A feature not listed here is refused by its own routes.",
      )
      .annotate(SuccessDescription, "The organization's features"),
  )
  .prefix("/api/org/:orgId/features")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Organization") {}

export class OrgFeaturesApi extends withApiDefaults(
  HttpApi.make("orgFeatures").add(OrgFeaturesGroup),
) {}
