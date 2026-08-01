/**
 * Slack as an alert transport.
 *
 * An org installs the Infrawrench Slack app through the standard "Add to Slack"
 * OAuth flow; we keep the resulting bot token and post alerts into whichever
 * channels the org picked. A channel opts into each trigger independently — the
 * five mobile push has (sync incidents, budget alerts, cost anomalies, resource
 * drift, workflow pages) plus the channel-only weekly digest — so a channel can
 * take budget crossings without also taking every sync failure.
 *
 * Config (env):
 *   SLACK_CLIENT_ID      — the Slack app's client id
 *   SLACK_CLIENT_SECRET  — the Slack app's client secret
 *
 * Without both, `isSlackConfigured()` is false, the settings UI says so, and
 * every send here is a no-op. That is the same shape as the GitHub App: a
 * self-hosted deployment that never registers a Slack app simply doesn't get
 * the feature, rather than erroring.
 */
import { and, eq, isNull } from "drizzle-orm";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { SlackAvailableChannel } from "@infrawrench/client-core";

import { db } from "./db/client";
import { slackChannels, slackInstallations } from "./db/schema";
import { buildAad, decrypt, encrypt } from "./encryption";
import type { ChannelTrigger } from "./push/types";

const SLACK_API = "https://slack.com/api";

/** Abort Slack requests after 10s so a hung connection can't stall paging. */
const SLACK_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Scopes requested at install. `chat:write.public` is what lets the bot post to
 * a public channel it hasn't been invited to — without it every channel the
 * org picks would need a manual `/invite`. Private channels still require an
 * invite; the settings UI says so.
 */
export const SLACK_SCOPES = ["chat:write", "chat:write.public", "channels:read", "groups:read"];

export function slackClientId(): string | null {
  return process.env["SLACK_CLIENT_ID"] ?? null;
}

function slackClientSecret(): string {
  const v = process.env["SLACK_CLIENT_SECRET"];
  if (!v) throw new Error("SLACK_CLIENT_SECRET is not configured.");
  return v;
}

/** Whether this deployment has a Slack app registered (id + secret present). */
export function isSlackConfigured(): boolean {
  return Boolean(process.env["SLACK_CLIENT_ID"] && process.env["SLACK_CLIENT_SECRET"]);
}

// --- Signed state for the install round-trip (binds the install to an org) ---

function stateKey(): Buffer {
  // Derived from the client secret so the `state` we hand Slack can't be forged
  // to attach someone else's workspace install to another org.
  return createHash("sha256").update(slackClientSecret()).digest();
}

export interface SlackInstallState {
  organizationId: string;
  /** The user who started the install, recorded on the installation row. */
  userId: string | null;
}

export function signSlackState(organizationId: string, userId?: string): string {
  const payload = JSON.stringify({ o: organizationId, ...(userId ? { u: userId } : {}) });
  const mac = createHmac("sha256", stateKey()).update(payload).digest("base64url");
  return `${Buffer.from(payload).toString("base64url")}.${mac}`;
}

export function verifySlackState(state: string): SlackInstallState | null {
  const [payloadB64, mac] = state.split(".");
  if (!payloadB64 || !mac) return null;
  const payload = Buffer.from(payloadB64, "base64url").toString("utf8");
  const expected = createHmac("sha256", stateKey()).update(payload).digest("base64url");
  const given = Buffer.from(mac);
  const want = Buffer.from(expected);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
  try {
    const parsed = JSON.parse(payload) as { o?: string; u?: string };
    if (!parsed.o) return null;
    return { organizationId: parsed.o, userId: parsed.u ?? null };
  } catch {
    return null;
  }
}

/** The URL the "Add to Slack" button points at. */
export function slackAuthorizeUrl(state: string, redirectUri: string): string {
  const clientId = slackClientId();
  if (!clientId) throw new Error("SLACK_CLIENT_ID is not configured.");
  const params = new URLSearchParams({
    client_id: clientId,
    scope: SLACK_SCOPES.join(","),
    state,
    redirect_uri: redirectUri,
  });
  return `https://slack.com/oauth/v2/authorize?${params.toString()}`;
}

// --- Slack API plumbing ---

interface SlackEnvelope {
  ok: boolean;
  error?: string;
}

/** How a method's arguments go up. See {@link slackCall}. */
type SlackEncoding = "json" | "form";

/**
 * Slack's form encoding: scalars as-is, anything structured as JSON text
 * (which is how Slack expects nested arguments in a form body).
 */
function formEncode(body: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || value === null) continue;
    params.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
  }
  return params.toString();
}

