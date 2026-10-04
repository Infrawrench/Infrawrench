import type {
  ActionNode,
  DetailViewSchema,
  KVItem,
  ResourceInstance,
  ResourceStatus,
  SchemaNode,
  SectionNode,
  SidebarItemSchema,
  StatusDotNode,
  TableRow,
} from "@infrawrench/plugin-base";
import { formatBytes, joinSubtitle, withMetricsCapability } from "@infrawrench/plugin-base";
import type { GitHubHost, GitHubOwner } from "./api.js";
import type { GhActionsCache } from "./mappers.js";
import { CODESPACE_STALE_DAYS, SEAT_IDLE_DAYS } from "./mappers.js";
import { METRICS_WINDOW_MS } from "./metrics.js";
import { productLabel, skuLabel } from "./products.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import type { SummaryItem } from "./usage.js";

/** Keys under which `getResource` stashes data the synchronous renderer needs. */
export const SUMMARY_KEY = "__summary__";
export const PREMIUM_KEY = "__premiumRequests__";
export const AI_CREDIT_KEY = "__aiCredits__";
export const SEAT_BREAKDOWN_KEY = "__seatBreakdown__";
export const CACHES_KEY = "__caches__";

export interface SeatBreakdown {
  total?: number;
  added_this_cycle?: number;
  pending_cancellation?: number;
  pending_invitation?: number;
  active_this_cycle?: number;
  inactive_this_cycle?: number;
}

export interface RenderContext {
  host: GitHubHost;
  owner: GitHubOwner;
}

const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));

