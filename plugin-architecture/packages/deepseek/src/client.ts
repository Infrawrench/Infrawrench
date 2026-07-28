import type {
  PluginClient,
  HostServices,
  ResourceInstance,
  DetailViewSchema,
  SidebarItemSchema,
  SectionNode,
  ActionNode,
  DashboardStat,
} from "@infrawrench/plugin-base";
import { jsonRestFetch } from "@infrawrench/plugin-base";

/**
 * DeepSeek's canonical base URL. The documented paths carry **no `/v1`
 * segment** — `/chat/completions`, `/models`, `/user/balance`. `/v1` is
 * accepted purely so the OpenAI SDK can be pointed at DeepSeek unchanged; it
 * is not the canonical form and we don't use it.
 * https://api-docs.deepseek.com/
 */
const BASE_URL = "https://api.deepseek.com";

/**
 * DeepSeek does not rate-limit by requests or tokens per minute. It caps
 * *concurrent in-flight requests* per model, and returns HTTP 429 when the cap
 * is exceeded. These numbers are published in the docs, not returned by
 * `GET /models`, so they're filled in here.
 * https://api-docs.deepseek.com/quick_start/rate_limit
 */
const CONCURRENCY_LIMITS: Record<string, number> = {
  "deepseek-v4-flash": 2500,
  "deepseek-v4-pro": 500,
};

interface DeepSeekModel {
  id: string;
  object?: string;
  owned_by?: string;
}

interface DeepSeekModelList {
  object?: string;
  data?: DeepSeekModel[];
}

/** ⚠️ Every amount here is a decimal **string**, not a number. */
interface DeepSeekBalanceInfo {
  currency?: string;
  total_balance?: string;
  granted_balance?: string;
  topped_up_balance?: string;
}

interface DeepSeekBalance {
  is_available?: boolean;
  balance_infos?: DeepSeekBalanceInfo[];
}

function str(value: unknown): string {
  if (value == null) return "";
  return typeof value === "string" ? value : String(value);
}

