import type {
  ActionNode,
  CreateFieldConfig,
  DetailViewSchema,
  KVItem,
  ResourceInstance,
  ResourceStatus,
  SchemaNode,
  SectionNode,
  SidebarItemSchema,
  TableRow,
} from "@infrawrench/plugin-base";
import { formatBytes, joinSubtitle, withMetricsCapability } from "@infrawrench/plugin-base";
import type { FastlyBillingSummary } from "./cost-data.js";
import { DEFAULT_METRICS_WINDOW_MS } from "./metrics.js";
import type { StatsTotals } from "./metrics.js";
import { SERVICE_PRODUCTS } from "./products.js";
import { RESOURCE_TYPES } from "./resource-types.js";

/** Keys under which `enrichDetail` stashes data the synchronous renderer needs. */
export const BILLING_KEY = "__billing__";
export const TOTALS_KEY = "__totals24h__";
export const REALTIME_KEY = "__realtime__";
export const VERSIONS_KEY = "__versions__";
export const STORE_SERVICES_KEY = "__storeServices__";

const MANAGE = "https://manage.fastly.com";

const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));

function money(value: unknown, currency = "USD"): string {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return "";
  try {
    return n.toLocaleString("en-US", { style: "currency", currency });
  } catch {
    return `${n.toFixed(2)} ${currency}`;
  }
}

function count(n: number): string {
  return Math.round(n).toLocaleString("en-US");
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

function parseJson<T>(raw: string | undefined): T | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function openUrl(label: string, url: string): ActionNode {
  return { kind: "action", label, variant: "ghost", action: { type: "open-url", url } };
}

const SOFT_PURGE_FIELD: CreateFieldConfig = {
  key: "soft",
  label: "Purge type",
  kind: "select",
  required: true,
  defaultValue: "hard",
  options: [
    { id: "hard", label: "Instant purge (remove from cache)" },
    { id: "soft", label: "Soft purge (mark stale, serve while revalidating)" },
  ],
};

export function purgeUrlAction(defaultHost: string): ActionNode {
  return {
    kind: "action",
    label: "Purge URL…",
    action: {
      type: "prompt-nosql-command",
      command: "purge-url",
      title: "Purge a URL",
      description:
        "Removes one URL from Fastly's cache on every POP, whichever service cached it. The next request fetches it from your origin again.",
      fields: [
        {
          key: "url",
          label: "URL",
          kind: "text",
          required: true,
          placeholder: defaultHost
            ? `https://${defaultHost}/path/to/object`
            : "https://www.example.com/path",
        },
        SOFT_PURGE_FIELD,
      ],
      submitLabel: "Purge",
    },
  };
}

function serviceActions(r: ResourceInstance, versions: number[]): ActionNode[] {
  const f = r.fields;
  const firstDomain = str(f["domains"]).split(",")[0]?.trim() ?? "";
  const active = Number(f["activeVersion"] ?? 0);
  const enabled = new Set(
    str(f["products"])
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean),
  );
  const type = str(f["type"]) as "vcl" | "wasm";
  const products = SERVICE_PRODUCTS.filter((p) => !p.serviceTypes || p.serviceTypes.includes(type));
  const actions: ActionNode[] = [
    purgeUrlAction(firstDomain),
    {
      kind: "action",
      label: "Purge surrogate keys…",
      action: {
        type: "prompt-nosql-command",
        command: "purge-keys",
        title: "Purge by surrogate key",
        description:
          "Removes every object tagged with any of these surrogate keys from this service's cache.",
        fields: [
          {
            key: "keys",
            label: "Surrogate keys",
            kind: "string-list",
            required: true,
            description: "One key per row, exactly as your origin sends them in Surrogate-Key.",
          },
          SOFT_PURGE_FIELD,
        ],
        submitLabel: "Purge",
      },
    },
    {
      kind: "action",
      label: "Purge everything",
      variant: "danger",
      action: {
        type: "plugin-action",
        actionId: "purge-all",
        destructive: true,
        confirmMessage: `Purge everything from ${r.displayName}? Every cached object is removed at once, so all traffic goes to your origin until the cache refills.`,
        successMessage: "Everything was purged from this service's cache.",
      },
    },
  ];
  if (versions.length > 0) {
    actions.push({
      kind: "action",
      label: "Activate version…",
      action: {
        type: "prompt-nosql-command",
        command: "activate-version",
        title: "Activate a version",
        description:
          "The version you pick starts serving traffic within seconds and the current active version is deactivated.",
        fields: [
          {
            key: "version",
            label: "Version",
            kind: "select",
            required: true,
            defaultValue: String(versions.find((v) => v !== active) ?? versions[0]),
            options: versions.map((v) => ({
              id: String(v),
              label: v === active ? `Version ${v} (active)` : `Version ${v}`,
            })),
          },
        ],
        submitLabel: "Activate",
      },
    });
  }
  if (active > 0) {
    actions.push({
      kind: "action",
      label: "Clone active version",
      action: {
        type: "plugin-action",
        actionId: "clone-active",
        successMessage: "A new draft version was created from the active version.",
      },
    });
  }
  actions.push({
    kind: "action",
    label: "Products…",
    action: {
      type: "prompt-nosql-command",
      command: "set-product",
      title: "Turn a product on or off",
      description:
        "Products are billed separately once enabled. Enabled now: " +
        (enabled.size > 0 ? [...enabled].join(", ") : "none") +
        ".",
      fields: [
        {
          key: "product",
          label: "Product",
          kind: "select",
          required: true,
          defaultValue: products[0]?.id ?? "",
          options: products.map((p) => ({
            id: p.id,
            label: enabled.has(p.label) ? `${p.label} (enabled)` : p.label,
          })),
        },
        {
          key: "state",
          label: "Change",
          kind: "select",
          required: true,
          defaultValue: "enable",
          options: [
            { id: "enable", label: "Enable" },
            { id: "disable", label: "Disable" },
          ],
        },
      ],
      submitLabel: "Apply",
    },
  });
  if (active > 0) {
    actions.push({
      kind: "action",
      label: "Deactivate",
      variant: "danger",
      action: {
        type: "plugin-action",
        actionId: "deactivate",
        destructive: true,
        confirmMessage: `Deactivate version ${active} of ${r.displayName}? The service stops serving traffic for its domains until a version is activated again.`,
        successMessage: "The active version was deactivated.",
      },
    });
  }
  actions.push(
    openUrl(
      "Open in Fastly",
      `${MANAGE}/configure/services/${encodeURIComponent(r.externalId ?? "")}`,
    ),
  );
  return actions;
}

