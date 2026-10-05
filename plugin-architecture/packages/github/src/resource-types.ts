import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * GitHub resource types. Field names follow GitHub's published REST API
 * description (`github/rest-api-description`, api.github.com and ghec,
 * 2026-10); each type names the endpoint it lists from.
 *
 * An account is scoped to exactly one organization or enterprise (the owner
 * credential), so the billing account is the account root.
 */

/** The organization or enterprise itself: billing summary and the usage charts. */
export const BillingAccountResourceType = rt({
  name: "Billing Account",
  id: "billing-account",
  description:
    "The GitHub organization or enterprise this account is scoped to. Shows this month's gross, discount and net spend by product and SKU, premium requests and AI credits by model, Copilot seats and Actions cache totals, and charts Actions minutes, Copilot users and daily spend.",
  fields: [
    f("name", "Name", { editable: false }),
    f("slug", "Slug", { editable: false }),
    f("kind", "Type", { required: false, editable: false }),
    f("plan", "Plan", { required: false, editable: false }),
    f("monthToDate", "Net Spend This Month (USD)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("grossToDate", "Gross Spend This Month (USD)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("discountToDate", "Discounts This Month (USD)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("copilotSeats", "Copilot Seats", { kind: "number", required: false, editable: false }),
    f("cacheSizeGb", "Actions Cache (GB)", { kind: "number", required: false, editable: false }),
  ],
  outputs: [o("slug", "Slug")],
  accountRoot: true,
  supportsMetrics: true,
  iconKey: "account",
});

/**
 * `GET /orgs/{org}/copilot/billing/seats` or
 * `GET /enterprises/{enterprise}/copilot/billing/seats`.
 */
export const CopilotSeatResourceType = rt({
  name: "Copilot Seat",
  id: "copilot-seat",
  description:
    "A Copilot Business or Enterprise seat assigned to a user, with last use and editor. Seats idle for 30 days are flagged. Remove a seat to stop paying for it from the next billing cycle, or assign one to a member.",
  fields: [
    f("login", "User", { editable: false }),
    f("name", "Name", { required: false, editable: false }),
    f("planType", "Plan", { required: false, editable: false }),
    f("lastActivityAt", "Last Activity", { required: false, editable: false }),
    f("lastActivityEditor", "Last Editor", { required: false, editable: false }),
    f("lastAuthenticatedAt", "Last Authenticated", { required: false, editable: false }),
    f("idleDays", "Days Since Activity", { kind: "number", required: false, editable: false }),
    f("idle", "Idle", { kind: "boolean", required: false, editable: false }),
    f("assigningTeam", "Assigned Through Team", { required: false, editable: false }),
    f("organization", "Organization", { required: false, editable: false }),
    f("pendingCancellationDate", "Cancels On", { required: false, editable: false }),
    f("monthlyPrice", "Seat Price (USD per month)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("createdAt", "Assigned", { required: false, editable: false }),
  ],
  outputs: [o("login", "Login")],
  supportsCreate: true,
  supportsDelete: true,
  orphanRule: {
    conditions: [
      { fieldKey: "idle", when: "equals", value: "true" },
      { fieldKey: "pendingCancellationDate", when: "empty" },
    ],
    reason:
      "Copilot seat with no activity in the last 30 days. It is billed every month whether it is used or not.",
  },
  iconKey: "user",
});

/**
 * `GET /orgs/{org}/actions/hosted-runners` or the enterprise equivalent:
 * GitHub-hosted larger runners.
 */
export const HostedRunnerResourceType = rt({
  name: "Larger Runner",
  id: "hosted-runner",
  description:
    "A GitHub-hosted larger runner: platform, machine size, image, runner group and scaling limit, with this month's spend on its SKU. Create, resize, rename or delete it.",
  fields: [
    f("name", "Name"),
    f("maximumRunners", "Maximum Concurrent Runners", {
      kind: "number",
      required: false,
      description: "How many jobs may run on this runner at once. Billing is per minute used.",
    }),
    f("enableStaticIp", "Static Public IP", { kind: "boolean", required: false }),
    f("platform", "Platform", { required: false, editable: false }),
    f("size", "Machine Size", { required: false, editable: false }),
    f("cpuCores", "CPU Cores", { kind: "number", required: false, editable: false }),
    f("memoryGb", "Memory (GB)", { kind: "number", required: false, editable: false }),
    f("storageGb", "Storage (GB)", { kind: "number", required: false, editable: false }),
    f("image", "Image", { required: false, editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("runnerGroupId", "Runner Group", { required: false, editable: false }),
    f("lastActiveOn", "Last Active", { required: false, editable: false }),
    f("sku", "Billing SKU", { required: false, editable: false }),
    f("pricePerMinute", "Price per Minute (USD)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("skuMonthToDate", "SKU Spend This Month (USD)", {
      kind: "number",
      required: false,
      editable: false,
      description:
        "Net spend this month on this runner's SKU. GitHub bills by SKU, not by runner, so runners sharing a size share the figure.",
    }),
  ],
  outputs: [o("runnerId", "Runner ID")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "server",
});

/** `GET /orgs/{org}/actions/runners`: self-hosted runners. */
export const RunnerResourceType = rt({
  name: "Self-Hosted Runner",
  id: "runner",
  description:
    "A self-hosted Actions runner registered with the organization: OS, labels, online and busy state, and version. Remove the registration when the machine is gone. GitHub does not bill self-hosted minutes.",
  fields: [
    f("name", "Name", { editable: false }),
    f("os", "OS", { required: false, editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("busy", "Busy", { kind: "boolean", required: false, editable: false }),
    f("labels", "Labels", { required: false, editable: false }),
    f("ephemeral", "Ephemeral", { kind: "boolean", required: false, editable: false }),
    f("runnerGroupId", "Runner Group", { required: false, editable: false }),
    f("version", "Runner Version", { required: false, editable: false }),
  ],
  outputs: [o("runnerId", "Runner ID")],
  supportsDelete: true,
  orphanRule: {
    conditions: [{ fieldKey: "status", when: "equals", value: "offline" }],
    reason:
      "Self-hosted runner that is offline. If the machine behind it still exists it may be idle capacity you are paying for elsewhere; if not, the registration can be removed.",
  },
  iconKey: "server",
});

/** `GET /orgs/{org}/actions/cache/usage-by-repository`. */
export const ActionsCacheResourceType = rt({
  name: "Actions Cache",
  id: "actions-cache",
  plural: "Actions Caches",
  description:
    "Actions cache storage for one repository: how many caches it holds and how much space they take, with the largest caches listed. Delete single caches or clear them all.",
  fields: [
    f("repository", "Repository", { editable: false }),
    f("cacheCount", "Active Caches", { kind: "number", required: false, editable: false }),
    f("sizeBytes", "Size (bytes)", { kind: "number", required: false, editable: false }),
    f("size", "Size", { required: false, editable: false }),
  ],
  outputs: [o("repository", "Repository")],
  iconKey: "cache",
});

/** `GET /orgs/{org}/codespaces`. */
export const CodespaceResourceType = rt({
  name: "Codespace",
  id: "codespace",
  description:
    "A codespace in the organization: owner, repository, machine type, state and last use. Stopped codespaces still bill for storage, so ones unused for 14 days are flagged. Stop or delete it.",
  fields: [
    f("displayName", "Name", { editable: false }),
    f("owner", "Owner", { editable: false }),
    f("billableOwner", "Billed To", { required: false, editable: false }),
    f("repository", "Repository", { required: false, editable: false }),
    f("state", "State", { required: false, editable: false }),
    f("machine", "Machine Type", { required: false, editable: false }),
    f("cpus", "CPUs", { kind: "number", required: false, editable: false }),
    f("memory", "Memory", { required: false, editable: false }),
    f("storage", "Storage", { required: false, editable: false }),
    f("lastUsedAt", "Last Used", { required: false, editable: false }),
    f("idleDays", "Days Since Use", { kind: "number", required: false, editable: false }),
    f("stale", "Unused for 14+ Days", { kind: "boolean", required: false, editable: false }),
    f("idleTimeoutMinutes", "Idle Timeout (minutes)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("retentionExpiresAt", "Auto-Deletes", { required: false, editable: false }),
    f("location", "Location", { required: false, editable: false }),
    f("devcontainerPath", "Dev Container", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("codespaceName", "Codespace ID", { required: false, editable: false }),
  ],
  outputs: [o("webUrl", "Web URL")],
  supportsDelete: true,
  orphanRule: {
    conditions: [{ fieldKey: "stale", when: "equals", value: "true" }],
    reason:
      "Codespace not used for 14 days or more. Stopped codespaces still bill for storage until they are deleted.",
  },
  iconKey: "compute",
});

/** `GET {billing}/budgets`. */
export const BudgetResourceType = rt({
  name: "Budget",
  id: "budget",
  description:
    "A GitHub spending budget for a product, SKU or AI credits, scoped to the organization, enterprise, repository, cost centre or user. Shows this month's spend against it. Create, edit or delete it.",
  fields: [
    f("budgetAmount", "Amount (USD)", {
      kind: "number",
      description:
        "Whole dollars. For licence-based products GitHub counts licences instead of dollars.",
    }),
    f("preventFurtherUsage", "Stop Usage When Exceeded", { kind: "boolean", required: false }),
    f("willAlert", "Send Alerts", { kind: "boolean", required: false }),
    f("alertRecipients", "Alert Recipients", {
      required: false,
      description: "GitHub usernames, comma-separated.",
    }),
    f("expiresAt", "Expires", {
      required: false,
      description: "YYYY-MM-DD. Only user budgets can expire.",
    }),
    f("product", "Product or SKU", { required: false, editable: false }),
    f("budgetType", "Budget Type", { required: false, editable: false }),
    f("productSku", "Product/SKU ID", { required: false, editable: false }),
    f("scope", "Scope", { required: false, editable: false }),
    f("entity", "Applies To", { required: false, editable: false }),
    f("user", "User", { required: false, editable: false }),
    f("spentThisMonth", "Spent This Month (USD)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("percentUsed", "Used (%)", { kind: "number", required: false, editable: false }),
  ],
  outputs: [o("budgetId", "Budget ID")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "sliders",
});

/** `GET /enterprises/{enterprise}/settings/billing/cost-centers`. */
export const CostCenterResourceType = rt({
  name: "Cost Center",
  id: "cost-center",
  description:
    "An enterprise cost centre and the users, organizations, repositories and teams whose usage it collects, with this month's spend. Create, rename, edit members or delete it. Enterprise accounts only.",
  fields: [
    f("name", "Name"),
    f("users", "Users", { required: false, description: "GitHub usernames, comma-separated." }),
    f("organizations", "Organizations", {
      required: false,
      description: "Organization logins, comma-separated.",
    }),
    f("repositories", "Repositories", {
      required: false,
      description: "owner/name, comma-separated.",
    }),
    f("enterpriseTeams", "Enterprise Teams", {
      required: false,
      description: "Enterprise team slugs, comma-separated.",
    }),
    f("aiCreditPoolEnabled", "Draw From AI Credit Pool", {
      kind: "boolean",
      required: false,
      description:
        "Caps the cost centre's AI credits at its members' licence entitlements. Only for cost centres with only users or teams.",
    }),
    f("state", "State", { required: false, editable: false }),
    f("azureSubscription", "Azure Subscription", { required: false, editable: false }),
    f("monthToDate", "Net Spend This Month (USD)", {
      kind: "number",
      required: false,
      editable: false,
    }),
  ],
  outputs: [o("costCenterId", "Cost Center ID")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "folder",
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  BillingAccountResourceType,
  CopilotSeatResourceType,
  HostedRunnerResourceType,
  RunnerResourceType,
  ActionsCacheResourceType,
  CodespaceResourceType,
  BudgetResourceType,
  CostCenterResourceType,
];
