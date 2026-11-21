/**
 * Associations: `/api/org/:orgId/associations`, the endpoint definitions.
 * Wiring one resource's output into another resource's secret field, or
 * setting that field to a literal: the two halves of a field's Reroll dialog.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { InvalidRequestMessage, RequiredPermission, SuccessDescription } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { BadGateway, NotFound } from "../http/errors";
import { OrgAuth } from "../http/middleware-tags";
import { Ok, OrgParams, ResourceId, Uuid } from "../http/schemas/common";
import { describeQuery } from "../http/schemas/params";

const AssociationRequest = Schema.Struct({
  consumerResourceId: ResourceId,
  consumerFieldKey: Schema.String,
  providerResourceId: ResourceId,
  providerOutputKey: Schema.String,
  // Accepted so older clients keep working, and ignored: the server reads the
  // provider's plugin, type and account from its stored row.
  providerPluginId: Schema.optionalKey(
    Schema.String.annotate({
      description: "Deprecated and ignored: read from the stored provider resource.",
    }),
  ),
  providerResourceTypeId: Schema.optionalKey(
    Schema.String.annotate({
      description: "Deprecated and ignored: read from the stored provider resource.",
    }),
  ),
  providerAccountId: Schema.optionalKey(
    Uuid.annotate({
      description: "Deprecated and ignored: read from the stored provider resource.",
    }),
  ),
}).annotate({ identifier: "AssociationRequest" });

const LiteralAssociationRequest = Schema.Struct({
  resourceId: ResourceId,
  fieldKey: Schema.String,
  plaintextValue: Schema.String,
}).annotate({ identifier: "LiteralAssociationRequest" });

const AssociationCandidate = Schema.Struct({
  resourceId: ResourceId,
  pluginId: Schema.String,
  resourceTypeId: Schema.String,
  accountId: Uuid,
  displayName: Schema.String,
  outputKey: Schema.String.annotate({
    description: "The output that would fill the field; send it as `providerOutputKey`.",
  }),
  pluginLogoSvg: Schema.String.annotate({ description: "Inline SVG markup; may be empty." }),
}).annotate({ identifier: "AssociationCandidate" });

export const AssociationCandidates = Schema.Array(AssociationCandidate);

export class AssociationsGroup extends HttpApiGroup.make("associations")
  .add(
    HttpApiEndpoint.get("candidates", "/candidates", {
      params: OrgParams,
      query: { resourceId: ResourceId, fieldKey: Schema.String },
      success: AssociationCandidates,
      error: NotFound,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "List the resources whose outputs can fill a secret field")
      .annotate(
        OpenApi.Description,
        "A candidate is a stored resource whose type hands one of its outputs to the field's plugin under the field's key (a peer integration's credential mapping) and whose fields pass that integration's visibility gates. Send one to `POST /associations` to point the field at it.",
      )
      .annotate(SuccessDescription, "Candidates, sorted by name")
      .annotate(
        OpenApi.Transform,
        describeQuery({
          resourceId: "The resource holding the field.",
          fieldKey: "The secret field to fill, e.g. `connectionString`.",
        }),
      ),
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
      error: [NotFound, BadGateway],
    })
      .annotate(RequiredPermission, "secrets:write")
      .annotate(OpenApi.Summary, "Set a secret field to a literal plaintext value")
      .annotate(
        OpenApi.Description,
        "When the resource's plugin applies a new value upstream (resetting a database password, say), it does so first; a refusal there answers 502 and stores nothing.",
      )
      .annotate(SuccessDescription, "Stored")
      .annotate(InvalidRequestMessage, "Invalid association"),
  )
  .prefix("/api/org/:orgId/associations")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Associations") {}

export class AssociationsApi extends withApiDefaults(
  HttpApi.make("associations").add(AssociationsGroup),
) {}