interface Realtime {
  seconds: number;
  requestsPerSecond: number;
  bytesPerSecond: number;
  hitRatio?: number;
  errorsPerSecond: number;
  status5xxPerSecond: number;
}

function trafficSection(title: string, totals: StatsTotals | undefined): SectionNode | undefined {
  if (!totals) return undefined;
  return section(title, [
    kv([
      ["Requests", count(totals.requests)],
      ["Bandwidth", formatBytes(totals.bandwidth)],
      ["Cache hit ratio", totals.hitRatio === undefined ? "" : `${totals.hitRatio.toFixed(1)}%`],
      ["4xx responses", count(totals.status4xx)],
      ["5xx responses", count(totals.status5xx)],
      ["Errors", count(totals.errors)],
    ]),
  ]);
}

function renderService(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const versions = parseJson<number[]>(r.resolvedOutputs[VERSIONS_KEY]) ?? [];
  const totals = parseJson<StatsTotals>(r.resolvedOutputs[TOTALS_KEY]);
  const live = parseJson<Realtime>(r.resolvedOutputs[REALTIME_KEY]);
  const isCompute = str(f["type"]) === "wasm";
  const hasActive = Number(f["activeVersion"] ?? 0) > 0;
  const sections: SectionNode[] = [
    section("Service", [
      kv([
        ["Name", f["name"]],
        ["Type", isCompute ? "Compute" : "Delivery (VCL)"],
        ["Service ID", f["serviceId"], true],
        ["Active version", hasActive ? f["activeVersion"] : "None"],
        ["Latest version", f["latestVersion"]],
        ["Domains", f["domains"]],
        ["Backends", f["backendCount"]],
        ["Products", f["products"]],
        ["Paused", f["paused"] === true ? true : ""],
        ["Comment", f["comment"]],
        ["Created", f["createdAt"]],
        ["Updated", f["updatedAt"]],
      ]),
    ]),
  ];
  if (live) {
    sections.push(
      section(`Live (last ${live.seconds} seconds)`, [
        kv([
          ["Requests per second", live.requestsPerSecond.toFixed(1)],
          ["Delivered per second", formatBytes(live.bytesPerSecond)],
          ["Cache hit ratio", live.hitRatio === undefined ? "" : `${live.hitRatio.toFixed(1)}%`],
          ["5xx per second", live.status5xxPerSecond.toFixed(2)],
          ["Errors per second", live.errorsPerSecond.toFixed(2)],
        ]),
      ]),
    );
  }
  const traffic = trafficSection("Last 24 hours", totals);
  if (traffic) sections.push(traffic);
  if (f["paused"] === true) {
    sections.push(
      section("Paused", [
        muted(
          "Fastly paused this service after a long period without traffic. It resumes when you activate a version.",
        ),
      ]),
    );
  }
  return {
    title: r.displayName,
    subtitle: joinSubtitle(
      isCompute ? "Compute service" : "Delivery service",
      hasActive ? `v${String(f["activeVersion"])}` : "inactive",
    ),
    status: {
      kind: "status-dot",
      status: hasActive ? (f["paused"] === true ? "degraded" : "healthy") : "unknown",
      label: hasActive ? (f["paused"] === true ? "Paused" : "Active") : "No active version",
    },
    sections,
    headerActions: serviceActions(r, versions),
  };
}