function usd(value: unknown): string {
  const n = typeof value === "number" ? value : Number(value);
  if (value === undefined || value === null || value === "" || !Number.isFinite(n)) return "";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function num(value: unknown): string {
  const n = typeof value === "number" ? value : Number(value);
  if (value === undefined || value === null || value === "" || !Number.isFinite(n)) return "";
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function kv(items: Array<[string, unknown, boolean?]>): SchemaNode {
  const list: KVItem[] = [];
  for (const [key, value, copyable] of items) {
    const text = typeof value === "boolean" ? (value ? "Yes" : "No") : str(value);
    if (text === "") continue;
    list.push({ key, value: text, ...(copyable ? { copyable: true } : {}) });
  }
  return { kind: "key-value-list", items: list };
}

function section(title: string, children: SchemaNode[]): SectionNode {
  return { kind: "section", title, children };
}

function muted(content: string): SchemaNode {
  return { kind: "text", variant: "muted", content };
}

function openLink(label: string, url: string): ActionNode {
  return { kind: "action", label, action: { type: "open-url", url } };
}

function parseJson<T>(raw: string | undefined): T | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

/** Where the owner's settings live in the GitHub web UI. */
export function ownerUrls(ctx: RenderContext): {
  billing: string;
  budgets: string;
  copilot: string;
  runners: string;
  costCenters: string;
} {
  const slug = encodeURIComponent(ctx.owner.slug);
  if (ctx.owner.kind === "org") {
    const base = `${ctx.host.webUrl}/organizations/${slug}/settings`;
    return {
      billing: `${base}/billing`,
      budgets: `${base}/billing/budgets`,
      copilot: `${base}/copilot/seat_management`,
      runners: `${base}/actions/runners`,
      costCenters: `${base}/billing`,
    };
  }
  const base = `${ctx.host.webUrl}/enterprises/${slug}`;
  return {
    billing: `${base}/billing`,
    budgets: `${base}/billing/budgets`,
    copilot: `${base}/settings/copilot`,
    runners: `${base}/settings/actions/runners`,
    costCenters: `${base}/billing/cost_centers`,
  };
}

function renderBillingAccount(r: ResourceInstance, ctx: RenderContext): DetailViewSchema {
  const f = r.fields;
  const summary = parseJson<SummaryItem[]>(r.resolvedOutputs[SUMMARY_KEY]);
  const premium = parseJson<SummaryItem[]>(r.resolvedOutputs[PREMIUM_KEY]);
  const credits = parseJson<SummaryItem[]>(r.resolvedOutputs[AI_CREDIT_KEY]);
  const seats = parseJson<SeatBreakdown>(r.resolvedOutputs[SEAT_BREAKDOWN_KEY]);
  const urls = ownerUrls(ctx);
  const sections: SectionNode[] = [
    section(f["kind"] === "Enterprise" ? "Enterprise" : "Organization", [
      kv([
        ["Name", f["name"] ?? r.displayName],
        ["Slug", f["slug"], true],
        ["Plan", f["plan"]],
        ["Host", ctx.host.host],
      ]),
    ]),
    section("Spend this month", [
      kv([
        ["Net", usd(f["monthToDate"])],
        ["Gross", usd(f["grossToDate"])],
        ["Discounts and included usage", usd(f["discountToDate"])],
      ]),
      ...(summary && summary.length > 0
        ? [
            {
              kind: "table" as const,
              columns: [
                { key: "product", label: "Product" },
                { key: "sku", label: "SKU", width: "wide" as const },
                { key: "quantity", label: "Quantity" },
                { key: "gross", label: "Gross" },
                { key: "discount", label: "Discount" },
                { key: "net", label: "Net" },
              ],
              rows: [...summary]
                .sort((a, b) => (b.grossAmount ?? 0) - (a.grossAmount ?? 0))
                .map<TableRow>((i) => ({
                  cells: {
                    product: productLabel(i.product, i.sku),
                    sku: skuLabel(i.sku) || str(i.sku),
                    quantity: `${num(i.grossQuantity)} ${str(i.unitType)}`.trim(),
                    gross: usd(i.grossAmount),
                    discount: usd(i.discountAmount),
                    net: usd(i.netAmount),
                  },
                })),
            },
          ]
        : [
            muted(
              "No usage is billed yet this month, or the token cannot read billing usage. Run Check credentials to see which.",
            ),
          ]),
    ]),
  ];
  for (const [title, items, unit] of [
    ["Premium requests by model this month", premium, "requests"],
    ["AI credits by model this month", credits, "credits"],
  ] as const) {
    if (!items || items.length === 0) continue;
    sections.push(
      section(title, [
        {
          kind: "table",
          columns: [
            { key: "model", label: "Model", width: "wide" },
            { key: "quantity", label: `Gross (${unit})` },
            { key: "included", label: `Included (${unit})` },
            { key: "net", label: "Net cost" },
          ],
          rows: [...items]
            .sort((a, b) => (b.grossQuantity ?? 0) - (a.grossQuantity ?? 0))
            .map<TableRow>((i) => ({
              cells: {
                model: str(i.model) || skuLabel(i.sku),
                quantity: num(i.grossQuantity),
                included: num(i.discountQuantity),
                net: usd(i.netAmount),
              },
            })),
        },
      ]),
    );
  }
  if (seats) {
    sections.push(
      section("Copilot seats", [
        kv([
          ["Total", num(seats.total)],
          ["Active this cycle", num(seats.active_this_cycle)],
          ["Inactive this cycle", num(seats.inactive_this_cycle)],
          ["Added this cycle", num(seats.added_this_cycle)],
          ["Pending cancellation", num(seats.pending_cancellation)],
          ["Pending invitation", num(seats.pending_invitation)],
        ]),
      ]),
    );
  }
  if (f["cacheSizeGb"] !== undefined) {
    sections.push(section("Actions cache", [kv([["Total size", `${num(f["cacheSizeGb"])} GB`]])]));
  }
  return withMetricsCapability(
    {
      title: r.displayName,
      subtitle: joinSubtitle(str(f["kind"]), ctx.host.dataResidency ? ctx.host.host : ""),
      status: { kind: "status-dot", status: "healthy", label: str(f["kind"]) || "GitHub" },
      sections,
      headerActions: [openLink("Open billing in GitHub", urls.billing)],
    },
    RESOURCE_TYPES,
    r.resourceTypeId,
    METRICS_WINDOW_MS,
  );
}

function seatStatus(f: ResourceInstance["fields"]): { status: ResourceStatus; label: string } {
  if (f["pendingCancellationDate"]) {
    return { status: "info", label: `Cancels ${str(f["pendingCancellationDate"])}` };
  }
  if (f["idle"] === true) return { status: "degraded", label: "Idle" };
  return { status: "healthy", label: "Active" };
}

function renderCopilotSeat(r: ResourceInstance, ctx: RenderContext): DetailViewSchema {
  const f = r.fields;
  const s = seatStatus(f);
  const viaTeam = str(f["assigningTeam"]);
  const pending = !!f["pendingCancellationDate"];
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Copilot seat", f["planType"] ? `${str(f["planType"])} plan` : ""),
    status: { kind: "status-dot", status: s.status, label: s.label },
    sections: [
      section("Seat", [
        kv([
          ["User", f["login"], true],
          ["Name", f["name"]],
          ["Plan", f["planType"]],
          ["Organization", f["organization"]],
          ["Assigned through team", viaTeam],
          ["Assigned", f["createdAt"]],
          [
            "Seat price",
            f["monthlyPrice"] !== undefined ? `${usd(f["monthlyPrice"])} / month` : "",
          ],
          ["Cancels on", f["pendingCancellationDate"]],
        ]),
      ]),
      section("Activity", [
        kv([
          ["Last activity", f["lastActivityAt"] ?? "Never"],
          ["Editor", f["lastActivityEditor"]],
          ["Last authenticated", f["lastAuthenticatedAt"]],
          ["Days since activity", num(f["idleDays"])],
        ]),
        ...(f["idle"] === true
          ? [
              muted(
                `No Copilot activity for ${SEAT_IDLE_DAYS} days or more. Removing the seat stops the charge from the next billing cycle.`,
              ),
            ]
          : []),
        ...(viaTeam
          ? [
              muted(
                `This seat comes from membership of the ${viaTeam} team. Removing it here only works for seats assigned directly; otherwise remove the user from the team or the team from Copilot.`,
              ),
            ]
          : []),
      ]),
    ],
    headerActions: [
      ...(pending
        ? []
        : [
            {
              kind: "action" as const,
              label: "Remove seat",
              variant: "danger" as const,
              action: {
                type: "plugin-action" as const,
                actionId: "remove-seat",
                confirmMessage: `Remove ${r.displayName}'s Copilot seat? They keep access until the end of the current billing cycle, then lose it, and the seat stops being billed.`,
                successMessage: "Seat set to cancel at the end of the billing cycle.",
                destructive: true,
              },
            },
          ]),
      openLink("Manage seats in GitHub", ownerUrls(ctx).copilot),
    ],
  };
}

function hostedRunnerStatus(status: string): ResourceStatus {
  switch (status) {
    case "Ready":
      return "healthy";
    case "Provisioning":
      return "provisioning";
    case "Stuck":
      return "error";
    case "Shutdown":
    case "Deleting":
      return "unknown";
    default:
      return "info";
  }
}

function renderHostedRunner(r: ResourceInstance, ctx: RenderContext): DetailViewSchema {
  const f = r.fields;
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Larger runner", f["platform"], f["size"]),
    status: {
      kind: "status-dot",
      status: hostedRunnerStatus(str(f["status"])),
      label: str(f["status"]) || "Runner",
    },
    sections: [
      section("Runner", [
        kv([
          ["Name", f["name"]],
          ["Platform", f["platform"]],
          ["Image", f["image"]],
          ["Runner group", f["runnerGroupId"]],
          ["Maximum concurrent jobs", num(f["maximumRunners"])],
          ["Static public IP", f["enableStaticIp"]],
          ["Last active", f["lastActiveOn"]],
        ]),
      ]),
      section("Machine", [
        kv([
          ["Size", f["size"]],
          ["CPU cores", num(f["cpuCores"])],
          ["Memory", f["memoryGb"] !== undefined ? `${num(f["memoryGb"])} GB` : ""],
          ["Storage", f["storageGb"] !== undefined ? `${num(f["storageGb"])} GB` : ""],
        ]),
      ]),
      section("Cost", [
        kv([
          ["Billing SKU", f["sku"] ? `${skuLabel(str(f["sku"]))} (${str(f["sku"])})` : ""],
          ["Price per minute", usd(f["pricePerMinute"])],
          ["SKU spend this month", usd(f["skuMonthToDate"])],
        ]),
        muted(
          "Larger runners bill per minute of job time on their SKU; an idle runner costs nothing. GitHub reports spend per SKU, not per runner, so runners of the same size share this figure.",
        ),
      ]),
    ],
    headerActions: [openLink("Open runners in GitHub", ownerUrls(ctx).runners)],
  };
}

