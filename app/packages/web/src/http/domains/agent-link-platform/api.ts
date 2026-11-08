/**
 * Agent links from the platform's side, the endpoint definitions: the device
 * flow a platform starts and a person approves, and the link-authenticated
 * surface the platform then drives. The org tree's view (Settings → Agents)
 * is the `agent-links` domain.
 *
 * Three audiences, three auth models, one group each so none can end up
 * behind another's:
 *
 * - **`/api/agent-links/requests`** and **`/requests/token`** take no auth: a
 *   platform with no credential asks for one and polls for the answer. Rate
 *   limited per address in `agent-links/links.ts`.
 * - **`/api/agent-links/requests/{lookup,approve,deny}`** are the person's
 *   half, session-only, behind a per-user attempt limit (the user code is
 *   looked up globally, exactly like a claim code).
 * - **`/api/agent-link`** authenticates with the link's own `iwl_` credential
 *   (the `agentLinkCredential` scheme) and reaches nothing but the link and
 *   the agents it made.
 *
 * Every handler reads and checks its own body with its own sentences, so the
 * bodies are documented here and read by the handlers (`handleRaw`).
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { Security, SuccessDescription } from "../../annotations";
import { withApiDefaults } from "../../domain";
import { Unauthorized } from "../../errors";
import { SessionAuth } from "../../middleware-tags";
import {
  AgentLinkApprove,
  AgentLinkCode,
  AgentLinkInfo,
  AgentLinkLookup,
  AgentLinkPoll,
  AgentLinkRequest,
  AgentLinkRequestStarted,
  agentLinkError,
  CreatePlatformAgent,
  PatchPlatformAgent,
  PlatformAgent,
  PlatformAgentEnvelope,
  PlatformAgentWithCredential,
} from "../../schemas/agent-links";
import { Ok, Uuid } from "../../schemas/common";
import { describeResponse, optionalRequestBody } from "../../schemas/documented";

/** `describeResponse` for each `[status, description]`, as one `OpenApi.Transform`. */
const describeResponses =
  (entries: ReadonlyArray<readonly [number, string]>) =>
  (operation: Record<string, unknown>): Record<string, unknown> =>
    entries.reduce(
      (op, [status, text]) => describeResponse(status, text)(op),
      optionalRequestBody(operation),
    );

const LinkSecurity = [{ agentLinkCredential: [] }];
const unknownLink: readonly [number, string] = [401, "Unknown or revoked link credential"];

export class AgentLinkRequestsGroup extends HttpApiGroup.make("agentLinkRequests")
  .add(
    HttpApiEndpoint.post("start", "/", {
      payload: AgentLinkRequest,
      success: AgentLinkRequestStarted.annotate({ httpApiStatus: 201 }),
      error: [agentLinkError(400), agentLinkError(429)],
    })
      .annotate(OpenApi.Summary, "Start linking a platform (device flow)")
      .annotate(OpenApi.Description, "Unauthenticated, rate limited per source address.")
      .annotate(SuccessDescription, "Started")
      .annotate(Security, [])
      .annotate(
        OpenApi.Transform,
        describeResponses([
          [400, "Malformed platform, label or scopes"],
          [429, "Too many requests from this address"],
        ]),
      ),
    HttpApiEndpoint.post("token", "/token", {
      payload: Schema.Struct({ deviceCode: Schema.String }),
      success: AgentLinkPoll,
      error: agentLinkError(429),
    })
      .annotate(OpenApi.Summary, "Poll a link request")
      .annotate(SuccessDescription, "Status")
      .annotate(Security, [])
      .annotate(
        OpenApi.Transform,
        describeResponses([[429, 'Polling faster than `interval`: `{ error: "slow_down" }`']]),
      ),
  )
  .prefix("/api/agent-links/requests")
  .annotate(OpenApi.Title, "Agent links") {}

export class AgentLinkApprovalGroup extends HttpApiGroup.make("agentLinkApproval")
  .add(
    HttpApiEndpoint.post("lookup", "/lookup", {
      payload: AgentLinkCode,
      success: AgentLinkLookup,
      error: [agentLinkError(400), Unauthorized, agentLinkError(429)],
    })
      .annotate(OpenApi.Summary, "Resolve a user code for the approval page")
      .annotate(
        OpenApi.Description,
        "Session only. A POST with the code in the body rather than a query string: the code is " +
          "a live bearer secret. Rate limited per user.",
      )
      .annotate(SuccessDescription, "Resolved")
      .annotate(
        OpenApi.Transform,
        describeResponses([
          [400, "Malformed, unknown or expired code"],
          [429, "Too many attempts"],
        ]),
      ),
    HttpApiEndpoint.post("approve", "/approve", {
      payload: AgentLinkApprove,
      success: Ok,
      error: [
        agentLinkError(400),
        Unauthorized,
        agentLinkError(403),
        agentLinkError(409),
        agentLinkError(429),
      ],
    })
      .annotate(OpenApi.Summary, "Approve a link request into an organization")
      .annotate(
        OpenApi.Description,
        "Session only. Needs `team:invite` in the organization; `scopes` (the ceiling) must be " +
          "within what you hold there, break-glass elevation excluded, minus permissions no agent " +
          "may hold.",
      )
      .annotate(SuccessDescription, "Approved")
      .annotate(
        OpenApi.Transform,
        describeResponses([
          [400, "Bad code, or `scope_not_allowed`"],
          [403, "You lack `team:invite` there"],
          [409, "Already decided or expired"],
          [429, "Too many attempts"],
        ]),
      ),
    HttpApiEndpoint.post("deny", "/deny", {
      payload: AgentLinkCode,
      success: Ok,
      error: [agentLinkError(400), Unauthorized],
    })
      .annotate(OpenApi.Summary, "Deny a link request")
      .annotate(SuccessDescription, "Denied")
      .annotate(OpenApi.Transform, describeResponses([[400, "Bad code"]])),
  )
  .prefix("/api/agent-links/requests")
  .middleware(SessionAuth)
  .annotate(OpenApi.Title, "Agent links") {}

