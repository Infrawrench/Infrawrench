/**
 * Bastions: `/api/org/:orgId/bastions`, the handlers.
 */
import { randomBytes } from "node:crypto";
import { Effect, Predicate, Schema } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { v4 as uuid } from "uuid";
import { eq, and, count } from "drizzle-orm";
import { bastionLiveStatuses } from "@infrawrench/server-core/bastion/registry";
import {
  badRequest,
  Bastion,
  BastionsApi,
  CreateBastionResponse,
  notFound,
  ok,
} from "@infrawrench/api-contract";
import { db } from "../../../db/client";
import { bastionVms, accounts } from "../../../db/schema";
import { logAudit } from "../../../services/audit";
import { keyedHash } from "../../../services/encryption";
import { makeDomain } from "../../domain";
import { fieldsOf, readJson } from "../../request-body";
import { fireAndForget, legacy } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";

const BASTION_TOKEN_HASH_DOMAIN = "bastion-agent";

async function listBastions(organizationId: string) {
  const rows = await db
    .select({
      id: bastionVms.id,
      name: bastionVms.name,
      tokenPrefix: bastionVms.tokenPrefix,
      agentVersion: bastionVms.agentVersion,
      lastSeenAt: bastionVms.lastSeenAt,
      status: bastionVms.status,
      revokedAt: bastionVms.revokedAt,
      createdAt: bastionVms.createdAt,
      createdByUserId: bastionVms.createdByUserId,
    })
    .from(bastionVms)
    .where(eq(bastionVms.organizationId, organizationId))
    .orderBy(bastionVms.createdAt);

  // Cross-reference the in-memory registry so "connected" is live, not stale.
  const accountCounts = await db
    .select({ bastionId: accounts.bastionId, count: count() })
    .from(accounts)
    .where(eq(accounts.organizationId, organizationId))
    .groupBy(accounts.bastionId);
  const countByBastion = new Map<string, number>();
  for (const r of accountCounts) {
    if (r.bastionId) countByBastion.set(r.bastionId, Number(r.count));
  }

  // Connected here or to the realtime relay, where production agents connect.
  const live = await bastionLiveStatuses(rows.map((r) => r.id));

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    tokenPrefix: r.tokenPrefix,
    agentVersion: live.get(r.id)?.agentVersion ?? r.agentVersion,
    lastSeenAt: r.lastSeenAt?.toISOString() ?? null,
    status: r.status,
    revokedAt: r.revokedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    createdByUserId: r.createdByUserId,
    connected: live.get(r.id)?.connected ?? false,
    accountCount: countByBastion.get(r.id) ?? 0,
  }));
}

/**
 * Register a bastion. The one-time enrollment token is returned here and
 * never again: only its keyed hash is stored.
 */
async function createBastion(organizationId: string, userId: string, name: string) {
  const raw = randomBytes(32);
  const token = `iwb_${raw.toString("base64url")}`;
  const hashedToken = await keyedHash(token, BASTION_TOKEN_HASH_DOMAIN);
  const tokenPrefix = token.slice(0, 12);
  const id = uuid();
  await db.insert(bastionVms).values({
    id,
    organizationId,
    createdByUserId: userId,
    name,
    hashedToken,
    tokenPrefix,
    status: "pending",
  });
  return { id, name, token, tokenPrefix };
}

const BastionsHandlers = HttpApiBuilder.group(BastionsApi, "bastions", (handlers) =>
  handlers
    .handleRaw("create", ({ request }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const { name } = yield* fieldsOf(yield* readJson(request));
        if (!Predicate.isString(name) || !name.trim()) return yield* badRequest("Name is required");
        const trimmed = name.trim();
        const created = yield* legacy(() => createBastion(organizationId, session.userId, trimmed));
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "bastion.create",
            entityType: "bastion",
            entityId: created.id,
            metadata: { name: trimmed },
          }),
        );
        return yield* respond(CreateBastionResponse)(created);
      }),
    )
    .handle("list", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const bastions = yield* legacy(() => listBastions(organizationId));
        return yield* respond(Schema.Array(Bastion))(bastions);
      }),
    )
    /** Accounts referencing the bastion have `bastionId` set NULL by the FK. */
    .handle("revoke", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const result = yield* legacy(() =>
          db
            .delete(bastionVms)
            .where(and(eq(bastionVms.id, params.id), eq(bastionVms.organizationId, organizationId)))
            .returning({ id: bastionVms.id }),
        );
        if (result.length === 0) return yield* notFound("Bastion not found");
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "bastion.revoke",
            entityType: "bastion",
            entityId: params.id,
          }),
        );
        return ok;
      }),
    ),
);

export const bastionsDomain = makeDomain("bastions", BastionsApi, BastionsHandlers);
