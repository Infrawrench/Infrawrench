/**
 * Agent registrations: `/api/org/:orgId/agent-registrations`, the handlers.
 */
import { Effect, Schema } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { and, desc, eq } from "drizzle-orm";
import { hasPermission } from "@infrawrench/server-core/permissions/catalog";
import { revokeAgentRegistration } from "@infrawrench/server-core/trials/ceremony";
import {
  AgentLinkError,
  LABEL_MAX,
  getLink,
  getLinkAgent,
  grantablePermissions,
  linkEffectiveScopes,
  updatePlatformAgent,
  validateAgentGrant,
} from "@infrawrench/server-core/agent-links/links";
import {
  AgentRegistration,
  AgentRegistrationsApi,
  AgentRevoked,
  badRequest,
  conflict,
  notFound,
  PlatformAgentEnvelope,
} from "@infrawrench/api-contract";
import { db } from "../../../db/client";
import { agentAuthRegistrations, users } from "../../../db/schema";
import { logAudit } from "../../../services/audit";
import { serializeAgent, unknownProviders } from "../../../services/agent-links";
import { makeDomain } from "../../domain";
import { HttpFailure } from "../../errors";
import { fieldsOf, readJsonOr } from "../../request-body";
import { fireAndForget, legacy } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";

/** A refusal whose body carries more than `error` (`code`, `scopes`), sent as-is. */
const refuse = (status: number, body: Readonly<Record<string, unknown>>) =>
  Effect.die(new HttpFailure(status, body));

/**
 * Promise code inside the edit's `try`: an `AgentLinkError` is answered with
 * its status, code and details, as the route's `catch` did; anything else
 * stays the defect it was (a 500).
 */
const linkCall = <A>(fn: () => PromiseLike<A>) =>
  legacy(fn).pipe(
    Effect.catchDefect((defect) =>
      Effect.die(
        defect instanceof AgentLinkError
          ? new HttpFailure(defect.status, {
              error: defect.message,
              ...(defect.code ? { code: defect.code } : {}),
              ...(defect.details ?? {}),
            })
          : defect,
      ),
    ),
  );

/** The registration, scoped to the org before anything acts on it. */
const orgRegistration = (organizationId: string, id: string) =>
  legacy(() =>
    db
      .select({ id: agentAuthRegistrations.id, linkId: agentAuthRegistrations.linkId })
      .from(agentAuthRegistrations)
      .where(
        and(
          eq(agentAuthRegistrations.id, id),
          eq(agentAuthRegistrations.organizationId, organizationId),
        ),
      )
      .limit(1),
  ).pipe(Effect.map((rows) => rows[0]));

