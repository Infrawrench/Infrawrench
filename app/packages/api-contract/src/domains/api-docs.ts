/**
 * The API's own documentation, the endpoint definitions: `GET /openapi.json`
 * (the public document) and `GET /docs` (the Scalar reference page over it).
 *
 * Public, since the document describes the API surface and no private data,
 * and left out of the document they serve.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";
import { Security } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";

export class ApiDocsGroup extends HttpApiGroup.make("apiDocs")
  .add(
    HttpApiEndpoint.get("openapi", "/openapi.json", { success: Schema.Unknown })
      .annotate(OpenApi.Summary, "The public OpenAPI document")
      .annotate(Security, []),
    HttpApiEndpoint.get("reference", "/docs", {
      success: Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/html" })),
    })
      .annotate(OpenApi.Summary, "The API reference page")
      .annotate(Security, []),
  )
  .annotate(OpenApi.Title, "API documentation")
  .annotate(OpenApi.Exclude, true) {}

export class ApiDocsApi extends withApiDefaults(HttpApi.make("apiDocs").add(ApiDocsGroup)) {}
