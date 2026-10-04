/**
 * Cursor Admin API, Analytics API and AI Code Tracking API transport.
 *
 * Every request in this plugin goes through {@link cursorRequest}, and every
 * endpoint it calls has a typed wrapper below carrying the doc URL it was
 * verified against (2026-10-04):
 *
 * - Admin API: https://cursor.com/docs/account/teams/admin-api
 * - Analytics API (Enterprise): https://cursor.com/docs/account/teams/analytics-api
 * - AI Code Tracking API (Enterprise): https://cursor.com/docs/account/teams/ai-code-tracking-api
 *
 * Auth is HTTP Basic with the team API key as the username and an empty
 * password (`curl -u KEY:`). There is one base URL for all three APIs.
 *
 * Rate limits are per team, per endpoint, per minute: 20 for most Admin API
 * endpoints, 60 for usage events, 250 for single spend-limit writes, 100 for
 * Analytics team endpoints. A 429 is retried with a short backoff before it
 * surfaces.
 */
import type { HttpHostServices } from "@infrawrench/plugin-base";

export const CURSOR_API_BASE = "https://api.cursor.com";

export const ADMIN_API_DOCS = "https://cursor.com/docs/account/teams/admin-api";
export const ANALYTICS_API_DOCS = "https://cursor.com/docs/account/teams/analytics-api";
export const AI_CODE_DOCS = "https://cursor.com/docs/account/teams/ai-code-tracking-api";
export const DASHBOARD_URL = "https://cursor.com/dashboard";

/** Longest window the date-ranged endpoints accept (daily usage, analytics, audit logs). */
export const MAX_RANGE_DAYS = 30;

export const DAY_MS = 24 * 60 * 60 * 1000;

export interface CursorContext {
  apiKey: string;
  caCert?: string;
  http?: HttpHostServices;
  /** Backoff before retrying a 429, in ms. Tests set 0. */
  retryDelayMs?: number;
}

/** A non-2xx response from the Cursor API, with the status kept for callers that branch on it. */
export class CursorApiError extends Error {
  readonly status: number;
  readonly path: string;

  constructor(status: number, path: string, body: string) {
    super(`Cursor API error ${status} for ${path}: ${body.slice(0, 500)}`);
    this.name = "CursorApiError";
    this.status = status;
    this.path = path;
  }
}

/** True for the statuses Cursor returns when a key or a plan cannot reach an endpoint. */
export function isAccessDenied(err: unknown): boolean {
  return err instanceof CursorApiError && (err.status === 401 || err.status === 403);
}

/** True when the endpoint is not available to this team (plan gate, preview, or unknown route). */
export function isUnavailable(err: unknown): boolean {
  return err instanceof CursorApiError && [401, 403, 404].includes(err.status);
}

function basicAuth(apiKey: string): string {
  return `Basic ${btoa(`${apiKey}:`)}`;
}

const MAX_ATTEMPTS = 4;

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One request against `api.cursor.com`. Prefers the host HTTP service (bastion
 * routing and custom CAs), falls back to `fetch` in the renderer and tests.
 */
export async function cursorRequest<T>(
  ctx: CursorContext,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const method = init.method ?? "GET";
  const headers: Record<string, string> = {
    Authorization: basicAuth(ctx.apiKey),
    Accept: "application/json",
  };
  const body = init.body === undefined ? undefined : JSON.stringify(init.body);
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const url = `${CURSOR_API_BASE}${path}`;
  const errorPath = path.split("?")[0] ?? path;

  for (let attempt = 1; ; attempt++) {
    let status: number;
    let text: string;
    if (ctx.http) {
      const result = await ctx.http.request({
        url,
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
        ...(ctx.caCert ? { caCert: ctx.caCert } : {}),
      });
      status = result.status;
      text = result.body ?? "";
    } else {
      const res = await fetch(url, { method, headers, ...(body !== undefined ? { body } : {}) });
      status = res.status;
      text = await res.text();
    }

    if (status === 429 && attempt < MAX_ATTEMPTS) {
      await sleep((ctx.retryDelayMs ?? 3000) * attempt);
      continue;
    }
    if (status < 200 || status >= 300) throw new CursorApiError(status, errorPath, text);
    if (status === 204 || !text) return undefined as T;
    return JSON.parse(text) as T;
  }
}

