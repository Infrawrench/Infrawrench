/**
 * Inbound Slack: slash commands, interactive buttons, and account linking.
 *
 * Three public endpoints (mounted at /api, no session):
 *
 *  - `POST /slack/commands` — the `/infrawrench` slash command (`costs`,
 *    `status <resource>`, `link`, `unlink`, `help`).
 *  - `POST /slack/interactions` — `block_actions` payloads: the Approve/Deny
 *    buttons on approval messages and the status disambiguation picker.
 *  - `GET /slack/link` + `POST /slack/link` — the browser half of account
 *    linking; session-authed (bounces through sign-in). The GET renders a
 *    confirmation page for a signed token minted for exactly one (org,
 *    workspace, Slack user); the CSRF-guarded POST stores the pair.
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
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { and, desc, eq, ilike, inArray, isNull, or } from "drizzle-orm";
import { randomUUID, timingSafeEqual } from "node:crypto";

import {
  ALERT_ACK_ACTION_ID,
  parseAlertAckButtonValue,
} from "@infrawrench/server-core/alerts/route";
import { acknowledgeAlert } from "@infrawrench/server-core/alerts/ack";

import {
  escapeMrkdwn,
  isSlackInboundConfigured,
  postToSlackResponseUrl,
  signSlackLinkToken,
  verifySlackLinkToken,
  verifySlackRequestSignature,
  type SlackLinkRequest,
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
import { decideAccessRequest } from "@infrawrench/server-core/access/break-glass";
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
  const perms = await Promise.all(
    members.map((m) => memberPermissions(m.organizationId, m.userId)),
  );
  const allowed = members.filter((_, i) => hasPermission(perms[i]!, "costs:read"));
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
  const perms = await Promise.all(
    members.map((m) => memberPermissions(m.organizationId, m.userId)),
  );
  const allowed = members.filter((_, i) => hasPermission(perms[i]!, "resources:read"));
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

  /* ---- alert acknowledgement ---- */
  if (action.action_id === ALERT_ACK_ACTION_ID) {
    const value = parseAlertAckButtonValue(action.value);
    if (!value) return;

    // Same trust boundary as the approval buttons: a click carries only a
    // Slack user id, and nothing is honoured until that resolves through
    // `slack_user_links` to a member of the org named in the button.
    const member = await linkedMemberForOrg(value.organizationId, teamId, slackUserId);
    if (!member) {
      const installs = await liveInstallOrgs(teamId);
      await respond(linkPrompt(installs, teamId, slackUserId));
      return;
    }

    const result = await acknowledgeAlert({
      deliveryId: value.deliveryId,
      organizationId: value.organizationId,
      userId: member.userId,
      via: "slack",
    });

    if (result.acknowledged) {
      // Threaded rather than a message rewrite: the alert text is still the
      // useful thing in the channel, and a reply leaves an audit trail of who
      // took it that a `chat.update` would overwrite.
      await respond(
        ephemeral(`Acknowledged — escalation for "${result.title ?? "this alert"}" is cancelled.`),
      );
      return;
    }
    if (result.reason === "already_escalated") {
      await respond(
        ephemeral("That alert already escalated — the escalation channel has been notified."),
      );
      return;
    }
    if (result.reason === "not_found") {
      await respond(ephemeral("That alert is no longer tracked."));
      return;
    }
    await respond(ephemeral("Someone already acknowledged that alert."));
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

  if (value.kind === "access") {
    // Same gate as POST /access-requests/:id/approve.
    if (!hasPermission(permissions, "access:approve")) {
      await respond(
        ephemeral(
          `You need the access:approve permission in ${member.orgName} to decide break-glass requests.`,
        ),
      );
      return;
    }
    const result = await decideAccessRequest(
      value.organizationId,
      value.approvalId,
      decision,
      // The Slack decider's live permissions are the ceiling on what they can
      // grant, exactly as on the HTTP route — the button is a second front
      // door to the same decision, not a way around its rules.
      { userId: member.userId, name: memberName(member), permissions },
      { decidedVia: "Slack" },
    );
    if (result.outcome === "not_found") {
      await respond(ephemeral("This access request no longer exists."));
    } else if (result.outcome === "self_approval") {
      await respond(
        ephemeral("You cannot decide your own access request — that is the point of the approval."),
      );
    } else if (result.outcome === "exceeds_approver") {
      await respond(
        ephemeral(
          `You cannot grant permissions you do not hold yourself: ${result.missing.join(", ")}.`,
        ),
      );
    } else if (result.outcome === "conflict") {
      await respond(ephemeral("This request has already been decided or has expired."));
    }
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

  // Claim the row first, conditioned on it still being `pending`. The returned
  // row count is what makes two racing deciders — Slack buttons, the web UI, or
  // one of each — produce exactly one decision: the loser's UPDATE matches
  // nothing, gets acknowledged, and goes no further. Same conditional
  // transition the web decision route uses.
  const claimed = await db
    .update(chatPendingActions)
    .set({ status: decision === "denied" ? "rejected" : "approved" })
    .where(and(eq(chatPendingActions.id, row.pending.id), eq(chatPendingActions.status, "pending")))
    .returning({ id: chatPendingActions.id });
  if (claimed.length === 0) {
    await respond(ephemeral("This action has already been resolved."));
    return;
  }

  if (decision === "denied") {
    // The claim above already moved the row to `rejected`, so
    // executePendingAction (which requires `approved`) can never also run;
    // rejectPendingAction records the reason and reports whether the turn can
    // resume.
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

  // Approved and claimed (same approved → executed transition as the web
  // route): run the tool and resume off this request — execution can outlive
  // Slack's 3-second acknowledgement window.
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
      // The approval still happened — only the execution failed — so the Slack
      // copies' decision controls must retire either way.
      await noteDecided("approved");
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
  const responseUrl = params.get("response_url") ?? "";
  const text = params.get("text") ?? "";
  if (!teamId || !slackUserId || !responseUrl) {
    return c.json({ error: "Malformed command payload" }, 400);
  }
  // Acknowledge inside Slack's 3-second window *before* doing any real work —
  // a cost query or resource search can blow that budget — and deliver the
  // actual reply through response_url, which stays valid for 30 minutes.
  void (async () => {
    let reply: SlackReply;
    try {
      reply = await handleSlashCommand({ teamId, slackUserId, text });
    } catch (err) {
      console.error("[slack] slash command failed:", err);
      reply = ephemeral("Something went wrong running that command. Try again shortly.");
    }
    try {
      await postToSlackResponseUrl(responseUrl, reply);
    } catch (err) {
      console.error("[slack] response_url post failed:", err);
    }
  })();
  return c.body(null, 200);
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
  // Same shape as /slack/commands: acknowledge now, work in the background.
  // All feedback rides response_url, chat.update, and threads.
  void handleBlockAction(payload).catch((err: unknown) => {
    console.error("[slack] interaction failed:", err);
  });
  return c.body(null, 200);
});

/** Double-submit CSRF cookie for the link confirmation form. */
const SLACK_LINK_CSRF_COOKIE = "slack_link_csrf";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function timingSafeEqualStrings(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Shared GET/POST preamble for /slack/link: authenticated session, valid link
 * token, and membership of the token's org. Failures keep the original
 * behavior — a redirect to the root with the `slack=error` toast param (or the
 * session middleware's own response).
 */
async function resolveLinkRequest(
  c: Context,
  token: string,
): Promise<{ userId: string; verified: SlackLinkRequest } | Response> {
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
  return { userId: session.userId, verified };
}

/**
 * Browser half of account linking. The Slack side handed the user a signed
 * token asserting "this Slack user in this workspace"; the session here
 * asserts the Infrawrench account. Membership of the token's org is required
 * before the pair is stored.
 *
 * The GET only *renders* a confirmation naming the Slack user and the org —
 * a state-changing write must not ride a URL that link unfurlers, prefetchers
 * and mail scanners follow. The write happens in the POST below, guarded by a
 * double-submit CSRF pair: a cookie bound to this browser session plus the
 * same value echoed by the form. A cross-site page can post the token, but it
 * can neither read nor set that cookie.
 */
app.get("/slack/link", async (c) => {
  const token = c.req.query("token") ?? "";
  // Signed out: bounce through sign-in and come back here.
  if (!getCookie(c, "wos-session") && !c.req.header("authorization")) {
    const returnTo = safeReturnPath(`/api/slack/link?token=${encodeURIComponent(token)}`);
    return c.redirect(`/api/auth/sign-in?return_to=${encodeURIComponent(returnTo ?? "/")}`);
  }
  const resolved = await resolveLinkRequest(c, token);
  if (resolved instanceof Response) return resolved;
  const { verified } = resolved;

  const [[org], [install]] = await Promise.all([
    db
      .select({ displayName: organizations.displayName })
      .from(organizations)
      .where(eq(organizations.id, verified.organizationId))
      .limit(1),
    db
      .select({ teamName: slackInstallations.teamName })
      .from(slackInstallations)
      .where(
        and(
          eq(slackInstallations.organizationId, verified.organizationId),
          eq(slackInstallations.teamId, verified.teamId),
          isNull(slackInstallations.deletedAt),
        ),
      )
      .limit(1),
  ]);
  const orgName = org?.displayName ?? verified.organizationId;
  const workspace = install?.teamName ?? verified.teamId;

  const csrf = randomUUID();
  setCookie(c, SLACK_LINK_CSRF_COOKIE, csrf, {
    path: "/api/slack/link",
    httpOnly: true,
    sameSite: "Lax",
    secure: appUrl().startsWith("https://"),
    maxAge: 15 * 60,
  });

  return c.html(
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Link Slack to Infrawrench</title>
<style>
  body { font-family: system-ui, sans-serif; background: #0f1117; color: #e6e8ee; display: grid; place-items: center; min-height: 100vh; margin: 0; }
  main { max-width: 26rem; padding: 2rem; background: #171a23; border: 1px solid #2a2f3d; border-radius: 12px; }
  h1 { font-size: 1.2rem; margin-top: 0; }
  code { background: #232836; border-radius: 4px; padding: 0.1rem 0.3rem; }
  p.hint { color: #9aa1b2; font-size: 0.85rem; }
  button { background: #4f6df5; color: #fff; border: 0; border-radius: 8px; padding: 0.6rem 1.2rem; font-size: 1rem; cursor: pointer; }
</style>
</head>
<body>
<main>
  <h1>Link your Slack account</h1>
  <p>Link Slack user <code>${escapeHtml(verified.slackUserId)}</code> in workspace
  <strong>${escapeHtml(workspace)}</strong> to your Infrawrench account in
  <strong>${escapeHtml(orgName)}</strong>?</p>
  <p class="hint">Once linked, /infrawrench commands and approval buttons pressed by that
  Slack user act with your Infrawrench permissions.</p>
  <form method="post" action="/api/slack/link">
    <input type="hidden" name="token" value="${escapeHtml(token)}">
    <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
    <button type="submit">Link account</button>
  </form>
</main>
</body>
</html>`,
  );
});

/** The confirmation form's target: validates the CSRF pair, then writes the link. */
app.post("/slack/link", async (c) => {
  const form = new URLSearchParams(await c.req.text());
  const token = form.get("token") ?? "";
  const formCsrf = form.get("csrf") ?? "";
  const cookieCsrf = getCookie(c, SLACK_LINK_CSRF_COOKIE) ?? "";
  if (!formCsrf || !cookieCsrf || !timingSafeEqualStrings(formCsrf, cookieCsrf)) {
    return c.redirect(`${appUrl()}/?slack=error`);
  }
  const resolved = await resolveLinkRequest(c, token);
  if (resolved instanceof Response) return resolved;
  const { userId, verified } = resolved;

  await db
    .insert(slackUserLinks)
    .values({
      id: randomUUID(),
      organizationId: verified.organizationId,
      teamId: verified.teamId,
      slackUserId: verified.slackUserId,
      userId,
    })
    .onConflictDoUpdate({
      target: [slackUserLinks.organizationId, slackUserLinks.teamId, slackUserLinks.slackUserId],
      set: { userId, updatedAt: new Date() },
    });

  deleteCookie(c, SLACK_LINK_CSRF_COOKIE, { path: "/api/slack/link" });
  return c.redirect(`${appUrl()}/org/${verified.organizationId}/settings/paging?slack=linked`);
});

export { app as slackInboundRoutes };
