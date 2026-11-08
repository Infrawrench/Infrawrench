/**
 * Cloud-credit burndown: `/api/org/:orgId/credits`, the handler: every
 * prepaid pot the org holds, most urgent first.
 */
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { getCreditBurndown } from "@infrawrench/server-core/credits/feed";
import { CreditBurndown, CreditsApi } from "@infrawrench/api-contract";
import { makeDomain } from "../../domain";
import { legacy } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";

const CreditsHandlers = HttpApiBuilder.group(CreditsApi, "credits", (handlers) =>
  handlers.handle("burndown", () =>
    Effect.gen(function* () {
      const { organizationId } = yield* OrgPrincipal;
      const burndown = yield* legacy(() => getCreditBurndown(organizationId));
      return yield* respond(CreditBurndown)(burndown);
    }),
  ),
);

export const creditsDomain = makeDomain("credits", CreditsApi, CreditsHandlers);