// ---------------------------------------------------------------------------
// Wire types (field names verbatim from the docs)
// ---------------------------------------------------------------------------

export interface CursorTeamMember {
  /** Encoded id, `user_…`. */
  id?: string;
  name?: string;
  email?: string;
  /** `owner`, `member`, or `free-owner` (unpaid admin). */
  role?: string;
  isRemoved?: boolean;
}

export interface CursorMemberSpend {
  userId?: string;
  spendCents?: number;
  overallSpendCents?: number;
  fastPremiumRequests?: number;
  name?: string;
  email?: string;
  role?: string;
  hardLimitOverrideDollars?: number | null;
  monthlyLimitDollars?: number | null;
  effectivePerUserLimitDollars?: number | null;
}

export interface CursorSpendResponse {
  teamMemberSpend?: CursorMemberSpend[];
  subscriptionCycleStart?: number;
  totalMembers?: number;
  totalPages?: number;
}

export interface CursorDailyUsage {
  userId?: number | string;
  day?: string;
  date?: number;
  isActive?: boolean;
  totalLinesAdded?: number;
  totalLinesDeleted?: number;
  acceptedLinesAdded?: number;
  acceptedLinesDeleted?: number;
  totalApplies?: number;
  totalAccepts?: number;
  totalRejects?: number;
  totalTabsShown?: number;
  totalTabsAccepted?: number;
  composerRequests?: number;
  chatRequests?: number;
  agentRequests?: number;
  cmdkUsages?: number;
  subscriptionIncludedReqs?: number;
  apiKeyReqs?: number;
  usageBasedReqs?: number;
  bugbotUsages?: number;
  mostUsedModel?: string;
  applyMostUsedExtension?: string;
  tabMostUsedExtension?: string;
  clientVersion?: string;
  email?: string;
}

interface DailyUsageResponse {
  data?: CursorDailyUsage[];
  pagination?: { hasNextPage?: boolean; totalPages?: number };
}

export interface CursorUsageEvent {
  /** Epoch milliseconds, as a string. */
  timestamp?: string;
  userEmail?: string;
  conversationId?: string;
  model?: string;
  /** e.g. `Usage-based`, `Included in Business`, `Errored, Not Charged`. */
  kind?: string;
  maxMode?: boolean;
  requestsCosts?: number;
  isTokenBasedCall?: boolean;
  isChargeable?: boolean;
  isHeadless?: boolean;
  tokenUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheWriteTokens?: number;
    cacheReadTokens?: number;
    totalCents?: number;
  };
  chargedCents?: number;
  cursorTokenFee?: number;
}

interface UsageEventsResponse {
  totalUsageEventsCount?: number;
  pagination?: { numPages?: number; currentPage?: number; hasNextPage?: boolean };
  usageEvents?: CursorUsageEvent[];
}

export interface CursorAuditEvent {
  event_id?: string;
  timestamp?: string;
  ip_address?: string;
  user_email?: string;
  event_type?: string;
  application_type?: string;
  event_data?: Record<string, unknown>;
}

interface AuditLogResponse {
  events?: CursorAuditEvent[];
  pagination?: { hasNextPage?: boolean };
}

export interface CursorGroupMember {
  userId?: string;
  name?: string;
  email?: string;
  joinedAt?: string;
  leftAt?: string | null;
  spendCents?: number;
}

export interface CursorBillingGroup {
  id: string;
  name?: string;
  type?: string;
  directoryGroupId?: string | null;
  memberCount?: number;
  createdAt?: string;
  updatedAt?: string;
  spendCents?: number;
  currentMembers?: CursorGroupMember[];
  formerMembers?: CursorGroupMember[];
  members?: CursorGroupMember[];
  dailySpend?: Array<{ date?: string; spendCents?: number }>;
}

