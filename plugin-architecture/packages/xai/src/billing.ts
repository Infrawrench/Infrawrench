import type {
  CreditBalance,
  DetailViewSchema,
  KVItem,
  ResourceInstance,
  TableRow,
} from "@infrawrench/plugin-base";

/**
 * Billing shapes and renderers for the management host's billing group.
 *
 * Every amount xAI's billing API returns is **USD cents as a string**, either
 * bare (`"2500"`) or wrapped as `{ "val": "2500" }` depending on the field, so
 * everything goes through {@link usd} before it is stored.
 *
 * Docs: https://docs.x.ai/developers/rest-api-reference/management/billing
 */

const DASH = "—";

/** `{ val: "<cents>" }`, xAI's "Representation of USD Cents". */
export interface XaiCents {
  val?: string;
}

export interface XaiInvoiceLine {
  clusterName?: string;
  description?: string;
  unitType?: string;
  /** 1/1,000,000 of a USD cent per unit. */
  unitPrice?: string;
  numUnits?: string;
  /** USD cents. */
  amount?: string;
}

export interface XaiInvoice {
  teamId?: string;
  invoiceId?: string;
  invoiceNumber?: string;
  createTime?: string;
  invoiceStatus?: string;
  firstDesiredNextCycleTs?: string;
  chargerAttempts?: Array<{ ticket?: number; successful?: boolean; paymentMethodId?: string }>;
  lines?: XaiInvoiceLine[];
  subtotal?: string;
  tax?: string;
  total?: string;
  monthly?: { billingCycle?: { year?: number; month?: number } };
  prepaid?: Record<string, unknown>;
}

export interface XaiSpendingLimits {
  hardSlOverride?: XaiCents;
  hardSlAuto?: XaiCents;
  effectiveHardSl?: XaiCents;
  softSl?: XaiCents;
  effectiveSl?: XaiCents;
}

export interface XaiInvoicePreview {
  coreInvoice?: {
    lines?: XaiInvoiceLine[];
    amountBeforeVat?: string;
    vatCost?: string;
    amountAfterVat?: string;
    prepaidCredits?: XaiCents;
    prepaidCreditsUsed?: XaiCents;
  };
  effectiveSpendingLimit?: string;
  defaultCredits?: string;
  billingCycle?: { year?: number; month?: number };
}

/** USD cents (bare string, number, or `{val}`) to dollars. */
export function usd(value: string | number | XaiCents | null | undefined): number {
  const raw = typeof value === "object" && value !== null ? value.val : value;
  const cents = Number(raw);
  return Number.isFinite(cents) ? cents / 100 : 0;
}

export function formatUsd(amount: number): string {
  const sign = amount < 0 ? "-" : "";
  return `${sign}$${Math.abs(amount).toFixed(2)}`;
}

function cycleLabel(cycle: { year?: number; month?: number } | undefined): string {
  if (!cycle?.year || !cycle.month) return "";
  return `${cycle.year}-${String(cycle.month).padStart(2, "0")}`;
}

/** The 1/1,000,000-cent unit price as dollars per million units. */
function unitPricePerMillion(unitPrice: string | undefined): string {
  const n = Number(unitPrice);
  if (!Number.isFinite(n) || n === 0) return DASH;
  // n millionths of a cent per unit = n / 1e8 dollars per unit = n / 100 per million.
  return `$${(n / 100).toFixed(4)} / 1M`;
}

/**
 * Remaining prepaid credit for the current billing period.
 *
 * Read off the invoice preview rather than the prepaid ledger: the ledger's
 * `total` sums purchases (negative) and spends (positive, booked against a
 * billing period), so mid-period it does not yet reflect this month's usage,
 * while the preview carries both the credit available to the period and how
 * much of it is already used. Credit is negative on the wire (the API books a
 * purchase as money owed back to the team), so both figures are taken as
 * magnitudes. A team with no prepaid credit at all is a postpaid team with no
 * pot, which is reported as no balance rather than a zero one.
 */
export function prepaidBalances(preview: XaiInvoicePreview): CreditBalance[] {
  const credits = Math.abs(usd(preview.coreInvoice?.prepaidCredits));
  if (credits === 0) return [];
  const used = Math.abs(usd(preview.coreInvoice?.prepaidCreditsUsed));
  return [
    {
      key: "prepaid",
      label: "Prepaid credits",
      remaining: Math.max(0, credits - used),
      currency: "USD",
      granted: credits,
    },
  ];
}

