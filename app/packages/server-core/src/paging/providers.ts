/**
 * Paging providers: PagerDuty, incident.io and any other plugin that declares
 * `manifest.paging`. Everything here goes through that generic capability
 * (`plugin-base/src/paging.ts`); there is no provider name in this file.
 *
 * Three jobs:
 *
 * 1. **Outbound.** A `paging-provider` routing destination opens an alert on a
 *    provider target. Each upstream alert is one `paging_provider_events` row,
 *    keyed by (account, target, dedup key), which doubles as the outbox: the
 *    send is tried immediately where plugin code can run, and the
 *    `paging-providers` poller pass retries whatever is still due. The alert's
 *    own lifecycle (a probe recovering, an incident resolving, an Infrawrench
 *    acknowledgement) lands on the same row and is written back upstream.
 * 2. **On-call.** A `provider-on-call` destination asks the provider who is on
 *    call and matches them to org members by email.
 * 3. **Inbound.** The provider's incidents are mirrored into
 *    `paging_provider_incidents`, refreshed by webhook nudges and a reconcile
 *    pass, and acknowledged or resolved from Infrawrench through the plugin.
 *    An upstream acknowledgement of an alert Infrawrench opened settles the
 *    Infrawrench escalation that alert belongs to, so nobody gets escalated to
 *    about a page somebody already took in PagerDuty.
 *
 * Nothing in here throws into an alert path: the routing calls catch and log,
 * and a provider outage degrades to "queued for retry", never to a lost alert.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import type {
  PagingCapabilityDeclaration,
  PagingEvent,
  PagingEventAction,
  PagingIncident,
  PagingSeverity,
  Plugin,
  PluginClient,
} from "@infrawrench/plugin-base";
import {
  pagingDedupKey,
  type PagerIncidentRecord,
  type PagingDestinationsResponse,
  type PagingEventRecord,
  type PagingEventState,
  type PagingOnCallNowResponse,
  type PagingProviderAccount,
  type PagingProviderSettingsInput,
} from "@infrawrench/client-core";

import { db } from "../db/client";
import { accounts, alertDeliveries, organizationMembers, users } from "../db/schema";
import {
  pagingProviderEvents,
  pagingProviderIncidents,
  pagingProviderSettings,
} from "../db/paging-provider-schema";
import { buildAad, decrypt, encrypt } from "../encryption";
import { getPlugin, pluginCodeAvailable } from "../plugin-loader";
import { getOrgAccountClient } from "../org-accounts";
import { appPath } from "../app-url";

// ---------------------------------------------------------------------------
// Plugin access
// ---------------------------------------------------------------------------

/** The error a caller can surface: message plus the HTTP-ish status the plugin attached. */
export class PagingProviderError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "PagingProviderError";
    this.status = status;
  }
}

