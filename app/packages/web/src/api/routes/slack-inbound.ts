/**
 * Inbound Slack: slash commands, interactive buttons, and account linking.
 *
 * Three public endpoints (mounted at /api, no session):
 *
 *  - `POST /slack/commands` — the `/infrawrench` slash command (`costs`,
 *    `status <resource>`, `link`, `unlink`, `help`).
 *  - `POST /slack/interactions` — `block_actions` payloads: the Approve/Deny
 *    buttons on approval messages and the status disambiguation picker.
 *  - `GET /slack/link` — the browser half of account linking; session-authed
 *    (bounces through sign-in), consumes a signed token minted for exactly one
 *    (org, workspace, Slack user).
 *
 * Security model, in order:
 *
 *  1. Every POST is verified against `SLACK_SIGNING_SECRET`
 *     (`verifySlackRequestSignature`) before the body is even parsed. Without
 *     the secret the endpoints refuse everything.
 *  2. Nothing is honoured until the Slack user id resolves through
 *     `slack_user_links` to a *current member* of the org — unknown users get
 *     an ephemeral "link your account" reply carrying a signed, short-lived
 *     link URL.
 *  3. Every action then re-checks the same permission the equivalent web
 *     surface requires: `costs:read`, `resources:read`, `workflows:approve`,
 *     `chat:write` — resolved through the member's role exactly as the org
 *     middleware does.
 *
 * Buttons never create or bypass approvals: they only decide rows that
 * already exist, through the same conditional transitions the web UI uses
 * (`decideWorkflowApproval`, the chat pending-action lifecycle), so two
 * deciders racing still produce exactly one decision.
 */
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { and, desc, eq, ilike, inArray, isNull, or } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import {
  escapeMrkdwn,
  isSlackInboundConfigured,
  postToSlackResponseUrl,
  signSlackLinkToken,
  verifySlackLinkToken,
  verifySlackRequestSignature,
} from "@infrawrench/server-core/slack";
import {
  SLACK_APPROVE_ACTION_ID,
  SLACK_DENY_ACTION_ID,
  SLACK_STATUS_PICK_ACTION_ID,
  parseSlackApprovalButtonValue,
} from "@infrawrench/server-core/slack-approvals";
import { resolveEffectivePermissions } from "@infrawrench/server-core/permissions";
import { hasPermission } from "@infrawrench/server-core/permissions/catalog";
import { decideWorkflowApproval } from "@infrawrench/server-core/workflows/approvals";
import { formatMoney } from "@infrawrench/client-core";

import { db } from "../../db/client";
import {
  accounts,
  chatConversations,
  chatPendingActions,
  organizationMembers,
  organizations,
  resourceChanges,
  resources,
  slackInstallations,
  slackUserLinks,
  users,
} from "../../db/schema";
import { CostQueryError, runCostQuery } from "../../services/cost-query";
import { getPlugin } from "../../plugins/loader";
import { executePendingAction, rejectPendingAction, runAgentTurn } from "../../chat/agent";
import { noteChatToolApprovalDecided } from "../../chat/slack-approvals";
import type { ToolAuthContext } from "../../tools/types";
import { sessionMiddleware } from "../auth-middleware";
import { safeReturnPath } from "../oauth-state";

function appUrl(): string {
  return (process.env["APP_URL"] ?? "http://localhost:3000").replace(/\/$/, "");
}

/* -------------------------------------------------------------------------- */
/* Identity resolution                                                        */
/* -------------------------------------------------------------------------- */

interface InstallOrg {
  organizationId: string;
  orgName: string;
}

/** Orgs with a live install of this workspace. */
async function liveInstallOrgs(teamId: string): Promise<InstallOrg[]> {
  return db
    .select({
      organizationId: slackInstallations.organizationId,
      orgName: organizations.displayName,
    })
    .from(slackInstallations)
    .innerJoin(organizations, eq(organizations.id, slackInstallations.organizationId))
    .where(and(eq(slackInstallations.teamId, teamId), isNull(slackInstallations.deletedAt)));
}

interface LinkedMember {
  organizationId: string;
  orgName: string;
  userId: string;
  email: string;
  displayName: string | null;
}

/**
 * Resolve a Slack user to the org members they've linked to, across every org
 * this workspace is installed into. The inner join on `organization_members`
 * is the trust boundary: a link whose user left the org resolves to nothing.
 */