export interface CursorBillingCycle {
  cycleStart?: string;
  cycleEnd?: string;
}

interface BillingGroupsResponse {
  groups?: CursorBillingGroup[];
  unassignedGroup?: CursorBillingGroup;
  billingCycle?: CursorBillingCycle;
}

export interface CursorDirectoryGroup {
  id: string;
  name?: string;
  memberCount?: number;
  monthlySpendingLimitDollars?: number | null;
  createdAt?: string;
  updatedAt?: string;
}

interface Paginated {
  pagination?: { hasNextPage?: boolean };
}

export interface CursorRepoBlocklist {
  id: string;
  url?: string;
  patterns?: string[];
}

export interface AnalyticsResponse<T> {
  data?: T;
}

export interface CursorDauRow {
  date?: string;
  dau?: number;
  cli_dau?: number;
  cloud_agent_dau?: number;
  bugbot_dau?: number;
}

export interface CursorEditsRow {
  event_date?: string;
  total_suggested_diffs?: number;
  total_accepted_diffs?: number;
  total_rejected_diffs?: number;
  total_suggestions?: number;
  total_accepts?: number;
  total_rejects?: number;
  total_lines_suggested?: number;
  total_lines_accepted?: number;
}

export interface CursorModelsRow {
  date?: string;
  model_breakdown?: Record<string, { messages?: number; users?: number }>;
}

export interface CursorClientVersionRow {
  event_date?: string;
  client_version?: string;
  user_count?: number;
  percentage?: number;
}

export interface CursorAiCommit {
  commitHash?: string;
  userEmail?: string;
  repoName?: string;
  commitTs?: string;
  totalLinesAdded?: number;
  tabLinesAdded?: number;
  composerLinesAdded?: number;
  nonAiLinesAdded?: number;
}