function renderAccount(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const billing = parseJson<FastlyBillingSummary>(r.resolvedOutputs[BILLING_KEY]);
  const totals = parseJson<StatsTotals>(r.resolvedOutputs[TOTALS_KEY]);
  const ccy = billing?.currency ?? str(f["currency"]) ?? "USD";
  const sections: SectionNode[] = [
    section("Account", [
      kv([
        ["Name", f["name"]],
        ["Customer ID", f["customerId"], true],
        ["Pricing plan", f["pricingPlan"]],
        ["Services", f["serviceCount"]],
        ["Token owner", f["userLogin"]],
        ["Owner role", f["userRole"]],
        ["Token scope", f["tokenScope"]],
      ]),
    ]),
  ];
  if (billing) {
    sections.push(
      section("This month's bill so far", [
        kv([["Month to date", money(billing.monthToDate, ccy)]]),
        ...(billing.monthToDateByProduct.length > 0
          ? [
              {
                kind: "table" as const,
                columns: [
                  { key: "product", label: "Product", width: "wide" as const },
                  { key: "line", label: "Product line" },
                  { key: "amount", label: "Amount" },
                ],
                rows: billing.monthToDateByProduct.map<TableRow>((p) => ({
                  cells: { product: p.product, line: p.productLine, amount: money(p.amount, ccy) },
                })),
              },
            ]
          : [muted("No charges yet this month.")]),
      ]),
    );
    if (billing.usage.length > 0) {
      sections.push(
        section("Billable usage this month", [
          {
            kind: "table",
            columns: [
              { key: "product", label: "Product", width: "narrow" },
              { key: "name", label: "Usage", width: "wide" },
              { key: "quantity", label: "Quantity" },
            ],
            rows: billing.usage.slice(0, 100).map<TableRow>((u) => ({
              cells: {
                product: u.productId,
                name: u.name,
                quantity: `${u.quantity.toLocaleString("en-US", { maximumFractionDigits: 3 })}${u.unit ? ` ${u.unit}` : ""}`,
              },
            })),
          },
        ]),
      );
    }
    sections.push(
      section("Invoices", [
        billing.invoices.length > 0
          ? {
              kind: "table",
              columns: [
                { key: "month", label: "Month" },
                { key: "total", label: "Total" },
                { key: "posted", label: "Posted" },
                { key: "statement", label: "Statement", mono: true },
              ],
              rows: billing.invoices.map<TableRow>((inv) => ({
                cells: {
                  month: inv.month,
                  total: money(inv.total, inv.currency),
                  posted: inv.postedOn,
                  statement: inv.statementNumber || inv.invoiceId,
                },
              })),
            }
          : muted("No posted invoices in the last 12 months."),
      ]),
    );
  } else {
    sections.push(
      section("Billing", [
        muted(
          "Billing is not readable with this token. Invoices and the month-to-date bill need a token whose owner has the Billing or Superuser role.",
        ),
      ]),
    );
  }
  const traffic = trafficSection("Traffic, last 24 hours (all services)", totals);
  if (traffic) sections.push(traffic);
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Fastly account", f["pricingPlan"]),
    status: { kind: "status-dot", status: "healthy", label: "Connected" },
    sections,
    headerActions: [purgeUrlAction(""), openUrl("Billing in Fastly", `${MANAGE}/account/billing`)],
  };
}

