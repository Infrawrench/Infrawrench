/**
 * Weekly digest — data gathering, scheduling, and delivery. The composition
 * itself is pure and lives in `./compose.ts`; this module is everything that
 * touches the database, ClickHouse, and the Slack/Teams/email transports.
 *
 * Scheduling piggybacks on the poller's tick loop (`poller/src/loop.ts` calls
 * `runWeeklyDigests()` every tick) rather than adding a scheduler process. That
 * makes the pass a *shared* resource: it runs in the same 15s tick as account
 * polling and cost collection, so it is claimed in bounded batches
 * (`DIGESTS_PER_TICK`) and each batch runs concurrently. See that constant for
 * why an unbounded pass is a problem and why deferring is free.
 *
 * Restart- and replica-safety come from conditional UPDATEs — one per claimed
 * org, so bounding the batch does not weaken them:
 *
 *   * `claimDueDigestOrgs` moves `last_sent_week_start` forward and returns
 *     only the rows it actually changed, so of any number of concurrent
 *     pollers exactly one instance sends a given org's digest for a given week.
 *     The column only ever moves forward — it is never rolled back — which is
 *     what keeps that invariant true even across timezone changes.
 *   * `claimRetryDigestOrgs` does the same trick on `next_attempt_at` for the
 *     bounded retries after a *total* delivery failure. Nulling the gate in
 *     the same statement is the claim: a second replica's WHERE no longer
 *     matches, so one retry means one send attempt.
 *
 * Like every other notifier, nothing here throws into the poller: errors are
 * recorded on the row (so the settings UI can show them), logged, and the tick
 * carries on.
 */
