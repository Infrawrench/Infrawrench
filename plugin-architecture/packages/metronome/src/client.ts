import type {
  ActionNode,
  BusinessMetricSourceOption,
  BusinessMetricSourceRange,
  BusinessMetricSourceResult,
  DetailViewSchema,
  HostServices,
  PluginClient,
  ResourceInstance,
  SectionNode,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { externalIdOf } from "@infrawrench/plugin-base";
import type { MetronomeBillableMetric, MetronomeCustomer, MetronomeInvoice } from "./api.js";
import { MetronomeApi, formatCreditAmount } from "./api.js";
import {
  listBusinessMetricSourceOptions as listSourceOptions,
  runBusinessMetricSource as runSource,
} from "./business-metric.js";

const PLUGIN_ID = "metronome";

function str(value: unknown): string {
  if (value == null) return "";
  return typeof value === "string" ? value : String(value);
}

function joinParts(parts: string[]): string {
  return parts.filter(Boolean).join(" · ");
}

function refreshAction(): ActionNode {
  return { kind: "action", label: "Refresh", action: { type: "refresh-resource" } };
}

function formatDate(iso: string): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? iso : new Date(ms).toISOString().slice(0, 10);
}

/**
 * Metronome plugin client.
 *
 * Deliberately small: the plugin exists mainly to feed business metrics
 * (usage and revenue per day) into unit costs, so it lists the two things an
 * importer picks from, customers and billable metrics, and reads everything
 * else on demand. Nothing here writes to Metronome.
 */
