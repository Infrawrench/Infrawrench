/**
 * Starred items: a member's personal shortlist of objects, listed first in the
 * command palette's empty state and togglable from an object's page header.
 *
 * Per user **and** per org (a member of two orgs stars in each separately) and
 * private to that user: nothing about a star is visible to anyone else, which
 * is why the routes need no permission beyond membership and write no audit
 * rows (a preference is not an action on the org's configuration).
 *
 * `(kind, object_id)` is **not** a foreign key, by design: it spans eighteen
 * tables, and a star on an object the member can no longer open (deleted,
 * unshared, outside a newly applied cost visibility scope) is filtered out at
 * read time rather than deleted, so access coming back brings the star back.
 * Orphans are bounded by the per-member cap (`MAX_STARRED_ITEMS`).
 *
 * Lives in its own module (importing only `core-schema.js`) and is re-exported
 * from `schema.ts`, the satellite-schema convention.
 */
import { pgTable, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import type { SearchResultKind } from "@infrawrench/client-core";

import { organizations, users } from "./core-schema.js";

export const starredItems = pgTable(
  "starred_items",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** A `SearchResultKind`: `resource`, `workflow`, `cost_report`, … */
    kind: text("kind").$type<SearchResultKind>().notNull(),
    /** The object's id in its own table. Not a FK, see above. */
    objectId: text("object_id").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    memberObjectUnique: uniqueIndex("starred_items_member_object_unique").on(
      t.organizationId,
      t.userId,
      t.kind,
      t.objectId,
    ),
    memberIdx: index("starred_items_member_idx").on(t.organizationId, t.userId, t.createdAt),
  }),
);