interface AiCommitsResponse {
  items?: CursorAiCommit[];
  totalCount?: number;
  page?: number;
  pageSize?: number;
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

/** GET /teams/members */
export async function getTeamMembers(ctx: CursorContext): Promise<CursorTeamMember[]> {
  const body = await cursorRequest<{ teamMembers?: CursorTeamMember[] }>(ctx, "/teams/members");
  return body?.teamMembers ?? [];
}

/**
 * POST /teams/spend, every page. Returns the per-member spend for the current
 * billing cycle plus the cycle start (epoch ms).
 */
export async function getTeamSpend(
  ctx: CursorContext,
): Promise<{ members: CursorMemberSpend[]; cycleStartMs: number | undefined }> {
  const members: CursorMemberSpend[] = [];
  let cycleStartMs: number | undefined;
  for (let page = 1; page <= 50; page++) {
    const body = await cursorRequest<CursorSpendResponse>(ctx, "/teams/spend", {
      method: "POST",
      body: { page, pageSize: 100, sortBy: "amount", sortDirection: "desc" },
    });
    members.push(...(body?.teamMemberSpend ?? []));
    cycleStartMs ??= body?.subscriptionCycleStart;
    const totalPages = body?.totalPages ?? 1;
    if (page >= totalPages || (body?.teamMemberSpend ?? []).length === 0) break;
  }
  return { members, cycleStartMs };
}

/**
 * POST /teams/daily-usage-data for one window of at most 30 days, every page.
 * Only days on which a user was active come back.
 */
export async function getDailyUsage(
  ctx: CursorContext,
  startMs: number,
  endMs: number,
): Promise<CursorDailyUsage[]> {
  const out: CursorDailyUsage[] = [];
  for (let page = 1; page <= 100; page++) {
    const body = await cursorRequest<DailyUsageResponse>(ctx, "/teams/daily-usage-data", {
      method: "POST",
      body: { startDate: startMs, endDate: endMs, page, pageSize: 500 },
    });
    out.push(...(body?.data ?? []));
    if (!body?.pagination?.hasNextPage) break;
  }
  return out;
}

/** Daily usage over any range, split into the API's 30-day windows. */
export async function getDailyUsageRange(
  ctx: CursorContext,
  startMs: number,
  endMs: number,
): Promise<CursorDailyUsage[]> {
  const out: CursorDailyUsage[] = [];
  for (const [from, to] of splitRange(startMs, endMs, MAX_RANGE_DAYS)) {
    out.push(...(await getDailyUsage(ctx, from, to)));
  }
  return out;
}

/** Default cap on usage-event pages (1,000 events each) for interactive views. */
export const INTERACTIVE_EVENT_PAGES = 20;

/**
 * POST /teams/filtered-usage-events, paginated at the 1,000-event maximum.
 * `maxPages` bounds interactive views; the cost collector passes a large cap.
 * Returns whether the cap cut the listing short.
 */
export async function getUsageEvents(
  ctx: CursorContext,
  startMs: number,
  endMs: number,
  opts: { email?: string; maxPages?: number } = {},
): Promise<{ events: CursorUsageEvent[]; truncated: boolean }> {
  const events: CursorUsageEvent[] = [];
  const maxPages = opts.maxPages ?? INTERACTIVE_EVENT_PAGES;
  for (let page = 1; page <= maxPages; page++) {
    const body = await cursorRequest<UsageEventsResponse>(ctx, "/teams/filtered-usage-events", {
      method: "POST",
      body: {
        startDate: startMs,
        endDate: endMs,
        page,
        pageSize: 1000,
        ...(opts.email ? { email: opts.email } : {}),
      },
    });
    events.push(...(body?.usageEvents ?? []));
    if (!body?.pagination?.hasNextPage) return { events, truncated: false };
  }
  return { events, truncated: true };
}

/** GET /teams/audit-logs, newest first, up to `limit` events within a 30-day window. */
export async function getAuditLogs(
  ctx: CursorContext,
  startMs: number,
  endMs: number,
  limit: number,
): Promise<CursorAuditEvent[]> {
  const out: CursorAuditEvent[] = [];
  const pageSize = Math.min(500, Math.max(1, limit));
  for (let page = 1; out.length < limit && page <= 20; page++) {
    const query = new URLSearchParams({
      startTime: new Date(startMs).toISOString(),
      endTime: new Date(endMs).toISOString(),
      page: String(page),
      pageSize: String(pageSize),
    });
    const body = await cursorRequest<AuditLogResponse>(ctx, `/teams/audit-logs?${query}`);
    out.push(...(body?.events ?? []));
    if (!body?.pagination?.hasNextPage) break;
  }
  return out.slice(0, limit);
}

/** POST /teams/user-spend-limit. `null` removes the member's limit. */
export async function setUserSpendLimit(
  ctx: CursorContext,
  userEmail: string,
  spendLimitDollars: number | null,
): Promise<void> {
  const body = await cursorRequest<{ outcome?: string; message?: string }>(
    ctx,
    "/teams/user-spend-limit",
    { method: "POST", body: { userEmail, spendLimitDollars } },
  );
  if (body?.outcome === "error") {
    throw new Error(`Cursor refused the spend limit: ${body.message ?? "unknown error"}`);
  }
}

/** POST /teams/remove-member */
export async function removeTeamMember(ctx: CursorContext, userId: string): Promise<void> {
  await cursorRequest<unknown>(ctx, "/teams/remove-member", {
    method: "POST",
    body: userId.startsWith("user_") ? { userId } : { email: userId },
  });
}

/** GET /teams/groups (billing groups) for the current billing cycle. */
export async function getBillingGroups(ctx: CursorContext): Promise<{
  groups: CursorBillingGroup[];
  billingCycle: CursorBillingCycle | undefined;
}> {
  const body = await cursorRequest<BillingGroupsResponse>(ctx, "/teams/groups");
  return { groups: body?.groups ?? [], billingCycle: body?.billingCycle };
}

/** GET /teams/groups/:groupId */
export async function getBillingGroup(
  ctx: CursorContext,
  groupId: string,
): Promise<CursorBillingGroup> {
  const body = await cursorRequest<{ group: CursorBillingGroup }>(
    ctx,
    `/teams/groups/${encodeURIComponent(groupId)}`,
  );
  return body.group;
}

/** POST /teams/groups */
export async function createBillingGroup(
  ctx: CursorContext,
  name: string,
): Promise<CursorBillingGroup> {
  const body = await cursorRequest<{ group: CursorBillingGroup }>(ctx, "/teams/groups", {
    method: "POST",
    body: { name, type: "BILLING" },
  });
  return body.group;
}

/** PATCH /teams/groups/:groupId */
export async function updateBillingGroup(
  ctx: CursorContext,
  groupId: string,
  patch: { name?: string },
): Promise<void> {
  await cursorRequest<unknown>(ctx, `/teams/groups/${encodeURIComponent(groupId)}`, {
    method: "PATCH",
    body: patch,
  });
}

/** DELETE /teams/groups/:groupId */
export async function deleteBillingGroup(ctx: CursorContext, groupId: string): Promise<void> {
  await cursorRequest<unknown>(ctx, `/teams/groups/${encodeURIComponent(groupId)}`, {
    method: "DELETE",
  });
}

/** POST (add) or DELETE (remove) /teams/groups/:groupId/members */
export async function changeBillingGroupMembers(
  ctx: CursorContext,
  groupId: string,
  change: "add" | "remove",
  userIds: string[],
): Promise<void> {
  if (userIds.length === 0) return;
  await cursorRequest<unknown>(ctx, `/teams/groups/${encodeURIComponent(groupId)}/members`, {
    method: change === "add" ? "POST" : "DELETE",
    body: { userIds },
  });
}

async function listPaged<T>(
  ctx: CursorContext,
  path: string,
  key: string,
  pageSize = 200,
): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= 50; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const body = await cursorRequest<Paginated & Record<string, unknown>>(
      ctx,
      `${path}${sep}page=${page}&pageSize=${pageSize}`,
    );
    const items = (body?.[key] as T[] | undefined) ?? [];
    out.push(...items);
    if (!body?.pagination?.hasNextPage || items.length === 0) break;
  }
  return out;
}

