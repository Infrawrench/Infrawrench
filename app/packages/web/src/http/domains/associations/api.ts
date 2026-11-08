/**
 * Associations: `/api/org/:orgId/associations`, the endpoint definitions.
 * Wiring one resource's output into another resource's secret field, or
 * setting that field to a literal.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { InvalidRequestMessage, RequiredPermission, SuccessDescription } from "../../annotations";
import { withApiDefaults } from "../../domain";
import { NotFound } from "../../errors";
import { OrgAuth } from "../../middleware-tags";
import { Ok, OrgParams, ResourceId, Uuid } from "../../schemas/common";

const AssociationRequest = Schema.Struct({
  consumerResourceId: ResourceId,
  consumerFieldKey: Schema.String,
  providerResourceId: ResourceId,
  providerOutputKey: Schema.String,
  providerPluginId: Schema.String,
  providerResourceTypeId: Schema.String,
  providerAccountId: Uuid,
}).annotate({ identifier: "AssociationRequest" });

const LiteralAssociationRequest = Schema.Struct({
  resourceId: ResourceId,
  fieldKey: Schema.String,
  plaintextValue: Schema.String,
}).annotate({ identifier: "LiteralAssociationRequest" });

export class AssociationsGroup extends HttpApiGroup.make("associations")
  .add(
    HttpApiEndpoint.post("create", "/", {
      params: OrgParams,
      payload: AssociationRequest,
      success: Ok,
      error: NotFound,
    })
      .annotate(RequiredPermission, "secrets:write")
      .annotate(OpenApi.Summary, "Wire one resource's output into another resource's secret field")
      .annotate(SuccessDescription, "Created")
      .annotate(InvalidRequestMessage, "Invalid association"),
    HttpApiEndpoint.post("literal", "/literal", {
      params: OrgParams,
      payload: LiteralAssociationRequest,
      success: Ok,
      error: NotFound,
    })
      .annotate(RequiredPermission, "secrets:write")
      .annotate(OpenApi.Summary, "Set a secret field to a literal plaintext value")
      .annotate(SuccessDescription, "Stored")
      .annotate(InvalidRequestMessage, "Invalid association"),
  )
  .prefix("/api/org/:orgId/associations")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Associations") {}

export class AssociationsApi extends withApiDefaults(
  HttpApi.make("associations").add(AssociationsGroup),
) {}
