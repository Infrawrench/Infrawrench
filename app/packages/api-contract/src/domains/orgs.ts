/**
 * Organization creation: `POST /api/orgs`, the endpoint definition.
 *
 * Session-only, and the only place a person creates an organization (agent
 * trials are the other way one comes to exist, at `/api/agent`).
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { minLength } from "../schemas";
import { SuccessDescription } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { BadRequest, Unauthorized } from "../http/errors";
import { SessionAuth } from "../http/middleware-tags";
import { Uuid } from "../http/schemas/common";

const CreateOrgRequest = Schema.Struct({
  displayName: Schema.String.annotate({ examples: ["Acme Inc"] }).check(minLength(1)),
}).annotate({ identifier: "CreateOrgRequest" });

export const Organization = Schema.Struct({
  id: Uuid,
  displayName: Schema.String,
}).annotate({ identifier: "Organization" });

export class OrgsGroup extends HttpApiGroup.make("orgs")
  .add(
    HttpApiEndpoint.post("create", "/", {
      payload: CreateOrgRequest,
      success: Organization,
      error: [BadRequest, Unauthorized],
    })
      .annotate(OpenApi.Summary, "Create a new organization")
      .annotate(OpenApi.Description, "The caller becomes the `owner` of the new organization.")
      .annotate(SuccessDescription, "Created"),
  )
  .prefix("/api/orgs")
  .middleware(SessionAuth)
  .annotate(OpenApi.Title, "Organizations") {}

export class OrgsApi extends withApiDefaults(HttpApi.make("orgs").add(OrgsGroup)) {}