/** GET /teams/directory-groups, every page. */
export function getDirectoryGroups(ctx: CursorContext): Promise<CursorDirectoryGroup[]> {
  return listPaged<CursorDirectoryGroup>(ctx, "/teams/directory-groups", "groups");
}

/** GET /teams/directory-groups/:groupId */
export async function getDirectoryGroup(
  ctx: CursorContext,
  groupId: string,
): Promise<CursorDirectoryGroup> {
  const body = await cursorRequest<{ group: CursorDirectoryGroup }>(
    ctx,
    `/teams/directory-groups/${encodeURIComponent(groupId)}`,
  );
  return body.group;
}

/** GET /teams/directory-groups/:groupId/members, every page. */
export function getDirectoryGroupMembers(
  ctx: CursorContext,
  groupId: string,
): Promise<CursorGroupMember[]> {
  return listPaged<CursorGroupMember>(
    ctx,
    `/teams/directory-groups/${encodeURIComponent(groupId)}/members`,
    "members",
  );
}

/** POST /teams/directory-groups */
export async function createDirectoryGroup(
  ctx: CursorContext,
  name: string,
): Promise<CursorDirectoryGroup> {
  const body = await cursorRequest<{ group: CursorDirectoryGroup }>(
    ctx,
    "/teams/directory-groups",
    { method: "POST", body: { name } },
  );
  return body.group;
}

/** PATCH /teams/directory-groups/:groupId */
export async function updateDirectoryGroup(
  ctx: CursorContext,
  groupId: string,
  patch: {
    name?: string;
    monthlySpendingLimitDollars?: number;
    clearMonthlySpendingLimitDollars?: boolean;
  },
): Promise<CursorDirectoryGroup> {
  const body = await cursorRequest<{ group: CursorDirectoryGroup }>(
    ctx,
    `/teams/directory-groups/${encodeURIComponent(groupId)}`,
    { method: "PATCH", body: patch },
  );
  return body.group;
}