export function mapInvoice(accountId: string, now: string, inv: XaiInvoice): ResourceInstance {
  const id = inv.invoiceId ?? "";
  const cycle = cycleLabel(inv.monthly?.billingCycle);
  const lines = inv.lines ?? [];
  return {
    id: `${accountId}:invoice:${id}`,
    pluginId: "xai",
    resourceTypeId: "invoice",
    accountId,
    displayName: inv.invoiceNumber || id,
    externalId: id,
    fields: {
      invoiceId: id,
      invoiceNumber: inv.invoiceNumber ?? "",
      status: inv.invoiceStatus ?? "",
      // Monthly invoices carry their cycle; prepaid top-up invoices carry a
      // `prepaid` block instead.
      billingCycle: cycle || (inv.prepaid ? "prepaid top-up" : ""),
      createTime: inv.createTime ?? "",
      chargeTime: inv.firstDesiredNextCycleTs ?? "",
      subtotal: usd(inv.subtotal),
      tax: usd(inv.tax),
      total: usd(inv.total),
      lineCount: lines.length,
      chargeAttempts: (inv.chargerAttempts ?? []).length,
    },
    resolvedOutputs: {
      invoiceNumber: inv.invoiceNumber ?? "",
      total: usd(inv.total).toFixed(2),
      // The renderer is synchronous: keep the line items with the row.
      __lines__: JSON.stringify(lines),
    },
    secretStates: [],
    createdAt: inv.createTime || now,
    updatedAt: now,
  };
}

export function mapSpendingLimit(
  accountId: string,
  now: string,
  limits: XaiSpendingLimits,
  preview: XaiInvoicePreview | undefined,
): ResourceInstance {
  const core = preview?.coreInvoice;
  const cycle = cycleLabel(preview?.billingCycle);
  return {
    id: `${accountId}:spending-limit:team`,
    pluginId: "xai",
    resourceTypeId: "spending-limit",
    accountId,
    displayName: "Monthly spending limit",
    externalId: "team",
    fields: {
      softLimit: usd(limits.softSl),
      effectiveLimit: usd(limits.effectiveSl),
      hardLimit: usd(limits.effectiveHardSl ?? limits.hardSlAuto),
      hardLimitOverride: usd(limits.hardSlOverride),
      billingCycle: cycle,
      currentSpend: usd(core?.amountAfterVat),
      prepaidCredits: Math.abs(usd(core?.prepaidCredits)),
      prepaidCreditsUsed: Math.abs(usd(core?.prepaidCreditsUsed)),
    },
    resolvedOutputs: {
      softLimit: usd(limits.softSl).toFixed(2),
      currentSpend: usd(core?.amountAfterVat).toFixed(2),
      __previewLines__: JSON.stringify(core?.lines ?? []),
    },
    secretStates: [],
    createdAt: now,
    updatedAt: now,
  };
}

function lineRows(raw: string | undefined): TableRow[] {
  let lines: XaiInvoiceLine[] = [];
  try {
    const parsed = JSON.parse(raw ?? "[]") as unknown;
    if (Array.isArray(parsed)) lines = parsed as XaiInvoiceLine[];
  } catch {
    lines = [];
  }
  return lines.map((line) => ({
    cells: {
      description: line.description || DASH,
      unitType: line.unitType || DASH,
      units: Number(line.numUnits ?? 0).toLocaleString("en-US"),
      unitPrice: unitPricePerMillion(line.unitPrice),
      amount: formatUsd(usd(line.amount)),
      cluster: line.clusterName || DASH,
    },
  }));
}

const LINE_COLUMNS = [
  { key: "description", label: "Description" },
  { key: "unitType", label: "Unit" },
  { key: "units", label: "Units", mono: true },
  { key: "unitPrice", label: "Unit Price", mono: true },
  { key: "amount", label: "Amount", mono: true },
  { key: "cluster", label: "Cluster" },
];

export function invoiceStatusDot(status: string): "healthy" | "degraded" | "error" | "info" {
  switch (status) {
    case "PAID":
      return "healthy";
    case "PENDING":
      return "degraded";
    case "FAILED":
      return "error";
    default:
      return "info";
  }
}

