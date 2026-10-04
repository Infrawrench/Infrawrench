import type {
  CostFetchRange,
  CostRow,
  CreateResourceConfig,
  DashboardStat,
  DetailViewSchema,
  HostServices,
  LogsFetchParams,
  LogsFetchResult,
  MetricSeries,
  PluginClient,
  PreflightCapabilityCheck,
  PreflightResult,
  ResourceInstance,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { CostSetupError, externalIdOf, withMetricsCapability } from "@infrawrench/plugin-base";
import type {
  CursorBillingGroup,
  CursorContext,
  CursorDirectoryGroup,
  CursorEditsRow,
  CursorGroupMember,
  CursorMemberSpend,
  CursorModelsRow,
  CursorDauRow,
  CursorRepoBlocklist,
  CursorTeamMember,
  CursorUsageEvent,
} from "./api.js";
import {
  ADMIN_API_DOCS,
  ANALYTICS_API_DOCS,
  DAY_MS,
  INTERACTIVE_EVENT_PAGES,
  changeBillingGroupMembers,
  changeDirectoryGroupMembers,
  createBillingGroup,
  createDirectoryGroup,
  deleteBillingGroup,
  deleteDirectoryGroup,
  deleteRepoBlocklist,
  getAiCommits,
  getAnalytics,
  getAuditLogs,
  getBillingGroup,
  getBillingGroups,
  getDailyUsageRange,
  getDirectoryGroup,
  getDirectoryGroupMembers,
  getDirectoryGroups,
  getRepoBlocklists,
  getTeamMembers,
  getTeamSpend,
  getUsageEvents,
  isAccessDenied,
  isUnavailable,
  isoDay,
  removeTeamMember,
  setUserSpendLimit,
  updateBillingGroup,
  updateDirectoryGroup,
  upsertRepoBlocklist,
} from "./api.js";
import type { SeatPricing } from "./cost-data.js";
import {
  fetchCursorCostData,
  isPaidSeat,
  parseSeatPricing,
  seatMonthlyPrice,
  seatTier,
} from "./cost-data.js";
import { renderCursorDetail, renderCursorSidebarItem } from "./render.js";
import { resourceTypes } from "./resource-types.js";
import type { MemberActivity, ModelUsage } from "./usage.js";
import {
  analyticsSeries,
  dailyUsageSeries,
  eventSeries,
  memberActivity,
  modelUsage,
  n,
} from "./usage.js";

const PLUGIN_ID = "cursor";
const TEAM_ID = "team";
const CACHE_TTL_MS = 60_000;
/** Window for "idle seat", "requests (30 days)" and the model list. */
const ACTIVITY_WINDOW_MS = 30 * DAY_MS;
/** Default Metrics-tab window; must match what `fetchMetricSeries` uses with no range. */
export const DEFAULT_METRICS_WINDOW_MS = 30 * DAY_MS;
/** Largest integer Cursor accepts for a dollar limit (documented on directory groups). */
const MAX_LIMIT_DOLLARS = 2_147_483_647;
/** Directory groups whose members are read during a listing (one request each, 20/min). */
const LIST_MEMBERS_FOR_GROUPS = 10;

interface TeamSnapshot {
  members: CursorTeamMember[];
  spendByEmail: Map<string, CursorMemberSpend>;
  cycleStartMs: number | undefined;
  activity: Map<string, MemberActivity>;
  activeUsers: number;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function dollars(cents: unknown): number {
  return Math.round(n(cents)) / 100;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Parse a whole-dollar limit; `""` means "remove". Throws a message the edit form shows. */
export function parseDollarLimit(raw: string, label: string): number | null {
  const trimmed = raw.trim().replace(/^\$/, "");
  if (!trimmed) return null;
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < 0 || value > MAX_LIMIT_DOLLARS) {
    throw new Error(
      `${label} must be a whole number of US dollars between 0 and ${MAX_LIMIT_DOLLARS.toLocaleString("en-US")}, or empty to remove it.`,
    );
  }
  return value;
}

export function parseEmailList(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(/[\s,;]+/)
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

/** Policy-picker values arrive as a JSON array of ids; tolerate a comma list too. */
function parseIdList(raw: string | undefined): string[] {
  const value = (raw ?? "").trim();
  if (!value) return [];
  if (value.startsWith("[")) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
    } catch {
      // fall through to the comma form
    }
  }
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function parsePatterns(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(/[,\n]+/)
        .map((p) => p.trim())
        .filter(Boolean),
    ),
  ];
}