/** DELETE /teams/directory-groups/:groupId */
export async function deleteDirectoryGroup(ctx: CursorContext, groupId: string): Promise<void> {
  await cursorRequest<unknown>(ctx, `/teams/directory-groups/${encodeURIComponent(groupId)}`, {
    method: "DELETE",
  });
}

/** POST /teams/directory-groups/:groupId/members/bulk-add | bulk-remove, 100 ids per call. */
export async function changeDirectoryGroupMembers(
  ctx: CursorContext,
  groupId: string,
  change: "add" | "remove",
  userIds: string[],
): Promise<void> {
  const verb = change === "add" ? "bulk-add" : "bulk-remove";
  for (let i = 0; i < userIds.length; i += 100) {
    await cursorRequest<unknown>(
      ctx,
      `/teams/directory-groups/${encodeURIComponent(groupId)}/members/${verb}`,
      { method: "POST", body: { userIds: userIds.slice(i, i + 100) } },
    );
  }
}

/** GET /settings/repo-blocklists/repos */
export async function getRepoBlocklists(ctx: CursorContext): Promise<CursorRepoBlocklist[]> {
  const body = await cursorRequest<{ repos?: CursorRepoBlocklist[] }>(
    ctx,
    "/settings/repo-blocklists/repos",
  );
  return body?.repos ?? [];
}

/** POST /settings/repo-blocklists/repos/upsert, keyed by repository URL. */
export async function upsertRepoBlocklist(
  ctx: CursorContext,
  url: string,
  patterns: string[],
): Promise<CursorRepoBlocklist | undefined> {
  const body = await cursorRequest<{ repos?: CursorRepoBlocklist[] }>(
    ctx,
    "/settings/repo-blocklists/repos/upsert",
    { method: "POST", body: { repos: [{ url, patterns }] } },
  );
  return (body?.repos ?? []).find((r) => r.url === url) ?? body?.repos?.[0];
}

/** DELETE /settings/repo-blocklists/repos/:repoId */
export async function deleteRepoBlocklist(ctx: CursorContext, repoId: string): Promise<void> {
  await cursorRequest<unknown>(
    ctx,
    `/settings/repo-blocklists/repos/${encodeURIComponent(repoId)}`,
    {
      method: "DELETE",
    },
  );
}

/**
 * GET /analytics/team/:metric (Enterprise). Dates go as `YYYY-MM-DD`; the API
 * caps a request at 30 days, so longer ranges are split.
 */
export async function getAnalytics<T>(
  ctx: CursorContext,
  metric: "dau" | "agent-edits" | "tabs" | "models" | "client-versions",
  startMs: number,
  endMs: number,
): Promise<T[]> {
  const out: T[] = [];
  for (const [from, to] of splitRange(startMs, endMs, MAX_RANGE_DAYS)) {
    const query = new URLSearchParams({ startDate: isoDay(from), endDate: isoDay(to) });
    const body = await cursorRequest<AnalyticsResponse<T[]>>(
      ctx,
      `/analytics/team/${metric}?${query}`,
    );
    out.push(...(body?.data ?? []));
  }
  return out;
}

/** GET /analytics/ai-code/commits (Enterprise), capped at `maxPages` × 1,000 commits. */
export async function getAiCommits(
  ctx: CursorContext,
  startMs: number,
  endMs: number,
  maxPages = 5,
): Promise<CursorAiCommit[]> {
  const out: CursorAiCommit[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const query = new URLSearchParams({
      startDate: isoDay(startMs),
      endDate: isoDay(endMs),
      page: String(page),
      pageSize: "1000",
    });
    const body = await cursorRequest<AiCommitsResponse>(ctx, `/analytics/ai-code/commits?${query}`);
    const items = body?.items ?? [];
    out.push(...items);
    if (items.length < 1000 || out.length >= (body?.totalCount ?? 0)) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Split `[startMs, endMs]` into consecutive windows of at most `days` days. */
export function splitRange(startMs: number, endMs: number, days: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const span = days * DAY_MS;
  for (let from = startMs; from < endMs; from += span) {
    out.push([from, Math.min(endMs, from + span - 1)]);
  }
  return out;
}
