/**
 * Agent registration and the claim ceremony, the endpoint definitions.
 *
 * Three audiences, three auth models:
 *
 * - **`POST /api/agent/identity`** is unauthenticated by definition: it is how
 *   an agent with no credentials gets one, and the only route in the product
 *   that creates an organization without a person, so the rate limit in
 *   `trials/ceremony.ts` is the whole of its protection.
 * - **`GET /api/agent/identity`** and **`POST /api/agent/identity/claim`**
 *   authenticate with the agent's own credential, which the handler resolves.
 * - **`/api/agent/claim*`** is the human half: session-authed, because the
 *   point of the ceremony is binding the registration to a person we have
 *   actually signed in.
 *
 * Every handler reads its own body and answers its own sentences, so bodies
 * are documented here and read by the handlers (`handleRaw`).
 *
 * The routes are part of the *public* spec on purpose: they are the
 * documented way an autonomous client gets credentials. **Both halves or
 * neither**: the ceremony spans an agent-authed start and a session-authed
 * confirm, so describing only the agent's half publishes a flow that can be
 * begun and never finished.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";
import { maxLength } from "@infrawrench/ui/schemas";
import { Security, SuccessDescription } from "../../annotations";
import { withApiDefaults } from "../../domain";
import { Unauthorized } from "../../errors";
import { SessionAuth } from "../../middleware-tags";
import { IsoDateTime, Uuid } from "../../schemas/common";
import { describeResponses, optionalRequestBody } from "../../schemas/documented";

const Url = Schema.String.annotate({ format: "uri" });

const AgentRegisterRequest = Schema.Struct({
  label: Schema.optionalKey(
    Schema.String.annotate({
      description: "Short name for the workspace, shown to the user who claims it.",
    }).check(maxLength(80)),
  ),
}).annotate({ identifier: "AgentRegisterRequest" });

export const RegisteredAgent = Schema.Struct({
  registration_id: Uuid,
  credential: Schema.String.annotate({
    description:
      "Bearer credential for this registration. Format `iwa_<base64url>`. Returned once and " +
      "never recoverable: there is no route that can show it again.",
  }),
  organization_id: Uuid,
  trial_expires_at: IsoDateTime.annotate({
    description: "When the trial workspace is deleted unless a person claims it.",
  }),
  claim_url: Url,
  notice: Schema.String.annotate({
    description: "Human-readable summary of the trial terms, meant to be relayed to the user.",
  }),
}).annotate({ identifier: "RegisteredAgent" });

export const AgentClaimStarted = Schema.Struct({
  user_code: Schema.String.annotate({
    description: "Formatted as `XXXX-XXXX`. Show it to the user alongside `verification_uri`.",
  }),
  verification_uri: Url,
  verification_uri_complete: Url.annotate({
    description:
      "The verification page with the code pre-filled. Convenient, but it puts a live bearer " +
      "secret in a URL; prefer `verification_uri` plus the code shown separately.",
  }),
  expires_at: IsoDateTime,
  interval: Schema.Int.annotate({ description: "Minimum seconds between status polls." }),
}).annotate({ identifier: "AgentClaimStarted" });

export const AgentIdentity = Schema.Struct({
  registration_id: Uuid,
  organization_id: Uuid,
  claimed: Schema.Boolean,
  claim_pending: Schema.Boolean.annotate({
    description: "A `user_code` is currently outstanding.",
  }),
  trial_expires_in_ms: Schema.NullOr(Schema.Int).annotate({
    description: "Milliseconds until deletion. Null once the workspace is claimed.",
  }),
}).annotate({ identifier: "AgentIdentity" });

const AgentClaimLookupRequest = Schema.Struct({
  code: Schema.String.annotate({ description: "The `user_code` the agent showed its user." }),
}).annotate({ identifier: "AgentClaimLookupRequest" });

const AgentClaimMergeTarget = Schema.Struct({
  id: Uuid,
  displayName: Schema.String,
}).annotate({ identifier: "AgentClaimMergeTarget" });

export const AgentClaimLookup = Schema.Struct({
  registrationId: Uuid,
  workspaceName: Schema.String,
  trialExpiresInMs: Schema.NullOr(Schema.Int),
  mergeTargets: Schema.Array(AgentClaimMergeTarget).annotate({
    description:
      "Organizations this user may merge the workspace into: ones they already belong to AND " +
      "hold `accounts:write` in. A merge writes cloud credentials, so membership alone is not " +
      "enough: the confirm route enforces the same rule.",
  }),
}).annotate({ identifier: "AgentClaimLookup" });

const AgentClaimRequest = Schema.Struct({
  code: Schema.String,
  mode: Schema.optionalKey(
    Schema.Literals(["adopt", "merge"]).annotate({
      description:
        "`adopt` keeps the workspace as its own organization and stops the clock. `merge` moves " +
        "its cloud accounts into an organization you already belong to and destroys the trial. " +
        "Defaults to `adopt`.",
    }),
  ),
  targetOrganizationId: Schema.optionalKey(
    Uuid.annotate({ description: "Required when `mode` is merge." }),
  ),
  moveHistory: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "Merge only: also re-parent the trial's metrics and cost history. Off by default; it " +
        "changes numbers the target organization may already be reporting on. Needs `costs:write`.",
    }),
  ),
}).annotate({ identifier: "AgentClaimRequest" });

export const AgentClaimResult = Schema.Struct({
  organizationId: Uuid.annotate({
    description: "The organization the agent acts in from now on.",
  }),
  mode: Schema.Literals(["adopt", "merge"]),
  accountsMoved: Schema.Int,
  historyMoved: Schema.Boolean,
}).annotate({ identifier: "AgentClaimResult" });

/** A status the hand-written spec listed with a description and no body. */
const bare = (status: number) => HttpApiSchema.Empty(status);

