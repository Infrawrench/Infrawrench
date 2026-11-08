/**
 * Bastions: `/api/org/:orgId/bastions`, the endpoint definitions. A bastion is
 * an enrolled agent that proxies cloud API traffic from inside a private
 * network; the agent's own WebSocket (`/api/bastions/agent`) is not here.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { minLength } from "@infrawrench/ui/schemas";
import { RequiredPermission, SuccessDescription } from "../../annotations";
import { withApiDefaults } from "../../domain";
import { BadRequest, NotFound } from "../../errors";
import { OrgAuth } from "../../middleware-tags";
import { IsoDateTime, Ok, OrgIdParams, OrgParams, Uuid } from "../../schemas/common";

const BastionStatus = Schema.Literals(["pending", "active", "revoked"]).annotate({
  identifier: "BastionStatus",
});

export const Bastion = Schema.Struct({
  id: Uuid,
  name: Schema.String,
  tokenPrefix: Schema.String,
  agentVersion: Schema.NullOr(Schema.String),
  lastSeenAt: Schema.NullOr(IsoDateTime),
  status: BastionStatus,
  revokedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  createdByUserId: Uuid,
  /** True iff an agent is currently connected to this bastion's WebSocket. */
  connected: Schema.Boolean,
  /** Number of accounts in this org that have this bastion attached. */
  accountCount: Schema.Int,
}).annotate({ identifier: "Bastion" });

/** Documented; the handler reads it raw and answers a blank name itself. */
const CreateBastionRequest = Schema.Struct({
  name: Schema.String.check(minLength(1)),
}).annotate({ identifier: "CreateBastionRequest" });

export const CreateBastionResponse = Schema.Struct({
  id: Uuid,
  name: Schema.String,
  tokenPrefix: Schema.String,
  token: Schema.String.annotate({
    description:
      "Enrollment token in the form `iwb_<random>`. Pass to the agent container as `BASTION_TOKEN`. Returned once: not recoverable later.",
  }),
}).annotate({ identifier: "CreateBastionResponse" });

export class BastionsGroup extends HttpApiGroup.make("bastions")
  .add(
    HttpApiEndpoint.get("list", "/", {
      params: OrgParams,
      success: Schema.Array(Bastion),
    })
      .annotate(RequiredPermission, "bastions:read")
      .annotate(OpenApi.Summary, "List bastion agents registered to this org")
      .annotate(SuccessDescription, "Bastions"),
    HttpApiEndpoint.post("create", "/", {
      params: OrgParams,
      payload: CreateBastionRequest,
      success: CreateBastionResponse,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "bastions:write")
      .annotate(OpenApi.Summary, "Register a new bastion (returns the enrollment token once)")
      .annotate(SuccessDescription, "Created"),
    HttpApiEndpoint.delete("revoke", "/:id", {
      params: OrgIdParams,
      success: Ok,
      error: NotFound,
    })
      .annotate(RequiredPermission, "bastions:write")
      .annotate(
        OpenApi.Summary,
        "Revoke a bastion; accounts referencing it have their bastion binding cleared",
      )
      .annotate(SuccessDescription, "Deleted"),
  )
  .prefix("/api/org/:orgId/bastions")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Bastions") {}

export class BastionsApi extends withApiDefaults(HttpApi.make("bastions").add(BastionsGroup)) {}
