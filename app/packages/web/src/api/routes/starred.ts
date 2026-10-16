import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { and, count, desc, eq } from "drizzle-orm";
import {
  MAX_STARRED_ITEMS,
  isSearchResultKind,
  starKey,
  type StarRef,
  type StarredItem,
} from "@infrawrench/client-core";
import { db } from "../../db/client";
import { starredItems } from "../../db/schema";
import { resolvePaletteRefs } from "../../services/palette-search";

/**
 * `/api/org/:orgId/starred`: the caller's own starred objects in this org.
 *
 * Personal and private, like push preferences: every query is keyed by the
 * session's user, so there is no permission to check beyond membership (the
 * org middleware) and nothing to audit. What a star may point at is checked
 * instead: starring resolves the object exactly as the palette's search does,
 * so only something the caller could open can be starred, and the listing
 * re-resolves every star on each read, leaving out any the caller can no
 * longer open.
 */
const app = new Hono();

function parseRef(kind: string, id: string): StarRef | null {
  if (!isSearchResultKind(kind) || !id || id.length > 512) return null;
  return { kind, id };
}

app.get("/", async (c) => {
  const organizationId = c.get("organizationId");
  const userId = c.get("session").userId;
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
  const hits = await resolvePaletteRefs(organizationId, c.get("permissions") ?? [], refs);
  const items: StarredItem[] = [];
  for (const row of rows) {
    const hit = hits.get(starKey({ kind: row.kind, id: row.objectId }));
    if (!hit) continue;
    items.push({ ...hit, kind: row.kind, starredAt: row.createdAt.toISOString() });
  }
  return c.json({ items });
});

app.put("/:kind/:objectId", async (c) => {
  const organizationId = c.get("organizationId");
  const userId = c.get("session").userId;
  const ref = parseRef(c.req.param("kind"), c.req.param("objectId"));
  if (!ref) return c.json({ error: "Unknown kind" }, 400);

  const hit = (await resolvePaletteRefs(organizationId, c.get("permissions") ?? [], [ref])).get(
    starKey(ref),
  );
  // Not found and not visible read the same, the sharing 404 rule: a star
  // must not confirm that an object the caller cannot open exists.
  if (!hit) return c.json({ error: "Not found" }, 404);

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
    if (n >= MAX_STARRED_ITEMS) {
      return c.json(
        {
          error: `You can star up to ${MAX_STARRED_ITEMS} items in an organization. Unstar something first.`,
        },
        409,
      );
    }
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
  const item: StarredItem = { ...hit, kind: ref.kind, starredAt: starredAt.toISOString() };
  return c.json({ item });
});

app.delete("/:kind/:objectId", async (c) => {
  const organizationId = c.get("organizationId");
  const userId = c.get("session").userId;
  const ref = parseRef(c.req.param("kind"), c.req.param("objectId"));
  if (!ref) return c.json({ error: "Unknown kind" }, 400);
  // Idempotent, and deliberately not visibility-checked: a member must be
  // able to clear a star on something they can no longer see.
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
  return c.json({ ok: true });
});

export { app as starredRoutes };
