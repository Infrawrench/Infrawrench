/**
 * Commitments: `/api/org/:orgId/commitments`, the handler: holdings, the
 * coverage range, utilization and recommendations, read inside the caller's
 * cost visibility scope.
 */
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { getCommitmentsFeed } from "@infrawrench/server-core/commitments/feed";
import { CommitmentsApi, CommitmentsFeed } from "@infrawrench/api-contract";
import { makeDomain } from "../../domain";
import { legacy } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";

const CommitmentsHandlers = HttpApiBuilder.group(CommitmentsApi, "commitments", (handlers) =>
  handlers.handle("feed", () =>
    Effect.gen(function* () {
      const { organizationId } = yield* OrgPrincipal;
      const feed = yield* legacy(() => getCommitmentsFeed(organizationId));
      return yield* respond(CommitmentsFeed)(feed);
    }),
  ),
);

export const commitmentsDomain = makeDomain("commitments", CommitmentsApi, CommitmentsHandlers);
