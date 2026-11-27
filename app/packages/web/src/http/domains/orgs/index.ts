/**
 * Organization creation: `POST /api/orgs`, the handler. The caller becomes the
 * owner; the system roles, the default Home dashboard and the default
 * scorecard are seeded with it (server-core `organizations/create.ts`).
 */
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { createOrganization } from "@infrawrench/server-core/organizations/create";
import { badRequest, Organization, OrgsApi } from "@infrawrench/api-contract";
import { makeDomain } from "../../domain";
import { fieldsOf, readJson, trimmedField } from "../../request-body";
import { legacy } from "../../legacy";
import { guardSessionPrefixes } from "../../prefix-guard";
import { SessionPrincipal } from "../../principal";
import { respond } from "../../response";

const OrgsHandlers = HttpApiBuilder.group(OrgsApi, "orgs", (handlers) =>
  handlers.handleRaw("create", ({ request }) =>
    Effect.gen(function* () {
      const session = yield* SessionPrincipal;
      const body = yield* readJson(request).pipe(Effect.flatMap(fieldsOf));
      const displayName = yield* trimmedField(body["displayName"], "displayName");
      if (!displayName) return yield* badRequest("Organization name is required");

      // Roles, the owner, the Home dashboard and the default scorecard: the
      // same call a workspace paid for from git.infrawrench.com makes.
      const created = yield* legacy(() =>
        createOrganization({ displayName, ownerUserId: session.userId }),
      );
      // A new id is never someone else's organization.
      if (!created.ok) return yield* Effect.die(new Error("A new organization id was taken"));
      const orgId = created.id;

      return yield* respond(Organization)({ id: orgId, displayName });
    }),
  ),
);

/**
 * Every other path and method under `/api/orgs` needs a person's session
 * first, as the Hono mount's `use("/orgs/*", sessionMiddleware)` did.
 */
export const orgsDomain = guardSessionPrefixes(makeDomain("orgs", OrgsApi, OrgsHandlers), [
  "/api/orgs",
]);
