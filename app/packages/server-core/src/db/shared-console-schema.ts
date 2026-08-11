/**
 * Shared consoles — pair-on-prod for a live cloud SSH session.
 *
 * The SSH proxy already holds both ends of the pty (`web/src/services/
 * ssh-proxy.ts` bridges the browser's WebSocket to ssh2), which is the same
 * fact that made session recording a tee rather than an agent. Sharing is the
 * other consumer of that position: fan the output out to more than one socket,
 * and accept input from exactly one of them.
 *
 * Two tables, because a share and the people on it have different lifetimes. A
 * share is created once and revoked once; participants join, leave and swap
 * roles throughout. Folding the participant list into a jsonb column on the
 * share would make the one invariant this feature exists to hold — **one
 * driver at a time** — a thing enforced only by application code, and read-
 * modify-write on a jsonb array is precisely where a handover race lands.
 * Here it is a partial unique index (see {@link sharedConsoleParticipants}),
 * so two simultaneous grants cannot both win no matter which replica served
 * them.
 *
 * Nothing here is an authorisation record. A participant row says a person is
 * *attached*; whether they may be is re-derived from their live permissions on
 * every attach and re-checked while they are on. The invite token is a
 * convenience for finding the session, never a capability — see
 * `shared-console/arbitration.ts`, which is where that is actually decided.
 */
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { organizations, users } from "./core-schema.js";

/**
 * One shared session.
 *
 * `liveConsoleId` is the key of the in-process pty registry on the web replica
 * that actually holds the ssh2 stream; `routingKey` is an opaque string the
 * originating browser minted and put in its own `/api/ws?sid=` query, which
 * the ingress consistently hashes on so a joiner asking for the same `sid`
 * lands on that same replica. Neither is a secret and neither authorises
 * anything: a joiner is admitted on their participant row and their live
 * permissions, and the two keys only answer "which process, and how do I get
 * routed to it".
 *
 * `accountId` / `resourceId` are deliberately not foreign keys, for the same
 * reason the recording tables avoid them: the audit trail a share leaves
 * behind has to survive the resource being deleted.
 */
export const sharedConsoles = pgTable(
  "shared_consoles",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Key of the pty in the holding replica's in-memory registry. */
    liveConsoleId: text("live_console_id").notNull(),
    /** Load-balancer affinity hint; echoed to joiners as `?sid=`. Not a secret. */
    routingKey: text("routing_key").notNull(),
    /** Who opened the underlying session and shared it. */
    ownerUserId: text("owner_user_id").references(() => users.id, { onDelete: "set null" }),
    /** Display-name snapshot, so a departed member still reads as a person. */
    ownerName: text("owner_name"),
    accountId: text("account_id"),
    resourceId: text("resource_id"),
    /** Final hop, as dialled — what the join screen shows before anyone joins. */
    host: text("host").notNull(),
    port: integer("port").notNull().default(22),
    username: text("username").notNull(),
    /**
     * The `ssh_session_recordings` row this session is being taped into, when
     * the org has recording on. No FK: a recording is prunable on the org's
     * retention schedule and a share must not pin it open, nor vanish with it.
     */
    recordingId: text("recording_id"),
    /** sha256 of the outstanding invite. Null once redeemed or withdrawn. */
    inviteTokenHash: text("invite_token_hash"),
    /** First few characters, so the UI can show which invite is outstanding. */
    inviteTokenPrefix: text("invite_token_prefix"),
    inviteExpiresAt: timestamp("invite_expires_at"),
    /** Set when an invite admitted somebody new; the next guest needs a new one. */
    inviteConsumedAt: timestamp("invite_consumed_at"),
    /**
     * Whether anyone but the owner may ever hold the keyboard. False makes the
     * share strictly read-only — the one safety property in this feature that
     * is enforced rather than inferred, and the honest alternative to guessing
     * which commands are dangerous.
     */
    allowHandover: boolean("allow_handover").notNull().default(true),
    /**
     * The pty's geometry, which is the *driver's* geometry. One pty has one
     * size; everyone else letterboxes rather than fighting over it.
     */
    ptyCols: integer("pty_cols").notNull().default(80),
    ptyRows: integer("pty_rows").notNull().default(24),
    /** "active" | "revoked" | "ended" */
    status: text("status").notNull().default("active"),
    revokedByUserId: text("revoked_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    revokedAt: timestamp("revoked_at"),
    /** Set when the underlying SSH session closed on its own. */
    endedAt: timestamp("ended_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    liveConsoleUnique: uniqueIndex("shared_consoles_live_console_unique").on(t.liveConsoleId),
    orgStatusIdx: index("shared_consoles_org_status_idx").on(t.organizationId, t.status),
    orgCreatedIdx: index("shared_consoles_org_created_idx").on(t.organizationId, t.createdAt),
  }),
);

/**
 * A person on a shared console.
 *
 * The **partial unique index** is the load-bearing part of this table: at most
 * one row per share may be a joined driver. A handover is "demote the current
 * driver, promote the new one" inside one transaction, so two concurrent
 * grants against the same share cannot both commit — the loser gets a unique
 * violation, which the route turns into a 409 saying the keyboard already
 * moved. Doing that arbitration in application code alone would be correct
 * only for as long as there is one replica, and there are two.
 *
 * `status` distinguishes a participant who walked away (`left`, may come back
 * on the same row without burning a fresh invite) from one the owner ejected
 * or whose permissions lapsed (`removed`, must be re-invited).
 */
export const sharedConsoleParticipants = pgTable(
  "shared_console_participants",
  {
    id: text("id").primaryKey(),
    sharedConsoleId: text("shared_console_id")
      .notNull()
      .references(() => sharedConsoles.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Display-name snapshot; the participant list has to still name people. */
    userName: text("user_name"),
    /** "observer" | "driver" */
    role: text("role").notNull().default("observer"),
    /** "joined" | "left" | "removed" */
    status: text("status").notNull().default("joined"),
    /** Set when this participant asked for the keyboard and nobody has answered. */
    driverRequestedAt: timestamp("driver_requested_at"),
    /**
     * The viewport this participant last reported. Only ever applied to the
     * pty while they are the driver — an observer's window size is recorded so
     * that a handover to them resizes to something they can read, and ignored
     * until then.
     */
    viewportCols: integer("viewport_cols"),
    viewportRows: integer("viewport_rows"),
    joinedAt: timestamp("joined_at").notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at").notNull().defaultNow(),
    leftAt: timestamp("left_at"),
  },
  (t) => ({
    consoleUserUnique: uniqueIndex("shared_console_participants_console_user_unique").on(
      t.sharedConsoleId,
      t.userId,
    ),
    // One driver at a time, enforced by Postgres rather than by hope.
    oneDriverIdx: uniqueIndex("shared_console_participants_one_driver_idx")
      .on(t.sharedConsoleId)
      .where(sql`${t.role} = 'driver' AND ${t.status} = 'joined'`),
    consoleIdx: index("shared_console_participants_console_idx").on(t.sharedConsoleId),
    orgUserIdx: index("shared_console_participants_org_user_idx").on(t.organizationId, t.userId),
  }),
);