async function linkedMembers(teamId: string, slackUserId: string): Promise<LinkedMember[]> {
  const installs = await liveInstallOrgs(teamId);
  if (installs.length === 0) return [];
  const orgName = new Map(installs.map((o) => [o.organizationId, o.orgName]));
  const rows = await db
    .select({
      organizationId: slackUserLinks.organizationId,
      userId: slackUserLinks.userId,
      email: users.email,
      displayName: users.displayName,
    })
    .from(slackUserLinks)
    .innerJoin(
      organizationMembers,
      and(
        eq(organizationMembers.userId, slackUserLinks.userId),
        eq(organizationMembers.organizationId, slackUserLinks.organizationId),
      ),
    )
    .innerJoin(users, eq(users.id, slackUserLinks.userId))
    .where(
      and(
        eq(slackUserLinks.teamId, teamId),
        eq(slackUserLinks.slackUserId, slackUserId),
        inArray(
          slackUserLinks.organizationId,
          installs.map((o) => o.organizationId),
        ),
      ),
    );
  return rows.map((r) => ({ ...r, orgName: orgName.get(r.organizationId) ?? r.organizationId }));
}

async function memberPermissions(
  organizationId: string,
  userId: string,
): Promise<readonly string[]> {
  const access = await resolveEffectivePermissions(organizationId, { kind: "user", userId });
  return access.permissions;
}

function memberName(m: LinkedMember): string {
  return m.displayName ?? m.email;
}

/* -------------------------------------------------------------------------- */
/* Message helpers                                                            */
/* -------------------------------------------------------------------------- */

type SlackReply = Record<string, unknown>;

function ephemeral(text: string, blocks?: unknown[]): SlackReply {
  return { response_type: "ephemeral", text, ...(blocks ? { blocks } : {}) };
}

function section(mrkdwn: string): unknown {
  return { type: "section", text: { type: "mrkdwn", text: mrkdwn } };
}

/** "link your account" reply, with a signed link URL per installed org. */
function linkPrompt(installs: InstallOrg[], teamId: string, slackUserId: string): SlackReply {
  const lines = installs.map((o) => {
    const token = signSlackLinkToken({
      organizationId: o.organizationId,
      teamId,
      slackUserId,
    });
    const url = `${appUrl()}/api/slack/link?token=${encodeURIComponent(token)}`;
    return `• <${url}|Link your account to ${escapeMrkdwn(o.orgName)}>`;
  });
  return ephemeral("Your Slack account isn't linked to Infrawrench yet.", [
    section(
      "*Your Slack account isn't linked to Infrawrench yet.*\n" +
        "To run commands or decide approvals from Slack, link it to your Infrawrench account " +
        "(you'll be asked to sign in):\n" +
        lines.join("\n") +
        "\n_Link URLs expire after 15 minutes; run `/infrawrench link` for a fresh one._",
    ),
  ]);
}

const USAGE =
  "*`/infrawrench` commands*\n" +
  "• `/infrawrench costs` — this month's cloud spend so far\n" +
  "• `/infrawrench status <resource>` — a resource's current status\n" +
  "• `/infrawrench link` — link your Slack account to Infrawrench\n" +
  "• `/infrawrench unlink` — remove that link";

