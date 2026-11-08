/**
 * Carbon estimate: `GET /api/org/:orgId/carbon`, the handler. The estimate is
 * assembled in server-core (`cost/carbon.ts`), which needs plugin clients to
 * resolve instance types to vCPU counts.
 */
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { CARBON_LIMITS } from "@infrawrench/client-core";
import { getCarbonEstimate } from "@infrawrench/server-core/cost/carbon";
import { makeDomain } from "../../domain";
import { badRequest } from "../../errors";
import { legacy } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";
import { CarbonApi, CarbonEstimate } from "./api";

const CarbonHandlers = HttpApiBuilder.group(CarbonApi, "carbon", (handlers) =>
  handlers.handle("estimate", ({ query }) =>
    Effect.gen(function* () {
      const raw = query.windowDays;
      const windowDays = raw === undefined ? undefined : Number(raw);
      if (
        windowDays !== undefined &&
        (!Number.isInteger(windowDays) ||
          windowDays < CARBON_LIMITS.minWindowDays ||
          windowDays > CARBON_LIMITS.maxWindowDays)
      ) {
        return yield* badRequest(
          `windowDays must be a whole number between ${CARBON_LIMITS.minWindowDays} and ${CARBON_LIMITS.maxWindowDays}`,
        );
      }
      const { organizationId } = yield* OrgPrincipal;
      const estimate = yield* legacy(() =>
        getCarbonEstimate(organizationId, windowDays === undefined ? {} : { windowDays }),
      );
      return yield* respond(CarbonEstimate)(estimate);
    }),
  ),
);

export const carbonDomain = makeDomain("carbon", CarbonApi, CarbonHandlers);