export function renderInvoiceDetail(resource: ResourceInstance): DetailViewSchema {
  const f = resource.fields;
  const status = String(f["status"] ?? "");
  const rows = lineRows(resource.resolvedOutputs["__lines__"]);
  const summary: KVItem[] = [
    { key: "Invoice Number", value: String(f["invoiceNumber"] || DASH), copyable: true },
    { key: "Invoice ID", value: String(f["invoiceId"] || DASH) },
    { key: "Status", value: status || DASH },
    { key: "Billing Cycle", value: String(f["billingCycle"] || DASH) },
    { key: "Created", value: String(f["createTime"] || DASH) },
    { key: "Charge Due", value: String(f["chargeTime"] || DASH) },
    { key: "Subtotal", value: formatUsd(Number(f["subtotal"] ?? 0)) },
    { key: "Tax", value: formatUsd(Number(f["tax"] ?? 0)) },
    { key: "Total", value: formatUsd(Number(f["total"] ?? 0)) },
    { key: "Charge Attempts", value: String(f["chargeAttempts"] ?? 0) },
  ];
  return {
    title: resource.displayName,
    subtitle: `xAI Invoice · ${formatUsd(Number(f["total"] ?? 0))}`,
    status: {
      kind: "status-dot",
      status: invoiceStatusDot(status),
      ...(status ? { label: status } : {}),
    },
    sections: [
      { kind: "section", title: "Invoice", children: [{ kind: "key-value-list", items: summary }] },
      {
        kind: "section",
        title: "Line Items",
        children: [
          rows.length > 0
            ? { kind: "table", emphasizeFirstColumn: true, columns: LINE_COLUMNS, rows }
            : { kind: "text", variant: "muted", content: "This invoice has no line items." },
        ],
      },
    ],
    headerActions: [
      { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
      {
        kind: "action",
        label: "Open billing in console",
        action: { type: "open-url", url: "https://console.x.ai/team/default/billing" },
      },
    ],
  };
}

export function renderSpendingLimitDetail(resource: ResourceInstance): DetailViewSchema {
  const f = resource.fields;
  const soft = Number(f["softLimit"] ?? 0);
  const spend = Number(f["currentSpend"] ?? 0);
  const effective = Number(f["effectiveLimit"] ?? 0);
  const ceiling = effective || soft;
  const nearLimit = ceiling > 0 && spend >= ceiling * 0.9;
  const rows = lineRows(resource.resolvedOutputs["__previewLines__"]);
  const override = Number(f["hardLimitOverride"] ?? 0);

  return {
    title: resource.displayName,
    subtitle: `xAI Billing · ${String(f["billingCycle"] || "current period")}`,
    status: {
      kind: "status-dot",
      status: nearLimit ? "degraded" : "healthy",
      label: ceiling > 0 ? `${formatUsd(spend)} of ${formatUsd(ceiling)}` : formatUsd(spend),
    },
    sections: [
      {
        kind: "section",
        title: "Limits",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Monthly Spending Limit", value: formatUsd(soft) },
              { key: "Effective Limit", value: formatUsd(effective) },
              { key: "Hard Limit", value: formatUsd(Number(f["hardLimit"] ?? 0)) },
              ...(override > 0 ? [{ key: "Hard Limit Override", value: formatUsd(override) }] : []),
            ],
          },
          {
            kind: "text",
            variant: "muted",
            content:
              "Prepaid credit is always used first. Once it runs out, postpaid usage continues until this month's spend reaches the limit, and then the API stops answering. Set the limit to 0 to use prepaid credit only. xAI sets the hard limit itself.",
          },
        ],
      },
      {
        kind: "section",
        title: "Current Period",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Billing Cycle", value: String(f["billingCycle"] || DASH) },
              { key: "Running Total (incl. VAT)", value: formatUsd(spend) },
              { key: "Prepaid Credits", value: formatUsd(Number(f["prepaidCredits"] ?? 0)) },
              {
                key: "Prepaid Credits Used",
                value: formatUsd(Number(f["prepaidCreditsUsed"] ?? 0)),
              },
            ],
          },
          rows.length > 0
            ? { kind: "table", emphasizeFirstColumn: true, columns: LINE_COLUMNS, rows }
            : { kind: "text", variant: "muted", content: "No usage billed yet this period." },
        ],
      },
    ],
    headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
  };
}