function relativeTime(date: Date | null, now = Date.now()): string {
  if (!date) return "never";
  const seconds = Math.max(0, Math.floor((now - date.getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/* -------------------------------------------------------------------------- */
/* /infrawrench costs                                                         */
/* -------------------------------------------------------------------------- */

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/**
 * One org's month-to-date summary as mrkdwn — the same numbers the costs
 * dashboard's headline and the CLI's `costs` command derive from `runCostQuery`
 * (total per currency, delta vs the previous period, top services).
 */
async function costSummaryMrkdwn(member: LinkedMember, showOrgName: boolean): Promise<string> {
  const nowIso = new Date().toISOString();
  const to = nowIso.slice(0, 10);
  const from = `${to.slice(0, 8)}01`;
  const monthLabel = MONTHS[Number(to.slice(5, 7)) - 1] ?? to.slice(0, 7);
  const heading = showOrgName
    ? `*${escapeMrkdwn(member.orgName)} — ${monthLabel}, month to date*`
    : `*Cloud costs — ${monthLabel}, month to date*`;

  try {
    const res = await runCostQuery(member.organizationId, {
      from,
      to,
      binning: "daily",
      groupBy: "service",
      filters: [],
      topN: 5,
      comparePreviousPeriod: true,
      forecast: false,
    });

    const currencies = Object.keys(res.totals);
    if (currencies.length === 0) {
      return `${heading}\nNo spend recorded yet this month.`;
    }

    const totalLines = currencies.map((currency) => {
      const total = res.totals[currency] ?? 0;
      const prev = res.previousTotals?.[currency];
      let delta = "";
      if (prev !== undefined && prev > 0) {
        const pct = Math.round(((total - prev) / prev) * 100);
        delta =
          pct === 0
            ? " (level with the previous period)"
            : ` (${pct > 0 ? "▲" : "▼"} ${Math.abs(pct)}% vs the previous period)`;
      }
      return `Total: *${formatMoney(total, currency)}*${delta}`;
    });

    const ranked = [...res.series]
      .map((s) => ({
        label: s.label,
        currency: s.currency,
        total: s.points.reduce((sum, p) => sum + p.amount, 0),
      }))
      .filter((s) => s.total > 0)
      .sort((a, b) => b.total - a.total)
      .slice(0, 5);
    const topLines =
      ranked.length > 0
        ? ["Top services:"].concat(
            ranked.map((s) => `• ${escapeMrkdwn(s.label)} — ${formatMoney(s.total, s.currency)}`),
          )
        : [];

    const dashboard = `<${appUrl()}/org/${member.organizationId}/costs|Open the costs dashboard>`;
    return [heading, ...totalLines, ...topLines, dashboard].join("\n");
  } catch (err) {
    const message =
      err instanceof CostQueryError
        ? err.message
        : "cost data is unavailable right now — try the dashboard.";
    return `${heading}\nCouldn't compute costs: ${escapeMrkdwn(message)}`;
  }
}

async function handleCostsCommand(members: LinkedMember[]): Promise<SlackReply> {
  const allowed: LinkedMember[] = [];
  for (const m of members) {
    if (hasPermission(await memberPermissions(m.organizationId, m.userId), "costs:read")) {
      allowed.push(m);
    }
  }
  if (allowed.length === 0) {
    return ephemeral("You need the costs:read permission to see cost summaries.");
  }
  const sections = await Promise.all(allowed.map((m) => costSummaryMrkdwn(m, allowed.length > 1)));
  return ephemeral(
    "Cloud costs, month to date",
    sections.map((s) => section(s)),
  );
}

/* -------------------------------------------------------------------------- */
/* /infrawrench status <resource>                                             */
/* -------------------------------------------------------------------------- */

interface ResourceHit {
  organizationId: string;
  orgName: string;
  id: string;
  displayName: string;
  score: number;
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function matchScore(displayName: string, query: string, tokens: string[]): number {
  const name = displayName.toLowerCase();
  if (name === query) return 100;
  if (name.startsWith(query)) return 80;
  if (name.includes(query)) return 60;
  if (tokens.length > 0 && tokens.every((t) => name.includes(t))) return 40;
  return 20;
}

async function findResources(member: LinkedMember, rawQuery: string): Promise<ResourceHit[]> {
  const query = rawQuery.toLowerCase().trim();
  const tokens = query.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  const rows = await db
    .select({ id: resources.id, displayName: resources.displayName })
    .from(resources)
    .where(
      and(
        eq(resources.organizationId, member.organizationId),
        isNull(resources.deletedAt),
        or(...tokens.map((t) => ilike(resources.displayName, `%${escapeLike(t)}%`))),
      ),
    )
    .limit(200);
  return rows.map((r) => ({
    organizationId: member.organizationId,
    orgName: member.orgName,
    id: r.id,
    displayName: r.displayName,
    score: matchScore(r.displayName, query, tokens),
  }));
}

/** The status card for one resource, or null when it no longer exists. */
async function resourceStatusMessage(
  organizationId: string,
  resourceId: string,
): Promise<{ text: string; blocks: unknown[] } | null> {
  const [r] = await db
    .select()
    .from(resources)
    .where(and(eq(resources.id, resourceId), eq(resources.organizationId, organizationId)))
    .limit(1);
  if (!r || r.deletedAt) return null;

  const [account] = await db
    .select({ displayName: accounts.displayName })
    .from(accounts)
    .where(eq(accounts.id, r.accountId))
    .limit(1);

  let typeName = r.resourceTypeId;
  let pluginName = r.pluginId;
  try {
    const loaded = await getPlugin(r.pluginId);
    if (loaded) {
      pluginName = loaded.plugin.manifest.displayName;
      typeName =
        loaded.plugin.resourceTypes.find((rt) => rt.id === r.resourceTypeId)?.displayName ??
        r.resourceTypeId;
    }
  } catch {
    // Plugin metadata is cosmetic here; raw ids are still an answer.
  }

  const [lastChange] = await db
    .select({
      changeKind: resourceChanges.changeKind,
      diff: resourceChanges.diff,
      createdAt: resourceChanges.createdAt,
    })
    .from(resourceChanges)
    .where(eq(resourceChanges.resourceId, r.id))
    .orderBy(desc(resourceChanges.createdAt))
    .limit(1);

  const lines = [
    `*${escapeMrkdwn(r.displayName)}*`,
    `${escapeMrkdwn(typeName)} · ${escapeMrkdwn(pluginName)}` +
      (account ? ` · account ${escapeMrkdwn(account.displayName)}` : ""),
    `Synced: ${relativeTime(r.lastSyncedAt)}`,
  ];
  if (lastChange) {
    const fields =
      lastChange.changeKind === "updated" && lastChange.diff.length > 0
        ? ` (${lastChange.diff.length} field${lastChange.diff.length === 1 ? "" : "s"})`
        : "";
    lines.push(
      `Last change: ${lastChange.changeKind}${fields}, ${relativeTime(lastChange.createdAt)}`,
    );
  }
  const url = `${appUrl()}/org/${organizationId}/resources/${r.pluginId}/${r.resourceTypeId}/${r.id}`;
  lines.push(`<${url}|View in Infrawrench>`);
  return {
    text: `${r.displayName} — synced ${relativeTime(r.lastSyncedAt)}`,
    blocks: [section(lines.join("\n"))],
  };
}

async function handleStatusCommand(members: LinkedMember[], query: string): Promise<SlackReply> {
  if (!query) {
    return ephemeral("Usage: `/infrawrench status <resource name>`");
  }
  const allowed: LinkedMember[] = [];
  for (const m of members) {
    if (hasPermission(await memberPermissions(m.organizationId, m.userId), "resources:read")) {
      allowed.push(m);
    }
  }
  if (allowed.length === 0) {
    return ephemeral("You need the resources:read permission to look up resources.");
  }

  const hits = (await Promise.all(allowed.map((m) => findResources(m, query))))
    .flat()
    .sort((a, b) => b.score - a.score || a.displayName.length - b.displayName.length);

  if (hits.length === 0) {
    return ephemeral(`No resource matching “${query}” found.`);
  }

  const best = hits[0]!;
  const unambiguous = hits.length === 1 || (best.score >= 60 && best.score > (hits[1]?.score ?? 0));
  if (unambiguous) {
    const message = await resourceStatusMessage(best.organizationId, best.id);
    if (!message) return ephemeral(`No resource matching “${query}” found.`);
    return { response_type: "ephemeral", ...message };
  }

  const multiOrg = new Set(hits.map((h) => h.organizationId)).size > 1;
  const choices = hits.slice(0, 5);
  return ephemeral(`Multiple resources match “${query}” — pick one.`, [
    section(
      `*Multiple resources match “${escapeMrkdwn(query)}”* — pick one:\n` +
        choices
          .map(
            (h) =>
              `• ${escapeMrkdwn(h.displayName)}${multiOrg ? ` · ${escapeMrkdwn(h.orgName)}` : ""}`,
          )
          .join("\n"),
    ),
    {
      type: "actions",
      elements: choices.map((h) => ({
        type: "button",
        text: { type: "plain_text", text: h.displayName.slice(0, 75) },
        action_id: SLACK_STATUS_PICK_ACTION_ID,
        value: JSON.stringify({ o: h.organizationId, r: h.id }),
      })),
    },
  ]);
}

/* -------------------------------------------------------------------------- */
/* Slash-command dispatch                                                     */
/* -------------------------------------------------------------------------- */

export async function handleSlashCommand(args: {
  teamId: string;
  slackUserId: string;
  text: string;
}): Promise<SlackReply> {
  const installs = await liveInstallOrgs(args.teamId);
  if (installs.length === 0) {
    return ephemeral(
      "This Slack workspace isn't connected to an Infrawrench organization. " +
        "Connect it from Settings → Notifications in Infrawrench.",
    );
  }

  const [subRaw, ...restParts] = args.text.trim().split(/\s+/);
  const sub = (subRaw ?? "").toLowerCase();
  const rest = restParts.join(" ").trim();

  if (sub === "link") {
    return linkPrompt(installs, args.teamId, args.slackUserId);
  }
  if (sub === "unlink") {
    const removed = await db
      .delete(slackUserLinks)
      .where(
        and(
          eq(slackUserLinks.teamId, args.teamId),
          eq(slackUserLinks.slackUserId, args.slackUserId),
        ),
      )
      .returning({ id: slackUserLinks.id });
    return ephemeral(
      removed.length > 0
        ? "Your Slack account has been unlinked from Infrawrench."
        : "Your Slack account wasn't linked to Infrawrench.",
    );
  }
  if (sub === "" || sub === "help") {
    return ephemeral("Infrawrench commands", [section(USAGE)]);
  }

  if (sub !== "costs" && sub !== "status") {
    return ephemeral(`Unknown command \`${sub}\`.`, [section(USAGE)]);
  }

  // Everything below acts on org data: the Slack user must resolve to a
  // current org member before anything is honoured.
  const members = await linkedMembers(args.teamId, args.slackUserId);
  if (members.length === 0) {
    return linkPrompt(installs, args.teamId, args.slackUserId);
  }

  if (sub === "costs") return handleCostsCommand(members);
  return handleStatusCommand(members, rest);
}

/* -------------------------------------------------------------------------- */
/* Interactions (buttons)                                                     */
/* -------------------------------------------------------------------------- */

interface SlackInteractionPayload {
  type?: string;
  team?: { id?: string };
  user?: { id?: string };
  response_url?: string;
  actions?: Array<{ action_id?: string; value?: string }>;
}

async function linkedMemberForOrg(
  organizationId: string,
  teamId: string,
  slackUserId: string,
): Promise<LinkedMember | null> {
  const members = await linkedMembers(teamId, slackUserId);
  return members.find((m) => m.organizationId === organizationId) ?? null;
}

/** Drain a resumed agent turn so the decision's outcome lands in the conversation. */
async function resumeConversation(conversationId: string, auth: ToolAuthContext): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _event of runAgentTurn({ conversationId, auth })) {
      // Events are for streaming clients; from Slack there is nobody watching.
    }
  } catch (err) {
    console.error(`[slack] resuming conversation ${conversationId} failed:`, err);
  }
}

export async function handleBlockAction(payload: SlackInteractionPayload): Promise<void> {
  const teamId = payload.team?.id;
  const slackUserId = payload.user?.id;
  const responseUrl = payload.response_url;
  const action = payload.actions?.[0];
  if (!teamId || !slackUserId || !action?.action_id) return;

  const respond = async (reply: SlackReply): Promise<void> => {
    if (!responseUrl) return;
    try {
      await postToSlackResponseUrl(responseUrl, reply);
    } catch (err) {
      console.error("[slack] response_url post failed:", err);
    }
  };

  /* ---- status disambiguation pick ---- */
  if (action.action_id === SLACK_STATUS_PICK_ACTION_ID) {
    let value: { o?: string; r?: string };
    try {
      value = JSON.parse(action.value ?? "") as { o?: string; r?: string };
    } catch {
      return;
    }
    if (!value.o || !value.r) return;
    const member = await linkedMemberForOrg(value.o, teamId, slackUserId);
    if (!member) {
      const installs = await liveInstallOrgs(teamId);
      await respond(linkPrompt(installs, teamId, slackUserId));
      return;
    }
    if (!hasPermission(await memberPermissions(value.o, member.userId), "resources:read")) {
      await respond(ephemeral("You need the resources:read permission to look up resources."));
      return;
    }
    const message = await resourceStatusMessage(value.o, value.r);
    if (!message) {
      await respond(ephemeral("That resource no longer exists."));
      return;
    }
    await respond({ response_type: "ephemeral", replace_original: true, ...message });
    return;
  }

  /* ---- approval buttons ---- */
  if (action.action_id !== SLACK_APPROVE_ACTION_ID && action.action_id !== SLACK_DENY_ACTION_ID) {
    return;
  }
  const value = parseSlackApprovalButtonValue(action.value);
  if (!value) return;
  const decision = action.action_id === SLACK_APPROVE_ACTION_ID ? "approved" : "denied";

  const member = await linkedMemberForOrg(value.organizationId, teamId, slackUserId);
  if (!member) {
    const installs = await liveInstallOrgs(teamId);
    await respond(linkPrompt(installs, teamId, slackUserId));
    return;
  }
  const permissions = await memberPermissions(value.organizationId, member.userId);

  if (value.kind === "workflow") {
    // Same gate as POST /workflow-approvals/:id/approve — deliberately
    // `workflows:approve`, not `workflows:write` (sign-off is its own trust
    // level; see the catalog).
    if (!hasPermission(permissions, "workflows:approve")) {
      await respond(
        ephemeral(
          `You need the workflows:approve permission in ${member.orgName} to decide approvals.`,
        ),
      );
      return;
    }
    const result = await decideWorkflowApproval(
      value.organizationId,
      value.approvalId,
      decision,
      { userId: member.userId, name: memberName(member) },
      { decidedVia: "Slack" },
    );
    if (result.outcome === "not_found") {
      await respond(ephemeral("This approval request no longer exists."));
    } else if (result.outcome === "conflict") {
      await respond(ephemeral("This request has already been decided or has expired."));
    }
    // "decided" needs no ephemeral reply: decideWorkflowApproval retires the
    // message in place and threads the outcome, which is the visible answer.
    return;
  }

  /* ---- chat pending action ---- */
  const [row] = await db
    .select({ pending: chatPendingActions, conversation: chatConversations })
    .from(chatPendingActions)
    .innerJoin(chatConversations, eq(chatConversations.id, chatPendingActions.conversationId))
    .where(eq(chatPendingActions.id, value.approvalId))
    .limit(1);
  if (!row || row.conversation.organizationId !== value.organizationId) {
    await respond(ephemeral("This approval request no longer exists."));
    return;
  }
  // Mirror the web route's ownership rule exactly: only the conversation's
  // owner may decide the agent's tool calls, holding the same `chat:write`
  // the web decision endpoint authenticates with.
  if (row.conversation.userId !== member.userId) {
    await respond(ephemeral("Only the conversation owner can decide this agent action."));
    return;
  }
  if (!hasPermission(permissions, "chat:write")) {
    await respond(
      ephemeral(`You need the chat:write permission in ${member.orgName} to decide this action.`),
    );
    return;
  }
  if (row.pending.status !== "pending") {
    await respond(ephemeral(`This action has already been resolved (${row.pending.status}).`));
    return;
  }

  const toolAuth: ToolAuthContext = {
    userId: member.userId,
    organizationId: value.organizationId,
    email: member.email,
    source: "chat",
  };
  const noteDecided = (d: "approved" | "denied") =>
    noteChatToolApprovalDecided({
      organizationId: value.organizationId,
      pendingActionId: row.pending.id,
      toolName: row.pending.toolName,
      toolInput: row.pending.toolInput,
      decision: d,
      decidedByName: memberName(member),
      via: "Slack",
    });

  if (decision === "denied") {
    const { allResolved } = await rejectPendingAction(
      row.pending.id,
      `Denied from Slack by ${memberName(member)}.`,
    );
    await noteDecided("denied");
    // Resume so the agent sees the rejection and answers in the conversation,
    // exactly as the web client does after a reject.
    if (allResolved) void resumeConversation(row.pending.conversationId, toolAuth);
    return;
  }

  // Approve: claim the row (same approved → executed transition as the web
  // route), then run the tool and resume off this request — execution can
  // outlive Slack's 3-second acknowledgement window.
  await db
    .update(chatPendingActions)
    .set({ status: "approved" })
    .where(eq(chatPendingActions.id, row.pending.id));
  void (async () => {
    try {
      const { allResolved } = await executePendingAction(row.pending.id, toolAuth);
      await noteDecided("approved");
      if (allResolved) await resumeConversation(row.pending.conversationId, toolAuth);
    } catch (err) {
      await db
        .update(chatPendingActions)
        .set({
          status: "errored",
          result: err instanceof Error ? err.message : "Execution failed",
          isError: true,
          resolvedAt: new Date(),
        })
        .where(eq(chatPendingActions.id, row.pending.id));
      console.error(`[slack] executing pending action ${row.pending.id} failed:`, err);
    }
  })();
}

/* -------------------------------------------------------------------------- */
/* Routes                                                                     */
/* -------------------------------------------------------------------------- */

const app = new Hono();

/** Shared preamble: refuse unconfigured, verify the signature on raw bytes. */
async function verifiedRawBody(c: {
  req: { text(): Promise<string>; header(name: string): string | undefined };
}): Promise<{ ok: true; rawBody: string } | { ok: false; status: 401 | 503; error: string }> {
  if (!isSlackInboundConfigured()) {
    return {
      ok: false,
      status: 503,
      error: "Slack slash commands and interactivity are not configured on this server.",
    };
  }
  const rawBody = await c.req.text();
  const verified = verifySlackRequestSignature({
    rawBody,
    timestamp: c.req.header("x-slack-request-timestamp"),
    signature: c.req.header("x-slack-signature"),
  });
  if (!verified) return { ok: false, status: 401, error: "Invalid Slack signature" };
  return { ok: true, rawBody };
}

app.post("/slack/commands", async (c) => {
  const pre = await verifiedRawBody(c);
  if (!pre.ok) return c.json({ error: pre.error }, pre.status);
  const params = new URLSearchParams(pre.rawBody);
  const teamId = params.get("team_id") ?? "";
  const slackUserId = params.get("user_id") ?? "";
  if (!teamId || !slackUserId) return c.json({ error: "Malformed command payload" }, 400);
  try {
    const reply = await handleSlashCommand({
      teamId,
      slackUserId,
      text: params.get("text") ?? "",
    });
    return c.json(reply);
  } catch (err) {
    console.error("[slack] slash command failed:", err);
    return c.json(ephemeral("Something went wrong running that command. Try again shortly."));
  }
});

app.post("/slack/interactions", async (c) => {
  const pre = await verifiedRawBody(c);
  if (!pre.ok) return c.json({ error: pre.error }, pre.status);
  const params = new URLSearchParams(pre.rawBody);
  let payload: SlackInteractionPayload | null = null;
  try {
    payload = JSON.parse(params.get("payload") ?? "null") as SlackInteractionPayload | null;
  } catch {
    return c.json({ error: "Malformed interaction payload" }, 400);
  }
  if (!payload || payload.type !== "block_actions") return c.body(null, 200);
  try {
    await handleBlockAction(payload);
  } catch (err) {
    console.error("[slack] interaction failed:", err);
  }
  // Slack only wants a timely 200 here; all feedback rides response_url,
  // chat.update, and threads.
  return c.body(null, 200);
});

/**
 * Browser half of account linking. The Slack side handed the user a signed
 * token asserting "this Slack user in this workspace"; the session here
 * asserts the Infrawrench account. Membership of the token's org is required
 * before the pair is stored.
 */
app.get("/slack/link", async (c) => {
  const token = c.req.query("token") ?? "";
  // Signed out: bounce through sign-in and come back here.
  if (!getCookie(c, "wos-session") && !c.req.header("authorization")) {
    const returnTo = safeReturnPath(`/api/slack/link?token=${encodeURIComponent(token)}`);
    return c.redirect(`/api/auth/sign-in?return_to=${encodeURIComponent(returnTo ?? "/")}`);
  }
  const denied = await sessionMiddleware(c, async () => {});
  if (denied instanceof Response) return denied;
  const session = c.get("session");
  if (!session?.userId) return c.json({ error: "Unauthorized" }, 401);

  const verified = verifySlackLinkToken(token);
  if (!verified) {
    // Expired or forged; the root layout surfaces the `slack` param as a toast.
    return c.redirect(`${appUrl()}/?slack=error`);
  }
  const [member] = await db
    .select({ id: organizationMembers.id })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.userId, session.userId),
        eq(organizationMembers.organizationId, verified.organizationId),
      ),
    )
    .limit(1);
  if (!member) {
    return c.redirect(`${appUrl()}/?slack=error`);
  }

  await db
    .insert(slackUserLinks)
    .values({
      id: randomUUID(),
      organizationId: verified.organizationId,
      teamId: verified.teamId,
      slackUserId: verified.slackUserId,
      userId: session.userId,
    })
    .onConflictDoUpdate({
      target: [slackUserLinks.organizationId, slackUserLinks.teamId, slackUserLinks.slackUserId],
      set: { userId: session.userId, updatedAt: new Date() },
    });

  return c.redirect(`${appUrl()}/org/${verified.organizationId}/settings/paging?slack=linked`);
});

export { app as slackInboundRoutes };