function renderVersion(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const active = f["active"] === true;
  const locked = f["locked"] === true;
  const actions: ActionNode[] = [];
  if (!active) {
    actions.push({
      kind: "action",
      label: "Activate",
      action: {
        type: "plugin-action",
        actionId: "activate",
        confirmMessage: `Activate version ${String(f["number"])}? It starts serving traffic within seconds and replaces the current active version.`,
        successMessage: "Version activated.",
      },
    });
  }
  actions.push(
    {
      kind: "action",
      label: "Clone",
      action: {
        type: "plugin-action",
        actionId: "clone",
        successMessage: "A new draft version was created from this one.",
      },
    },
    {
      kind: "action",
      label: "Validate",
      action: {
        type: "plugin-action",
        actionId: "validate",
        successMessage: "Fastly found no errors in this version.",
      },
    },
  );
  if (!locked) {
    actions.push({
      kind: "action",
      label: "Lock",
      action: {
        type: "plugin-action",
        actionId: "lock",
        confirmMessage:
          "Lock this version? A locked version can no longer be edited; clone it to make changes.",
        successMessage: "Version locked.",
      },
    });
  }
  if (active) {
    actions.push({
      kind: "action",
      label: "Deactivate",
      variant: "danger",
      action: {
        type: "plugin-action",
        actionId: "deactivate",
        destructive: true,
        confirmMessage:
          "Deactivate this version? The service stops serving traffic until a version is activated.",
        successMessage: "Version deactivated.",
      },
    });
  }
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Service version", f["serviceName"]),
    status: {
      kind: "status-dot",
      status: active ? "healthy" : "info",
      label: active ? "Active" : locked ? "Locked" : "Draft",
    },
    sections: [
      section("Version", [
        kv([
          ["Service", f["serviceName"]],
          ["Number", f["number"]],
          ["Active", active],
          ["Locked", locked],
          ["Comment", f["comment"]],
          ["Created", f["createdAt"]],
          ["Updated", f["updatedAt"]],
        ]),
      ]),
    ],
    headerActions: actions,
  };
}

function daysUntil(iso: unknown): number | undefined {
  const t = Date.parse(str(iso));
  if (Number.isNaN(t)) return undefined;
  return Math.floor((t - Date.now()) / 86_400_000);
}

function expiryStatus(iso: unknown): { status: ResourceStatus; label: string } {
  const days = daysUntil(iso);
  if (days === undefined) return { status: "unknown", label: "No expiry reported" };
  if (days < 0) return { status: "error", label: "Expired" };
  if (days <= 14) return { status: "degraded", label: `Expires in ${days} days` };
  return { status: "healthy", label: `Expires in ${days} days` };
}

