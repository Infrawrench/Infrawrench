/**
 * Starred items: `/api/org/:orgId/starred`, the handlers.
 *
 * Personal and private, like push preferences: every query is keyed by the
 * session's user, so there is no permission to check beyond membership (the
 * org middleware) and nothing to audit. What a star may point at is checked
 * instead: starring resolves the object exactly as the palette's search does,
 * so only something the caller could open can be starred, and the listing
 * re-resolves every star on each read, leaving out any the caller can no
 * longer open.
 */
import { randomUUID } from "node:crypto";
import { Effect, Schema } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { and, count, desc, eq } from "drizzle-orm";
import {
  MAX_STARRED_ITEMS,
  isSearchResultKind,
  starKey,
  type SearchResult,
  type StarRef,
  type StarredItem as StarredItemValue,
} from "@infrawrench/client-core";
import { db } from "../../../db/client";
import { starredItems } from "../../../db/schema";
import { resolvePaletteRefs } from "../../../services/palette-search";
import { makeDomain } from "../../domain";
import { badRequest, conflict, notFound } from "../../errors";
import { legacy } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";
import { ok } from "../../schemas/common";
import { StarredItem } from "../../schemas/search";
import { StarredApi } from "./api";

function parseRef(kind: string, id: string): StarRef | null {
  if (!isSearchResultKind(kind) || !id || id.length > 512) return null;
  return { kind, id };
}

const starOf = (hit: SearchResult, ref: StarRef, starredAt: Date): StarredItemValue => ({
  ...hit,
  kind: ref.kind,
  starredAt: starredAt.toISOString(),
});

async function listStars(
  organizationId: string,
  userId: string,
  permissions: readonly string[],
): Promise<StarredItemValue[]> {
  const rows = await db
    .select({
      kind: starredItems.kind,
      objectId: starredItems.objectId,
      createdAt: starredItems.createdAt,
    })
    .from(starredItems)
    .where(and(eq(starredItems.organizationId, organizationId), eq(starredItems.userId, userId)))
    .orderBy(desc(starredItems.createdAt));
  const refs = rows.map((r) => ({ kind: r.kind, id: r.objectId }));
  const hits = await resolvePaletteRefs(organizationId, [...permissions], refs);
  const items: StarredItemValue[] = [];
  for (const row of rows) {
    const ref = { kind: row.kind, id: row.objectId };
    const hit = hits.get(starKey(ref));
    if (!hit) continue;
    items.push(starOf(hit, ref, row.createdAt));
  }
  return items;
}

type StarOutcome =
  | { readonly kind: "starred"; readonly item: StarredItemValue }
  | { readonly kind: "not_found" }
  | { readonly kind: "full" };

async function starObject(
  organizationId: string,
  userId: string,
  permissions: readonly string[],
  ref: StarRef,
): Promise<StarOutcome> {
  const hit = (await resolvePaletteRefs(organizationId, [...permissions], [ref])).get(starKey(ref));
  // Not found and not visible read the same, the sharing 404 rule: a star
  // must not confirm that an object the caller cannot open exists.
  if (!hit) return { kind: "not_found" };

  const [existing] = await db
    .select({ createdAt: starredItems.createdAt })
    .from(starredItems)
    .where(
      and(
        eq(starredItems.organizationId, organizationId),
        eq(starredItems.userId, userId),
        eq(starredItems.kind, ref.kind),
        eq(starredItems.objectId, ref.id),
      ),
    );
  let starredAt = existing?.createdAt;
  if (!starredAt) {
    const [{ n } = { n: 0 }] = await db
      .select({ n: count() })
      .from(starredItems)
      .where(and(eq(starredItems.organizationId, organizationId), eq(starredItems.userId, userId)));
    if (n >= MAX_STARRED_ITEMS) return { kind: "full" };
    const now = new Date();
    await db
      .insert(starredItems)
      .values({
        id: randomUUID(),
        organizationId,
        userId,
        kind: ref.kind,
        objectId: ref.id,
        createdAt: now,
      })
      .onConflictDoNothing();
    starredAt = now;
  }
  return { kind: "starred", item: starOf(hit, ref, starredAt) };
}

async function unstarObject(organizationId: string, userId: string, ref: StarRef): Promise<void> {
  await db
    .delete(starredItems)
    .where(
      and(
        eq(starredItems.organizationId, organizationId),
        eq(starredItems.userId, userId),
        eq(starredItems.kind, ref.kind),
        eq(starredItems.objectId, ref.id),
      ),
    );
}

const StarredHandlers = HttpApiBuilder.group(StarredApi, "starred", (handlers) =>
  handlers
    .handle("list", () =>
      Effect.gen(function* () {
        const { organizationId, session, permissions } = yield* OrgPrincipal;
        const items = yield* legacy(() => listStars(organizationId, session.userId, permissions));
        return yield* respond(Schema.Struct({ items: Schema.Array(StarredItem) }))({ items });
      }),
    )
    .handle("star", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId, session, permissions } = yield* OrgPrincipal;
        const ref = parseRef(params.kind, params.objectId);
        if (!ref) return yield* badRequest("Unknown kind");
        const outcome = yield* legacy(() =>
          starObject(organizationId, session.userId, permissions, ref),
        );
        switch (outcome.kind) {
          case "not_found":
            return yield* notFound();
          case "full":
            return yield* conflict(
              `You can star up to ${MAX_STARRED_ITEMS} items in an organization. Unstar something first.`,
            );
          case "starred":
            return yield* respond(Schema.Struct({ item: StarredItem }))({ item: outcome.item });
        }
      }),
    )
    .handle("unstar", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const ref = parseRef(params.kind, params.objectId);
        if (!ref) return yield* badRequest("Unknown kind");
        // Idempotent, and deliberately not visibility-checked: a member must be
        // able to clear a star on something they can no longer see.
        yield* legacy(() => unstarObject(organizationId, session.userId, ref));
        return ok;
      }),
    ),
);

export const starredDomain = makeDomain("starred", StarredApi, StarredHandlers);
