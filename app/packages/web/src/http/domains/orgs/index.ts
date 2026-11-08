/**
 * Organization creation: `POST /api/orgs`, the handler. The caller becomes the
 * owner; the system roles, the default Home dashboard and the default
 * scorecard are seeded with it.
 */
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { v4 as uuid } from "uuid";
import { ensureSystemRoles, getSystemRole } from "@infrawrench/server-core/permissions";
import { ensureDefaultScorecard } from "@infrawrench/server-core/scorecards/store";
import { badRequest, Organization, OrgsApi } from "@infrawrench/api-contract";
import { db } from "../../../db/client";
import { dashboards, organizationMembers, organizations } from "../../../db/schema";
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

      const orgId = uuid();
      yield* legacy(() => db.insert(organizations).values({ id: orgId, displayName }));

      yield* legacy(() => ensureSystemRoles(orgId));
      const ownerRole = yield* legacy(() => getSystemRole(orgId, "owner"));

      yield* legacy(() =>
        db.insert(organizationMembers).values({
          id: uuid(),
          userId: session.userId,
          organizationId: orgId,
          role: "owner",
          roleId: ownerRole.id,
        }),
      );

      // Seed the default Home dashboard so it's already in the sidebar's
      // dashboard list when the client lands on the new org.
      yield* legacy(() =>
        db.insert(dashboards).values({
          id: uuid(),
          organizationId: orgId,
          name: "Home",
          isDefault: true,
        }),
      );

      // Seed the default scorecard so the first service is graded against
      // something. Best-effort: an org without it seeds lazily on first read.
      yield* legacy(() =>
        ensureDefaultScorecard(orgId).catch((err: unknown) =>
          console.error("[orgs] default scorecard seed failed:", err),
        ),
      );

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