import { and, eq, gte, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";

import { db } from "../db/client";
import {
  digestEmailRecipients,
  orgDigestSettings,
  organizations,
  pagingIncidents,
  resources,
} from "../db/schema";
import { queryCosts } from "../clickhouse/cost-readers";
import { sendSlackToOrg } from "../slack";
import { sendMsTeamsToOrg } from "../msteams";
import { isEmailConfigured, sendEmails, type EmailMessage } from "../email";
import { generateDigestNarrative } from "./narrative";
import {
  addDays,
  composeWeeklyDigest,
  DEFAULT_DIGEST_SCHEDULE,
  digestTitle,
  digestWindow,
  formatDigestEmailHtml,
  formatDigestEmailText,
  formatDigestSlackBody,
  formatDigestTeamsBody,
  isDigestDue,
  isValidTimeZone,
  type DigestSchedule,
  type DigestWindow,
  type IsoWeekday,
  type WeeklyDigest,
} from "./compose";

/**
 * How many attempts a single week's digest gets in total, including the first.
 * Small on purpose: a digest is a weekly summary, so an outage that outlasts a
 * couple of backoffs is better surfaced in the UI than retried into next week.
 */
export const MAX_DIGEST_ATTEMPTS = 3;

/** Backoff before attempt 2 and attempt 3, in minutes. */
const RETRY_BACKOFF_MINUTES = [15, 60];

/**
 * How many orgs one tick will claim, per phase (scheduled sends, then retries).
 * The claimed orgs of a phase run concurrently, so this is both the batch size
 * and the fan-out width.
 *
 * It exists because the digest shares the poller's 15s tick with account
 * polling, cost collection and workflow scheduling, and one org's digest is not
 * cheap: two ClickHouse queries, an optional Anthropic call bounded at 30s, and
 * a fan-out to Slack, Teams and one request per email recipient. Every org on
 * the default Monday 07:00 UTC schedule comes due in the *same* tick, so an
 * unbounded pass is a pile-up that stalls everything queued behind it.
 *
 * Deferring is free and cannot starve anyone: claiming moves the claim column
 * forward, so a claimed org drops out of the due set and the next tick's batch
 * is the next `DIGESTS_PER_TICK` orgs that still owe a digest. A weekly summary
 * that lands a few ticks later is not a summary anyone notices is late.
 */
export const DIGESTS_PER_TICK = 4;

/** Deep link to the org's cost dashboards, for the message button. */
function costsUrl(organizationId: string): string | null {
  const base = process.env["APP_URL"];
  if (!base) return null;
  return `${base.replace(/\/$/, "")}/org/${organizationId}/costs`;
}

function dayRange(from: string, to: string): { fromDate: Date; toDatePlusOne: Date } {
  return {
    fromDate: new Date(`${from}T00:00:00.000Z`),
    // Exclusive upper bound: the first instant of the day after `to`.
    toDatePlusOne: new Date(new Date(`${to}T00:00:00.000Z`).getTime() + 24 * 60 * 60 * 1000),
  };
}

/**
 * Gather one org's digest inputs and compose the digest. Two ClickHouse
 * queries (provider and service grouping over the two-week span) and three
 * cheap Postgres counts.
 *
 * Sync incidents are counted from `paging_incidents` rather than
 * `account_sync_failures`: the failure rows are a rolling window the pager
 * prunes within minutes (and skips entirely while paging is off), so they
 * can't answer "how many incidents last week".
 *
 * The window's dates are the org's *local* calendar week; the stores they are
 * matched against bucket by UTC day. That approximation is deliberate and
 * unchanged from when UTC was the only option — provider billing exports are
 * themselves dated to a day, not an instant, so there is no finer truth to
 * align to. It shifts at most a few hours of spend between two adjacent weeks
 * for a far-from-UTC org, and both weeks are reported.
 */
export async function buildWeeklyDigest(
  organizationId: string,
  window: DigestWindow,
): Promise<WeeklyDigest> {
  const span = { from: window.prevWeekStart, to: window.weekEnd };
  const [byProvider, byService] = await Promise.all([
    queryCosts(organizationId, {
      ...span,
      binning: "daily",
      groupBy: "provider",
      filters: [],
    }),
    queryCosts(organizationId, {
      ...span,
      binning: "daily",
      groupBy: "service",
      filters: [],
    }),
  ]);

  const { fromDate, toDatePlusOne } = dayRange(window.weekStart, window.weekEnd);
  const count = sql<number>`count(*)::int`;
  const [[incidents], [added], [removed]] = await Promise.all([
    db
      .select({ count })
      .from(pagingIncidents)
      .where(
        and(
          eq(pagingIncidents.organizationId, organizationId),
          gte(pagingIncidents.openedAt, fromDate),
          lt(pagingIncidents.openedAt, toDatePlusOne),
        ),
      ),
    db
      .select({ count })
      .from(resources)
      .where(
        and(
          eq(resources.organizationId, organizationId),
          gte(resources.createdAt, fromDate),
          lt(resources.createdAt, toDatePlusOne),
        ),
      ),
    db
      .select({ count })
      .from(resources)
      .where(
        and(
          eq(resources.organizationId, organizationId),
          gte(resources.deletedAt, fromDate),
          lt(resources.deletedAt, toDatePlusOne),
        ),
      ),
  ]);

  return composeWeeklyDigest({
    window,
    byProvider,
    byService,
    syncIncidentsOpened: incidents?.count ?? 0,
    resourcesAdded: added?.count ?? 0,
    resourcesRemoved: removed?.count ?? 0,
  });
}

export interface DigestDeliveryResult {
  attempted: number;
  succeeded: number;
  /** Per-transport counts, for the log line and the "Send now" response. */
  slack: { attempted: number; succeeded: number };
  teams: { attempted: number; succeeded: number };
  email: { attempted: number; succeeded: number };
}

/**
 * Send a composed digest to every Slack channel and Teams webhook opted into
 * the `weeklyDigest` trigger, and to every address on the org's digest email
 * list. Never throws (all three transports already swallow and log).
 *
 * `origin` labels the send — scheduled vs. a "Send now" — in the per-message
 * trace key, so Mailgun's logs distinguish the week's automatic mail from a
 * manual one. It is a breadcrumb only: Mailgun has no idempotency keys, and
 * nothing here relies on the provider collapsing duplicates. What actually
 * prevents a double-delivery is `classifyDelivery`, which only marks an attempt
 * retryable when *no* destination succeeded.
 */
export async function deliverWeeklyDigest(
  organizationId: string,
  digest: WeeklyDigest,
  narrative: string | null = null,
  origin = "scheduled",
): Promise<DigestDeliveryResult> {
  const [org] = await db
    .select({ displayName: organizations.displayName })
    .from(organizations)
    .where(eq(organizations.id, organizationId));

  const title = digestTitle(digest);
  const context = org ? `${org.displayName} · Infrawrench weekly digest` : undefined;
  const url = costsUrl(organizationId);

  const recipients = await db
    .select({ email: digestEmailRecipients.email })
    .from(digestEmailRecipients)
    .where(eq(digestEmailRecipients.organizationId, organizationId));

  // Built even when mail is unconfigured, on purpose: `sendEmails` is what logs
  // the "you have recipients but no mail provider" line, and short-circuiting
  // here would make that case silent — the exact failure mode this feature is
  // meant not to have.
  const text = recipients.length > 0 ? formatDigestEmailText(digest, narrative, url) : "";
  const html = recipients.length > 0 ? formatDigestEmailHtml(digest, narrative, url) : "";
  const emails: EmailMessage[] = recipients.map((r) => ({
    to: r.email,
    subject: title,
    text,
    html,
    traceKey: `digest:${organizationId}:${digest.window.weekStart}:${origin}:${r.email}`,
  }));

  const [slack, teams, email] = await Promise.all([
    sendSlackToOrg(organizationId, "weeklyDigest", {
      title,
      body: formatDigestSlackBody(digest, narrative),
      ...(context ? { context } : {}),
      ...(url ? { url } : {}),
    }),
    sendMsTeamsToOrg(organizationId, "weeklyDigest", {
      title,
      body: formatDigestTeamsBody(digest, narrative),
      ...(context ? { context } : {}),
      ...(url ? { url } : {}),
    }),
    sendEmails(emails, `digest for org ${organizationId}`),
  ]);

  return {
    attempted: slack.attempted + teams.attempted + email.attempted,
    succeeded: slack.succeeded + teams.succeeded + email.succeeded,
    slack: { attempted: slack.attempted, succeeded: slack.succeeded },
    teams: { attempted: teams.attempted, succeeded: teams.succeeded },
    email: { attempted: email.attempted, succeeded: email.succeeded },
  };
}

// --- Scheduling, claiming, and the retry state machine ---

/** What the last attempt for `lastSentWeekStart` did. Surfaced in the API and UI. */
export type DigestStatus = "pending" | "succeeded" | "partial" | "failed" | "no_targets";

/** A row's schedule, normalized so a hand-edited row can't break the math. */
export function scheduleFromRow(row: {
  timezone: string;
  sendDay: number;
  sendHour: number;
}): DigestSchedule {
  const day = Math.min(7, Math.max(1, Math.trunc(row.sendDay))) as IsoWeekday;
  return {
    timezone: isValidTimeZone(row.timezone) ? row.timezone : DEFAULT_DIGEST_SCHEDULE.timezone,
    sendDay: Number.isFinite(row.sendDay) ? day : DEFAULT_DIGEST_SCHEDULE.sendDay,
    sendHour: Math.min(23, Math.max(0, Math.trunc(row.sendHour) || 0)),
  };
}

/**
 * Classify a delivery. The distinction that matters is *total* failure (worth
 * retrying — nothing landed anywhere) versus *partial* (Slack took it, Teams
 * 500'd), which must never be retried: re-sending would post the digest into
 * Slack a second time. Email's idempotency keys make its half safe either way,
 * but Slack and Teams have no such guard, so partial is terminal.
 */
export function classifyDelivery(result: DigestDeliveryResult): {
  status: DigestStatus;
  error: string | null;
  retryable: boolean;
} {
  if (result.attempted === 0) {
    return {
      status: "no_targets",
      error:
        "Nothing is routed to receive the digest. Tick “Weekly digest” on a Slack channel or Teams webhook, or add an email recipient.",
      retryable: false,
    };
  }
  if (result.succeeded === 0) {
    return {
      status: "failed",
      error: `All ${result.attempted} deliveries failed. See the poller logs for the per-channel errors.`,
      retryable: true,
    };
  }
  if (result.succeeded < result.attempted) {
    return {
      status: "partial",
      error: `Delivered to ${result.succeeded} of ${result.attempted} destinations; the rest failed. Not retried automatically — a retry would post the digest twice where it already landed. Use “Send now” once the failing destination is fixed.`,
      retryable: false,
    };
  }
  return { status: "succeeded", error: null, retryable: false };
}

/** When the next attempt may run, or null when the attempts are spent. */
export function nextDigestAttemptAt(now: Date, attemptCount: number): Date | null {
  if (attemptCount >= MAX_DIGEST_ATTEMPTS) return null;
  const minutes = RETRY_BACKOFF_MINUTES[attemptCount - 1] ?? RETRY_BACKOFF_MINUTES.at(-1) ?? 60;
  return new Date(now.getTime() + minutes * 60 * 1000);
}

interface DueOrgRow {
  organizationId: string;
  timezone: string;
  sendDay: number;
  sendHour: number;
  narrativeEnabled: boolean;
  attemptCount: number;
}

const DUE_COLUMNS = {
  organizationId: orgDigestSettings.organizationId,
  timezone: orgDigestSettings.timezone,
  sendDay: orgDigestSettings.sendDay,
  sendHour: orgDigestSettings.sendHour,
  narrativeEnabled: orgDigestSettings.narrativeEnabled,
  attemptCount: orgDigestSettings.attemptCount,
} as const;

/**
 * Atomically claim every enabled org whose digest has not been sent for the
 * week it is currently due for. The WHERE clause is the entire dedupe story:
 * an org is returned only when this UPDATE moved `last_sent_week_start`
 * forward, so a concurrent replica (or a restarted poller re-entering the same
 * morning) matches zero rows and sends nothing.
 *
 * Because each org's window and due time depend on its own timezone and
 * schedule, the *predicate* is per-row and cannot be expressed in one SQL
 * comparison. It is computed here instead: the due check maps a row to the week
 * it owes right now (or nothing), and the UPDATE is issued per claimed org with
 * that org's own `weekStart`. Each UPDATE is still a single conditional
 * statement, so the exactly-once guarantee is unchanged — only the batching is.
 *
 * At most `limit` orgs are claimed; the rest ride the next tick (see
 * {@link DIGESTS_PER_TICK}). Deferring cannot starve an org: a claim moves
 * `last_sent_week_start` forward, so every org this pass claimed fails the
 * pre-filter next time and the batch after it is drawn from the orgs that are
 * still owed one. The stable `organizationId` ordering makes that drain
 * deterministic rather than dependent on whatever order the planner returns.
 */
export async function claimDueDigestOrgs(
  now: Date,
  limit = DIGESTS_PER_TICK,
): Promise<Array<DueOrgRow & { weekStart: string }>> {
  const candidates = await db
    .select({ ...DUE_COLUMNS, lastSentWeekStart: orgDigestSettings.lastSentWeekStart })
    .from(orgDigestSettings)
    .where(eq(orgDigestSettings.enabled, true))
    .orderBy(orgDigestSettings.organizationId);

  const claimed: Array<DueOrgRow & { weekStart: string }> = [];
  let deferred = 0;
  for (const row of candidates) {
    const schedule = scheduleFromRow(row);
    const window = digestWindow(now, schedule.timezone);
    if (!isDigestDue(now, window, schedule)) continue;
    // Cheap pre-filter so a settled org costs a comparison, not a write.
    if (row.lastSentWeekStart !== null && row.lastSentWeekStart >= window.weekStart) continue;
    // Over budget for this tick. Keep counting so the log can say how far
    // behind the send is, but claim nothing more — an unclaimed org is
    // untouched state, which is exactly what makes deferring safe.
    if (claimed.length >= limit) {
      deferred += 1;
      continue;
    }

    const [won] = await db
      .update(orgDigestSettings)
      .set({
        lastSentWeekStart: window.weekStart,
        attemptCount: 1,
        lastAttemptAt: now,
        lastStatus: "pending",
        lastError: null,
        nextAttemptAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(orgDigestSettings.organizationId, row.organizationId),
          eq(orgDigestSettings.enabled, true),
          or(
            isNull(orgDigestSettings.lastSentWeekStart),
            lt(orgDigestSettings.lastSentWeekStart, window.weekStart),
          ),
        ),
      )
      .returning(DUE_COLUMNS);
    if (won) claimed.push({ ...won, weekStart: window.weekStart });
  }
  if (deferred > 0) {
    console.log(
      `[digest] claimed ${claimed.length} due org(s) this tick; ${deferred} more are due and will be claimed by a later tick.`,
    );
  }
  return claimed;
}

/**
 * Atomically claim up to `limit` orgs whose last attempt failed outright and
 * whose backoff has elapsed. Nulling `next_attempt_at` inside the same UPDATE
 * is what makes this a claim rather than a query — two replicas arriving at
 * once cannot both take the row, so a retry is one send attempt, not two.
 *
 * Only rows whose `lastStatus` is `failed` are eligible, so a partial delivery
 * is structurally excluded from ever being retried.
 *
 * Like the weekly claim this is a bounded select followed by one conditional
 * UPDATE per candidate, rather than a single UPDATE over everything that
 * matches. The reason is the bound: a claimed retry *must* be attempted (its
 * gate is gone and its attempt is spent), so the batch has to be limited at
 * claim time and not afterwards. Splitting it per row leaves the claim itself
 * untouched — the WHERE still requires the gate to be set and in the past, so
 * whichever replica's UPDATE lands first is the only one that gets the row.
 *
 * Ordering by the gate means the longest-waiting retry goes first, so a backlog
 * drains oldest-first instead of leaving the same tail behind every tick.
 */
export async function claimRetryDigestOrgs(
  now: Date,
  limit = DIGESTS_PER_TICK,
): Promise<Array<DueOrgRow & { weekStart: string }>> {
  const eligible = and(
    eq(orgDigestSettings.enabled, true),
    eq(orgDigestSettings.lastStatus, "failed"),
    isNotNull(orgDigestSettings.nextAttemptAt),
    lte(orgDigestSettings.nextAttemptAt, now),
    lt(orgDigestSettings.attemptCount, MAX_DIGEST_ATTEMPTS),
  );

  const candidates = await db
    .select({ ...DUE_COLUMNS, lastSentWeekStart: orgDigestSettings.lastSentWeekStart })
    .from(orgDigestSettings)
    .where(eligible)
    .orderBy(orgDigestSettings.nextAttemptAt)
    .limit(limit);

  const claimed: Array<DueOrgRow & { weekStart: string }> = [];
  for (const candidate of candidates) {
    // Belt to the LIMIT's brace: the batch is bounded here too, so the cap
    // holds even if the select ever stops honouring it.
    if (claimed.length >= limit) break;
    // A retry re-sends the week the failed attempt claimed. Without that key
    // there is nothing to re-send, so the row is left for the weekly claim.
    if (!candidate.lastSentWeekStart) continue;

    const [won] = await db
      .update(orgDigestSettings)
      .set({
        attemptCount: sql`${orgDigestSettings.attemptCount} + 1`,
        lastAttemptAt: now,
        lastStatus: "pending",
        nextAttemptAt: null,
        updatedAt: now,
      })
      .where(and(eq(orgDigestSettings.organizationId, candidate.organizationId), eligible))
      // The week comes back from the winning UPDATE, not from the select: the
      // row that was claimed is the authority on which week it owes.
      .returning({ ...DUE_COLUMNS, lastSentWeekStart: orgDigestSettings.lastSentWeekStart });
    if (won?.lastSentWeekStart) claimed.push({ ...won, weekStart: won.lastSentWeekStart });
  }
  return claimed;
}

/** Record what an attempt did. Never throws — bookkeeping must not mask the send. */
async function recordAttempt(
  organizationId: string,
  now: Date,
  attemptCount: number,
  outcome: { status: DigestStatus; error: string | null; retryable: boolean },
): Promise<void> {
  try {
    await db
      .update(orgDigestSettings)
      .set({
        lastStatus: outcome.status,
        lastError: outcome.error,
        lastAttemptAt: now,
        // `lastSentAt` means "a digest actually reached someone", so it moves
        // for a full or partial success and stays put on a failure. Claiming
        // no longer touches it — the old behaviour reported a send that had
        // not happened yet.
        ...(outcome.status === "succeeded" || outcome.status === "partial"
          ? { lastSentAt: now }
          : {}),
        nextAttemptAt: outcome.retryable ? nextDigestAttemptAt(now, attemptCount) : null,
        updatedAt: now,
      })
      .where(eq(orgDigestSettings.organizationId, organizationId));
  } catch (err) {
    console.error(`[digest] org ${organizationId}: failed to record attempt outcome:`, err);
  }
}

/** Build, optionally narrate, deliver, and record one org's digest for one week. */
async function runOneDigest(
  row: DueOrgRow & { weekStart: string },
  now: Date,
  attemptLabel: string,
): Promise<void> {
  const { organizationId, weekStart } = row;
  // The window is derived from the claimed `weekStart`, never recomputed from
  // the clock: a retry (or a claim that straddles midnight) must re-report the
  // week it claimed, not whatever week `now` has since rolled into.
  const target: DigestWindow = {
    weekStart,
    weekEnd: addDays(weekStart, 6),
    prevWeekStart: addDays(weekStart, -7),
    prevWeekEnd: addDays(weekStart, -1),
  };

  try {
    const digest = await buildWeeklyDigest(organizationId, target);
    const narrative = row.narrativeEnabled ? await generateDigestNarrative(digest) : null;
    const result = await deliverWeeklyDigest(organizationId, digest, narrative);
    const outcome = classifyDelivery(result);
    await recordAttempt(organizationId, now, row.attemptCount, outcome);
    const line = `[digest] org ${organizationId} week ${weekStart} ${attemptLabel} ${row.attemptCount}/${MAX_DIGEST_ATTEMPTS}: ${outcome.status} — slack ${result.slack.succeeded}/${result.slack.attempted}, teams ${result.teams.succeeded}/${result.teams.attempted}, email ${result.email.succeeded}/${result.email.attempted}`;
    if (outcome.status === "succeeded") console.log(line);
    else console.warn(`${line}${outcome.error ? ` — ${outcome.error}` : ""}`);
  } catch (err) {
    // A build failure (ClickHouse down, Postgres blip) is as retryable as a
    // total delivery failure, and just as invisible if we only logged it.
    const message = err instanceof Error ? err.message : String(err);
    await recordAttempt(organizationId, now, row.attemptCount, {
      status: "failed",
      error: `Could not build the digest: ${message}`,
      retryable: true,
    });
    console.error(`[digest] org ${organizationId} week ${weekStart} digest failed:`, err);
  }
}

/**
 * One scheduler pass: claim and send up to `limit` orgs whose digest has come
 * due in their own timezone, then pick up to `limit` bounded retries whose
 * backoff has elapsed. Called from the poller's tick loop; safe to call as
 * often as you like.
 *
 * The pass is bounded in both directions. The claim caps how many orgs a tick
 * takes on, so a Monday-morning pile-up drains over several ticks instead of
 * blocking the account, cost and workflow passes behind it; and each phase's
 * claimed orgs run concurrently, so the tick costs one org's latency rather
 * than four. The two phases stay sequential: an org can in principle be due for
 * this week *and* owe a retry for last week, and running both at once would
 * have two attempts writing the same status row.
 */
export async function runWeeklyDigests(now = new Date(), limit = DIGESTS_PER_TICK): Promise<void> {
  let due: Array<DueOrgRow & { weekStart: string }> = [];
  try {
    due = await claimDueDigestOrgs(now, limit);
  } catch (err) {
    console.error("[digest] failed to claim due orgs:", err);
  }
  // `runOneDigest` swallows its own errors; `allSettled` is the belt to that
  // brace, so one org can never take the rest of the batch down with it.
  await Promise.allSettled(due.map((row) => runOneDigest(row, now, "attempt")));

  let retries: Array<DueOrgRow & { weekStart: string }> = [];
  try {
    retries = await claimRetryDigestOrgs(now, limit);
  } catch (err) {
    console.error("[digest] failed to claim retries:", err);
  }
  await Promise.allSettled(retries.map((row) => runOneDigest(row, now, "retry")));
}

// --- Settings ---

export interface DigestSettingsRecord {
  enabled: boolean;
  lastSentWeekStart: string | null;
  lastSentAt: Date | null;
  timezone: string;
  sendDay: number;
  sendHour: number;
  narrativeEnabled: boolean;
  /** Whether this deployment can write narratives at all (ANTHROPIC_API_KEY). */
  narrativeAvailable: boolean;
  /** Whether this deployment can send mail (MAILGUN_API_KEY + MAILGUN_DOMAIN + EMAIL_FROM). */
  emailAvailable: boolean;
  attemptCount: number;
  lastAttemptAt: Date | null;
  lastStatus: DigestStatus | null;
  lastError: string | null;
  nextAttemptAt: Date | null;
}

function toRecord(row: typeof orgDigestSettings.$inferSelect): DigestSettingsRecord {
  return {
    enabled: row.enabled,
    lastSentWeekStart: row.lastSentWeekStart,
    lastSentAt: row.lastSentAt,
    timezone: row.timezone,
    sendDay: row.sendDay,
    sendHour: row.sendHour,
    narrativeEnabled: row.narrativeEnabled,
    narrativeAvailable: Boolean(process.env["ANTHROPIC_API_KEY"]),
    emailAvailable: isEmailConfigured(),
    attemptCount: row.attemptCount,
    lastAttemptAt: row.lastAttemptAt,
    lastStatus: (row.lastStatus as DigestStatus | null) ?? null,
    lastError: row.lastError,
    nextAttemptAt: row.nextAttemptAt,
  };
}

const DEFAULT_SETTINGS: Omit<DigestSettingsRecord, "narrativeAvailable" | "emailAvailable"> = {
  enabled: false,
  lastSentWeekStart: null,
  lastSentAt: null,
  timezone: DEFAULT_DIGEST_SCHEDULE.timezone,
  sendDay: DEFAULT_DIGEST_SCHEDULE.sendDay,
  sendHour: DEFAULT_DIGEST_SCHEDULE.sendHour,
  narrativeEnabled: false,
  attemptCount: 0,
  lastAttemptAt: null,
  lastStatus: null,
  lastError: null,
  nextAttemptAt: null,
};

/** The org's digest settings; a missing row reads as disabled, on the defaults. */
export async function getOrgDigestSettings(organizationId: string): Promise<DigestSettingsRecord> {
  const [row] = await db
    .select()
    .from(orgDigestSettings)
    .where(eq(orgDigestSettings.organizationId, organizationId));
  if (!row) {
    return {
      ...DEFAULT_SETTINGS,
      narrativeAvailable: Boolean(process.env["ANTHROPIC_API_KEY"]),
      emailAvailable: isEmailConfigured(),
    };
  }
  return toRecord(row);
}

export interface DigestSettingsPatch {
  enabled?: boolean;
  timezone?: string;
  sendDay?: number;
  sendHour?: number;
  narrativeEnabled?: boolean;
}

/**
 * Update the digest settings. Enabling marks the current window as already
 * sent so the first scheduled digest goes out at the next send time rather than
 * the moment the toggle flips — the settings UI offers "Send now" for immediate
 * feedback instead.
 *
 * A schedule change also clears any parked failure state: the org has changed
 * what it asked for, so a stale error about the old schedule would only
 * confuse. It does *not* move `lastSentWeekStart` backwards, so changing the
 * timezone can never replay a week that already went out.
 */
export async function updateOrgDigestSettings(
  organizationId: string,
  patch: DigestSettingsPatch,
  now = new Date(),
): Promise<DigestSettingsRecord> {
  if (patch.timezone !== undefined && !isValidTimeZone(patch.timezone)) {
    throw new Error(`Unknown time zone: ${patch.timezone}`);
  }
  if (patch.sendDay !== undefined && ![1, 2, 3, 4, 5, 6, 7].includes(patch.sendDay)) {
    throw new Error("sendDay must be 1 (Monday) through 7 (Sunday)");
  }
  if (
    patch.sendHour !== undefined &&
    (!Number.isInteger(patch.sendHour) || patch.sendHour < 0 || patch.sendHour > 23)
  ) {
    throw new Error("sendHour must be an integer from 0 to 23");
  }

  const existing = await getOrgDigestSettings(organizationId);
  const timezone = patch.timezone ?? existing.timezone;
  const enabled = patch.enabled ?? existing.enabled;
  // Compute the "already covered" week in the *new* timezone, so enabling and
  // changing zone in one call cannot leave a half-applied schedule behind.
  const window = digestWindow(now, timezone);
  const scheduleChanged =
    (patch.timezone !== undefined && patch.timezone !== existing.timezone) ||
    (patch.sendDay !== undefined && patch.sendDay !== existing.sendDay) ||
    (patch.sendHour !== undefined && patch.sendHour !== existing.sendHour);

  const clearedFailure = scheduleChanged
    ? { lastStatus: null, lastError: null, nextAttemptAt: null, attemptCount: 0 }
    : {};

  const [row] = await db
    .insert(orgDigestSettings)
    .values({
      organizationId,
      enabled,
      timezone,
      ...(patch.sendDay !== undefined ? { sendDay: patch.sendDay } : {}),
      ...(patch.sendHour !== undefined ? { sendHour: patch.sendHour } : {}),
      ...(patch.narrativeEnabled !== undefined ? { narrativeEnabled: patch.narrativeEnabled } : {}),
      lastSentWeekStart: enabled ? window.weekStart : null,
    })
    .onConflictDoUpdate({
      target: orgDigestSettings.organizationId,
      set: {
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(patch.timezone !== undefined ? { timezone: patch.timezone } : {}),
        ...(patch.sendDay !== undefined ? { sendDay: patch.sendDay } : {}),
        ...(patch.sendHour !== undefined ? { sendHour: patch.sendHour } : {}),
        ...(patch.narrativeEnabled !== undefined
          ? { narrativeEnabled: patch.narrativeEnabled }
          : {}),
        ...clearedFailure,
        updatedAt: now,
        // Only an explicit *enable* skips the current window. Re-stamping on
        // every save would mean that toggling the narrative at 06:00 on send
        // day silently swallowed that day's digest. Re-enabling after a gap
        // also skips the stale backlog week; GREATEST keeps the column
        // monotonic, which is what the exactly-once claim depends on — a
        // timezone move can shift the local week start by a day and must never
        // walk it backwards.
        ...(patch.enabled === true
          ? {
              lastSentWeekStart: sql`GREATEST(coalesce(${orgDigestSettings.lastSentWeekStart}, ${window.weekStart}), ${window.weekStart})`,
            }
          : {}),
      },
    })
    .returning();
  if (!row) throw new Error("Failed to save digest settings");
  return toRecord(row);
}

/**
 * Backwards-compatible shorthand for the plain on/off toggle.
 */
export async function setOrgDigestEnabled(
  organizationId: string,
  enabled: boolean,
  now = new Date(),
): Promise<DigestSettingsRecord> {
  return updateOrgDigestSettings(organizationId, { enabled }, now);
}

/**
 * Compose last week's digest and send it immediately, ignoring the schedule
 * and the enabled flag. Backs the settings UI's "Send now" button, so unlike
 * the scheduler this throws when nothing could be delivered — the user needs
 * to see why.
 *
 * A successful manual send also clears any parked failure state: it is the
 * documented recovery for a partial delivery, so leaving the old error on the
 * row afterwards would be misleading.
 */
export async function sendWeeklyDigestNow(
  organizationId: string,
  now = new Date(),
): Promise<DigestDeliveryResult> {
  const settings = await getOrgDigestSettings(organizationId);
  const schedule = scheduleFromRow(settings);
  const window = digestWindow(now, schedule.timezone);
  const digest = await buildWeeklyDigest(organizationId, window);
  const narrative = settings.narrativeEnabled ? await generateDigestNarrative(digest) : null;
  const result = await deliverWeeklyDigest(
    organizationId,
    digest,
    narrative,
    `manual-${now.toISOString()}`,
  );
  if (result.attempted === 0) {
    throw new Error(
      "Nothing is routed to receive the digest. Tick “Weekly digest” on a Slack channel or Teams webhook, or add an email recipient below.",
    );
  }
  const outcome = classifyDelivery(result);
  // Recorded so a manual recovery clears the parked failure the UI is showing.
  // This is an UPDATE, so an org that never enabled the digest has no row to
  // match and nothing is conjured into existence.
  await recordAttempt(organizationId, now, MAX_DIGEST_ATTEMPTS, {
    ...outcome,
    // A manual send is the recovery path, not a scheduled attempt: never arm
    // the automatic retry from here.
    retryable: false,
  });
  if (result.succeeded === 0) {
    throw new Error(
      `The digest could not be delivered to any of its ${result.attempted} destination(s). Check the Slack, Teams and email settings above.`,
    );
  }
  return result;
}
