/**
 * The platform-admin surface: `/api/admin`, the handlers. Every request under
 * the prefix, routed or not, checks the allowlist right after the session, as
 * the Hono router's `use("*", platformAdminMiddleware)` did.
 */
import { Effect, Predicate, Schema } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { eq, sql } from "drizzle-orm";
import {
  AdminApi,
  AdminOrganization,
  badRequest,
  ComplimentaryResult,
  FeatureResult,
  forbidden,
  notFound,
} from "@infrawrench/api-contract";
import { featuresByOrg, orgFeatures, setOrgFeature } from "@infrawrench/server-core/features";
import { isPlatformAdmin } from "../../../auth/platform-admin";
import { ensureCiPrices } from "../billing/operations";
import { db } from "../../../db/client";
import { organizationMembers, organizations, subscriptions } from "../../../db/schema";
import { makeDomain } from "../../domain";
import { readJsonOr } from "../../request-body";
import { legacy } from "../../legacy";
import { json } from "../../middleware";
import { guardSessionPrefixes } from "../../prefix-guard";
import { SessionPrincipal } from "../../principal";
import { respond } from "../../response";

/** 403 unless the session's email is on the allowlist. */
const requirePlatformAdmin = Effect.gen(function* () {
  const session = yield* SessionPrincipal;
  if (!isPlatformAdmin(session.email)) return yield* forbidden("Forbidden");
  return session;
});

const AdminHandlers = HttpApiBuilder.group(AdminApi, "admin", (handlers) =>
  handlers
    .handle("listOrganizations", () =>
      Effect.gen(function* () {
        yield* requirePlatformAdmin;
        const rows = yield* legacy(() =>
          db
            .select({
              id: organizations.id,
              displayName: organizations.displayName,
              complimentary: organizations.complimentary,
              createdAt: organizations.createdAt,
              memberCount: sql<number>`(
                select count(*)::int from ${organizationMembers}
                where ${organizationMembers.organizationId} = ${organizations.id}
              )`,
              subscriptionStatus: subscriptions.status,
            })
            .from(organizations)
            .leftJoin(subscriptions, eq(subscriptions.organizationId, organizations.id))
            .orderBy(organizations.createdAt),
        );
        const features = yield* legacy(() => featuresByOrg(rows.map((r) => r.id)));
        return yield* respond(Schema.Array(AdminOrganization))(
          rows.map((r) => ({ ...r, features: features.get(r.id) ?? [] })),
        );
      }),
    )
    .handleRaw("setComplimentary", ({ params, request }) =>
      Effect.gen(function* () {
        const session = yield* requirePlatformAdmin;
        const body = yield* readJsonOr(request, null);
        if (!Predicate.isObject(body) || !Predicate.isBoolean(body["complimentary"])) {
          return yield* badRequest("Body must be { complimentary: boolean }");
        }
        const complimentary = body["complimentary"];

        const [updated] = yield* legacy(() =>
          db
            .update(organizations)
            .set({ complimentary, updatedAt: new Date() })
            .where(eq(organizations.id, params.orgId))
            .returning({ id: organizations.id, complimentary: organizations.complimentary }),
        );
        if (!updated) return yield* notFound("Organization not found");

        console.log(
          `[admin] ${session.email} set complimentary=${updated.complimentary} on org ${updated.id}`,
        );
        return yield* respond(ComplimentaryResult)(updated);
      }),
    )
    .handle("setFeature", ({ params, payload }) =>
      Effect.gen(function* () {
        const session = yield* requirePlatformAdmin;
        const [org] = yield* legacy(() =>
          db
            .select({ id: organizations.id })
            .from(organizations)
            .where(eq(organizations.id, params.orgId))
            .limit(1),
        );
        if (!org) return yield* notFound("Organization not found");
        yield* legacy(() => setOrgFeature(org.id, params.feature, payload.enabled, session.email));
        // CI is billed by metered prices that subscriptions made before CI
        // existed lack. Adding them is best-effort: CI still turns on, and the
        // log says what to fix by hand.
        if (params.feature === "ci" && payload.enabled) {
          yield* legacy(() =>
            ensureCiPrices(org.id).then(
              (added) => {
                if (added.length > 0)
                  console.log(`[admin] added CI prices ${added.join(", ")} to org ${org.id}`);
              },
              (err) =>
                console.error(
                  `[admin] could not add CI prices to org ${org.id}'s subscription:`,
                  err,
                ),
            ),
          );
        }
        console.log(
          `[admin] ${session.email} turned ${params.feature} ${payload.enabled ? "on" : "off"} for org ${org.id}`,
        );
        const features = yield* legacy(() => orgFeatures(org.id));
        return yield* respond(FeatureResult)({ id: org.id, features });
      }),
    ),
);

/**
 * Every other path under `/api/admin` needs a person's session and then the
 * allowlist: a 401 without a session, a 403 off the list, the 404 on it.
 */
export const adminDomain = guardSessionPrefixes(
  makeDomain("admin", AdminApi, AdminHandlers),
  ["/api/admin"],
  (session) => (isPlatformAdmin(session.email) ? undefined : json({ error: "Forbidden" }, 403)),
);
