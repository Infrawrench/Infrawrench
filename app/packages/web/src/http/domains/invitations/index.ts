/**
 * Accepting an invitation: `/api/invitations`, the handlers.
 */
import { createHash } from "node:crypto";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { v4 as uuid } from "uuid";
import { and, eq, gt, isNull } from "drizzle-orm";
import {
  ensureSystemRoles,
  getSystemRole,
  isSystemRoleKey,
} from "@infrawrench/server-core/permissions";
import { db } from "../../../db/client";
import { invitations, organizationMembers, organizations } from "../../../db/schema";
import { makeDomain } from "../../domain";
import { badRequest, forbidden, notFound } from "../../errors";
import { fieldsOf, readJson } from "../../json-body";
import { legacy } from "../../legacy";
import { guardSessionPrefixes } from "../../prefix-guard";
import { SessionPrincipal } from "../../principal";
import { respond } from "../../response";
import { workosClient } from "../../workos";
import { AcceptInvitationResponse, InvitationDetail, InvitationsApi } from "./api";

/**
 * The stored hash of an invitation token. `createHash().update()` threw a
 * `TypeError` (a 500) for anything but a string, which a body without a usable
 * `token` still gets.
 */
const hashToken = (raw: unknown): Effect.Effect<string> =>
  typeof raw === "string"
    ? Effect.succeed(createHash("sha256").update(raw).digest("hex"))
    : Effect.die(new TypeError('The "data" argument must be of type string'));

const InvitationsHandlers = HttpApiBuilder.group(InvitationsApi, "invitations", (handlers) =>
  handlers
    .handle("byToken", ({ params }) =>
      Effect.gen(function* () {
        const hashedToken = yield* hashToken(params.token);
        // Only return invites that are still pending and unexpired. Returning the
        // email/org for an already-accepted or expired invite would leak who was
        // invited to which org: treat those as 404.
        const rows = yield* legacy(() =>
          db
            .select({
              id: invitations.id,
              email: invitations.email,
              role: invitations.role,
              expiresAt: invitations.expiresAt,
              acceptedAt: invitations.acceptedAt,
              orgId: invitations.organizationId,
              orgName: organizations.displayName,
            })
            .from(invitations)
            .innerJoin(organizations, eq(invitations.organizationId, organizations.id))
            .where(
              and(
                eq(invitations.hashedToken, hashedToken),
                isNull(invitations.acceptedAt),
                gt(invitations.expiresAt, new Date()),
              ),
            )
            .limit(1),
        );
        const invite = rows[0];
        if (!invite) return yield* notFound("Invitation not found");
        return yield* respond(InvitationDetail)({
          id: invite.id,
          email: invite.email,
          role: invite.role,
          expiresAt: invite.expiresAt,
          acceptedAt: invite.acceptedAt,
          organizationId: invite.orgId,
          organizationName: invite.orgName,
        });
      }),
    )
    .handleRaw("accept", ({ request }) =>
      Effect.gen(function* () {
        const session = yield* SessionPrincipal;
        const body = yield* readJson(request).pipe(Effect.flatMap(fieldsOf));
        const hashedToken = yield* hashToken(body["token"]);

        const rows = yield* legacy(() =>
          db
            .select()
            .from(invitations)
            .where(
              and(
                eq(invitations.hashedToken, hashedToken),
                isNull(invitations.acceptedAt),
                gt(invitations.expiresAt, new Date()),
              ),
            )
            .limit(1),
        );
        const invite = rows[0];
        if (!invite) return yield* badRequest("Invalid or expired invitation");

        if (invite.email !== session.email) {
          return yield* forbidden("This invitation was sent to a different email address");
        }

        // Require the WorkOS user's email to be verified before honoring an invite.
        // Otherwise an attacker who controls a different, similarly-named email
        // could intercept invites by registering with an unverified address.
        const { workos } = yield* workosClient;
        const verified = yield* legacy(async () => {
          try {
            const workosUser = await workos.userManagement.getUser(session.userId);
            return workosUser.emailVerified ? "verified" : "unverified";
          } catch {
            return "unknown";
          }
        });
        if (verified === "unverified") {
          return yield* forbidden("Email address must be verified before accepting invitations");
        }
        if (verified === "unknown") return yield* forbidden("Unable to verify account status");

        yield* legacy(() => ensureSystemRoles(invite.organizationId));
        // Resolve roleId: prefer the explicit invitation roleId; otherwise map the
        // legacy text role to the matching system role.
        let assignedRoleId = invite.roleId;
        if (!assignedRoleId) {
          const key = isSystemRoleKey(invite.role) ? invite.role : "member";
          const sys = yield* legacy(() => getSystemRole(invite.organizationId, key));
          assignedRoleId = sys.id;
        }
        const roleId = assignedRoleId;

        yield* legacy(() =>
          db
            .insert(organizationMembers)
            .values({
              id: uuid(),
              userId: session.userId,
              organizationId: invite.organizationId,
              role: invite.role,
              roleId,
            })
            .onConflictDoNothing(),
        );

        yield* legacy(() =>
          db
            .update(invitations)
            .set({ acceptedAt: new Date() })
            .where(eq(invitations.id, invite.id)),
        );

        const orgRows = yield* legacy(() =>
          db
            .select({ id: organizations.id, displayName: organizations.displayName })
            .from(organizations)
            .where(eq(organizations.id, invite.organizationId))
            .limit(1),
        );
        return yield* respond(AcceptInvitationResponse)({ organization: orgRows[0] });
      }),
    ),
);

/**
 * Every other path under `/api/invitations` needs a person's session first, as
 * the Hono mount's `use("/invitations/*", sessionMiddleware)` did.
 */
export const invitationsDomain = guardSessionPrefixes(
  makeDomain("invitations", InvitationsApi, InvitationsHandlers),
  ["/api/invitations"],
);
