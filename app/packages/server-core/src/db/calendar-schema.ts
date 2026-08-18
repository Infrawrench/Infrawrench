/**
 * The operations calendar's one table: iCalendar subscriptions.
 *
 * The calendar itself stores nothing. Every event on it — a freeze, a sleep
 * window, a deadline, a commitment term, a scheduled run, an incident — already
 * exists somewhere else, and the feed is recomputed on read exactly as posture
 * findings and backup coverage are, for the same reason: an event has no
 * identity of its own, and materialising one would only create a second thing
 * that can go stale.
 *
 * What *does* need storing is the subscription — a URL someone pasted into
 * Google Calendar eighteen months ago and forgot about, which has to keep
 * working, be attributable, and be revocable.
 *
 * Lives in its own module (importing only `core-schema.js`) and is re-exported
 * from `schema.ts`, the satellite-schema convention.
 */
import { pgTable, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";

import { organizations, users } from "./core-schema.js";

/**
 * One iCalendar subscription URL.
 *
 * **The token is stored hashed**, like an API key, because it is the sole
 * credential on a route that runs outside every auth layer — a calendar client
 * cannot do OAuth, so the URL *is* the authentication. Plain SHA-256 rather
 * than a password KDF is the right call here and only here: the token is 32
 * bytes from `randomBytes`, so there is no low-entropy guess space for a work
 * factor to defend, and the lookup is on the hot path of a route a hundred
 * phones may poll.
 *
 * `userId` is the person who created it and is nulled rather than cascaded when
 * they leave: the feed keeps working, and the org keeps a record that a live
 * subscription exists — the opposite behaviour (silently deleting feeds when
 * someone offboards) is how a team discovers its shared calendar vanished.
 * Revoking is what stops a feed, and that is deliberately explicit.
 *
 * `kinds` is a comma-joined text column, the `backup_policies.resource_type_ids`
 * convention: short opaque identifiers with no commas, only ever read whole.
 * Empty means every kind.
 */
export const calendarSubscriptions = pgTable(
  "calendar_subscriptions",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    /** SHA-256 hex of the 32-byte token that appears in the URL. */
    hashedToken: text("hashed_token").notNull(),
    /** First 8 characters of the token, for identifying a row in the list. */
    prefix: text("prefix").notNull(),
    /** Comma-joined `CalendarEventKind`s; empty means every kind. */
    kinds: text("kinds").notNull().default(""),
    /**
     * Last time the feed was actually fetched. Written best-effort on a
     * throttle rather than on every request — a subscribed client polls hourly
     * forever, and a write per poll would make this table the busiest one in
     * the schema for no gain. Its purpose is answering "is anyone still using
     * this?" before revoking, and an hour of staleness cannot change that
     * answer.
     */
    lastAccessedAt: timestamp("last_accessed_at"),
    /** Set on revoke; the row is kept so the audit trail still resolves. */
    revokedAt: timestamp("revoked_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    hashedTokenUnique: uniqueIndex("calendar_subscriptions_token_unique").on(t.hashedToken),
    orgIdx: index("calendar_subscriptions_org_idx").on(t.organizationId),
  }),
);
