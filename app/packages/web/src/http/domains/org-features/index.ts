/**
 * `/api/org/:orgId/features`: the organization's rolled-out features.
 */
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { OrgFeatureList, OrgFeaturesApi } from "@infrawrench/api-contract";
import { orgFeatures } from "@infrawrench/server-core/features";
import { makeDomain } from "../../domain";
import { legacy } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";

const OrgFeaturesHandlers = HttpApiBuilder.group(OrgFeaturesApi, "orgFeatures", (handlers) =>
  handlers.handle("list", () =>
    Effect.gen(function* () {
      const { organizationId } = yield* OrgPrincipal;
      const features = yield* legacy(() => orgFeatures(organizationId));
      return yield* respond(OrgFeatureList)({ features });
    }),
  ),
);

export const orgFeaturesDomain = makeDomain("orgFeatures", OrgFeaturesApi, OrgFeaturesHandlers);
