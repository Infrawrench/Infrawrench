/**
 * Tag keys: `/api/org/:orgId/tag-keys`, the handlers. The stores are promise
 * code and run through `legacy`, inside the request's scopes.
 */
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { tagKeySettingsError } from "@infrawrench/client-core";
import { TagKeySettings } from "@infrawrench/api-contract/schemas";
import {
  getOrgTagKeySettings,
  setOrgTagKeySettings,
} from "@infrawrench/server-core/cost/tag-key-settings";
import { badRequest, DiscoveredTagKeys, TagKeysApi } from "@infrawrench/api-contract";
import { logAudit } from "../../../services/audit";
import { discoverTagKeys } from "../../../services/tag-keys";
import { makeDomain } from "../../domain";
import { fireAndForget, legacy } from "../../legacy";
import { holdsPermission, OrgPrincipal } from "../../principal";
import { respond } from "../../response";

const TagKeysHandlers = HttpApiBuilder.group(TagKeysApi, "tagKeys", (handlers) =>
  handlers
    .handle("list", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        // The inventory half is `resources:read`; the cost half needs `costs:read` too.
        const includeCosts = yield* holdsPermission("costs:read");
        const discovered = yield* legacy(() => discoverTagKeys(organizationId, { includeCosts }));
        return yield* respond(DiscoveredTagKeys)(discovered);
      }),
    )
    .handle("getSettings", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const settings = yield* legacy(() => getOrgTagKeySettings(organizationId));
        return yield* respond(TagKeySettings)(settings);
      }),
    )
    .handle("setSettings", ({ payload }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        // The cross-list rule (a key both hidden and preferred), after the shape.
        const conflict = tagKeySettingsError(payload);
        if (conflict) return yield* badRequest(conflict);

        const settings = yield* legacy(() => setOrgTagKeySettings(organizationId, payload));
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "tag_key_settings.update",
            entityType: "tag_key_settings",
            entityId: organizationId,
            metadata: { hidden: settings.hidden, preferred: settings.preferred },
          }),
        );
        return yield* respond(TagKeySettings)(settings);
      }),
    ),
);

export const tagKeysDomain = makeDomain("tag-keys", TagKeysApi, TagKeysHandlers);