function simple(
  r: ResourceInstance,
  subtitle: string,
  rows: Array<[string, unknown, boolean?]>,
  extra: Partial<DetailViewSchema> = {},
): DetailViewSchema {
  return {
    title: r.displayName,
    subtitle,
    sections: [section(subtitle, [kv(rows)]), ...(extra.sections ?? [])],
    ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== "sections")),
  };
}

export function renderFastlyDetail(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  let schema: DetailViewSchema;
  switch (r.resourceTypeId) {
    case "account":
      schema = renderAccount(r);
      break;
    case "service":
      schema = renderService(r);
      break;
    case "service-version":
      schema = renderVersion(r);
      break;
    case "domain":
      schema = simple(r, "Domain", [
        ["Domain", f["name"], true],
        ["Service", f["serviceName"]],
        ["Version", f["version"]],
        ["Comment", f["comment"]],
      ]);
      schema.headerActions = [openUrl("Open", `https://${str(f["name"])}`)];
      break;
    case "backend":
      schema = simple(r, "Backend", [
        ["Address", f["address"], true],
        ["Port", f["port"]],
        ["TLS to origin", f["useSsl"]],
        ["Verify certificate", f["sslCheckCert"]],
        ["Certificate hostname", f["sslCertHostname"]],
        ["SNI hostname", f["sslSniHostname"]],
        ["Override host", f["overrideHost"]],
        ["Shield POP", f["shield"]],
        ["Health check", f["healthcheck"]],
        ["Minimum TLS", f["minTlsVersion"]],
        ["Connect timeout (ms)", f["connectTimeout"]],
        ["First byte timeout (ms)", f["firstByteTimeout"]],
        ["Between bytes timeout (ms)", f["betweenBytesTimeout"]],
        ["Max connections", f["maxConn"]],
        ["Weight", f["weight"]],
        ["Auto load balance", f["autoLoadbalance"]],
        ["Service", f["serviceName"]],
        ["Version", f["version"]],
      ]);
      schema.status = {
        kind: "status-dot",
        status: f["useSsl"] === true ? "healthy" : "degraded",
        label: f["useSsl"] === true ? "TLS to origin" : "Plain HTTP to origin",
      };
      break;
    case "logging-endpoint":
      schema = simple(r, "Logging endpoint", [
        ["Destination type", f["kind"]],
        ["Destination", f["destination"], true],
        ["Placement", f["placement"]],
        ["Condition", f["responseCondition"]],
        ["Format version", f["formatVersion"]],
        ["Service", f["serviceName"]],
        ["Version", f["version"]],
      ]);
      if (str(f["format"])) {
        schema.sections.push(
          section("Log format", [
            { kind: "text", variant: "mono", content: str(f["format"]), copyable: true },
          ]),
        );
      }
      break;
    case "dictionary":
      schema = simple(r, "Edge dictionary", [
        ["Name", f["name"]],
        ["Items", f["itemCount"]],
        ["Write-only", f["writeOnly"]],
        ["Service", f["serviceName"]],
        ["Dictionary ID", f["dictionaryId"], true],
        ["Updated", f["updatedAt"]],
      ]);
      schema.kvBrowser = {
        namespaceLabel: str(f["name"]),
        defaultPageSize: 100,
        helpText:
          f["writeOnly"] === true
            ? "This dictionary is write-only: you can add, change and remove items, but Fastly never returns their values."
            : "Changes apply to the dictionary immediately, without activating a new service version.",
      };
      break;
    case "kv-store":
      schema = simple(r, "KV store", [
        ["Name", f["name"]],
        ["Store ID", f["storeId"], true],
        ["Created", f["createdAt"]],
        ["Updated", f["updatedAt"]],
      ]);
      schema.kvBrowser = {
        namespaceLabel: str(f["name"]),
        defaultPageSize: 100,
        helpText: "Writes are visible to Compute services within seconds, on every POP.",
      };
      break;
    case "config-store": {
      const services = parseJson<string[]>(r.resolvedOutputs[STORE_SERVICES_KEY]);
      schema = simple(r, "Config store", [
        ["Name", f["name"]],
        ["Store ID", f["storeId"], true],
        ["Items", f["itemCount"]],
        ["Linked services", services ? services.join(", ") || "None" : f["services"]],
        ["Created", f["createdAt"]],
        ["Updated", f["updatedAt"]],
      ]);
      schema.kvBrowser = {
        namespaceLabel: str(f["name"]),
        defaultPageSize: 100,
        helpText: "Items apply to linked services immediately.",
      };
      break;
    }
    case "secret-store":
      schema = simple(r, "Secret store", [
        ["Name", f["name"]],
        ["Store ID", f["storeId"], true],
        ["Created", f["createdAt"]],
      ]);
      schema.sections.push(
        section("Secrets", [
          muted(
            "Fastly never returns secret values, so they are not listed here. Manage them with the Fastly CLI or console.",
          ),
        ]),
      );
      break;
    case "tls-certificate": {
      const st = expiryStatus(f["notAfter"]);
      schema = simple(r, "TLS certificate", [
        ["Issued to", f["issuedTo"]],
        ["Issuer", f["issuer"]],
        ["Domains", f["domains"]],
        ["Valid from", f["notBefore"]],
        ["Expires", f["notAfter"]],
        ["Serial number", f["serialNumber"], true],
        ["Signature algorithm", f["signatureAlgorithm"]],
        ["Rotation recommended", f["replace"]],
        ["Uploaded", f["createdAt"]],
      ]);
      schema.status = { kind: "status-dot", ...st };
      break;
    }
    case "tls-subscription": {
      const st = expiryStatus(f["notAfter"]);
      const state = str(f["state"]);
      schema = simple(r, "TLS subscription", [
        ["Common name", f["commonName"]],
        ["Domains", f["domains"]],
        ["Certificate authority", f["certificateAuthority"]],
        ["State", state],
        ["Order in progress", f["hasActiveOrder"]],
        ["Certificate expires", f["notAfter"]],
        ["Created", f["createdAt"]],
        ["Updated", f["updatedAt"]],
      ]);
      schema.status =
        state === "failed"
          ? { kind: "status-dot", status: "error", label: "Failed" }
          : state === "pending" || state === "processing"
            ? { kind: "status-dot", status: "provisioning", label: state }
            : { kind: "status-dot", ...st };
      break;
    }
    case "api-token": {
      const current = f["current"] === true;
      schema = simple(r, "API token", [
        ["Name", f["name"]],
        ["Scope", f["scope"]],
        ["Limited to services", f["services"] || "All services"],
        ["Created", f["createdAt"]],
        ["Last used", f["lastUsedAt"]],
        ["Last used from", f["lastIp"]],
        ["Expires", f["expiresAt"] || "Never"],
        ["Used by this account", current],
      ]);
      schema.headerActions = current
        ? []
        : [
            {
              kind: "action",
              label: "Revoke",
              variant: "danger",
              action: {
                type: "plugin-action",
                actionId: "revoke",
                destructive: true,
                confirmMessage: `Revoke the token "${r.displayName}"? Anything using it stops working immediately.`,
                successMessage: "Token revoked.",
              },
            },
          ];
      break;
    }
    default:
      schema = simple(
        r,
        r.resourceTypeId,
        Object.entries(f).map(([k, v]) => [k, v]),
      );
  }
  return withMetricsCapability(schema, RESOURCE_TYPES, r.resourceTypeId, DEFAULT_METRICS_WINDOW_MS);
}

export function renderFastlySidebar(r: ResourceInstance): SidebarItemSchema {
  const f = r.fields;
  let status: ResourceStatus | undefined;
  if (r.resourceTypeId === "service") {
    status = Number(f["activeVersion"] ?? 0) > 0 ? "healthy" : "unknown";
  } else if (r.resourceTypeId === "tls-certificate" || r.resourceTypeId === "tls-subscription") {
    status = expiryStatus(f["notAfter"]).status;
  }
  return {
    id: r.id,
    label: r.displayName || r.externalId || r.id,
    ...(status ? { status: { kind: "status-dot", status } } : {}),
  };
}
