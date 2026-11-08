/**
 * Environment diff: `/api/org/:orgId/environment-diff`, the handlers.
 */
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import {
  loadEnvironmentDiff,
  EnvironmentDiffAccountNotFoundError,
  EnvironmentDiffPluginMismatchError,
} from "@infrawrench/server-core/environment-diff";
import {
  BadRequest,
  badRequest,
  EnvironmentDiffApi,
  EnvironmentDiffResponse,
  NotFound,
} from "@infrawrench/api-contract";
import { makeDomain } from "../../domain";
import { legacyTry } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";

const EnvironmentDiffHandlers = HttpApiBuilder.group(
  EnvironmentDiffApi,
  "environmentDiff",
  (handlers) =>
    handlers.handle("get", ({ query }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const { a, b } = query;
        if (!a || !b) return yield* badRequest("Both a and b account ids are required");
        if (a === b) return yield* badRequest("a and b must be different accounts");

        const diff = yield* legacyTry(
          () =>
            loadEnvironmentDiff(organizationId, a, b, {
              resourceTypeId: query.resourceTypeId,
              includeIdentityFields: query.includeIdentityFields === "true",
            }),
          // Both are user-input problems, not server faults: an id that isn't
          // this org's, and two accounts that can't meaningfully be compared.
          (error) =>
            error instanceof EnvironmentDiffAccountNotFoundError
              ? new NotFound({ error: error.message })
              : error instanceof EnvironmentDiffPluginMismatchError
                ? new BadRequest({ error: error.message })
                : undefined,
        );
        return yield* respond(EnvironmentDiffResponse)(diff);
      }),
    ),
);

export const environmentDiffDomain = makeDomain(
  "environment-diff",
  EnvironmentDiffApi,
  EnvironmentDiffHandlers,
);
