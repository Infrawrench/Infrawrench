/**
 * `GET /api/v1/whoami`, the endpoint definition: who a bearer credential
 * belongs to. Outside the org tree so a key needs no org in the path; the
 * `@infrawrench/instances-bundles` Worker gates its downloads on it. Bearer
 * only, and it authenticates itself (`http/caller-auth.ts`).
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { Security, SuccessDescription } from "../../annotations";
import { withApiDefaults } from "../../domain";
import { Unauthorized } from "../../errors";
import { Uuid } from "../../schemas/common";

export const Whoami = Schema.Struct({
  userId: Schema.String.annotate({
    description:
      "The user the credential acts as. For an agent this is the agent's own user, not the person who claimed it.",
  }),
  organizationId: Uuid.annotate({
    description: "The organization the credential is pinned to.",
  }),
  principal: Schema.Literals(["user", "api_key", "agent"]).annotate({
    description:
      "`user` for a person's WorkOS access token, `api_key` for an `iwk_` key, `agent` for an agent credential or agent token.",
  }),
}).annotate({ identifier: "Whoami" });

export class WhoamiGroup extends HttpApiGroup.make("whoami")
  .add(
    HttpApiEndpoint.get("get", "/api/v1/whoami", { success: Whoami, error: [Unauthorized] })
      .annotate(OpenApi.Summary, "Identify a bearer credential")
      .annotate(
        OpenApi.Description,
        "Reports who an `Authorization: Bearer` credential belongs to: an API key, an agent " +
          "credential, or a WorkOS access token. Needs no scope; a 401 means the credential is " +
          "unknown, revoked, expired or no longer backed by an organization membership. Use it to " +
          "check a key before relying on it, or to gate a service of your own on Infrawrench sign-in.",
      )
      .annotate(SuccessDescription, "Credential owner")
      .annotate(Security, [{ bearerAuth: [] }]),
  )
  .annotate(OpenApi.Title, "Auth") {}

export class WhoamiApi extends withApiDefaults(HttpApi.make("whoami").add(WhoamiGroup)) {}