function renderRunner(r: ResourceInstance, ctx: RenderContext): DetailViewSchema {
  const f = r.fields;
  const online = f["status"] === "online";
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Self-hosted runner", f["os"]),
    status: {
      kind: "status-dot",
      status: online ? (f["busy"] === true ? "info" : "healthy") : "error",
      label: online ? (f["busy"] === true ? "Busy" : "Idle") : "Offline",
    },
    sections: [
      section("Runner", [
        kv([
          ["Name", f["name"]],
          ["OS", f["os"]],
          ["Status", f["status"]],
          ["Busy", f["busy"]],
          ["Labels", f["labels"]],
          ["Ephemeral", f["ephemeral"]],
          ["Runner group", f["runnerGroupId"]],
          ["Version", f["version"]],
        ]),
      ]),
    ],
    headerActions: [openLink("Open runners in GitHub", ownerUrls(ctx).runners)],
  };
}

function renderActionsCache(r: ResourceInstance, ctx: RenderContext): DetailViewSchema {
  const f = r.fields;
  const caches = parseJson<GhActionsCache[]>(r.resolvedOutputs[CACHES_KEY]);
  const repo = str(f["repository"]);
  const count = Number(f["cacheCount"] ?? 0);
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Actions cache", f["size"]),
    status: { kind: "status-dot", status: "info", label: `${num(count)} caches` },
    sections: [
      section("Usage", [
        kv([
          ["Repository", repo, true],
          ["Active caches", num(count)],
          ["Size", f["size"]],
        ]),
        muted(
          "Each repository gets 10 GB of cache storage before the oldest caches are evicted, unless your organization buys more. Deleting caches frees space at once; workflows rebuild what they need on their next run.",
        ),
      ]),
      ...(caches && caches.length > 0
        ? [
            section("Largest caches", [
              {
                kind: "table" as const,
                columns: [
                  { key: "key", label: "Key", width: "wide" as const, mono: true },
                  { key: "ref", label: "Ref" },
                  { key: "size", label: "Size" },
                  { key: "lastUsed", label: "Last used" },
                  { key: "delete", label: "", width: "narrow" as const },
                ],
                rows: caches.map<TableRow>((c) => ({
                  cells: {
                    key: str(c.key),
                    ref: str(c.ref),
                    size: formatBytes(c.size_in_bytes ?? 0),
                    lastUsed: str(c.last_accessed_at),
                    delete: {
                      kind: "action",
                      label: "Delete",
                      variant: "danger",
                      action: {
                        type: "plugin-action",
                        actionId: `delete-cache:${String(c.id ?? "")}`,
                        confirmMessage: `Delete the cache "${str(c.key)}"?`,
                        successMessage: "Cache deleted.",
                        destructive: true,
                      },
                    },
                  },
                })),
              },
            ]),
          ]
        : []),
    ],
    headerActions: [
      ...(count > 0
        ? [
            {
              kind: "action" as const,
              label: "Delete all caches",
              variant: "danger" as const,
              action: {
                type: "plugin-action" as const,
                actionId: "delete-all-caches",
                confirmMessage: `Delete all ${num(count)} Actions caches in ${repo}? Workflows will rebuild them on their next run.`,
                successMessage: "Caches deleted.",
                destructive: true,
              },
            },
          ]
        : []),
      openLink("Open caches in GitHub", `${ctx.host.webUrl}/${repo}/actions/caches`),
    ],
  };
}