/**
 * Call a Slack Web API method with a bot token. Slack answers 200 with
 * `{ok: false, error}` for most failures, so the envelope matters more than the
 * HTTP status.
 *
 * `encoding` is not a style choice. Slack's reference lists
 * `application/json` as an accepted content type for read methods like
 * `conversations.list`, but it does not actually *honour* arguments sent that
 * way: the call returns `ok: true` with the arguments silently defaulted. Sent
 * as JSON, `types: "public_channel,private_channel"` came back byte-identical
 * to sending no `types` at all — i.e. public channels only, with no error to
 * notice. So reads go up form-encoded. `chat.postMessage` genuinely needs JSON
 * (its `blocks` are a structured array), and it honours it.
 */
async function slackCall<T extends SlackEnvelope>(
  method: string,
  token: string,
  body: Record<string, unknown>,
  encoding: SlackEncoding = "json",
): Promise<T> {
  const res = await fetch(`${SLACK_API}/${method}`, {
    method: "POST",
    signal: AbortSignal.timeout(SLACK_REQUEST_TIMEOUT_MS),
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type":
        encoding === "form"
          ? "application/x-www-form-urlencoded; charset=utf-8"
          : "application/json; charset=utf-8",
    },
    body: encoding === "form" ? formEncode(body) : JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Slack ${method} HTTP ${res.status}`);
  }
  const json = (await res.json()) as T;
  if (!json.ok) {
    throw new Error(`Slack ${method} failed: ${json.error ?? "unknown_error"}`);
  }
  return json;
}

interface OauthAccessResponse extends SlackEnvelope {
  access_token?: string;
  token_type?: string;
  scope?: string;
  bot_user_id?: string;
  team?: { id?: string; name?: string };
}

export interface SlackInstallResult {
  teamId: string;
  teamName: string | null;
  botUserId: string | null;
  botToken: string;
  scopes: string | null;
}

/**
 * Exchange the OAuth `code` for a bot token. Credentials go in an HTTP Basic
 * header rather than the form body, as Slack's docs prefer.
 */
export async function exchangeSlackCode(
  code: string,
  redirectUri: string,
): Promise<SlackInstallResult> {
  const clientId = slackClientId();
  if (!clientId) throw new Error("SLACK_CLIENT_ID is not configured.");
  const params = new URLSearchParams({ code, redirect_uri: redirectUri });
  const basic = Buffer.from(`${clientId}:${slackClientSecret()}`).toString("base64");

  const res = await fetch(`${SLACK_API}/oauth.v2.access`, {
    method: "POST",
    signal: AbortSignal.timeout(SLACK_REQUEST_TIMEOUT_MS),
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });
  if (!res.ok) throw new Error(`Slack oauth.v2.access HTTP ${res.status}`);
  const json = (await res.json()) as OauthAccessResponse;
  if (!json.ok) throw new Error(`Slack install failed: ${json.error ?? "unknown_error"}`);
  if (!json.access_token || !json.team?.id) {
    throw new Error("Slack install returned no bot token");
  }
  return {
    teamId: json.team.id,
    teamName: json.team.name ?? null,
    botUserId: json.bot_user_id ?? null,
    botToken: json.access_token,
    scopes: json.scope ?? null,
  };
}

/** Record (or refresh) an install. Re-installing the same workspace updates it. */
export async function recordSlackInstall(
  organizationId: string,
  userId: string | null,
  install: SlackInstallResult,
): Promise<string> {
  const enc = await encrypt(install.botToken, buildAad("slack", organizationId, "botToken"));
  const now = new Date();
  const [row] = await db
    .insert(slackInstallations)
    .values({
      id: randomUUID(),
      organizationId,
      teamId: install.teamId,
      teamName: install.teamName,
      botUserId: install.botUserId,
      scopes: install.scopes,
      encryptedBotToken: enc.ciphertext,
      botTokenIv: enc.iv,
      installedByUserId: userId,
    })
    .onConflictDoUpdate({
      target: [slackInstallations.organizationId, slackInstallations.teamId],
      set: {
        teamName: install.teamName,
        botUserId: install.botUserId,
        scopes: install.scopes,
        encryptedBotToken: enc.ciphertext,
        botTokenIv: enc.iv,
        installedByUserId: userId,
        // A re-install revives the previous connection, so the channels the org
        // already picked (and their trigger opt-ins) come back with it.
        deletedAt: null,
        updatedAt: now,
      },
    })
    .returning({ id: slackInstallations.id });
  if (!row) throw new Error("Failed to record Slack installation");
  return row.id;
}

interface LiveInstallation {
  id: string;
  teamId: string;
  teamName: string | null;
  token: string;
}

/** Load an org's live installs with their tokens decrypted. */
async function loadInstallations(organizationId: string): Promise<LiveInstallation[]> {
  const rows = await db
    .select()
    .from(slackInstallations)
    .where(
      and(
        eq(slackInstallations.organizationId, organizationId),
        isNull(slackInstallations.deletedAt),
      ),
    );
  const live: LiveInstallation[] = [];
  for (const row of rows) {
    try {
      const token = await decrypt(
        row.encryptedBotToken,
        row.botTokenIv,
        buildAad("slack", organizationId, "botToken"),
      );
      live.push({ id: row.id, teamId: row.teamId, teamName: row.teamName, token });
    } catch (err) {
      console.error("[slack] failed to decrypt bot token for org", organizationId, err);
    }
  }
  return live;
}

/** One install's token, or null when the org has no live install for it. */
async function loadInstallationToken(
  organizationId: string,
  installationId: string,
): Promise<string | null> {
  const installs = await loadInstallations(organizationId);
  return installs.find((i) => i.id === installationId)?.token ?? null;
}

// --- Channel listing (powers the picker) ---

/**
 * What the picker renders. Returned verbatim by
 * `GET /slack/installations/:id/available-channels`, so the definition is the
 * client contract in `@infrawrench/client-core`.
 */
export type SlackChannelInfo = SlackAvailableChannel;

interface ConversationsListResponse extends SlackEnvelope {
  channels?: Array<{ id?: string; name?: string; is_private?: boolean; is_archived?: boolean }>;
  response_metadata?: { next_cursor?: string };
}

/**
 * Every non-archived channel the install can see, so the settings UI can offer
 * a picker instead of asking anyone for a channel id. Paginated; capped at
 * `maxPages` so a workspace with tens of thousands of channels can't hang the
 * request.
 */
export async function listSlackChannels(
  organizationId: string,
  installationId: string,
  maxPages = 10,
): Promise<SlackChannelInfo[]> {
  const token = await loadInstallationToken(organizationId, installationId);
  if (!token) throw new Error("Slack workspace is not connected");

  const out: SlackChannelInfo[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const body: Record<string, unknown> = {
      types: "public_channel,private_channel",
      exclude_archived: true,
      limit: 200,
    };
    if (cursor) body["cursor"] = cursor;
    // Form-encoded, not JSON: sent as JSON, Slack ignores `types` and returns
    // public channels only — silently, with ok: true. See slackCall.
    const res = await slackCall<ConversationsListResponse>(
      "conversations.list",
      token,
      body,
      "form",
    );
    for (const ch of res.channels ?? []) {
      if (!ch.id || !ch.name || ch.is_archived) continue;
      out.push({ id: ch.id, name: ch.name, isPrivate: Boolean(ch.is_private) });
    }
    cursor = res.response_metadata?.next_cursor || undefined;
    if (!cursor) break;
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// --- Delivery ---

export interface SlackFanOutResult {
  attempted: number;
  succeeded: number;
  failed: number;
}

const NO_DELIVERY: SlackFanOutResult = { attempted: 0, succeeded: 0, failed: 0 };

export interface SlackAlert {
  /** Headline, rendered as the message's bold first line. */
  title: string;
  /** The alert text. */
  body: string;
  /** Optional deep link back into the app ("View in Infrawrench"). */
  url?: string;
  /** Small trailing context line, e.g. the workflow or account name. */
  context?: string;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/**
 * Block Kit payload for one alert. `text` is set too — it is the fallback used
 * in notifications and by clients that don't render blocks.
 */
function alertBlocks(alert: SlackAlert): { text: string; blocks: unknown[] } {
  const title = truncate(alert.title, 150);
  const body = truncate(alert.body, 2800);
  const blocks: unknown[] = [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*${escapeMrkdwn(title)}*\n${escapeMrkdwn(body)}` },
    },
  ];
  if (alert.url) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "View in Infrawrench" },
          url: alert.url,
        },
      ],
    });
  }
  if (alert.context) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: escapeMrkdwn(truncate(alert.context, 150)) }],
    });
  }
  return { text: `${title} — ${body}`, blocks };
}

