/**
 * Leaked credentials: findings a scanner plugin (`manifest.secretScanning`)
 * reported, attributed to what Infrawrench holds, and the per-account scan
 * schedule that fetches them.
 *
 * Satellite-schema convention: imports only `core-schema.js`, re-exported
 * from `schema.ts`.
 *
 * No column holds a secret. `fingerprint` is a keyed hash (`keyedHash`, a
 * sub-key of the master key, domain-separated per org) so a database-only
 * leak yields nothing that can be checked offline, and `secret_hint` keeps at
 * most the first and last four characters, which the scanner already shows.
 */
import {
  pgTable,
  text,
  boolean,
  integer,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { accounts, organizations, users } from "./core-schema.js";

export const leakedSecrets = pgTable(
  "leaked_secrets",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    scannerAccountId: text("scanner_account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    scannerPluginId: text("scanner_plugin_id").notNull(),
    /** The scanner's stable id for the finding (`LeakedSecretFinding.ref`). */
    externalRef: text("external_ref").notNull(),
    tokenType: text("token_type").notNull(),
    tokenTypeLabel: text("token_type_label"),
    /** Plugin whose `tokenFormats` claim the token type. */
    ownerPluginId: text("owner_plugin_id"),
    tokenFormatId: text("token_format_id"),
    /** Keyed hash of the leaked value; null when the scanner withheld it. */
    fingerprint: text("fingerprint"),
    secretHint: text("secret_hint"),
    repository: text("repository"),
    path: text("path"),
    line: integer("line"),
    commitSha: text("commit_sha"),
    upstreamUrl: text("upstream_url"),
    /** "open" | "resolved", as the scanner reports it. */
    upstreamState: text("upstream_state").notNull().default("open"),
    upstreamResolution: text("upstream_resolution"),
    /** "active" | "inactive" | "unknown" */
    validity: text("validity"),
    publiclyLeaked: boolean("publicly_leaked").notNull().default(false),
    detectedAt: timestamp("detected_at").notNull(),
    firstSeenAt: timestamp("first_seen_at").notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at").notNull().defaultNow(),
    /** "account" | "secret-field" | "output" | "none" */
    matchKind: text("match_kind").notNull().default("none"),
    /** "fingerprint" | "token-type" | "none" */
    matchConfidence: text("match_confidence").notNull().default("none"),
    matchedAccountId: text("matched_account_id").references(() => accounts.id, {
      onDelete: "set null",
    }),
    matchedPluginId: text("matched_plugin_id"),
    /** Not a FK: the `resource_changes` stance, a finding outlives a resync. */
    matchedResourceId: text("matched_resource_id"),
    matchedResourceTypeId: text("matched_resource_type_id"),
    matchedFieldKey: text("matched_field_key"),
    candidateAccountIds: text("candidate_account_ids")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** "open" | "rotated" | "dismissed" | "resolved" */
    status: text("status").notNull().default("open"),
    rotatedAt: timestamp("rotated_at"),
    rotatedByUserId: text("rotated_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    /** "reissued" | "replaced" | "detected" | "manual" */
    rotationMethod: text("rotation_method"),
    /** "false-positive" | "wont-fix" | "used-in-tests" */
    dismissedReason: text("dismissed_reason"),
    dismissedComment: text("dismissed_comment"),
    dismissedAt: timestamp("dismissed_at"),
    dismissedByUserId: text("dismissed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    upstreamResolvedAt: timestamp("upstream_resolved_at"),
    upstreamResolveError: text("upstream_resolve_error"),
    /** Claim column for the alert: set when routed, cleared if nobody heard. */
    notifiedAt: timestamp("notified_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    findingUnique: uniqueIndex("leaked_secrets_finding_unique").on(
      t.scannerAccountId,
      t.externalRef,
    ),
    orgStatusIdx: index("leaked_secrets_org_status_idx").on(t.organizationId, t.status),
    matchedAccountIdx: index("leaked_secrets_matched_account_idx").on(t.matchedAccountId),
  }),
);

/** One row per scanner account: when it is next due and how the last scan went. */
export const leakedSecretScans = pgTable(
  "leaked_secret_scans",
  {
    accountId: text("account_id")
      .primaryKey()
      .references(() => accounts.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Due time and claim lease in one column (the `alerts/pass.ts` idiom). */
    nextScanAt: timestamp("next_scan_at").notNull().defaultNow(),
    lastScannedAt: timestamp("last_scanned_at"),
    lastError: text("last_error"),
    lastCount: integer("last_count"),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    dueIdx: index("leaked_secret_scans_due_idx").on(t.nextScanAt),
  }),
);
