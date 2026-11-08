/**
 * Agent links on the org tree: `/api/org/:orgId/agent-links`, the handlers.
 */
import { Effect, Schema } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { getLink, listOrgLinks, revokeLink } from "@infrawrench/server-core/agent-links/links";
import { logAudit } from "../../../services/audit";
import { buildOrgLinkSummary } from "../../../services/agent-links";
import { makeDomain } from "../../domain";
import { notFound } from "../../errors";
import { fireAndForget, legacy } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";
import { AgentLinkRevoked, AgentLinksApi, AgentLinkSummary } from "./api";

const AgentLinksHandlers = HttpApiBuilder.group(AgentLinksApi, "agentLinks", (handlers) =>
  handlers
    .handle("list", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const summaries = yield* legacy(async () => {
          const rows = await listOrgLinks(organizationId);
          return Promise.all(rows.map((row) => buildOrgLinkSummary(row)));
        });
        return yield* respond(Schema.Array(AgentLinkSummary))(summaries);
      }),
    )
    // Revoke the link and its agents.
    .handle("revoke", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        // Scoped to the org before the update, so an id learned elsewhere is a 404.
        const link = yield* legacy(() => getLink(organizationId, params.id));
        if (!link) return yield* notFound("Agent link not found");
        const revoked = yield* legacy(() => revokeLink(link.id));
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "agent_link.revoke",
            entityType: "agent_link",
            entityId: link.id,
            metadata: { platform: link.platform, by: "member", alreadyRevoked: !revoked },
          }),
        );
        return yield* respond(AgentLinkRevoked)({ ok: true, revoked });
      }),
    ),
);

export const agentLinksDomain = makeDomain("agent-links", AgentLinksApi, AgentLinksHandlers);