function codespaceStatus(state: string): ResourceStatus {
  switch (state) {
    case "Available":
      return "healthy";
    case "Starting":
    case "Provisioning":
    case "Queued":
    case "Created":
    case "Rebuilding":
    case "Updating":
    case "Exporting":
    case "ShuttingDown":
      return "provisioning";
    case "Failed":
    case "Unavailable":
      return "error";
    case "Shutdown":
    case "Archived":
      return "unknown";
    default:
      return "info";
  }
}

function renderCodespace(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const state = str(f["state"]);
  const running = state === "Available" || state === "Starting" || state === "Rebuilding";
  const webUrl = r.resolvedOutputs["webUrl"];
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Codespace", f["repository"]),
    status: { kind: "status-dot", status: codespaceStatus(state), label: state || "Codespace" },
    sections: [
      section("Codespace", [
        kv([
          ["Owner", f["owner"]],
          ["Billed to", f["billableOwner"]],
          ["Repository", f["repository"]],
          ["State", state],
          ["Location", f["location"]],
          ["Dev container", f["devcontainerPath"]],
          ["Created", f["createdAt"]],
          ["Codespace ID", f["codespaceName"], true],
        ]),
      ]),
      section("Machine", [
        kv([
          ["Machine type", f["machine"]],
          ["CPUs", num(f["cpus"])],
          ["Memory", f["memory"]],
          ["Storage", f["storage"]],
        ]),
      ]),
      section("Idle", [
        kv([
          ["Last used", f["lastUsedAt"]],
          ["Days since use", num(f["idleDays"])],
          [
            "Idle timeout",
            f["idleTimeoutMinutes"] !== undefined ? `${num(f["idleTimeoutMinutes"])} minutes` : "",
          ],
          ["Auto-deletes", f["retentionExpiresAt"]],
        ]),
        ...(f["stale"] === true
          ? [
              muted(
                `Not used for ${CODESPACE_STALE_DAYS} days or more. A stopped codespace keeps billing for storage until it is deleted.`,
              ),
            ]
          : []),
      ]),
    ],
    headerActions: [
      ...(running
        ? [
            {
              kind: "action" as const,
              label: "Stop",
              action: {
                type: "plugin-action" as const,
                actionId: "stop",
                confirmMessage: `Stop ${r.displayName}? Unsaved work in open editors may be lost; files on disk are kept.`,
                successMessage: "Codespace stopping.",
              },
            },
          ]
        : []),
      ...(webUrl ? [openLink("Open in GitHub", webUrl)] : []),
    ],
  };
}