export class CursorClient implements PluginClient {
  private readonly ctx: CursorContext;
  private readonly pricing: SeatPricing;
  private readonly cache = new Map<string, { at: number; value: Promise<unknown> }>();

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const apiKey = (credentials["apiKey"] ?? "").trim();
    if (!apiKey) throw new Error("Cursor plugin: missing apiKey credential");
    this.ctx = {
      apiKey,
      ...(credentials["caCert"] ? { caCert: credentials["caCert"] } : {}),
      ...(services?.http ? { http: services.http } : {}),
    };
    this.pricing = parseSeatPricing(credentials);
  }

  /** Test seam: skip the 429 backoff. */
  setRetryDelayMs(ms: number): void {
    this.ctx.retryDelayMs = ms;
  }

  private cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value as Promise<T>;
    const value = load();
    this.cache.set(key, { at: Date.now(), value });
    value.catch(() => this.cache.delete(key));
    return value;
  }

  private invalidate(): void {
    this.cache.clear();
  }

  // ---- Shared reads --------------------------------------------------------

  private snapshot(): Promise<TeamSnapshot> {
    return this.cached("snapshot", async () => {
      const end = Date.now();
      const [members, spend, usage] = await Promise.all([
        getTeamMembers(this.ctx),
        getTeamSpend(this.ctx),
        getDailyUsageRange(this.ctx, end - ACTIVITY_WINDOW_MS, end),
      ]);
      const spendByEmail = new Map<string, CursorMemberSpend>();
      for (const s of spend.members) {
        const email = str(s.email).toLowerCase();
        if (email) spendByEmail.set(email, s);
      }
      const activity = memberActivity(usage);
      return {
        members,
        spendByEmail,
        cycleStartMs: spend.cycleStartMs,
        activity,
        activeUsers: activity.size,
      };
    });
  }

  private recentEvents(): Promise<{ events: CursorUsageEvent[]; truncated: boolean }> {
    return this.cached("events30d", () => {
      const end = Date.now();
      return getUsageEvents(this.ctx, end - ACTIVITY_WINDOW_MS, end, {
        maxPages: INTERACTIVE_EVENT_PAGES,
      });
    });
  }

  private analyticsAvailable(): Promise<boolean> {
    return this.cached("analytics", async () => {
      const end = Date.now();
      try {
        await getAnalytics<CursorDauRow>(this.ctx, "dau", end - DAY_MS, end);
        return true;
      } catch (err) {
        if (isUnavailable(err)) return false;
        throw err;
      }
    });
  }

  private async memberIdsForEmails(emails: string[]): Promise<string[]> {
    const { members } = await this.snapshot();
    const byEmail = new Map<string, string>();
    for (const m of members) {
      if (m.isRemoved) continue;
      const email = str(m.email).toLowerCase();
      if (email && m.id) byEmail.set(email, m.id);
    }
    const unknown = emails.filter((e) => !byEmail.has(e));
    if (unknown.length > 0) {
      throw new Error(
        `Not members of this Cursor team: ${unknown.join(", ")}. Use the email each member signs in to Cursor with.`,
      );
    }
    return emails.map((e) => byEmail.get(e)!);
  }

  // ---- Listing -------------------------------------------------------------

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "team":
        return [await this.teamResource(accountId)];
      case "team-member": {
        const snap = await this.snapshot();
        return snap.members.map((m) => this.mapMember(accountId, m, snap));
      }
      case "model": {
        const { events, truncated } = await this.recentEvents();
        return modelUsage(events).map((m) => this.mapModel(accountId, m, truncated));
      }
      case "billing-group": {
        const { groups } = await getBillingGroups(this.ctx);
        return groups.map((g) => this.mapBillingGroup(accountId, g));
      }
      case "directory-group": {
        const groups = await getDirectoryGroups(this.ctx);
        const withMembers = groups.length <= LIST_MEMBERS_FOR_GROUPS;
        return Promise.all(
          groups.map(async (g) =>
            this.mapDirectoryGroup(
              accountId,
              g,
              withMembers ? await getDirectoryGroupMembers(this.ctx, g.id) : undefined,
            ),
          ),
        );
      }
      case "repo-blocklist":
        return (await getRepoBlocklists(this.ctx)).map((r) => this.mapBlocklist(accountId, r));
      default:
        throw new Error(`Cursor plugin: unknown resource type "${typeId}"`);
    }
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const externalId = externalIdOf(resourceId);
    if (typeId === "billing-group") {
      return this.mapBillingGroup(accountId, await getBillingGroup(this.ctx, externalId));
    }
    if (typeId === "directory-group") {
      const [group, members] = await Promise.all([
        getDirectoryGroup(this.ctx, externalId),
        getDirectoryGroupMembers(this.ctx, externalId),
      ]);
      return this.mapDirectoryGroup(accountId, group, members);
    }
    const all = await this.listResources(typeId, accountId);
    const found = all.find((r) => r.id === resourceId || r.externalId === externalId);
    if (!found) throw new Error(`Cursor plugin: resource ${typeId}/${externalId} not found`);
    return found;
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    const resource = await this.getResource(typeId, resourceId, accountId);
    const value = resource.resolvedOutputs[outputKey];
    if (value !== undefined) return value;
    throw new Error(`Cursor plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
  }

  // ---- Mapping -------------------------------------------------------------

  private async teamResource(accountId: string): Promise<ResourceInstance> {
    const [snap, analytics] = await Promise.all([this.snapshot(), this.analyticsAvailable()]);
    const current = snap.members.filter((m) => !m.isRemoved);
    let paidSeats = 0;
    let idleSeats = 0;
    let seatCost = 0;
    for (const m of current) {
      if (!isPaidSeat(m)) continue;
      paidSeats += 1;
      seatCost += seatMonthlyPrice(seatTier(m, this.pricing), this.pricing);
      if (!snap.activity.has(str(m.email).toLowerCase())) idleSeats += 1;
    }
    let cycleCents = 0;
    for (const s of snap.spendByEmail.values()) cycleCents += n(s.spendCents);
    const now = nowIso();
    return {
      id: `${accountId}:team:${TEAM_ID}`,
      pluginId: PLUGIN_ID,
      resourceTypeId: "team",
      accountId,
      displayName: "Cursor team",
      externalId: TEAM_ID,
      fields: {
        members: current.length,
        paidSeats,
        idleSeats,
        unpaidAdmins: current.length - paidSeats,
        cycleStart: snap.cycleStartMs ? isoDay(snap.cycleStartMs) : "",
        cycleSpendUsd: dollars(cycleCents),
        estimatedSeatCostUsd: Math.round(seatCost * 100) / 100,
        activeUsers30d: snap.activeUsers,
        analyticsApi: analytics,
      },
      resolvedOutputs: { teamId: TEAM_ID },
      secretStates: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  private mapMember(
    accountId: string,
    member: CursorTeamMember,
    snap: TeamSnapshot,
  ): ResourceInstance {
    const email = str(member.email).toLowerCase();
    const id = str(member.id) || email;
    const spend = snap.spendByEmail.get(email);
    const activity = snap.activity.get(email);
    const tier = seatTier(member, this.pricing);
    const seatStatus = member.isRemoved
      ? "removed"
      : tier === "none"
        ? "unpaid"
        : activity
          ? "active"
          : "idle";
    const limit = spend?.hardLimitOverrideDollars;
    const now = nowIso();
    return {
      id: `${accountId}:team-member:${id}`,
      pluginId: PLUGIN_ID,
      resourceTypeId: "team-member",
      accountId,
      displayName: str(member.name) || str(member.email) || id,
      externalId: id,
      fields: {
        email: str(member.email),
        name: str(member.name),
        role: str(member.role),
        seat: tier,
        seatStatus,
        lastActiveAt: activity?.lastActiveDay ?? "",
        activeDays30d: activity?.activeDays ?? 0,
        requests30d: activity?.requests ?? 0,
        acceptedLines30d: activity?.acceptedLines ?? 0,
        mostUsedModel: activity?.mostUsedModel ?? "",
        clientVersion: activity?.clientVersion ?? "",
        spendThisCycleUsd: dollars(spend?.spendCents),
        premiumRequests: n(spend?.fastPremiumRequests),
        spendLimitDollars: typeof limit === "number" ? limit : "",
        teamLimitDollars:
          typeof spend?.monthlyLimitDollars === "number" ? spend.monthlyLimitDollars : "",
        effectiveLimitDollars:
          typeof spend?.effectivePerUserLimitDollars === "number"
            ? spend.effectivePerUserLimitDollars
            : "",
      },
      resolvedOutputs: { userId: id, email: str(member.email) },
      secretStates: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  private mapModel(accountId: string, m: ModelUsage, truncated: boolean): ResourceInstance {
    const now = nowIso();
    return {
      id: `${accountId}:model:${m.model}`,
      pluginId: PLUGIN_ID,
      resourceTypeId: "model",
      accountId,
      displayName: m.model,
      externalId: m.model,
      fields: {
        requests30d: m.requests,
        usageBasedRequests30d: m.usageBasedRequests,
        includedRequests30d: m.includedRequests,
        usageBasedSpendUsd30d: dollars(m.usageBasedCents),
        tokenCostUsd30d: dollars(m.tokenCostCents),
        inputTokens30d: m.inputTokens,
        outputTokens30d: m.outputTokens,
        cacheReadTokens30d: m.cacheReadTokens,
        cacheWriteTokens30d: m.cacheWriteTokens,
        maxModeRequests30d: m.maxModeRequests,
        users30d: m.users,
        lastUsedAt: m.lastUsedMs ? new Date(m.lastUsedMs).toISOString() : "",
        ...(truncated ? { sampled: true } : {}),
      },
      resolvedOutputs: { model: m.model },
      secretStates: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  private mapBillingGroup(accountId: string, g: CursorBillingGroup): ResourceInstance {
    const members: CursorGroupMember[] = g.currentMembers ?? g.members ?? [];
    const createdAt = str(g.createdAt) || nowIso();
    return {
      id: `${accountId}:billing-group:${g.id}`,
      pluginId: PLUGIN_ID,
      resourceTypeId: "billing-group",
      accountId,
      displayName: str(g.name) || g.id,
      externalId: g.id,
      fields: {
        name: str(g.name),
        memberCount: n(g.memberCount ?? members.length),
        members: members
          .map((m) => str(m.email))
          .filter(Boolean)
          .join(", "),
        spendThisCycleUsd: dollars(g.spendCents),
        directoryGroup: str(g.directoryGroupId),
        createdAt: str(g.createdAt),
        memberTable: JSON.stringify(
          members.map((m) => ({
            userId: str(m.userId),
            name: str(m.name),
            email: str(m.email),
            joinedAt: str(m.joinedAt),
            spendUsd: dollars(m.spendCents),
          })),
        ),
        dailySpend: JSON.stringify(g.dailySpend ?? []),
      },
      resolvedOutputs: { groupId: g.id },
      secretStates: [],
      createdAt,
      updatedAt: str(g.updatedAt) || createdAt,
    };
  }

  private mapDirectoryGroup(
    accountId: string,
    g: CursorDirectoryGroup,
    members: CursorGroupMember[] | undefined,
  ): ResourceInstance {
    const createdAt = str(g.createdAt) || nowIso();
    const limit = g.monthlySpendingLimitDollars;
    return {
      id: `${accountId}:directory-group:${g.id}`,
      pluginId: PLUGIN_ID,
      resourceTypeId: "directory-group",
      accountId,
      displayName: str(g.name) || g.id,
      externalId: g.id,
      fields: {
        name: str(g.name),
        memberCount: n(g.memberCount),
        ...(members
          ? {
              members: members
                .map((m) => str(m.email))
                .filter(Boolean)
                .join(", "),
              memberTable: JSON.stringify(
                members.map((m) => ({
                  userId: str(m.userId),
                  name: str(m.name),
                  email: str(m.email),
                  joinedAt: str(m.joinedAt),
                })),
              ),
            }
          : {}),
        monthlySpendingLimitDollars: typeof limit === "number" ? limit : "",
        createdAt: str(g.createdAt),
        updatedAt: str(g.updatedAt),
      },
      resolvedOutputs: { groupId: g.id },
      secretStates: [],
      createdAt,
      updatedAt: str(g.updatedAt) || createdAt,
    };
  }

  private mapBlocklist(accountId: string, r: CursorRepoBlocklist): ResourceInstance {
    const now = nowIso();
    const patterns = r.patterns ?? [];
    return {
      id: `${accountId}:repo-blocklist:${r.id}`,
      pluginId: PLUGIN_ID,
      resourceTypeId: "repo-blocklist",
      accountId,
      displayName: str(r.url).replace(/^https?:\/\//, "") || r.id,
      externalId: r.id,
      fields: {
        url: str(r.url),
        patterns: patterns.join(", "),
        patternCount: patterns.length,
      },
      resolvedOutputs: { repoId: r.id, url: str(r.url) },
      secretStates: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  // ---- Create / update / delete -------------------------------------------

  private async memberPickerOptions() {
    const { members } = await this.snapshot();
    return members
      .filter((m) => !m.isRemoved && m.id)
      .map((m) => ({
        id: str(m.id),
        label: str(m.name) || str(m.email),
        description: str(m.email),
        category: str(m.role) === "member" ? "Members" : "Admins",
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  async getCreateConfig(typeId: string): Promise<CreateResourceConfig> {
    if (typeId === "billing-group" || typeId === "directory-group") {
      const policies = await this.memberPickerOptions();
      return {
        fields: [
          {
            key: "name",
            label: "Name",
            kind: "text",
            required: true,
            placeholder: typeId === "billing-group" ? "Platform engineering" : "Contractors",
            description: "Must be unique within the team.",
          },
          ...(typeId === "directory-group"
            ? [
                {
                  key: "monthlySpendingLimitDollars",
                  label: "Monthly spending limit (USD)",
                  kind: "number" as const,
                  required: false,
                  minValue: 0,
                  maxValue: MAX_LIMIT_DOLLARS,
                  stepValue: 1,
                  description: "Whole US dollars per member per month. Leave empty for no limit.",
                },
              ]
            : []),
          {
            key: "memberIds",
            label: "Members",
            kind: "policy-picker",
            required: false,
            policies,
            description: "Team members to add to the group. You can change them later.",
          },
        ],
      };
    }
    if (typeId === "repo-blocklist") {
      return {
        fields: [
          {
            key: "url",
            label: "Repository URL",
            kind: "text",
            required: true,
            placeholder: "https://github.com/acme/payments",
          },
          {
            key: "patterns",
            label: "Blocked patterns",
            kind: "string-list",
            required: true,
            placeholder: "*.env",
            addLabel: "Add pattern",
            minEntries: 1,
            description: "Glob patterns of files Cursor must not read, for example secrets/**",
          },
        ],
      };
    }
    throw new Error(`Cursor plugin: ${typeId} cannot be created`);
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    this.invalidate();
    if (typeId === "billing-group" || typeId === "directory-group") {
      const name = (fields["name"] ?? "").trim();
      if (!name) throw new Error("A group name is required.");
      const memberIds = parseIdList(fields["memberIds"]);
      if (typeId === "billing-group") {
        const group = await createBillingGroup(this.ctx, name);
        await changeBillingGroupMembers(this.ctx, group.id, "add", memberIds);
        return this.getResource(typeId, `${accountId}:${typeId}:${group.id}`, accountId);
      }
      const limit = parseDollarLimit(
        fields["monthlySpendingLimitDollars"] ?? "",
        "The monthly spending limit",
      );
      let group = await createDirectoryGroup(this.ctx, name);
      if (limit !== null) {
        group = await updateDirectoryGroup(this.ctx, group.id, {
          monthlySpendingLimitDollars: limit,
        });
      }
      await changeDirectoryGroupMembers(this.ctx, group.id, "add", memberIds);
      return this.getResource(typeId, `${accountId}:${typeId}:${group.id}`, accountId);
    }
    if (typeId === "repo-blocklist") {
      const url = validateRepoUrl(fields["url"] ?? "");
      const patterns = parsePatterns(fields["patterns"] ?? "");
      if (patterns.length === 0) throw new Error("Add at least one pattern to block.");
      const saved = await upsertRepoBlocklist(this.ctx, url, patterns);
      if (!saved) throw new Error("Cursor did not return the saved blocklist.");
      return this.mapBlocklist(accountId, saved);
    }
    throw new Error(`Cursor plugin: ${typeId} cannot be created`);
  }

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const externalId = externalIdOf(resourceId);

    if (typeId === "team-member") {
      if (fields["spendLimitDollars"] === undefined) {
        throw new Error("The spend limit is the only editable field on a team member.");
      }
      const limit = parseDollarLimit(fields["spendLimitDollars"], "The spend limit");
      const member = (await this.snapshot()).members.find(
        (m) => m.id === externalId || str(m.email).toLowerCase() === externalId.toLowerCase(),
      );
      const email = str(member?.email);
      if (!email) throw new Error(`Cursor plugin: team member ${externalId} not found`);
      if (member?.isRemoved) throw new Error("This member has been removed from the team.");
      await setUserSpendLimit(this.ctx, email, limit);
      this.invalidate();
      return this.getResource(typeId, resourceId, accountId);
    }

    if (typeId === "billing-group") {
      if (fields["name"] !== undefined) {
        const name = fields["name"].trim();
        if (!name) throw new Error("A group name cannot be empty.");
        await updateBillingGroup(this.ctx, externalId, { name });
      }
      if (fields["members"] !== undefined) {
        const current = await getBillingGroup(this.ctx, externalId);
        const currentIds = (current.currentMembers ?? current.members ?? [])
          .map((m) => str(m.userId))
          .filter(Boolean);
        const { add, remove } = await this.membershipDiff(currentIds, fields["members"]);
        await changeBillingGroupMembers(this.ctx, externalId, "add", add);
        await changeBillingGroupMembers(this.ctx, externalId, "remove", remove);
      }
      this.invalidate();
      return this.getResource(typeId, resourceId, accountId);
    }

    if (typeId === "directory-group") {
      const patch: {
        name?: string;
        monthlySpendingLimitDollars?: number;
        clearMonthlySpendingLimitDollars?: boolean;
      } = {};
      if (fields["name"] !== undefined) {
        const name = fields["name"].trim();
        if (!name) throw new Error("A group name cannot be empty.");
        patch.name = name;
      }
      if (fields["monthlySpendingLimitDollars"] !== undefined) {
        const limit = parseDollarLimit(
          fields["monthlySpendingLimitDollars"],
          "The monthly spending limit",
        );
        if (limit === null) patch.clearMonthlySpendingLimitDollars = true;
        else patch.monthlySpendingLimitDollars = limit;
      }
      if (fields["members"] !== undefined) {
        const current = await getDirectoryGroupMembers(this.ctx, externalId);
        const currentIds = current.map((m) => str(m.userId)).filter(Boolean);
        const { add, remove } = await this.membershipDiff(currentIds, fields["members"]);
        await changeDirectoryGroupMembers(this.ctx, externalId, "add", add);
        await changeDirectoryGroupMembers(this.ctx, externalId, "remove", remove);
      }
      if (Object.keys(patch).length > 0) await updateDirectoryGroup(this.ctx, externalId, patch);
      this.invalidate();
      return this.getResource(typeId, resourceId, accountId);
    }

    if (typeId === "repo-blocklist") {
      if (fields["patterns"] === undefined) {
        throw new Error("The patterns are the only editable field on a blocklist.");
      }
      const patterns = parsePatterns(fields["patterns"]);
      if (patterns.length === 0) {
        throw new Error("Add at least one pattern, or delete the blocklist instead.");
      }
      const existing = (await getRepoBlocklists(this.ctx)).find((r) => r.id === externalId);
      if (!existing?.url) throw new Error(`Cursor plugin: blocklist ${externalId} not found`);
      const saved = await upsertRepoBlocklist(this.ctx, existing.url, patterns);
      return this.mapBlocklist(accountId, saved ?? { ...existing, patterns });
    }

    throw new Error(`Cursor plugin: ${typeId} cannot be edited`);
  }

  private async membershipDiff(
    currentIds: string[],
    rawEmails: string,
  ): Promise<{ add: string[]; remove: string[] }> {
    const wanted = new Set(await this.memberIdsForEmails(parseEmailList(rawEmails)));
    const current = new Set(currentIds);
    return {
      add: [...wanted].filter((id) => !current.has(id)),
      remove: [...current].filter((id) => !wanted.has(id)),
    };
  }

  async deleteResource(typeId: string, resourceId: string): Promise<void> {
    const externalId = externalIdOf(resourceId);
    this.invalidate();
    switch (typeId) {
      case "team-member":
        return removeTeamMember(this.ctx, externalId);
      case "billing-group":
        return deleteBillingGroup(this.ctx, externalId);
      case "directory-group":
        return deleteDirectoryGroup(this.ctx, externalId);
      case "repo-blocklist":
        return deleteRepoBlocklist(this.ctx, externalId);
      default:
        throw new Error(`Cursor plugin: ${typeId} cannot be deleted`);
    }
  }

  /** `remove-from-group:<userId>` on a group's member table. */
  async invokeAction(typeId: string, resourceId: string, actionId: string): Promise<void> {
    const externalId = externalIdOf(resourceId);
    const [verb, userId] = actionId.split(":", 2);
    if (verb === "remove-from-group" && userId) {
      this.invalidate();
      if (typeId === "billing-group") {
        return changeBillingGroupMembers(this.ctx, externalId, "remove", [userId]);
      }
      if (typeId === "directory-group") {
        return changeDirectoryGroupMembers(this.ctx, externalId, "remove", [userId]);
      }
    }
    throw new Error(`Cursor plugin: unknown action "${actionId}" for type "${typeId}"`);
  }

  // ---- Metrics, cost, stats, logs -----------------------------------------

  async fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    const endMs = Math.min(timeRange?.endMs ?? Date.now(), Date.now());
    const startMs = timeRange?.startMs ?? endMs - DEFAULT_METRICS_WINDOW_MS;
    const externalId = externalIdOf(resourceId);

    switch (resourceTypeId) {
      case "team": {
        const usage = await getDailyUsageRange(this.ctx, startMs, endMs);
        return [...dailyUsageSeries(usage), ...(await this.enterpriseTeamSeries(startMs, endMs))];
      }
      case "team-member": {
        const resource = await this.getResource(resourceTypeId, resourceId, accountId);
        const email = str(resource.fields["email"]).toLowerCase();
        if (!email) return [];
        const [usage, events] = await Promise.all([
          getDailyUsageRange(this.ctx, startMs, endMs),
          getUsageEvents(this.ctx, startMs, endMs, { email, maxPages: 5 }),
        ]);
        const own = usage.filter((r) => str(r.email).toLowerCase() === email);
        return [...eventSeries(events.events), ...dailyUsageSeries(own, { perMember: true })];
      }
      case "model": {
        const { events } = await getUsageEvents(this.ctx, startMs, endMs);
        const own = events.filter((e) => e.model === externalId);
        return [
          ...eventSeries(own),
          ...(await this.analyticsModelSeries(externalId, startMs, endMs)),
        ];
      }
      case "billing-group": {
        const group = await getBillingGroup(this.ctx, externalId);
        const startDay = isoDay(startMs);
        const endDay = isoDay(endMs);
        const rows = (group.dailySpend ?? []).filter(
          (d) => str(d.date) >= startDay && str(d.date) <= endDay,
        );
        return [
          analyticsSeries(
            rows,
            "Spend",
            "USD",
            (d) => d.date,
            (d) => dollars(d.spendCents),
          ),
        ];
      }
      default:
        return [];
    }
  }

  /** Analytics API and AI Code Tracking series; empty for teams without Enterprise. */
  private async enterpriseTeamSeries(startMs: number, endMs: number): Promise<MetricSeries[]> {
    if (!(await this.analyticsAvailable())) return [];
    const out: MetricSeries[] = [];
    const tolerate = async <T>(load: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await load();
      } catch (err) {
        if (isUnavailable(err)) return undefined;
        throw err;
      }
    };
    const [dau, edits, tabs, commits] = await Promise.all([
      tolerate(() => getAnalytics<CursorDauRow>(this.ctx, "dau", startMs, endMs)),
      tolerate(() => getAnalytics<CursorEditsRow>(this.ctx, "agent-edits", startMs, endMs)),
      tolerate(() => getAnalytics<CursorEditsRow>(this.ctx, "tabs", startMs, endMs)),
      tolerate(() => getAiCommits(this.ctx, startMs, endMs)),
    ]);
    if (dau) {
      out.push(
        analyticsSeries(
          dau,
          "CLI active users",
          "users",
          (r) => r.date,
          (r) => n(r.cli_dau),
        ),
        analyticsSeries(
          dau,
          "Cloud agent active users",
          "users",
          (r) => r.date,
          (r) => n(r.cloud_agent_dau),
        ),
        analyticsSeries(
          dau,
          "Bugbot active users",
          "users",
          (r) => r.date,
          (r) => n(r.bugbot_dau),
        ),
      );
    }
    if (edits) {
      out.push(
        analyticsSeries(
          edits,
          "Agent diffs accepted",
          "diffs",
          (r) => r.event_date,
          (r) => n(r.total_accepted_diffs),
        ),
        analyticsSeries(
          edits,
          "Agent lines accepted",
          "lines",
          (r) => r.event_date,
          (r) => n(r.total_lines_accepted),
        ),
      );
    }
    if (tabs) {
      out.push(
        analyticsSeries(
          tabs,
          "Tab lines accepted",
          "lines",
          (r) => r.event_date,
          (r) => n(r.total_lines_accepted),
        ),
      );
    }
    if (commits) {
      out.push(
        analyticsSeries(
          commits,
          "AI lines committed",
          "lines",
          (c) => c.commitTs,
          (c) => n(c.tabLinesAdded) + n(c.composerLinesAdded),
        ),
        analyticsSeries(
          commits,
          "Non-AI lines committed",
          "lines",
          (c) => c.commitTs,
          (c) => n(c.nonAiLinesAdded),
        ),
      );
    }
    return out;
  }

  private async analyticsModelSeries(
    model: string,
    startMs: number,
    endMs: number,
  ): Promise<MetricSeries[]> {
    if (!(await this.analyticsAvailable())) return [];
    try {
      const rows = await getAnalytics<CursorModelsRow>(this.ctx, "models", startMs, endMs);
      return [
        analyticsSeries(
          rows,
          "Messages (all surfaces)",
          "messages",
          (r) => r.date,
          (r) => n(r.model_breakdown?.[model]?.messages),
        ),
        analyticsSeries(
          rows,
          "Members using it",
          "users",
          (r) => r.date,
          (r) => n(r.model_breakdown?.[model]?.users),
        ),
      ];
    } catch (err) {
      if (isUnavailable(err)) return [];
      throw err;
    }
  }

  async fetchCostData(_accountId: string, range: CostFetchRange): Promise<CostRow[]> {
    try {
      return await fetchCursorCostData(this.ctx, this.pricing, range);
    } catch (err) {
      if (isAccessDenied(err)) {
        throw new CostSetupError(
          "Cursor rejected the API key. Cost collection needs a team API key created by a team admin (Teams or Enterprise plan).",
          { label: "Create an Admin API key", url: ADMIN_API_DOCS },
        );
      }
      throw err;
    }
  }

  async fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    const r = await this.getResource(resourceTypeId, resourceId, accountId);
    const f = r.fields;
    switch (resourceTypeId) {
      case "team":
        return [
          { label: "Paid seats", value: String(n(f["paidSeats"])) },
          {
            label: "Idle seats",
            value: String(n(f["idleSeats"])),
            variant: n(f["idleSeats"]) > 0 ? "status-degraded" : "status-healthy",
          },
          { label: "Cycle spend", value: `$${n(f["cycleSpendUsd"]).toFixed(2)}` },
        ];
      case "team-member":
        return [
          { label: "Seat", value: str(f["seatStatus"]) },
          { label: "Cycle spend", value: `$${n(f["spendThisCycleUsd"]).toFixed(2)}` },
          { label: "Requests (30d)", value: n(f["requests30d"]).toLocaleString("en-US") },
        ];
      case "model":
        return [
          { label: "Requests (30d)", value: n(f["requests30d"]).toLocaleString("en-US") },
          { label: "Usage spend", value: `$${n(f["usageBasedSpendUsd30d"]).toFixed(2)}` },
          { label: "Members", value: String(n(f["users30d"])) },
        ];
      case "billing-group":
        return [
          { label: "Members", value: String(n(f["memberCount"])) },
          { label: "Cycle spend", value: `$${n(f["spendThisCycleUsd"]).toFixed(2)}` },
        ];
      case "directory-group":
        return [
          { label: "Members", value: String(n(f["memberCount"])) },
          {
            label: "Monthly limit",
            value:
              f["monthlySpendingLimitDollars"] === ""
                ? "None"
                : `$${n(f["monthlySpendingLimitDollars"])}`,
          },
        ];
      case "repo-blocklist":
        return [{ label: "Patterns", value: String(n(f["patternCount"])) }];
      default:
        return [];
    }
  }

  /** The team audit log, oldest first so the tail is the newest. */
  async getLogs(
    typeId: string,
    _resourceId: string,
    _accountId: string,
    params: LogsFetchParams,
  ): Promise<LogsFetchResult> {
    const container = "audit-log";
    if (typeId !== "team") return { text: "", containers: [], activeContainer: "" };
    const end = Date.now();
    const events = await getAuditLogs(
      this.ctx,
      end - 30 * DAY_MS + 60_000,
      end,
      params.tailLines ?? 200,
    );
    const lines = events
      .slice()
      .sort((a, b) => (str(a.timestamp) < str(b.timestamp) ? -1 : 1))
      .map((e) => {
        const data =
          e.event_data && Object.keys(e.event_data).length > 0
            ? ` ${JSON.stringify(e.event_data)}`
            : "";
        const ip = e.ip_address ? ` from ${e.ip_address}` : "";
        return `${str(e.timestamp)} ${str(e.event_type)} ${str(e.user_email) || "-"}${ip}${data}\n`;
      });
    return { text: lines.join(""), containers: [container], activeContainer: container };
  }

  async verifyCredentials(): Promise<PreflightResult> {
    const checks: PreflightCapabilityCheck[] = [];
    let identity: string | undefined;
    try {
      const members = await getTeamMembers(this.ctx);
      identity = `Cursor team (${members.filter((m) => !m.isRemoved).length} members)`;
      checks.push({ capabilityId: "read", status: "ok" });
    } catch (err) {
      checks.push(
        isAccessDenied(err)
          ? {
              capabilityId: "read",
              status: "missing",
              missingPermissions: [
                { id: "read-only", label: "Team API key (read-only or admin scope)" },
              ],
              message:
                "Cursor rejected the key. Check it was copied in full and has not been revoked.",
              helpLink: { label: "Admin API keys", url: ADMIN_API_DOCS },
            }
          : { capabilityId: "read", status: "unknown", message: errorMessage(err) },
      );
    }

    // Cursor has no read endpoint that tells a read-only key from an
    // admin-scoped one, and preflight must not write, so the write check is
    // reported as unknown with what will happen if the key is read-only.
    checks.push({
      capabilityId: "write",
      status: "unknown",
      message:
        "Cursor offers no read-only way to check a key's scope. With a read-only key, listing and costs work and edits fail with a permission error.",
    });

    try {
      const available = await this.analyticsAvailable();
      checks.push(
        available
          ? { capabilityId: "analytics", status: "ok" }
          : {
              capabilityId: "analytics",
              status: "missing",
              missingPermissions: [
                { id: "enterprise", label: "Enterprise plan" },
                { id: "admin", label: "Team API key with the admin scope" },
              ],
              message:
                "The Analytics API answered with an access error: it is Enterprise-only and needs an admin-scoped key. Everything else keeps working.",
              helpLink: { label: "Analytics API", url: ANALYTICS_API_DOCS },
            },
      );
    } catch (err) {
      checks.push({ capabilityId: "analytics", status: "unknown", message: errorMessage(err) });
    }

    return { checks, ...(identity ? { identity } : {}) };
  }

  // ---- Rendering -----------------------------------------------------------

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return withMetricsCapability(
      renderCursorDetail(resource),
      resourceTypes,
      resource.resourceTypeId,
      DEFAULT_METRICS_WINDOW_MS,
    );
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderCursorSidebarItem(resource);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function validateRepoUrl(raw: string): string {
  const url = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      "Enter the repository's full URL, for example https://github.com/acme/payments.",
    );
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("The repository URL must start with https://.");
  }
  return url.replace(/\/+$/, "");
}