const AgentRegistrationsHandlers = HttpApiBuilder.group(
  AgentRegistrationsApi,
  "agentRegistrations",
  (handlers) =>
    handlers
      .handle("list", () =>
        Effect.gen(function* () {
          const { organizationId } = yield* OrgPrincipal;
          const rows = yield* legacy(() =>
            db
              .select({
                id: agentAuthRegistrations.id,
                label: agentAuthRegistrations.label,
                kind: agentAuthRegistrations.kind,
                prefix: agentAuthRegistrations.credentialPrefix,
                claimedAt: agentAuthRegistrations.claimedAt,
                claimedByUserId: agentAuthRegistrations.claimedByUserId,
                claimedByEmail: users.email,
                lastSeenAt: agentAuthRegistrations.lastSeenAt,
                revokedAt: agentAuthRegistrations.revokedAt,
                createdAt: agentAuthRegistrations.createdAt,
                linkId: agentAuthRegistrations.linkId,
                externalId: agentAuthRegistrations.externalId,
                scopes: agentAuthRegistrations.scopes,
                providers: agentAuthRegistrations.providers,
              })
              .from(agentAuthRegistrations)
              .leftJoin(users, eq(users.id, agentAuthRegistrations.claimedByUserId))
              .where(eq(agentAuthRegistrations.organizationId, organizationId))
              .orderBy(desc(agentAuthRegistrations.createdAt)),
          );
          return yield* respond(Schema.Array(AgentRegistration))(rows);
        }),
      )
      // Edit a platform agent's label, scopes and providers. Only platform
      // agents have scopes of their own; a trial or service agent's authority
      // is its claimer's role and there is nothing here to edit. The grant is
      // validated against the link's current ceiling exactly as the platform's
      // own PATCH is, and additionally a person may only *add* scopes they hold
      // themselves, so `team:invite` alone is not a way to widen an agent past
      // its editor.
      .handleRaw("update", ({ params, request }) =>
        Effect.gen(function* () {
          const { organizationId, session } = yield* OrgPrincipal;
          const id = params.id;
          const row = yield* orgRegistration(organizationId, id);
          if (!row) return yield* notFound("Agent registration not found");
          const linkId = row.linkId;
          if (!linkId) {
            return yield* badRequest(
              "Only agents made through a connected platform have scopes to edit.",
            );
          }
          const link = yield* legacy(() => getLink(organizationId, linkId));
          const existing = yield* legacy(() => getLinkAgent(linkId, id));
          if (!link || link.revokedAt || !existing || existing.revokedAt) {
            return yield* conflict("That agent or its platform link has been revoked.");
          }

          const body = yield* fieldsOf(yield* readJsonOr(request, {}));
          const patch: { label?: string; scopes?: string[]; providers?: string[] } = {};
          if (body["label"] !== undefined) {
            const label = typeof body["label"] === "string" ? body["label"].trim() : "";
            if (label.length < 1 || label.length > LABEL_MAX) {
              return yield* badRequest(`\`label\` must be 1 to ${LABEL_MAX} characters.`);
            }
            patch.label = label;
          }
          if (body["scopes"] !== undefined || body["providers"] !== undefined) {
            const grant = yield* linkCall(async () =>
              validateAgentGrant(
                await linkEffectiveScopes(link),
                body["scopes"] ?? existing.scopes ?? [],
                body["providers"] !== undefined ? body["providers"] : (existing.providers ?? []),
              ),
            );
            const unknown = yield* linkCall(() => unknownProviders(grant.providers));
            if (unknown.length > 0) {
              return yield* refuse(400, {
                error: `Unknown providers: ${unknown.join(", ")}`,
                code: "invalid_provider",
              });
            }
            // The editor's own role, without break-glass elevation: an
            // elevation is authority for a bounded window and must not become
            // a standing grant on an agent.
            const granted = yield* linkCall(() =>
              grantablePermissions(organizationId, session.userId),
            );
            const before = existing.scopes ?? [];
            const beforeProviders = existing.providers ?? [];
            // Widening the providers widens every scope it applies to, so it
            // counts as adding them: clearing the list (every provider) or
            // naming a new one.
            const providersWidened =
              beforeProviders.length > 0 &&
              (grant.providers.length === 0 ||
                grant.providers.some((p) => !beforeProviders.includes(p)));
            const added = providersWidened
              ? grant.scopes
              : grant.scopes.filter((s) => !before.includes(s));
            const beyondEditor = added.filter((s) => !hasPermission(granted, s));
            if (beyondEditor.length > 0) {
              return yield* refuse(400, {
                error: `You cannot grant: ${beyondEditor.join(", ")}`,
                code: "scope_not_allowed",
                scopes: beyondEditor,
              });
            }
            patch.scopes = grant.scopes;
            patch.providers = grant.providers;
          }
          yield* linkCall(() => updatePlatformAgent(id, patch));
          yield* fireAndForget(() =>
            logAudit({
              organizationId,
              userId: session.userId,
              action: "agent.update",
              entityType: "agent_registration",
              entityId: id,
              metadata: { linkId: link.id, by: "member", ...patch },
            }),
          );
          const updated = yield* linkCall(() => getLinkAgent(link.id, id));
          return yield* respond(PlatformAgentEnvelope)({
            agent: serializeAgent(updated ?? existing),
          });
        }),
      )
      // Revoke, not delete. The row is how an audit entry naming this agent
      // stays legible, and how "what did that thing do before we cut it off"
      // remains answerable: `resolveAgentPrincipal` refuses a revoked row on
      // the next request, which is what actually ends the access. Gated on
      // `team:invite` because revoking an agent is the same class of act as
      // removing a member, and `team:read` must not be enough to do it.
      .handle("revoke", ({ params }) =>
        Effect.gen(function* () {
          const { organizationId, session } = yield* OrgPrincipal;
          const id = params.id;
          // Scoped to the org before the update: without this, any org's admin
          // could revoke any registration whose id they happened to learn.
          const row = yield* orgRegistration(organizationId, id);
          if (!row) return yield* notFound("Agent registration not found");
          const revoked = yield* legacy(() => revokeAgentRegistration(id));
          yield* fireAndForget(() =>
            logAudit({
              organizationId,
              userId: session.userId,
              action: "agent.revoke",
              entityType: "agent_registration",
              entityId: id,
              metadata: { alreadyRevoked: !revoked },
            }),
          );
          return yield* respond(AgentRevoked)({ ok: true, revoked });
        }),
      ),
);

export const agentRegistrationsDomain = makeDomain(
  "agent-registrations",
  AgentRegistrationsApi,
  AgentRegistrationsHandlers,
);