function renderBudget(r: ResourceInstance, ctx: RenderContext): DetailViewSchema {
  const f = r.fields;
  const pct = typeof f["percentUsed"] === "number" ? f["percentUsed"] : undefined;
  const status: ResourceStatus =
    pct === undefined ? "info" : pct >= 100 ? "error" : pct >= 80 ? "degraded" : "healthy";
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Budget", f["scope"], f["entity"]),
    status: {
      kind: "status-dot",
      status,
      label: pct !== undefined ? `${num(pct)}% used` : "Budget",
    },
    sections: [
      section("Budget", [
        kv([
          ["Product or SKU", f["product"]],
          ["ID", f["productSku"], true],
          ["Type", f["budgetType"]],
          ["Scope", f["scope"]],
          ["Applies to", f["entity"]],
          ["Amount", usd(f["budgetAmount"])],
          ["Stop usage when exceeded", f["preventFurtherUsage"]],
          ["Expires", f["expiresAt"]],
        ]),
      ]),
      section("This month", [
        kv([
          ["Spent", usd(f["spentThisMonth"])],
          ["Used", pct !== undefined ? `${num(pct)}%` : ""],
        ]),
        muted(
          "Spend is this month's net usage for the budget's product or SKU within its scope, from the usage report. GitHub's own figure can lag by a few hours.",
        ),
      ]),
      section("Alerts", [
        kv([
          ["Send alerts", f["willAlert"]],
          ["Recipients", f["alertRecipients"]],
        ]),
      ]),
    ],
    headerActions: [openLink("Open budgets in GitHub", ownerUrls(ctx).budgets)],
  };
}

