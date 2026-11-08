/**
 * Tag policy: `/api/org/:orgId/tag-policy`, the handlers. The stores are
 * promise code and run through `legacy`, inside the request's scopes.
 */
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { TagPolicy } from "@infrawrench/ui/schemas";
import { getOrgTagPolicy, setOrgTagPolicy } from "@infrawrench/server-core/cost/tag-policy";
import { logAudit } from "../../../services/audit";
import { getAccountTagCompliance } from "../../../services/tag-policy";
import { makeDomain } from "../../domain";
import { fireAndForget, legacy } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";
import { TagComplianceReport, TagPolicyApi } from "./api";

const TagPolicyHandlers = HttpApiBuilder.group(TagPolicyApi, "tagPolicy", (handlers) =>
  handlers
    .handle("get", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const policy = yield* legacy(() => getOrgTagPolicy(organizationId));
        return yield* respond(TagPolicy)(policy);
      }),
    )
    .handle("set", ({ payload }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const policy = yield* legacy(() => setOrgTagPolicy(organizationId, payload));
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "tag_policy.update",
            entityType: "tag_policy",
            entityId: organizationId,
            metadata: {
              requiredKeys: policy.requiredTags.map((t) => t.key),
              enforceOnCreate: policy.enforceOnCreate,
            },
          }),
        );
        return yield* respond(TagPolicy)(policy);
      }),
    )
    /**
     * Per-account compliance scores: the share of each account's tag-capable
     * resources carrying every required tag (with an allowed value where the
     * policy restricts one).
     */
    .handle("compliance", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const [policy, accounts] = yield* legacy(() =>
          Promise.all([getOrgTagPolicy(organizationId), getAccountTagCompliance(organizationId)]),
        );
        return yield* respond(TagComplianceReport)({ policy, accounts });
      }),
    ),
);

export const tagPolicyDomain = makeDomain("tag-policy", TagPolicyApi, TagPolicyHandlers);