function errorStatus(err: unknown): number | null {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The manifest's paging declaration for a plugin id, or null. Edge-safe: manifests only. */
export async function pagingDeclaration(
  pluginId: string,
): Promise<PagingCapabilityDeclaration | null> {
  const loaded = await getPlugin(pluginId);
  return loaded?.plugin.manifest.paging ?? null;
}

interface PagingAccountClient {
  client: PluginClient;
  plugin: Plugin;
  paging: PagingCapabilityDeclaration;
  pluginId: string;
}

/**
 * Instantiate a paging-capable account's client, scoped to the org. Throws a
 * {@link PagingProviderError} when the account is gone, belongs to another org,
 * or its plugin has no paging capability.
 */
async function pagingAccountClient(
  organizationId: string,
  accountId: string,
): Promise<PagingAccountClient> {
  const resolved = await getOrgAccountClient(accountId, organizationId);
  if (!resolved) throw new PagingProviderError("No such account in this organization", 404);
  const paging = resolved.plugin.manifest.paging;
  if (!paging) {
    throw new PagingProviderError("That account's provider cannot page anyone", 400);
  }
  return {
    client: resolved.client,
    plugin: resolved.plugin,
    paging,
    pluginId: resolved.account.pluginId,
  };
}

/** Accounts in the org whose plugin declares the paging capability. */
async function listPagingAccountRows(
  organizationId: string,
): Promise<
  Array<{ id: string; displayName: string; pluginId: string; paging: PagingCapabilityDeclaration }>
> {
  const rows = await db
    .select({ id: accounts.id, displayName: accounts.displayName, pluginId: accounts.pluginId })
    .from(accounts)
    .where(eq(accounts.organizationId, organizationId))
    .orderBy(accounts.displayName);
  const out = [];
  for (const row of rows) {
    const paging = await pagingDeclaration(row.pluginId);
    if (paging) out.push({ ...row, paging });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Members by email
// ---------------------------------------------------------------------------

/**
 * Match provider emails to org members, case-insensitively. Emails nobody in
 * the org uses are simply absent from the map: a responder who is not an
 * Infrawrench member is still on call upstream, just not reachable from here.
 */
export async function membersByEmail(
  organizationId: string,
  emails: ReadonlyArray<string | null | undefined>,
): Promise<Map<string, string>> {
  const wanted = [...new Set(emails.filter((e): e is string => !!e).map((e) => e.toLowerCase()))];
  const out = new Map<string, string>();
  if (wanted.length === 0) return out;
  const rows = await db
    .select({ userId: users.id, email: users.email })
    .from(organizationMembers)
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(
      and(
        eq(organizationMembers.organizationId, organizationId),
        inArray(sql<string>`lower(${users.email})`, wanted),
      ),
    );
  for (const row of rows) out.set(row.email.toLowerCase(), row.userId);
  return out;
}

// ---------------------------------------------------------------------------
// On-call resolution
// ---------------------------------------------------------------------------

/**
 * Who is on call on a provider source right now, matched to members.
 *
 * Never throws: it is called on the alert delivery path, where a provider
 * outage must contribute nobody rather than fail the alert's other
 * destinations. Only the first escalation level is returned for delivery;
 * later levels are the provider's own escalation, not ours to page early.
 */
export async function resolveProviderOnCallMembers(
  organizationId: string,
  accountId: string,
  sourceId: string,
  at = new Date(),
): Promise<string[]> {
  try {
    const { client } = await pagingAccountClient(organizationId, accountId);
    if (!client.resolvePagingOnCall) return [];
    const people = await client.resolvePagingOnCall(sourceId, at);
    const firstLevel = Math.min(...people.map((p) => p.level ?? 1));
    const onCall = people.filter((p) => (p.level ?? 1) === firstLevel);
    const byEmail = await membersByEmail(
      organizationId,
      onCall.map((p) => p.email),
    );
    return [
      ...new Set(onCall.flatMap((p) => (p.email ? [byEmail.get(p.email.toLowerCase())] : []))),
    ].filter((id): id is string => !!id);
  } catch (err) {
    console.error(
      `[paging] on-call resolve for account ${accountId} source ${sourceId} failed:`,
      errorMessage(err),
    );
    return [];
  }
}

/** The on-call preview the settings page shows. Throws, unlike the delivery path. */
export async function previewProviderOnCall(
  organizationId: string,
  accountId: string,
  sourceId: string,
): Promise<PagingOnCallNowResponse> {
  const { client } = await pagingAccountClient(organizationId, accountId);
  if (!client.resolvePagingOnCall) {
    throw new PagingProviderError("This provider cannot say who is on call", 400);
  }
  const people = await client.resolvePagingOnCall(sourceId, new Date());
  const byEmail = await membersByEmail(
    organizationId,
    people.map((p) => p.email),
  );
  return {
    people: people.map((p) => ({
      name: p.name,
      email: p.email,
      memberUserId: p.email ? (byEmail.get(p.email.toLowerCase()) ?? null) : null,
      until: p.until ?? null,
      level: p.level ?? null,
    })),
  };
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

type SettingsRow = typeof pagingProviderSettings.$inferSelect;

function webhookAad(accountId: string): string {
  return buildAad("paging-provider", accountId, "webhook-secret");
}

function webhookUrlFor(token: string): string | null {
  return appPath(`/api/paging-webhooks/${token}`);
}

async function loadSettings(accountId: string): Promise<SettingsRow | null> {
  const [row] = await db
    .select()
    .from(pagingProviderSettings)
    .where(eq(pagingProviderSettings.accountId, accountId))
    .limit(1);
  return row ?? null;
}

/** Every paging-capable account in the org, with its settings (or the defaults). */
export async function listPagingProviders(
  organizationId: string,
): Promise<PagingProviderAccount[]> {
  const accountRows = await listPagingAccountRows(organizationId);
  if (accountRows.length === 0) return [];
  const settings = await db
    .select()
    .from(pagingProviderSettings)
    .where(eq(pagingProviderSettings.organizationId, organizationId));
  const byAccount = new Map(settings.map((s) => [s.accountId, s]));

  return accountRows.map((row) => {
    const s = byAccount.get(row.id);
    return {
      accountId: row.id,
      displayName: row.displayName,
      pluginId: row.pluginId,
      targetLabel: row.paging.targetLabel,
      targetDescription: row.paging.targetDescription ?? null,
      supportsAcknowledgeEvent: row.paging.supportsAcknowledgeEvent,
      onCallSourceLabel: row.paging.onCall?.sourceLabel ?? null,
      incidents: row.paging.incidents ?? null,
      webhookMode: row.paging.webhook?.mode ?? null,
      webhookSetupHelp: row.paging.webhook?.setupHelp ?? null,
      settings: {
        inboundEnabled: s?.inboundEnabled ?? false,
        webhookConfigured: Boolean(s?.encryptedWebhookSecret),
        webhookUrl: s?.inboundEnabled && row.paging.webhook ? webhookUrlFor(s.webhookToken) : null,
        lastSyncedAt: s?.lastSyncedAt?.toISOString() ?? null,
        lastSyncError: s?.lastSyncError ?? null,
      },
    };
  });
}

/**
 * Turn inbound mirroring on or off, and manage the webhook that makes it real
 * time. A managed webhook is registered with the provider on enable and
 * removed on disable; a manual one stores the secret the user pasted. A failed
 * registration is reported, but mirroring stays on: the reconcile pass still
 * works without a webhook, only slower.
 */
export async function updatePagingProviderSettings(
  organizationId: string,
  accountId: string,
  input: PagingProviderSettingsInput,
): Promise<{ account: PagingProviderAccount; warning: string | null }> {
  const accountRows = await listPagingAccountRows(organizationId);
  const account = accountRows.find((a) => a.id === accountId);
  if (!account) throw new PagingProviderError("No paging provider account with that id", 404);
  if (input.inboundEnabled && !account.paging.incidents) {
    throw new PagingProviderError("This provider has no incidents to mirror", 400);
  }

  const now = new Date();
  let row = await loadSettings(accountId);
  if (!row) {
    const [inserted] = await db
      .insert(pagingProviderSettings)
      .values({
        accountId,
        organizationId,
        webhookToken: randomBytes(24).toString("base64url"),
      })
      .onConflictDoNothing()
      .returning();
    row = inserted ?? (await loadSettings(accountId));
    if (!row) throw new Error("Failed to create the paging provider settings");
  }

  const patch: Partial<typeof pagingProviderSettings.$inferInsert> = {
    inboundEnabled: input.inboundEnabled,
    updatedAt: now,
    // Reconcile straight away on enable, so the list is not empty for minutes.
    nextSyncAt: input.inboundEnabled ? now : null,
  };
  let warning: string | null = null;
  const mode = account.paging.webhook?.mode ?? null;

  if (mode === "manual" && input.webhookSecret !== undefined) {
    if (input.webhookSecret && input.webhookSecret.trim()) {
      const enc = await encrypt(input.webhookSecret.trim(), webhookAad(accountId));
      patch.encryptedWebhookSecret = enc.ciphertext;
      patch.webhookSecretIv = enc.iv;
    } else {
      patch.encryptedWebhookSecret = null;
      patch.webhookSecretIv = null;
    }
  }

  if (mode === "managed") {
    if (input.inboundEnabled && !row.webhookId) {
      const url = webhookUrlFor(row.webhookToken);
      if (!url) {
        warning =
          "APP_URL is not set on this deployment, so incidents are reconciled on a timer instead of by webhook.";
      } else {
        try {
          const { client } = await pagingAccountClient(organizationId, accountId);
          const registration = await client.registerPagingWebhook!(url);
          const enc = await encrypt(registration.secret, webhookAad(accountId));
          patch.webhookId = registration.webhookId;
          patch.encryptedWebhookSecret = enc.ciphertext;
          patch.webhookSecretIv = enc.iv;
        } catch (err) {
          warning = `Could not subscribe a webhook (${errorMessage(err)}); incidents will be reconciled on a timer instead.`;
        }
      }
    } else if (!input.inboundEnabled && row.webhookId) {
      try {
        const { client } = await pagingAccountClient(organizationId, accountId);
        await client.removePagingWebhook?.(row.webhookId);
      } catch (err) {
        // Not fatal: a subscription left behind delivers to a URL that now
        // ignores it (inbound is off), and the user can delete it upstream.
        warning = `Could not remove the webhook subscription upstream (${errorMessage(err)}).`;
      }
      patch.webhookId = null;
      patch.encryptedWebhookSecret = null;
      patch.webhookSecretIv = null;
    }
  }

  await db
    .update(pagingProviderSettings)
    .set(patch)
    .where(eq(pagingProviderSettings.accountId, accountId));
  if (!input.inboundEnabled) {
    // Turning mirroring off forgets the mirror: stale incidents nobody is
    // refreshing would read as current.
    await db
      .delete(pagingProviderIncidents)
      .where(eq(pagingProviderIncidents.accountId, accountId));
  }

  const listed = (await listPagingProviders(organizationId)).find((a) => a.accountId === accountId);
  if (!listed) throw new PagingProviderError("No paging provider account with that id", 404);
  return { account: listed, warning };
}

/** Pickers for the routing editor, loaded live, with per-account errors. */
export async function listPagingDestinations(
  organizationId: string,
): Promise<PagingDestinationsResponse> {
  const accountRows = await listPagingAccountRows(organizationId);
  const results = await Promise.all(
    accountRows.map(async (row) => {
      const base = {
        accountId: row.id,
        displayName: row.displayName,
        pluginId: row.pluginId,
        targetLabel: row.paging.targetLabel,
        onCallSourceLabel: row.paging.onCall?.sourceLabel ?? null,
      };
      try {
        const { client } = await pagingAccountClient(organizationId, row.id);
        const [targets, sources] = await Promise.all([
          client.listPagingTargets ? client.listPagingTargets() : Promise.resolve([]),
          row.paging.onCall && client.listPagingOnCallSources
            ? client.listPagingOnCallSources()
            : Promise.resolve([]),
        ]);
        return {
          ...base,
          targets: targets.map((t) => ({
            id: t.id,
            name: t.name,
            description: t.description ?? null,
          })),
          onCallSources: sources.map((s) => ({ id: s.id, name: s.name, kind: s.kind })),
          error: null,
        };
      } catch (err) {
        return { ...base, targets: [], onCallSources: [], error: errorMessage(err) };
      }
    }),
  );
  return { accounts: results };
}

// ---------------------------------------------------------------------------
// Outbound events
// ---------------------------------------------------------------------------

/** Where an Infrawrench alert is in its own life, as the paging leg needs it. */
export interface PagingLifecycle {
  /** Stable per condition: `probe:<id>`, `incident:<id>`, `page:<source>:<key>`. */
  key: string;
  phase: "open" | "acknowledged" | "resolved";
}

/** What the outbound leg needs from an alert. A structural subset of `AlertEvent`. */
export interface PagingAlert {
  organizationId: string;
  trigger: string;
  severity: PagingSeverity;
  title: string;
  body: string;
  url?: string | null;
  context?: string;
  facts?: { accountId?: string; pluginId?: string; resourceId?: string; key?: string };
  lifecycle?: PagingLifecycle;
}

type EventRow = typeof pagingProviderEvents.$inferSelect;
type StoredPayload = Omit<PagingEvent, "action" | "dedupKey">;

const MAX_ATTEMPTS = 8;
const SEND_LEASE_MS = 2 * 60_000;
const STATE_FOR_ACTION: Record<PagingEventAction, PagingEventState> = {
  trigger: "triggered",
  acknowledge: "acknowledged",
  resolve: "resolved",
};
const ACTION_FOR_STATE: Record<PagingEventState, PagingEventAction> = {
  triggered: "trigger",
  acknowledged: "acknowledge",
  resolved: "resolve",
};

/**
 * The lifecycle key for an alert that brought none: repeat raises of the same
 * thing (the same budget, the same resource) land on the same upstream alert
 * as a new trigger entry instead of opening a fresh incident each time.
 */
function lifecycleKeyFor(alert: PagingAlert): string {
  if (alert.lifecycle) return alert.lifecycle.key;
  const subject =
    alert.facts?.resourceId ??
    alert.facts?.key ??
    alert.facts?.accountId ??
    alert.title.slice(0, 120);
  return `${alert.trigger}:${subject}`;
}

function payloadFor(alert: PagingAlert): StoredPayload {
  const details: Record<string, string> = { trigger: alert.trigger };
  if (alert.facts?.key) details.key = alert.facts.key;
  if (alert.facts?.pluginId) details.provider = alert.facts.pluginId;
  if (alert.context) details.context = alert.context;
  return {
    summary: alert.title,
    body: alert.body,
    severity: alert.severity,
    source: `infrawrench/${alert.trigger}`,
    url: alert.url ?? null,
    details,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Open (or re-trigger) an upstream alert on each destination. Returns how many
 * destinations were attempted and how many took it (sent now, or durably
 * queued where plugin code cannot run). Never throws.
 */
export async function sendPagingDestinations(
  alert: PagingAlert,
  destinations: ReadonlyArray<{ accountId: string; targetId: string }>,
  options: { alertDeliveryId?: string | null } = {},
): Promise<{ attempted: number; succeeded: number }> {
  if (destinations.length === 0) return { attempted: 0, succeeded: 0 };
  const lifecycleKey = lifecycleKeyFor(alert);
  const dedupKey = pagingDedupKey(alert.organizationId, lifecycleKey);
  const payload = payloadFor(alert);
  const now = new Date();
  let succeeded = 0;

  // Only accounts that are this org's and paging-capable; a destination naming
  // anything else contributes nothing (the API validates on save, this guards
  // against a rule that outlived its account).
  const owned = await db
    .select({ id: accounts.id, pluginId: accounts.pluginId })
    .from(accounts)
    .where(
      and(
        eq(accounts.organizationId, alert.organizationId),
        inArray(
          accounts.id,
          destinations.map((d) => d.accountId),
        ),
      ),
    );
  const ownedIds = new Set(owned.map((o) => o.id));

  for (const dest of destinations) {
    if (!ownedIds.has(dest.accountId)) continue;
    try {
      const [row] = await db
        .insert(pagingProviderEvents)
        .values({
          id: randomUUID(),
          organizationId: alert.organizationId,
          accountId: dest.accountId,
          targetId: dest.targetId,
          dedupKey,
          lifecycleKey,
          alertDeliveryId: options.alertDeliveryId ?? null,
          trigger: alert.trigger,
          title: alert.title.slice(0, 500),
          state: "triggered",
          pendingAction: "trigger",
          payload,
          nextAttemptAt: now,
        })
        .onConflictDoUpdate({
          target: [
            pagingProviderEvents.accountId,
            pagingProviderEvents.targetId,
            pagingProviderEvents.dedupKey,
          ],
          set: {
            // A re-raise is a new trigger on the same upstream alert. If the
            // last one was resolved upstream, PagerDuty opens a fresh incident
            // under the same key, which is what a recurrence should do.
            state: "triggered",
            pendingAction: "trigger",
            payload,
            title: alert.title.slice(0, 500),
            trigger: alert.trigger,
            lifecycleKey,
            alertDeliveryId: sql`coalesce(excluded.alert_delivery_id, ${pagingProviderEvents.alertDeliveryId})`,
            attempts: 0,
            lastError: null,
            nextAttemptAt: now,
            updatedAt: now,
          },
        })
        .returning({ id: pagingProviderEvents.id });
      if (!row) continue;
      if (!pluginCodeAvailable()) {
        // Durably queued: the gateway pass sends it within a tick.
        succeeded += 1;
        continue;
      }
      const sent = await flushPagingEvent(row.id);
      if (sent !== "failed") succeeded += 1;
    } catch (err) {
      console.error(
        `[paging] failed to queue ${alert.trigger} for account ${dest.accountId}:`,
        errorMessage(err),
      );
    }
  }
  return { attempted: destinations.length, succeeded };
}

/**
 * Ask for an acknowledge or resolve on every upstream alert matching `where`,
 * then try to send it. Rows already at or past the requested state are left
 * alone, so a late acknowledgement never reopens a resolved alert.
 *
 * A resolve on a row whose trigger never reached the provider simply settles
 * the row: nobody was paged, so there is nothing to resolve.
 */
async function requestAction(
  where: ReturnType<typeof and>,
  action: "acknowledge" | "resolve",
): Promise<number> {
  const now = new Date();
  const notPast =
    action === "acknowledge"
      ? eq(pagingProviderEvents.state, "triggered")
      : ne(pagingProviderEvents.state, "resolved");
  const rows = await db
    .update(pagingProviderEvents)
    .set({
      state: STATE_FOR_ACTION[action],
      pendingAction:
        action === "resolve"
          ? sql`case when ${pagingProviderEvents.sentAt} is null then null else 'resolve' end`
          : sql`case when ${pagingProviderEvents.sentAt} is null then ${pagingProviderEvents.pendingAction} else 'acknowledge' end`,
      attempts: 0,
      lastError: null,
      nextAttemptAt: now,
      updatedAt: now,
    })
    .where(and(where, notPast))
    .returning({ id: pagingProviderEvents.id, pendingAction: pagingProviderEvents.pendingAction });

  if (pluginCodeAvailable()) {
    await Promise.all(rows.filter((r) => r.pendingAction).map((r) => flushPagingEvent(r.id)));
  }
  return rows.length;
}

/**
 * Apply an alert's lifecycle to every upstream alert it opened, whichever rule
 * opened them. Called by `routeAlert` for an acknowledged/resolved event, and
 * directly by the paths that end a condition without raising an alert
 * (clearing a page). Never throws.
 */
export async function applyPagingLifecycle(
  organizationId: string,
  lifecycleKey: string,
  phase: "acknowledged" | "resolved",
): Promise<void> {
  try {
    await requestAction(
      and(
        eq(pagingProviderEvents.organizationId, organizationId),
        eq(pagingProviderEvents.lifecycleKey, lifecycleKey),
      ),
      phase === "resolved" ? "resolve" : "acknowledge",
    );
  } catch (err) {
    console.error(`[paging] lifecycle ${phase} for ${lifecycleKey} failed:`, errorMessage(err));
  }
}

/**
 * An Infrawrench acknowledgement of an escalating alert, written upstream to
 * every provider alert that delivery opened. Never throws.
 */
export async function acknowledgePagingForDelivery(
  organizationId: string,
  alertDeliveryId: string,
): Promise<void> {
  try {
    await requestAction(
      and(
        eq(pagingProviderEvents.organizationId, organizationId),
        eq(pagingProviderEvents.alertDeliveryId, alertDeliveryId),
      ),
      "acknowledge",
    );
  } catch (err) {
    console.error(
      `[paging] acknowledgement for delivery ${alertDeliveryId} failed:`,
      errorMessage(err),
    );
  }
}

function backoffMs(attempts: number): number {
  return Math.min(60, 2 ** Math.max(0, attempts - 1)) * 60_000;
}

/**
 * Claim one row's pending action and send it. Returns `sent`, `skipped`
 * (nothing pending, or another worker holds it) or `failed` (left for retry
 * or given up). Never throws.
 */
export async function flushPagingEvent(id: string): Promise<"sent" | "skipped" | "failed"> {
  const now = new Date();
  const [claimed] = await db
    .update(pagingProviderEvents)
    .set({ nextAttemptAt: new Date(now.getTime() + SEND_LEASE_MS), updatedAt: now })
    .where(
      and(
        eq(pagingProviderEvents.id, id),
        isNotNull(pagingProviderEvents.pendingAction),
        or(
          isNull(pagingProviderEvents.nextAttemptAt),
          lte(pagingProviderEvents.nextAttemptAt, now),
        ),
      ),
    )
    .returning();
  if (!claimed) return "skipped";
  return sendClaimed(claimed);
}

async function sendClaimed(row: EventRow): Promise<"sent" | "failed"> {
  const action = row.pendingAction as PagingEventAction;
  const now = new Date();
  try {
    const { client, paging } = await pagingAccountClient(row.organizationId, row.accountId);
    let url: string | null = row.externalUrl;
    // A provider that cannot acknowledge by event (an HTTP alert source only
    // knows firing and resolved) records the state without a send.
    if (!(action === "acknowledge" && !paging.supportsAcknowledgeEvent)) {
      const result = await client.sendPagingEvent!(row.targetId, {
        ...(row.payload as StoredPayload),
        action,
        dedupKey: row.dedupKey,
      });
      url = result.url ?? url;
    }
    await db.transaction(async (tx) => {
      const [current] = await tx
        .select({ state: pagingProviderEvents.state })
        .from(pagingProviderEvents)
        .where(eq(pagingProviderEvents.id, row.id))
        .for("update");
      // If the alert moved on while this send was in flight (a resolve arrived
      // behind a trigger), queue the follow-up rather than dropping it.
      const wanted = current
        ? (ACTION_FOR_STATE[current.state as PagingEventState] ?? action)
        : action;
      const next = wanted !== action ? wanted : null;
      await tx
        .update(pagingProviderEvents)
        .set({
          pendingAction: next,
          nextAttemptAt: next ? now : null,
          attempts: 0,
          lastError: null,
          sentAt: action === "trigger" ? now : (row.sentAt ?? now),
          externalUrl: url,
          updatedAt: now,
        })
        .where(eq(pagingProviderEvents.id, row.id));
    });
    return "sent";
  } catch (err) {
    const status = errorStatus(err);
    const attempts = row.attempts + 1;
    // 4xx other than throttling will not fix itself by waiting.
    const permanent =
      (status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429) ||
      err instanceof PagingProviderError ||
      attempts >= MAX_ATTEMPTS;
    console.error(
      `[paging] ${action} for ${row.dedupKey} on account ${row.accountId} failed (attempt ${attempts}):`,
      errorMessage(err),
    );
    await db
      .update(pagingProviderEvents)
      .set({
        attempts,
        lastError: (permanent ? "Gave up: " : "") + errorMessage(err).slice(0, 500),
        pendingAction: permanent ? null : row.pendingAction,
        nextAttemptAt: permanent ? null : new Date(now.getTime() + backoffMs(attempts)),
        updatedAt: now,
      })
      .where(eq(pagingProviderEvents.id, row.id));
    return "failed";
  }
}

/** The outbound log for the settings page, newest first. */
export async function listPagingEvents(
  organizationId: string,
  limit = 50,
): Promise<PagingEventRecord[]> {
  const rows = await db
    .select()
    .from(pagingProviderEvents)
    .where(eq(pagingProviderEvents.organizationId, organizationId))
    .orderBy(desc(pagingProviderEvents.updatedAt))
    .limit(Math.min(Math.max(limit, 1), 200));
  return rows.map((r) => ({
    id: r.id,
    accountId: r.accountId,
    targetId: r.targetId,
    dedupKey: r.dedupKey,
    trigger: r.trigger,
    title: r.title,
    state: r.state as PagingEventState,
    pendingAction: r.pendingAction as PagingEventRecord["pendingAction"],
    attempts: r.attempts,
    lastError: r.lastError,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    sentAt: r.sentAt?.toISOString() ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Upstream state flowing back into Infrawrench
// ---------------------------------------------------------------------------

/**
 * A provider says a person acknowledged (or something resolved) the upstream
 * alert behind `dedupKey`. Record it on the event row without echoing it back,
 * and settle the Infrawrench escalation that alert belongs to: nobody should be
 * escalated to about a page somebody already took upstream.
 */
async function settleFromUpstream(
  organizationId: string,
  accountId: string,
  pluginId: string,
  dedupKey: string,
  phase: "acknowledged" | "resolved",
  actorEmail: string | null,
): Promise<void> {
  const now = new Date();
  const rows = await db
    .update(pagingProviderEvents)
    .set({
      state: phase,
      // Only clear a pending send that the upstream change makes moot.
      pendingAction: sql`case when ${pagingProviderEvents.pendingAction} in ('trigger','acknowledge') then null else ${pagingProviderEvents.pendingAction} end`,
      updatedAt: now,
    })
    .where(
      and(
        eq(pagingProviderEvents.organizationId, organizationId),
        eq(pagingProviderEvents.accountId, accountId),
        eq(pagingProviderEvents.dedupKey, dedupKey),
        phase === "acknowledged"
          ? eq(pagingProviderEvents.state, "triggered")
          : ne(pagingProviderEvents.state, "resolved"),
      ),
    )
    .returning({ alertDeliveryId: pagingProviderEvents.alertDeliveryId });
  const deliveryIds = [
    ...new Set(rows.map((r) => r.alertDeliveryId).filter((id): id is string => !!id)),
  ];
  if (deliveryIds.length === 0) return;

  const actorUserId = actorEmail
    ? ((await membersByEmail(organizationId, [actorEmail])).get(actorEmail.toLowerCase()) ?? null)
    : null;
  // The same conditional shape `acknowledgeAlert` uses: only a row still
  // waiting on an acknowledgement moves, so a race with the escalation pass
  // has exactly one winner.
  await db
    .update(alertDeliveries)
    .set({
      state: "acknowledged",
      acknowledgedAt: now,
      acknowledgedByUserId: actorUserId,
      acknowledgedVia: pluginId,
      escalateAt: null,
      deliverAfter: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(alertDeliveries.organizationId, organizationId),
        inArray(alertDeliveries.id, deliveryIds),
        eq(alertDeliveries.state, "awaiting_ack"),
      ),
    );
}

function incidentValues(organizationId: string, accountId: string, incident: PagingIncident) {
  const now = new Date();
  return {
    organizationId,
    accountId,
    externalId: incident.id,
    reference: incident.reference ?? null,
    title: incident.title.slice(0, 1000),
    status: incident.status,
    statusLabel: incident.statusLabel ?? null,
    urgency: incident.urgency ?? null,
    url: incident.url ?? null,
    serviceName: incident.serviceName ?? null,
    assignees: incident.assignees.slice(0, 20),
    dedupKey: incident.dedupKey ?? null,
    externalCreatedAt: new Date(incident.createdAt),
    externalUpdatedAt: incident.updatedAt ? new Date(incident.updatedAt) : null,
    resolvedAt: incident.resolvedAt ? new Date(incident.resolvedAt) : null,
    syncedAt: now,
  };
}

/** Upsert mirrored incidents and settle any Infrawrench alerts they answer. */
async function storeIncidents(
  organizationId: string,
  accountId: string,
  pluginId: string,
  incidents: PagingIncident[],
  options: { mirror: boolean },
): Promise<void> {
  for (const incident of incidents) {
    if (options.mirror) {
      const values = incidentValues(organizationId, accountId, incident);
      await db
        .insert(pagingProviderIncidents)
        .values({ id: randomUUID(), ...values })
        .onConflictDoUpdate({
          target: [pagingProviderIncidents.accountId, pagingProviderIncidents.externalId],
          set: values,
        });
    }
    if (incident.dedupKey && incident.status !== "triggered") {
      await settleFromUpstream(
        organizationId,
        accountId,
        pluginId,
        incident.dedupKey,
        incident.status,
        incident.assignees[0]?.email ?? null,
      );
    }
  }
}

/**
 * Reconcile one account's incidents with the provider. The window reaches back
 * a day on the first run and to the last successful sync (minus a margin for
 * clock skew) after that.
 */
export async function syncPagingIncidents(
  organizationId: string,
  accountId: string,
): Promise<number> {
  const settings = await loadSettings(accountId);
  const now = new Date();
  const since = settings?.lastSyncedAt
    ? new Date(settings.lastSyncedAt.getTime() - 10 * 60_000)
    : new Date(now.getTime() - 24 * 3600_000);
  try {
    const { client, pluginId } = await pagingAccountClient(organizationId, accountId);
    if (!client.listPagingIncidents) return 0;
    const incidents = await client.listPagingIncidents({ since, includeResolved: true });
    await storeIncidents(organizationId, accountId, pluginId, incidents, {
      mirror: settings?.inboundEnabled ?? false,
    });
    const interval = settings?.encryptedWebhookSecret
      ? SYNC_INTERVAL_WITH_WEBHOOK_MS
      : SYNC_INTERVAL_MS;
    await db
      .update(pagingProviderSettings)
      .set({
        lastSyncedAt: now,
        lastSyncError: null,
        nextSyncAt: settings?.inboundEnabled ? new Date(now.getTime() + interval) : null,
        updatedAt: now,
      })
      .where(eq(pagingProviderSettings.accountId, accountId));
    return incidents.length;
  } catch (err) {
    await db
      .update(pagingProviderSettings)
      .set({ lastSyncError: errorMessage(err).slice(0, 500), updatedAt: now })
      .where(eq(pagingProviderSettings.accountId, accountId));
    throw err;
  }
}

function toIncidentRecord(
  row: typeof pagingProviderIncidents.$inferSelect,
  account: { displayName: string; pluginId: string },
  paging: PagingCapabilityDeclaration | null,
  fromInfrawrench: boolean,
): PagerIncidentRecord {
  return {
    id: row.id,
    accountId: row.accountId,
    accountName: account.displayName,
    pluginId: account.pluginId,
    externalId: row.externalId,
    reference: row.reference,
    title: row.title,
    status: row.status as PagerIncidentRecord["status"],
    statusLabel: row.statusLabel,
    urgency: row.urgency,
    url: row.url,
    serviceName: row.serviceName,
    assignees: Array.isArray(row.assignees)
      ? (row.assignees as PagerIncidentRecord["assignees"])
      : [],
    createdAt: row.externalCreatedAt.toISOString(),
    updatedAt: row.externalUpdatedAt?.toISOString() ?? null,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    fromInfrawrench,
    canAcknowledge: Boolean(paging?.incidents?.canAcknowledge) && row.status === "triggered",
    canResolve: Boolean(paging?.incidents?.canResolve) && row.status !== "resolved",
  };
}

/** Mirrored incidents for the incidents surfaces. Open first. */
export async function listPagerIncidents(
  organizationId: string,
  options: { status?: "open" | "all"; limit?: number } = {},
): Promise<PagerIncidentRecord[]> {
  const where =
    options.status === "all"
      ? eq(pagingProviderIncidents.organizationId, organizationId)
      : and(
          eq(pagingProviderIncidents.organizationId, organizationId),
          ne(pagingProviderIncidents.status, "resolved"),
        );
  const rows = await db
    .select({
      incident: pagingProviderIncidents,
      displayName: accounts.displayName,
      pluginId: accounts.pluginId,
    })
    .from(pagingProviderIncidents)
    .innerJoin(accounts, eq(accounts.id, pagingProviderIncidents.accountId))
    .where(where)
    .orderBy(desc(pagingProviderIncidents.externalCreatedAt))
    .limit(Math.min(Math.max(options.limit ?? 100, 1), 500));
  if (rows.length === 0) return [];

  const dedupKeys = rows.map((r) => r.incident.dedupKey).filter((k): k is string => !!k);
  const ours = dedupKeys.length
    ? await db
        .select({
          accountId: pagingProviderEvents.accountId,
          dedupKey: pagingProviderEvents.dedupKey,
        })
        .from(pagingProviderEvents)
        .where(
          and(
            eq(pagingProviderEvents.organizationId, organizationId),
            inArray(pagingProviderEvents.dedupKey, dedupKeys),
          ),
        )
    : [];
  const ourKeys = new Set(ours.map((o) => `${o.accountId}\u0000${o.dedupKey}`));
  const declarations = new Map<string, PagingCapabilityDeclaration | null>();
  for (const r of rows) {
    if (!declarations.has(r.pluginId))
      declarations.set(r.pluginId, await pagingDeclaration(r.pluginId));
  }
  return rows.map((r) =>
    toIncidentRecord(
      r.incident,
      { displayName: r.displayName, pluginId: r.pluginId },
      declarations.get(r.pluginId) ?? null,
      Boolean(
        r.incident.dedupKey && ourKeys.has(`${r.incident.accountId}\u0000${r.incident.dedupKey}`),
      ),
    ),
  );
}

/**
 * Acknowledge or resolve a mirrored incident upstream, as the acting member.
 * The new state is stored from the provider's answer, not assumed.
 */
export async function actOnPagerIncident(
  organizationId: string,
  incidentRowId: string,
  action: "acknowledge" | "resolve",
  actorEmail: string | null,
): Promise<PagerIncidentRecord> {
  const [row] = await db
    .select({
      incident: pagingProviderIncidents,
      displayName: accounts.displayName,
      pluginId: accounts.pluginId,
    })
    .from(pagingProviderIncidents)
    .innerJoin(accounts, eq(accounts.id, pagingProviderIncidents.accountId))
    .where(
      and(
        eq(pagingProviderIncidents.organizationId, organizationId),
        eq(pagingProviderIncidents.id, incidentRowId),
      ),
    )
    .limit(1);
  if (!row) throw new PagingProviderError("No such incident", 404);

  const { client, paging, pluginId } = await pagingAccountClient(
    organizationId,
    row.incident.accountId,
  );
  const allowed =
    action === "acknowledge" ? paging.incidents?.canAcknowledge : paging.incidents?.canResolve;
  if (!allowed || !client.updatePagingIncident) {
    throw new PagingProviderError(`This provider cannot ${action} incidents from Infrawrench`, 400);
  }
  const updated = await client.updatePagingIncident(row.incident.externalId, {
    action,
    actorEmail,
  });
  await storeIncidents(organizationId, row.incident.accountId, pluginId, [updated], {
    mirror: true,
  });
  const [stored] = await db
    .select()
    .from(pagingProviderIncidents)
    .where(eq(pagingProviderIncidents.id, incidentRowId))
    .limit(1);
  return toIncidentRecord(
    stored ?? row.incident,
    { displayName: row.displayName, pluginId: row.pluginId },
    paging,
    false,
  );
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

/** At most this many incidents are re-read per delivery. */
const MAX_REFRESH_PER_WEBHOOK = 20;

/**
 * Handle one inbound webhook delivery. The token picks the account; the
 * plugin verifies the signature with the stored secret. Returns the HTTP
 * status to answer with: 404 for an unknown token, 401 for a bad signature,
 * 202 once accepted.
 */
export async function handlePagingWebhook(
  token: string,
  headers: Record<string, string>,
  body: string,
): Promise<number> {
  const [settings] = await db
    .select({
      settings: pagingProviderSettings,
      pluginId: accounts.pluginId,
    })
    .from(pagingProviderSettings)
    .innerJoin(accounts, eq(accounts.id, pagingProviderSettings.accountId))
    .where(eq(pagingProviderSettings.webhookToken, token))
    .limit(1);
  if (
    !settings ||
    !settings.settings.encryptedWebhookSecret ||
    !settings.settings.webhookSecretIv
  ) {
    return 404;
  }
  const { accountId, organizationId } = settings.settings;
  const loaded = await getPlugin(settings.pluginId);
  if (!loaded?.plugin.verifyPagingWebhook) return 404;

  const secret = await decrypt(
    settings.settings.encryptedWebhookSecret,
    settings.settings.webhookSecretIv,
    webhookAad(accountId),
  );
  const result = await loaded.plugin.verifyPagingWebhook({
    headers,
    body,
    secret,
    now: new Date(),
  });
  if (!result.valid) return 401;

  for (const key of result.acknowledgedDedupKeys) {
    await settleFromUpstream(
      organizationId,
      accountId,
      settings.pluginId,
      key,
      "acknowledged",
      result.actorEmail ?? null,
    );
  }
  for (const key of result.resolvedDedupKeys) {
    await settleFromUpstream(
      organizationId,
      accountId,
      settings.pluginId,
      key,
      "resolved",
      result.actorEmail ?? null,
    );
  }
  if (settings.settings.inboundEnabled && result.incidentIds.length > 0) {
    // The payload is a nudge, not the record: re-read each incident so an
    // out-of-order delivery cannot roll the mirror back.
    try {
      const { client, pluginId } = await pagingAccountClient(organizationId, accountId);
      const ids = [...new Set(result.incidentIds)].slice(0, MAX_REFRESH_PER_WEBHOOK);
      for (const id of ids) {
        const incident = await client.getPagingIncident?.(id);
        if (incident) {
          await storeIncidents(organizationId, accountId, pluginId, [incident], { mirror: true });
        }
      }
    } catch (err) {
      // Accepted anyway: the reconcile pass will catch up, and a non-2xx would
      // only make the provider retry into the same failure.
      console.error(`[paging] webhook refresh for account ${accountId} failed:`, errorMessage(err));
    }
  }
  return 202;
}

// ---------------------------------------------------------------------------
// The poller pass
// ---------------------------------------------------------------------------

const PASS_BATCH = 25;
/** Reconcile cadence: faster without a webhook, because polling is all there is. */
const SYNC_INTERVAL_MS = 2 * 60_000;
const SYNC_INTERVAL_WITH_WEBHOOK_MS = 15 * 60_000;
const RETENTION_MS = 30 * 24 * 3600_000;

/**
 * The `paging-providers` pass: send due outbound events, reconcile due
 * accounts, prune what is finished. Gateway-only, because it calls plugin
 * code for arbitrary accounts. Claims are leases written into the due column,
 * so any number of replicas can run it.
 */
export async function runPagingProvidersPass(): Promise<{ sent: number; synced: number }> {
  const now = new Date();
  let sent = 0;
  let synced = 0;

  const due = await db
    .update(pagingProviderEvents)
    .set({ nextAttemptAt: new Date(now.getTime() + SEND_LEASE_MS), updatedAt: now })
    .where(
      inArray(
        pagingProviderEvents.id,
        db
          .select({ id: pagingProviderEvents.id })
          .from(pagingProviderEvents)
          .where(
            and(
              isNotNull(pagingProviderEvents.pendingAction),
              isNotNull(pagingProviderEvents.nextAttemptAt),
              lte(pagingProviderEvents.nextAttemptAt, now),
            ),
          )
          .limit(PASS_BATCH)
          .for("update", { skipLocked: true }),
      ),
    )
    .returning();
  for (const row of due) {
    if ((await sendClaimed(row)) === "sent") sent += 1;
  }

  const accountsDue = await db
    .update(pagingProviderSettings)
    .set({
      // A lease; a successful reconcile moves it to the real next slot.
      nextSyncAt: new Date(now.getTime() + SYNC_INTERVAL_MS),
    })
    .where(
      inArray(
        pagingProviderSettings.accountId,
        db
          .select({ id: pagingProviderSettings.accountId })
          .from(pagingProviderSettings)
          .where(
            and(
              eq(pagingProviderSettings.inboundEnabled, true),
              or(
                isNull(pagingProviderSettings.nextSyncAt),
                lte(pagingProviderSettings.nextSyncAt, now),
              ),
            ),
          )
          .limit(PASS_BATCH)
          .for("update", { skipLocked: true }),
      ),
    )
    .returning({
      accountId: pagingProviderSettings.accountId,
      organizationId: pagingProviderSettings.organizationId,
    });
  for (const row of accountsDue) {
    try {
      await syncPagingIncidents(row.organizationId, row.accountId);
      synced += 1;
    } catch (err) {
      console.error(`[paging] reconcile for account ${row.accountId} failed:`, errorMessage(err));
    }
  }

  const cutoff = new Date(now.getTime() - RETENTION_MS);
  await db
    .delete(pagingProviderEvents)
    .where(
      and(
        eq(pagingProviderEvents.state, "resolved"),
        isNull(pagingProviderEvents.pendingAction),
        lte(pagingProviderEvents.updatedAt, cutoff),
      ),
    );
  await db
    .delete(pagingProviderIncidents)
    .where(
      and(
        eq(pagingProviderIncidents.status, "resolved"),
        lte(pagingProviderIncidents.syncedAt, cutoff),
      ),
    );

  return { sent, synced };
}