function renderCostCenter(r: ResourceInstance, ctx: RenderContext): DetailViewSchema {
  const f = r.fields;
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Cost center", f["state"]),
    status: {
      kind: "status-dot",
      status: f["state"] === "deleted" ? "unknown" : "healthy",
      label: str(f["state"]) || "Cost center",
    },
    sections: [
      section("Cost center", [
        kv([
          ["Name", f["name"]],
          ["State", f["state"]],
          ["Net spend this month", usd(f["monthToDate"])],
          ["Draws from AI credit pool", f["aiCreditPoolEnabled"]],
          ["Azure subscription", f["azureSubscription"], true],
        ]),
      ]),
      section("Members", [
        kv([
          ["Users", f["users"]],
          ["Organizations", f["organizations"]],
          ["Repositories", f["repositories"]],
          ["Enterprise teams", f["enterpriseTeams"]],
        ]),
        muted(
          "Usage by these members is billed to this cost centre. Edit the lists to move members in or out.",
        ),
      ]),
    ],
    headerActions: [openLink("Open cost centers in GitHub", ownerUrls(ctx).costCenters)],
  };
}

export function renderGitHubDetail(r: ResourceInstance, ctx: RenderContext): DetailViewSchema {
  switch (r.resourceTypeId) {
    case "billing-account":
      return renderBillingAccount(r, ctx);
    case "copilot-seat":
      return renderCopilotSeat(r, ctx);
    case "hosted-runner":
      return renderHostedRunner(r, ctx);
    case "runner":
      return renderRunner(r, ctx);
    case "actions-cache":
      return renderActionsCache(r, ctx);
    case "codespace":
      return renderCodespace(r);
    case "budget":
      return renderBudget(r, ctx);
    case "cost-center":
      return renderCostCenter(r, ctx);
    default:
      return {
        title: r.displayName,
        sections: [section("Details", [kv(Object.entries(r.fields).map(([k, v]) => [k, v]))])],
      };
  }
}

function dot(status: ResourceStatus, label: string): StatusDotNode {
  return { kind: "status-dot", status, label };
}

export function renderGitHubSidebar(r: ResourceInstance): SidebarItemSchema {
  const f = r.fields;
  switch (r.resourceTypeId) {
    case "copilot-seat": {
      const s = seatStatus(f);
      return { id: r.id, label: r.displayName, status: dot(s.status, s.label) };
    }
    case "hosted-runner":
      return {
        id: r.id,
        label: r.displayName,
        status: dot(hostedRunnerStatus(str(f["status"])), str(f["status"])),
      };
    case "runner":
      return {
        id: r.id,
        label: r.displayName,
        status: dot(f["status"] === "online" ? "healthy" : "error", str(f["status"])),
      };
    case "codespace":
      return {
        id: r.id,
        label: r.displayName,
        status: dot(codespaceStatus(str(f["state"])), str(f["state"])),
      };
    default:
      return { id: r.id, label: r.displayName };
  }
}