export class MetronomeClient implements PluginClient {
  readonly api: MetronomeApi;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const token = credentials["apiToken"];
    if (!token) throw new Error("Metronome plugin: missing apiToken credential");
    this.api = new MetronomeApi(token, services, credentials["caCert"] ?? "");
  }

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "customer":
        return (await this.api.listCustomers()).map((c) => this.mapCustomer(accountId, c));
      case "billable-metric":
        return (await this.api.listBillableMetrics()).map((m) => this.mapMetric(accountId, m));
      default:
        throw new Error(`Metronome plugin: unknown resource type "${typeId}"`);
    }
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const id = externalIdOf(resourceId);
    if (typeId === "customer") return this.mapCustomer(accountId, await this.api.getCustomer(id));
    if (typeId === "billable-metric") {
      return this.mapMetric(accountId, await this.api.getBillableMetric(id));
    }
    throw new Error(`Metronome plugin: unknown resource type "${typeId}"`);
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    if (
      (typeId === "customer" && outputKey === "customerId") ||
      (typeId === "billable-metric" && outputKey === "metricId")
    ) {
      return externalIdOf(resourceId);
    }
    const resource = await this.getResource(typeId, resourceId, accountId);
    const value = resource.resolvedOutputs[outputKey];
    if (value !== undefined) return value;
    throw new Error(`Metronome plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
  }

  /** Customer detail pulls the ten most recent invoices. */
  async enrichDetail(resource: ResourceInstance): Promise<ResourceInstance> {
    if (resource.resourceTypeId !== "customer") return resource;
    const invoices = await this.api.listRecentInvoices(resource.externalId ?? "");
    return {
      ...resource,
      fields: { ...resource.fields, recentInvoices: JSON.stringify(invoices) },
    };
  }

  listBusinessMetricSourceOptions(
    _accountId: string,
    fieldKey: string,
    params: Record<string, string>,
  ): Promise<BusinessMetricSourceOption[]> {
    return listSourceOptions(this.api, fieldKey, params);
  }

  runBusinessMetricSource(
    _accountId: string,
    params: Record<string, string>,
    range: BusinessMetricSourceRange,
  ): Promise<BusinessMetricSourceResult> {
    return runSource(this.api, params, range);
  }

  private mapCustomer(accountId: string, c: MetronomeCustomer): ResourceInstance {
    const now = new Date().toISOString();
    const aliases = c.ingest_aliases ?? [];
    const custom = Object.entries(c.custom_fields ?? {});
    return {
      id: `${accountId}:customer:${c.id}`,
      pluginId: PLUGIN_ID,
      resourceTypeId: "customer",
      accountId,
      displayName: c.name || aliases[0] || c.id,
      externalId: c.id,
      fields: {
        customerId: c.id,
        name: str(c.name),
        ingestAliases: aliases.join(", "),
        salesforceAccountId: str(c.customer_config?.salesforce_account_id),
        billableStatus: str(c.current_billable_status?.value),
        customFields: custom.map(([k, v]) => `${k}=${v}`).join(", "),
        customFieldsJson: JSON.stringify(c.custom_fields ?? {}),
        createdAt: str(c.created_at),
        updatedAt: str(c.updated_at),
      },
      resolvedOutputs: { customerId: c.id, ...(aliases[0] ? { ingestAlias: aliases[0] } : {}) },
      secretStates: [],
      createdAt: c.created_at || now,
      updatedAt: c.updated_at || now,
    };
  }

  private mapMetric(accountId: string, m: MetronomeBillableMetric): ResourceInstance {
    const now = new Date().toISOString();
    return {
      id: `${accountId}:billable-metric:${m.id}`,
      pluginId: PLUGIN_ID,
      resourceTypeId: "billable-metric",
      accountId,
      displayName: m.name || m.id,
      externalId: m.id,
      fields: {
        metricId: m.id,
        name: str(m.name),
        aggregationType: str(m.aggregation_type).toUpperCase(),
        aggregationKey: str(m.aggregation_key),
        eventTypes: (m.event_type_filter?.in_values ?? []).join(", "),
        excludedEventTypes: (m.event_type_filter?.not_in_values ?? []).join(", "),
        groupKeys: (m.group_keys ?? []).map((g) => g.join(" + ")).join(", "),
        sql: str(m.sql),
        propertyFilters: JSON.stringify(m.property_filters ?? []),
        archived: Boolean(m.archived_at),
      },
      resolvedOutputs: { metricId: m.id },
      secretStates: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    const fields = resource.fields;
    if (resource.resourceTypeId === "billable-metric") {
      return {
        id: resource.id,
        label: resource.displayName,
        status: {
          kind: "status-dot",
          status: fields["archived"] ? "unknown" : "healthy",
          label: str(fields["sql"]) ? "SQL" : str(fields["aggregationType"]) || "metric",
        },
      };
    }
    const status = str(fields["billableStatus"]);
    return {
      id: resource.id,
      label: resource.displayName,
      status: {
        kind: "status-dot",
        status: status === "unbillable" ? "unknown" : "healthy",
        label: status || "customer",
      },
    };
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return resource.resourceTypeId === "billable-metric"
      ? this.renderMetricDetail(resource)
      : this.renderCustomerDetail(resource);
  }

  private renderCustomerDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const status = str(fields["billableStatus"]);
    const sections: SectionNode[] = [
      {
        kind: "section",
        title: "Customer",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Name", value: str(fields["name"]) || resource.displayName },
              { key: "Customer ID", value: str(fields["customerId"]), copyable: true },
              ...(str(fields["ingestAliases"])
                ? [{ key: "Ingest Aliases", value: str(fields["ingestAliases"]), copyable: true }]
                : []),
              ...(str(fields["salesforceAccountId"])
                ? [{ key: "Salesforce Account", value: str(fields["salesforceAccountId"]) }]
                : []),
              ...(status ? [{ key: "Billable Status", value: status }] : []),
              { key: "Created", value: formatDate(str(fields["createdAt"])) || "unknown" },
              { key: "Updated", value: formatDate(str(fields["updatedAt"])) || "unknown" },
            ],
          },
        ],
      },
    ];

    const custom = Object.entries(
      parseJson<Record<string, string>>(fields["customFieldsJson"]) ?? {},
    );
    if (custom.length) {
      sections.push({
        kind: "section",
        title: "Custom Fields",
        children: [
          {
            kind: "table",
            columns: [
              { key: "key", label: "Field" },
              { key: "value", label: "Value", mono: true },
            ],
            rows: custom.map(([key, value]) => ({ cells: { key, value: str(value) } })),
          },
        ],
      });
    }

    const invoices = parseJson<MetronomeInvoice[]>(fields["recentInvoices"]);
    if (invoices) {
      sections.push({
        kind: "section",
        title: "Recent Invoices",
        children: invoices.length
          ? [
              {
                kind: "table",
                columns: [
                  { key: "period", label: "Period" },
                  { key: "type", label: "Type" },
                  { key: "status", label: "Status" },
                  { key: "total", label: "Total" },
                ],
                rows: invoices.map((inv) => ({
                  cells: {
                    period: [
                      formatDate(str(inv.start_timestamp)),
                      formatDate(str(inv.end_timestamp)),
                    ]
                      .filter(Boolean)
                      .join(" to "),
                    type: str(inv.type),
                    status: str(inv.status),
                    total: formatCreditAmount(inv.total, inv.credit_type?.name),
                  },
                })),
              },
            ]
          : [{ kind: "text", variant: "muted", content: "This customer has no invoices yet." }],
      });
    }

    return {
      title: resource.displayName,
      subtitle: joinParts([
        "Metronome customer",
        str(fields["ingestAliases"]).split(", ")[0] ?? "",
      ]),
      status: {
        kind: "status-dot",
        status: status === "unbillable" ? "unknown" : "healthy",
        label: status || "Active",
      },
      sections,
      headerActions: [refreshAction()],
    };
  }

  private renderMetricDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const sql = str(fields["sql"]);
    const aggregation = str(fields["aggregationType"]);
    const sections: SectionNode[] = [
      {
        kind: "section",
        title: "Billable Metric",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Name", value: str(fields["name"]) || resource.displayName },
              { key: "Metric ID", value: str(fields["metricId"]), copyable: true },
              ...(aggregation ? [{ key: "Aggregation", value: aggregation }] : []),
              ...(str(fields["aggregationKey"])
                ? [{ key: "Aggregation Key", value: str(fields["aggregationKey"]) }]
                : []),
              ...(str(fields["eventTypes"])
                ? [{ key: "Event Types", value: str(fields["eventTypes"]) }]
                : []),
              ...(str(fields["excludedEventTypes"])
                ? [{ key: "Excluded Event Types", value: str(fields["excludedEventTypes"]) }]
                : []),
              ...(str(fields["groupKeys"])
                ? [{ key: "Group Keys", value: str(fields["groupKeys"]) }]
                : []),
            ],
          },
        ],
      },
    ];

    const filters = parseJson<MetronomeBillableMetric["property_filters"]>(
      fields["propertyFilters"],
    );
    if (filters && filters.length) {
      sections.push({
        kind: "section",
        title: "Property Filters",
        children: [
          {
            kind: "table",
            columns: [
              { key: "name", label: "Property", mono: true },
              { key: "exists", label: "Must Exist" },
              { key: "in", label: "Allowed Values" },
              { key: "notIn", label: "Excluded Values" },
            ],
            rows: filters.map((p) => ({
              cells: {
                name: p.name,
                exists: p.exists === undefined ? "optional" : p.exists ? "yes" : "no",
                in: (p.in_values ?? []).join(", "),
                notIn: (p.not_in_values ?? []).join(", "),
              },
            })),
          },
        ],
      });
    }

    if (sql) {
      sections.push({
        kind: "section",
        title: "SQL",
        children: [{ kind: "text", variant: "mono", content: sql, copyable: true }],
      });
    }

    return {
      title: resource.displayName,
      subtitle: joinParts(["Metronome billable metric", sql ? "SQL" : aggregation]),
      status: {
        kind: "status-dot",
        status: fields["archived"] ? "unknown" : "healthy",
        label: fields["archived"] ? "Archived" : "Active",
      },
      sections,
      headerActions: [refreshAction()],
    };
  }
}

function parseJson<T>(raw: unknown): T | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
