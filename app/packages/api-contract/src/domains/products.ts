/**
 * `/api/org/:orgId/products`: the organization's app policy, the endpoint
 * definitions. An organization can turn any app ("product") except
 * Infrastructure off; a turned-off app leaves Home, the sidebar and the
 * Tools launcher, and its tools are refused for the chat agent and the MCP
 * server. Any member may read it, since every client needs it to draw its
 * navigation; changing it is `org:settings:write`.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { PRODUCT_IDS } from "@infrawrench/client-core";
import { RequiredPermission, SuccessDescription } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { BadRequest } from "../http/errors";
import { OrgAuth } from "../http/middleware-tags";
import { OrgParams } from "../http/schemas/common";

export const OrgProductId = Schema.Literals(PRODUCT_IDS).annotate({
  identifier: "OrgProductId",
  description: "An app the application is presented as.",
});

export const OrgProductPolicy = Schema.Struct({
  disabled: Schema.Array(OrgProductId).annotate({
    description: "The apps the organization has turned off. Empty when every app is on.",
  }),
}).annotate({ identifier: "OrgProductPolicy" });

/** Read as plain strings: the handler refuses an unknown or always-on app in words. */
export const OrgProductPolicyUpdate = Schema.Struct({
  disabled: Schema.Array(Schema.String).annotate({
    description:
      "The apps to turn off, replacing the stored list. `infrastructure` cannot be turned off.",
    examples: [["costs", "automation"]],
  }),
}).annotate({ identifier: "OrgProductPolicyUpdate" });

export class ProductsGroup extends HttpApiGroup.make("products")
  .add(
    HttpApiEndpoint.get("get", "/", {
      params: OrgParams,
      success: OrgProductPolicy,
    })
      .annotate(OpenApi.Summary, "Get the apps the organization has turned off")
      .annotate(
        OpenApi.Description,
        "A turned-off app is hidden from Home, the sidebar and the Tools launcher, and its " +
          "tools are not offered to, and are refused for, the chat agent and the MCP server. " +
          "It does not block this API: the routes behind an app keep answering under their " +
          "own permissions.",
      )
      .annotate(SuccessDescription, "The organization's app policy"),
    HttpApiEndpoint.put("update", "/", {
      params: OrgParams,
      payload: OrgProductPolicyUpdate,
      success: OrgProductPolicy,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Set the apps the organization has turned off")
      .annotate(
        OpenApi.Description,
        "Replaces the list. An unknown app id, or an app that cannot be turned off " +
          "(`infrastructure`), is refused with a 400 and nothing is saved.",
      )
      .annotate(SuccessDescription, "The saved app policy"),
  )
  .prefix("/api/org/:orgId/products")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Organization") {}

export class ProductsApi extends withApiDefaults(HttpApi.make("products").add(ProductsGroup)) {}