const AgentParams = { id: Uuid };

export class AgentLinkGroup extends HttpApiGroup.make("agentLink")
  .add(
    HttpApiEndpoint.get("describe", "/", {
      success: AgentLinkInfo,
      error: agentLinkError(401),
    })
      .annotate(OpenApi.Summary, "Describe this link")
      .annotate(SuccessDescription, "The link")
      .annotate(OpenApi.Transform, describeResponses([unknownLink])),
    HttpApiEndpoint.delete("unlink", "/", {
      success: Ok,
      error: agentLinkError(401),
    })
      .annotate(OpenApi.Summary, "Unlink, revoking every agent this link made")
      .annotate(SuccessDescription, "Revoked")
      .annotate(OpenApi.Transform, describeResponses([unknownLink])),
    HttpApiEndpoint.get("agents", "/agents", {
      success: Schema.Array(PlatformAgent),
      error: agentLinkError(401),
    })
      .annotate(OpenApi.Summary, "List the agents this link made, newest first, revoked included")
      .annotate(SuccessDescription, "Agents")
      .annotate(OpenApi.Transform, describeResponses([unknownLink])),
    HttpApiEndpoint.post("createAgent", "/agents", {
      payload: CreatePlatformAgent,
      success: PlatformAgentWithCredential.annotate({ httpApiStatus: 201 }),
      error: [agentLinkError(400), agentLinkError(401), agentLinkError(403), agentLinkError(409)],
    })
      .annotate(OpenApi.Summary, "Create an agent with its own `iwa_` credential")
      .annotate(SuccessDescription, "Created")
      .annotate(
        OpenApi.Transform,
        describeResponses([
          [400, "`scope_not_allowed` (with `scopes`), `invalid_provider`, or malformed"],
          unknownLink,
          [403, "The approving person no longer exists"],
          [409, "`exists`: a live agent with this `externalId` (with `agentId`)"],
        ]),
      ),
    HttpApiEndpoint.patch("updateAgent", "/agents/:id", {
      params: AgentParams,
      payload: PatchPlatformAgent,
      success: PlatformAgentEnvelope,
      error: [agentLinkError(400), agentLinkError(401), agentLinkError(404)],
    })
      .annotate(OpenApi.Summary, "Edit an agent's label, scopes or providers")
      .annotate(SuccessDescription, "Updated")
      .annotate(
        OpenApi.Transform,
        describeResponses([
          [400, "`scope_not_allowed`, `invalid_provider`, or malformed"],
          unknownLink,
          [404, "Not an agent of this link, or revoked"],
        ]),
      ),
    HttpApiEndpoint.post("rotateAgent", "/agents/:id/rotate", {
      params: AgentParams,
      success: PlatformAgentWithCredential,
      error: [agentLinkError(401), agentLinkError(404)],
    })
      .annotate(
        OpenApi.Summary,
        "Replace an agent's credential; the old one stops working immediately",
      )
      .annotate(SuccessDescription, "Rotated")
      .annotate(
        OpenApi.Transform,
        describeResponses([unknownLink, [404, "Not an agent of this link, or revoked"]]),
      ),
    HttpApiEndpoint.delete("revokeAgent", "/agents/:id", {
      params: AgentParams,
      success: Ok,
      error: [agentLinkError(401), agentLinkError(404)],
    })
      .annotate(OpenApi.Summary, "Revoke an agent (idempotent; the row is kept for the audit log)")
      .annotate(SuccessDescription, "Revoked")
      .annotate(
        OpenApi.Transform,
        describeResponses([unknownLink, [404, "Not an agent of this link"]]),
      ),
  )
  .prefix("/api/agent-link")
  .annotate(Security, LinkSecurity)
  .annotate(OpenApi.Title, "Agent links") {}

export class AgentLinkPlatformApi extends withApiDefaults(
  HttpApi.make("agentLinkPlatform")
    .add(AgentLinkRequestsGroup)
    .add(AgentLinkApprovalGroup)
    .add(AgentLinkGroup),
) {}
