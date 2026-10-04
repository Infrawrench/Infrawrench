import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * The team itself: one row per account. Carries the team-wide usage metrics
 * (active users, requests by feature, accepted lines, Tab acceptance, spend)
 * and the audit log.
 */
export const TeamResourceType = rt({
  name: "Team",
  id: "team",
  description:
    "Your Cursor team: seats, spend this billing cycle, and team-wide usage metrics (active users, requests by feature, included vs usage-based requests, accepted lines and Tab acceptance). Enterprise teams also get the Analytics API series and AI-attributed commit lines. The Logs tab shows the team audit log.",
  fields: [
    f("members", "Members", { kind: "number", editable: false }),
    f("paidSeats", "Paid seats", { kind: "number", editable: false }),
    f("idleSeats", "Idle seats (30 days)", { kind: "number", editable: false }),
    f("unpaidAdmins", "Unpaid admins", { kind: "number", editable: false }),
    f("cycleStart", "Billing cycle start", { required: false, editable: false }),
    f("cycleSpendUsd", "Usage-based spend this cycle (USD)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("estimatedSeatCostUsd", "Estimated seat cost per month (USD)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("activeUsers30d", "Active users (30 days)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("analyticsApi", "Analytics API", { kind: "boolean", required: false, editable: false }),
  ],
  outputs: [o("teamId", "Team")],
  supportsCreate: false,
  supportsDelete: false,
  supportsMetrics: true,
  iconKey: "project",
});

/**
 * A team member and their seat. The spend limit is the one thing the Admin
 * API lets you change on a member; removing them frees the seat at the end
 * of the billing cycle.
 */
export const TeamMemberResourceType = rt({
  name: "Team Member",
  id: "team-member",
  description:
    "A member of the Cursor team with their role, seat, last activity, spend this billing cycle and per-user spend limit. Edit to set or clear the spend limit (whole US dollars). Delete removes the member from the team; Cursor keeps the seat billed until the end of the cycle. Members with no activity in 30 days are flagged as idle seats.",
  fields: [
    f("email", "Email", { editable: false }),
    f("name", "Name", { required: false, editable: false }),
    f("role", "Role", {
      kind: "enum",
      enumValues: ["owner", "member", "free-owner"],
      editable: false,
    }),
    f("seat", "Seat", {
      kind: "enum",
      enumValues: ["standard", "premium", "none"],
      editable: false,
    }),
    f("seatStatus", "Seat status", {
      kind: "enum",
      enumValues: ["active", "idle", "unpaid", "removed"],
      editable: false,
    }),
    f("lastActiveAt", "Last active", { required: false, editable: false }),
    f("activeDays30d", "Active days (30 days)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("requests30d", "Requests (30 days)", { kind: "number", required: false, editable: false }),
    f("acceptedLines30d", "Accepted lines (30 days)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("mostUsedModel", "Most used model", { required: false, editable: false }),
    f("clientVersion", "Client version", { required: false, editable: false }),
    f("spendThisCycleUsd", "Spend this cycle (USD)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("premiumRequests", "Premium requests this cycle", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("spendLimitDollars", "Spend limit (USD)", {
      kind: "number",
      required: false,
      description:
        "Hard limit on this member's usage-based spend per billing cycle, in whole US dollars. Leave empty to remove the member's own limit (the team or group limit then applies).",
    }),
    f("teamLimitDollars", "Team default limit (USD)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("effectiveLimitDollars", "Effective limit (USD)", {
      kind: "number",
      required: false,
      editable: false,
    }),
  ],
  outputs: [o("userId", "User ID"), o("email", "Email")],
  principalRole: {
    role: "user",
    lastUsedKey: "lastActiveAt",
    adminIndicatorKey: "role",
    adminValues: ["owner", "free-owner"],
  },
  orphanRule: {
    conditions: [{ fieldKey: "seatStatus", when: "equals", value: "idle" }],
    reason: "Paid Cursor seat with no editor, agent or Bugbot activity in the last 30 days",
  },
  supportsCreate: false,
  supportsUpdate: true,
  supportsDelete: true,
  supportsMetrics: true,
  iconKey: "user",
});

/** A model the team used in the trailing 30 days, with its request and token totals. */
export const ModelResourceType = rt({
  name: "Model",
  id: "model",
  description:
    "A model your team used in the last 30 days, from Cursor's usage events: requests (included vs usage-based), Max Mode share, tokens, usage-based spend and how many members used it. Read-only.",
  fields: [
    f("requests30d", "Requests (30 days)", { kind: "number", editable: false }),
    f("usageBasedRequests30d", "Usage-based requests", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("includedRequests30d", "Included requests", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("usageBasedSpendUsd30d", "Usage-based spend (USD)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("tokenCostUsd30d", "Token cost (USD)", { kind: "number", required: false, editable: false }),
    f("inputTokens30d", "Input tokens", { kind: "number", required: false, editable: false }),
    f("outputTokens30d", "Output tokens", { kind: "number", required: false, editable: false }),
    f("cacheReadTokens30d", "Cache read tokens", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("cacheWriteTokens30d", "Cache write tokens", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("maxModeRequests30d", "Max Mode requests", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("users30d", "Members using it", { kind: "number", required: false, editable: false }),
    f("lastUsedAt", "Last used", { required: false, editable: false }),
  ],
  outputs: [o("model", "Model")],
  supportsCreate: false,
  supportsDelete: false,
  supportsMetrics: true,
  iconKey: "model",
});

/** A billing group: spend attribution for a set of members. */
export const BillingGroupResourceType = rt({
  name: "Billing Group",
  id: "billing-group",
  description:
    "A Cursor billing group, used to attribute spend to a department or cost centre. Shows spend this billing cycle, daily spend and members. Create, rename, change members (by email) or delete.",
  fields: [
    f("name", "Name"),
    f("memberCount", "Members", { kind: "number", editable: false }),
    f("members", "Member emails", {
      required: false,
      description:
        "Comma-separated emails of the team members in this group. Add or remove addresses to change membership; every address must belong to a team member.",
    }),
    f("spendThisCycleUsd", "Spend this cycle (USD)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("directoryGroup", "Synced directory group", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [o("groupId", "Group ID")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  supportsMetrics: true,
  iconKey: "folder",
});

/** A directory (member) group: the unit Cursor applies group spend limits to. */
export const DirectoryGroupResourceType = rt({
  name: "Member Group",
  id: "directory-group",
  description:
    "A Cursor team directory group with its monthly spending limit and members. Create, rename, set or clear the spending limit, change members (by email) or delete.",
  fields: [
    f("name", "Name"),
    f("memberCount", "Members", { kind: "number", editable: false }),
    f("members", "Member emails", {
      required: false,
      description:
        "Comma-separated emails of the team members in this group. Add or remove addresses to change membership; every address must belong to a team member.",
    }),
    f("monthlySpendingLimitDollars", "Monthly spending limit (USD)", {
      kind: "number",
      required: false,
      description:
        "Whole US dollars per member per month, 0 to 2,147,483,647. Leave empty to remove the limit.",
    }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("updatedAt", "Updated", { required: false, editable: false }),
  ],
  outputs: [o("groupId", "Group ID")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "user",
});

/** Files Cursor must never read from a given repository. */
export const RepoBlocklistResourceType = rt({
  name: "Repository Blocklist",
  id: "repo-blocklist",
  description:
    "Glob patterns of files Cursor will not index or send to models for a repository (for example .env files or a secrets directory). Create, edit the patterns, or delete.",
  fields: [
    f("url", "Repository URL", { editable: false }),
    f("patterns", "Blocked patterns", {
      description: "Comma-separated glob patterns, for example *.env, config/*, secrets/**",
    }),
    f("patternCount", "Pattern count", { kind: "number", editable: false }),
  ],
  outputs: [o("repoId", "Blocklist ID"), o("url", "Repository URL")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "shield",
});

export const resourceTypes: ResourceTypeDefinition[] = [
  TeamResourceType,
  TeamMemberResourceType,
  ModelResourceType,
  BillingGroupResourceType,
  DirectoryGroupResourceType,
  RepoBlocklistResourceType,
];