/**
 * Escape the three characters Slack treats as markup delimiters. Alert bodies
 * carry provider error text, so a stray `<` must not silently eat the rest of
 * the message as a malformed link.
 */
function escapeMrkdwn(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const TRIGGER_COLUMN = {
  syncIncidents: slackChannels.syncIncidents,
  budgetAlerts: slackChannels.budgetAlerts,
  anomalyAlerts: slackChannels.anomalyAlerts,
  resourceDrift: slackChannels.resourceDrift,
  workflowPages: slackChannels.workflowPages,
  providerIncidents: slackChannels.providerIncidents,
  weeklyDigest: slackChannels.weeklyDigest,
} as const;

interface TargetChannel {
  channelId: string;
  channelName: string;
  installationId: string;
}

/** Channels opted into `trigger`, across the org's live installs. */
async function resolveTargets(
  organizationId: string,
  trigger: ChannelTrigger,
): Promise<TargetChannel[]> {
  return db
    .select({
      channelId: slackChannels.channelId,
      channelName: slackChannels.channelName,
      installationId: slackChannels.installationId,
    })
    .from(slackChannels)
    .innerJoin(slackInstallations, eq(slackInstallations.id, slackChannels.installationId))
    .where(
      and(
        eq(slackChannels.organizationId, organizationId),
        eq(TRIGGER_COLUMN[trigger], true),
        isNull(slackInstallations.deletedAt),
      ),
    );
}

/**
 * Post one alert to every channel opted into `trigger`. Never throws — a Slack
 * outage must not fail the poller, the budget evaluator, or the workflow that
 * raised the alert. Per-channel errors are logged and counted as failures so
 * the caller can still tell whether anything landed.
 */
export async function sendSlackToOrg(
  organizationId: string,
  trigger: ChannelTrigger,
  alert: SlackAlert,
): Promise<SlackFanOutResult> {
  try {
    if (!isSlackConfigured()) return NO_DELIVERY;
    const targets = await resolveTargets(organizationId, trigger);
    if (targets.length === 0) return NO_DELIVERY;

    const installs = await loadInstallations(organizationId);
    const tokenById = new Map(installs.map((i) => [i.id, i.token]));
    const payload = alertBlocks(alert);

    const jobs = targets.map(async (t) => {
      const token = tokenById.get(t.installationId);
      if (!token) throw new Error(`no live install for channel #${t.channelName}`);
      await slackCall("chat.postMessage", token, {
        channel: t.channelId,
        text: payload.text,
        blocks: payload.blocks,
        unfurl_links: false,
        unfurl_media: false,
      });
    });

    const settled = await Promise.allSettled(jobs);
    const succeeded = settled.filter((s) => s.status === "fulfilled").length;
    for (const [i, s] of settled.entries()) {
      if (s.status === "rejected") {
        console.error(`[slack] post to #${targets[i]?.channelName ?? "?"} failed:`, s.reason);
      }
    }
    return { attempted: jobs.length, succeeded, failed: jobs.length - succeeded };
  } catch (err) {
    console.error("[slack] fan-out failed:", err);
    return NO_DELIVERY;
  }
}

/**
 * Send a one-off test message to every channel the org has added, regardless of
 * trigger opt-ins. Throws (unlike `sendSlackToOrg`) so the settings UI can show
 * the actual Slack error — `not_in_channel` on a private channel is the common
 * one, and the user needs to see it.
 */
export async function sendSlackTest(organizationId: string): Promise<{
  channelCount: number;
  attempted: number;
  succeeded: number;
}> {
  if (!isSlackConfigured()) throw new Error("Slack is not configured on this server");
  const installs = await loadInstallations(organizationId);
  if (installs.length === 0) throw new Error("No Slack workspace is connected");
  const tokenById = new Map(installs.map((i) => [i.id, i.token]));

  const channels = await db
    .select()
    .from(slackChannels)
    .where(eq(slackChannels.organizationId, organizationId));
  if (channels.length === 0) throw new Error("No Slack channels configured");

  const payload = alertBlocks({
    title: "Test alert",
    body: "Your Infrawrench Slack connection is working. Real alerts will arrive here.",
  });

  const settled = await Promise.allSettled(
    channels.map(async (ch) => {
      const token = tokenById.get(ch.installationId);
      if (!token) throw new Error(`#${ch.channelName}: workspace is not connected`);
      try {
        await slackCall("chat.postMessage", token, {
          channel: ch.channelId,
          text: payload.text,
          blocks: payload.blocks,
          unfurl_links: false,
        });
      } catch (err) {
        // Prefix with the channel so a multi-channel failure is diagnosable.
        throw new Error(`#${ch.channelName}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),
  );
  const succeeded = settled.filter((s) => s.status === "fulfilled").length;
  if (succeeded === 0) {
    const first = settled.find((s) => s.status === "rejected");
    const reason =
      first && first.status === "rejected"
        ? first.reason instanceof Error
          ? first.reason.message
          : String(first.reason)
        : "unknown error";
    throw new Error(`Test message failed: ${reason}`);
  }
  return { channelCount: channels.length, attempted: channels.length, succeeded };
}