/** Parse one of DeepSeek's string-encoded money values. */
function money(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function formatMoney(amount: number, currency: string): string {
  return `${amount.toFixed(2)} ${currency || ""}`.trim();
}

function externalIdOf(resourceId: string): string {
  return resourceId.split(":").slice(2).join(":");
}

/**
 * DeepSeek plugin client.
 *
 * This is deliberately small because DeepSeek's REST surface is deliberately
 * small: two GET endpoints, one API key, no admin plane. There is no key
 * management API, no usage or cost API, and no speech API — so this plugin
 * does not pretend otherwise. Everything it shows comes from `GET /models` and
 * `GET /user/balance`.
 */
export class DeepSeekClient implements PluginClient {
  private readonly apiKey: string;
  private readonly caCert: string;
  private readonly services: HostServices | undefined;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const apiKey = credentials["apiKey"];
    if (!apiKey) throw new Error("DeepSeek plugin: missing apiKey credential");
    this.apiKey = apiKey;
    this.caCert = credentials["caCert"] ?? "";
    this.services = services;
  }

  private async fetch<T>(path: string, init?: RequestInit): Promise<T> {
    return jsonRestFetch<T>({
      vendor: "DeepSeek",
      url: `${BASE_URL}${path}`,
      errorPath: path,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: "application/json",
      },
      ...(init ? { init } : {}),
      ...(this.services?.http ? { http: this.services.http } : {}),
      ...(this.caCert ? { caCert: this.caCert } : {}),
    });
  }

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "model":
        return this.listModels(accountId);
      case "balance":
        return this.listBalances(accountId);
      default:
        throw new Error(`DeepSeek plugin: unknown resource type "${typeId}"`);
    }
  }

  /**
   * GET /models — verified 2026-07-28 against
   * https://api-docs.deepseek.com/api/list-models
   *
   * Note the canonical path has no `/v1`. There is no pagination: the response
   * is a flat `{object:"list", data:[…]}`.
   */
  private async listModels(accountId: string): Promise<ResourceInstance[]> {
    const body = await this.fetch<DeepSeekModelList>("/models");
    const now = new Date().toISOString();

    return (body.data ?? []).map((model) => {
      const limit = CONCURRENCY_LIMITS[model.id];
      return {
        id: `${accountId}:model:${model.id}`,
        pluginId: "deepseek",
        resourceTypeId: "model",
        accountId,
        displayName: model.id,
        externalId: model.id,
        fields: {
          modelId: model.id,
          ownedBy: str(model.owned_by),
          ...(limit !== undefined ? { concurrencyLimit: limit } : {}),
        },
        resolvedOutputs: { modelId: model.id },
        secretStates: [],
        createdAt: now,
        updatedAt: now,
      } satisfies ResourceInstance;
    });
  }

  /**
   * GET /user/balance — verified 2026-07-28 against
   * https://api-docs.deepseek.com/api/get-user-balance
   *
   * Returns one entry per currency (CNY and/or USD). Every amount is a decimal
   * string, so each one goes through `money()` before it is stored as a number
   * field. `is_available` is account-wide and copied onto each row.
   */
  private async listBalances(accountId: string): Promise<ResourceInstance[]> {
    const body = await this.fetch<DeepSeekBalance>("/user/balance");
    const now = new Date().toISOString();
    const isAvailable = body.is_available === true;

    return (body.balance_infos ?? []).map((info) => {
      const currency = str(info.currency) || "USD";
      const total = money(info.total_balance);
      return {
        id: `${accountId}:balance:${currency}`,
        pluginId: "deepseek",
        resourceTypeId: "balance",
        accountId,
        displayName: `${currency} balance`,
        externalId: currency,
        fields: {
          currency,
          totalBalance: total,
          grantedBalance: money(info.granted_balance),
          toppedUpBalance: money(info.topped_up_balance),
          isAvailable,
        },
        resolvedOutputs: {
          currency,
          totalBalance: total.toFixed(2),
          isAvailable: String(isAvailable),
        },
        secretStates: [],
        createdAt: now,
        updatedAt: now,
      } satisfies ResourceInstance;
    });
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const all = await this.listResources(typeId, accountId);
    const found = all.find((r) => r.id === resourceId);
    if (!found) throw new Error(`DeepSeek plugin: resource ${typeId}/${resourceId} not found`);
    return found;
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    if (typeId === "model" && outputKey === "modelId") {
      // Cheap path: the model id *is* the external id.
      return externalIdOf(resourceId);
    }
    const resource = await this.getResource(typeId, resourceId, accountId);
    const value = resource.resolvedOutputs[outputKey];
    if (value !== undefined) return value;
    throw new Error(`DeepSeek plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
  }

  /**
   * The balance is the one genuinely operational number a DeepSeek account
   * has, so it goes on the dashboard card.
   *
   * (`PluginClient.fetchStats` is the SQL/KV/Docker connection-probe hook and
   * is only ever called for those drivers — the generic labelled-stat surface
   * the host renders on cards is this one.)
   */
  async fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    const resource = await this.getResource(resourceTypeId, resourceId, accountId);
    const fields = resource.fields;

    if (resourceTypeId === "balance") {
      const currency = str(fields["currency"]);
      const total = Number(fields["totalBalance"]) || 0;
      return [
        {
          label: "Balance",
          value: formatMoney(total, currency),
          variant: fields["isAvailable"] ? "status-healthy" : "status-error",
        },
        { label: "Granted", value: formatMoney(Number(fields["grantedBalance"]) || 0, currency) },
        {
          label: "Topped up",
          value: formatMoney(Number(fields["toppedUpBalance"]) || 0, currency),
        },
      ];
    }

    if (resourceTypeId === "model") {
      const limit = Number(fields["concurrencyLimit"]) || 0;
      return [
        { label: "Model", value: str(fields["modelId"]) },
        { label: "Concurrency", value: limit ? String(limit) : "see docs" },
      ];
    }

    return [];
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return resource.resourceTypeId === "balance"
      ? this.renderBalanceDetail(resource)
      : this.renderModelDetail(resource);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    const fields = resource.fields;

    if (resource.resourceTypeId === "balance") {
      const available = Boolean(fields["isAvailable"]);
      return {
        id: resource.id,
        label: resource.displayName,
        status: {
          kind: "status-dot",
          status: available ? "healthy" : "error",
          label: formatMoney(Number(fields["totalBalance"]) || 0, str(fields["currency"])),
        },
      };
    }

    return {
      id: resource.id,
      label: resource.displayName,
      status: { kind: "status-dot", status: "healthy", label: str(fields["ownedBy"]) || "model" },
    };
  }

  private renderModelDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const limit = Number(fields["concurrencyLimit"]) || 0;

    const sections: SectionNode[] = [
      {
        kind: "section",
        title: "Model",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Model ID", value: str(fields["modelId"]), copyable: true },
              { key: "Owned By", value: str(fields["ownedBy"]) || "deepseek" },
              {
                key: "Concurrency Limit",
                value: limit ? `${limit} concurrent requests` : "not published for this model",
              },
            ],
          },
          {
            kind: "text",
            variant: "muted",
            content:
              "DeepSeek does not publish an RPM or TPM rate limit. A request occupies one concurrent slot from the moment it is sent until the response completes; exceeding the cap returns HTTP 429. Capacity increases are free to request.",
          },
          {
            kind: "text",
            variant: "muted",
            content:
              "Call this model at https://api.deepseek.com/chat/completions — the canonical paths have no /v1 segment. A /v1 prefix exists only so the OpenAI SDK works unchanged, and there is an Anthropic-compatible alias at https://api.deepseek.com/anthropic.",
          },
        ],
      },
    ];

    return {
      title: resource.displayName,
      subtitle: "DeepSeek model",
      status: { kind: "status-dot", status: "healthy", label: "Available" },
      sections,
      headerActions: [refreshAction()],
    };
  }

  private renderBalanceDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const currency = str(fields["currency"]);
    const available = Boolean(fields["isAvailable"]);

    const sections: SectionNode[] = [
      {
        kind: "section",
        title: "Balance",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Currency", value: currency },
              {
                key: "Total Balance",
                value: formatMoney(Number(fields["totalBalance"]) || 0, currency),
              },
              {
                key: "Granted Balance",
                value: formatMoney(Number(fields["grantedBalance"]) || 0, currency),
              },
              {
                key: "Topped-up Balance",
                value: formatMoney(Number(fields["toppedUpBalance"]) || 0, currency),
              },
              {
                key: "Sufficient for API Calls",
                value: available ? "Yes" : "No — top up to keep calling the API",
              },
            ],
          },
        ],
      },
      {
        kind: "section",
        title: "Billing",
        children: [
          {
            kind: "text",
            variant: "muted",
            content:
              "This snapshot is DeepSeek's entire billing surface: there is no usage time series, no invoice list, and no per-day spend endpoint, so Infrawrench cannot chart DeepSeek costs. Top up and review invoices in the DeepSeek platform console.",
          },
          {
            kind: "link",
            label: "Open DeepSeek billing console",
            url: "https://platform.deepseek.com/usage",
          },
        ],
      },
    ];

    return {
      title: resource.displayName,
      subtitle: `${formatMoney(Number(fields["totalBalance"]) || 0, currency)} remaining`,
      status: {
        kind: "status-dot",
        status: available ? "healthy" : "error",
        label: available ? "Available" : "Insufficient",
      },
      sections,
      headerActions: [refreshAction()],
    };
  }
}

function refreshAction(): ActionNode {
  return { kind: "action", label: "Refresh", action: { type: "refresh-resource" } };
}