export class AgentIdentityGroup extends HttpApiGroup.make("agentIdentity")
  .add(
    HttpApiEndpoint.post("register", "/identity", {
      payload: AgentRegisterRequest,
      success: RegisteredAgent,
      error: [bare(429), bare(500)],
    })
      .annotate(OpenApi.Summary, "Open an anonymous registration and a 24-hour trial workspace")
      .annotate(
        OpenApi.Description,
        "Requires no authentication; this is how a client with no credentials gets one. Rate " +
          "limited per source address. The workspace it opens is deleted 24 hours later unless a " +
          "person completes the claim ceremony.",
      )
      .annotate(SuccessDescription, "Registered")
      .annotate(Security, [])
      .annotate(OpenApi.Transform, (operation) =>
        describeResponses([
          [429, "Too many registrations from this address"],
          [500, "Could not open a workspace"],
        ])(optionalRequestBody(operation)),
      ),
    HttpApiEndpoint.get("status", "/identity", {
      success: AgentIdentity,
      error: [bare(401), bare(404)],
    })
      .annotate(OpenApi.Summary, "Poll this registration's claim status and time remaining")
      .annotate(SuccessDescription, "Status")
      .annotate(
        OpenApi.Transform,
        describeResponses([
          [401, "Unknown or revoked credential"],
          [404, "Unknown registration"],
        ]),
      ),
    HttpApiEndpoint.post("startClaim", "/identity/claim", {
      success: AgentClaimStarted,
      error: [bare(400), bare(401), bare(403)],
    })
      .annotate(OpenApi.Summary, "Start the claim ceremony and mint a user code")
      .annotate(
        OpenApi.Description,
        "Returns a code to show the user together with the verification URL. Replaces any code " +
          "already outstanding for this registration.",
      )
      .annotate(SuccessDescription, "Ceremony started")
      .annotate(
        OpenApi.Transform,
        describeResponses([
          [400, "Already claimed"],
          [401, "Unknown or revoked credential"],
          [403, "Registration revoked"],
        ]),
      ),
  )
  .prefix("/api/agent")
  .annotate(OpenApi.Title, "Agent auth") {}

/**
 * The human half of the ceremony. Session-authed (no `security` override, so
 * the document default applies), and in the spec for the same reason the
 * agent half is: a ceremony described only up to the point where it needs a
 * person is a ceremony no client can be written against.
 */
export class AgentClaimGroup extends HttpApiGroup.make("agentClaim")
  .add(
    HttpApiEndpoint.post("lookup", "/lookup", {
      payload: AgentClaimLookupRequest,
      success: AgentClaimLookup,
      error: [bare(400), Unauthorized, bare(404), bare(429)],
    })
      .annotate(
        OpenApi.Summary,
        "Resolve a user code so the claim page can show what is being claimed",
      )
      .annotate(
        OpenApi.Description,
        "A POST rather than a GET with the code in the path: the code is a live bearer secret for " +
          "15 minutes, and a URL lands in history, in `Referer`, and in access logs. Rate limited " +
          "per user.",
      )
      .annotate(SuccessDescription, "Resolved")
      .annotate(OpenApi.Transform, (operation) =>
        describeResponses([
          [400, "Missing, malformed, or expired code"],
          [404, "The workspace no longer exists"],
          [429, "Too many attempts"],
        ])(optionalRequestBody(operation)),
      ),
    HttpApiEndpoint.post("confirm", "/", {
      payload: AgentClaimRequest,
      success: AgentClaimResult,
      error: [bare(400), Unauthorized, bare(402), bare(403), bare(429)],
    })
      .annotate(OpenApi.Summary, "Confirm a claim, binding the workspace to the signed-in user")
      .annotate(
        OpenApi.Description,
        "The code is re-resolved here rather than trusting a registration id from the lookup, so " +
          "the lookup cannot be used as an oracle. Rate limited per user.",
      )
      .annotate(SuccessDescription, "Claimed")
      .annotate(OpenApi.Transform, (operation) =>
        describeResponses([
          [400, "Bad code, already claimed, revoked, or a merge with no valid target"],
          [402, "The merge would put a free target organization over its plan limits"],
          [
            403,
            "You lack the permission the merge needs in the target organization " +
              "(`accounts:write`, plus `costs:write` when moving history).",
          ],
          [429, "Too many attempts"],
        ])(optionalRequestBody(operation)),
      ),
  )
  .prefix("/api/agent/claim")
  .middleware(SessionAuth)
  .annotate(OpenApi.Title, "Agent auth") {}

export class AgentAuthApi extends withApiDefaults(
  HttpApi.make("agentAuth").add(AgentIdentityGroup).add(AgentClaimGroup),
) {}
