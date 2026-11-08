/**
 * Agent link components: a platform (Nibblets, ...) that a person approved to
 * mint scoped agents in one organization.
 *
 * Defined by the platform's own routes (`domains/agent-link-platform/`), the
 * device flow, the approval and the `iwl_`-authenticated surface. The org
 * tree's Settings views (`domains/agent-links/`, `domains/agent-registrations/`)
 * refer to the shared ones by name through `./zod-components.ts`, so each is
 * one component in the document.
 */
import { Schema } from "effect";
import { HttpApiSchema } from "effect/http-api";
import { lengthBetween, maxLength, minLength, pattern } from "@infrawrench/ui/schemas";
import { IsoDateTime, Uuid } from "./common";

const Url = Schema.String.annotate({ format: "uri" });
const Strings = Schema.Array(Schema.String);

/** The body every agent link refusal has: `{ error }` plus a code and the details it names. */
export const AgentLinkError = Schema.Struct({
  error: Schema.String,
  code: Schema.optionalKey(Schema.String),
  scopes: Schema.optionalKey(Strings),
  agentId: Schema.optionalKey(Schema.String),
  providers: Schema.optionalKey(Strings),
}).annotate({ identifier: "AgentLinkError" });

/** {@link AgentLinkError} as the response for `status`. */
export const agentLinkError = (status: number) => AgentLinkError.pipe(HttpApiSchema.status(status));

export const AgentLinkRequest = Schema.Struct({
  platform: Schema.String.check(pattern(/^[a-z0-9-]{1,40}$/)),
  label: Schema.String.check(...lengthBetween(1, 80)),
  requestedScopes: Schema.optionalKey(
    Strings.annotate({
      description: "Pre-ticks the ceiling on the approval page. Unknown strings are ignored.",
    }),
  ),
}).annotate({ identifier: "AgentLinkRequest" });

export const AgentLinkRequestStarted = Schema.Struct({
  deviceCode: Schema.String.annotate({ description: "Secret to the platform; poll with it." }),
  userCode: Schema.String.annotate({ description: "`XXXX-XXXX`, shown to the person." }),
  verificationUrl: Url,
  verificationUrlComplete: Url,
  expiresIn: Schema.Int.annotate({ description: "Seconds." }),
  interval: Schema.Int.annotate({ description: "Minimum seconds between polls." }),
}).annotate({ identifier: "AgentLinkRequestStarted" });

export const AgentLinkScopeGroup = Schema.Struct({
  title: Schema.String,
  scopes: Schema.Array(Schema.Struct({ value: Schema.String, label: Schema.String })),
}).annotate({ identifier: "AgentLinkScopeGroup" });

export const AgentLinkProvider = Schema.Struct({
  id: Schema.String,
  displayName: Schema.String,
}).annotate({ identifier: "AgentLinkProvider" });

export const AgentLinkInfo = Schema.Struct({
  id: Uuid,
  organizationId: Uuid,
  organizationName: Schema.String,
  platform: Schema.String,
  label: Schema.String,
  scopes: Strings.annotate({ description: "The ceiling as approved." }),
  effectiveScopes: Strings.annotate({
    description:
      "The ceiling as it stands now: approved ∩ the approver's current role (no elevation) − " +
      "permissions no agent may hold. Agents can only be granted scopes from here.",
  }),
  narrowableScopes: Strings.annotate({
    description:
      "The scopes in `effectiveScopes` that `providers` can limit (resources, secrets, object " +
      "storage). An agent given `providers` may hold only these; any other scope is a " +
      "`scope_not_allowed`, because it would stay organization-wide.",
  }),
  scopeGroups: Schema.Array(AgentLinkScopeGroup).annotate({
    description: "`effectiveScopes` grouped and labelled as the Infrawrench pickers show them.",
  }),
  providers: Schema.Array(AgentLinkProvider).annotate({
    description: "Plugins the organization has at least one connected account for.",
  }),
  approvedBy: Schema.NullOr(Schema.Struct({ email: Schema.String })),
  createdAt: IsoDateTime,
}).annotate({ identifier: "AgentLinkInfo" });

export const AgentLinkPoll = Schema.Union([
  Schema.Struct({ status: Schema.Literals(["pending", "denied", "expired"]) }),
  Schema.Struct({
    status: Schema.Literal("approved"),
    credential: Schema.String.annotate({
      description: "`iwl_` link credential. Returned exactly once; later polls read `expired`.",
    }),
    link: AgentLinkInfo,
  }),
]).annotate({ identifier: "AgentLinkPoll" });

export const AgentLinkLookupOrganization = Schema.Struct({
  id: Uuid,
  name: Schema.String,
  canApprove: Schema.Boolean.annotate({ description: "You hold `team:invite` there." }),
  grantableScopes: Strings.annotate({
    description: "What you could put in the ceiling there; empty when `canApprove` is false.",
  }),
}).annotate({ identifier: "AgentLinkLookupOrganization" });

export const AgentLinkLookup = Schema.Struct({
  platform: Schema.String,
  label: Schema.String,
  requestedScopes: Strings,
  expiresAt: IsoDateTime,
  organizations: Schema.Array(AgentLinkLookupOrganization),
}).annotate({ identifier: "AgentLinkLookup" });

export const AgentLinkCode = Schema.Struct({ code: Schema.String }).annotate({
  identifier: "AgentLinkCode",
});

export const AgentLinkApprove = Schema.Struct({
  code: Schema.String,
  organizationId: Uuid,
  scopes: Strings.annotate({ description: "The ceiling." }).check(minLength(1)),
}).annotate({ identifier: "AgentLinkApprove" });

export const PlatformAgent = Schema.Struct({
  id: Uuid,
  externalId: Schema.String,
  label: Schema.String,
  scopes: Strings,
  providers: Strings.annotate({ description: "Empty means every provider." }),
  credentialPrefix: Schema.NullOr(Schema.String),
  lastSeenAt: Schema.NullOr(IsoDateTime),
  revokedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
}).annotate({ identifier: "PlatformAgent" });

export const CreatePlatformAgent = Schema.Struct({
  externalId: Schema.String.check(...lengthBetween(1, 120)),
  label: Schema.String.check(...lengthBetween(1, 80)),
  scopes: Strings,
  providers: Schema.optionalKey(
    Strings.annotate({
      description:
        "Plugin ids. Narrows every `resources:*`, `secrets:*` and `storage:*` scope to these " +
        "providers (`resources:read` becomes `resources:<plugin>:read`). Omitted or empty means " +
        "all. With providers, every scope must be one of those families (see `narrowableScopes`).",
    }),
  ),
}).annotate({ identifier: "CreatePlatformAgent" });

export const PatchPlatformAgent = Schema.Struct({
  label: Schema.optionalKey(Schema.String.check(minLength(1), maxLength(80))),
  scopes: Schema.optionalKey(Strings),
  providers: Schema.optionalKey(Strings),
}).annotate({ identifier: "PatchPlatformAgent" });

export const PlatformAgentWithCredential = Schema.Struct({
  agent: PlatformAgent,
  credential: Schema.String.annotate({ description: "`iwa_` credential, shown once." }),
}).annotate({ identifier: "PlatformAgentWithCredential" });

export const PlatformAgentEnvelope = Schema.Struct({ agent: PlatformAgent }).annotate({
  identifier: "PlatformAgentEnvelope",
});
