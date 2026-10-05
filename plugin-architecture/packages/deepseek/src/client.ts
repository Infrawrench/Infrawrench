import type {
  PluginClient,
  HostServices,
  ResourceInstance,
  DetailViewSchema,
  SidebarItemSchema,
  SectionNode,
  ActionNode,
  DashboardStat,
  CreditBalance,
} from "@infrawrench/plugin-base";
import { jsonRestFetch, externalIdOf, formatBytes } from "@infrawrench/plugin-base";

/**
 * DeepSeek's canonical base URL. The documented paths carry **no `/v1`
 * segment**: `/chat/completions`, `/models`, `/user/balance`. `/v1` is
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
  "deepseek-flash": 2500,
  "deepseek-v4-pro": 500,
  // Retired names that DeepSeek still accepts and serves on V4.1-Flash, so
  // they share its cap if an account's listing still carries them.
  "deepseek-v4-flash": 2500,
  "deepseek-v4-flash-vision-exp": 2500,
};

/**
 * Model names DeepSeek retired but still accepts, routing them to a current
 * model and billing at its price. `GET /models` lists only the current ids,
 * so the aliases are filled in from the changelog: anyone grepping their
 * code for the old name needs to know where it went.
 * https://api-docs.deepseek.com/updates
 */
const LEGACY_ALIASES: Record<string, string[]> = {
  "deepseek-flash": ["deepseek-v4-flash", "deepseek-v4-flash-vision-exp"],
};

/**
 * Peak-hour list prices in USD per million tokens, from DeepSeek's pricing
 * page (verified 2026-10-03). Off-peak is exactly half of each figure, which
 * is how the page states it, so only the peak rate is stored. Like the
 * concurrency caps these are published rather than returned by any endpoint.
 * https://api-docs.deepseek.com/quick_start/pricing
 */
interface ModelPrice {
  inputCacheHit: number;
  inputCacheMiss: number;
  output: number;
}

const PEAK_PRICES_USD: Record<string, ModelPrice> = {
  "deepseek-flash": { inputCacheHit: 0.006, inputCacheMiss: 0.3, output: 1.2 },
  "deepseek-v4-pro": { inputCacheHit: 0.044, inputCacheMiss: 1.32, output: 3.96 },
};

const PEAK_HOURS =
  "Peak hours are 01:00-04:00 and 06:00-10:00 UTC, Monday to Friday, excluding Chinese public holidays. Every other hour bills at half the peak rate.";

/**
 * Published Files API limits. Prose in the guide, not returned by any
 * endpoint, so they are shown as context and never as a quota reading.
 * https://api-docs.deepseek.com/guides/files_api
 */
const FILES_STORAGE_QUOTA_BYTES = 25 * 1024 * 1024 * 1024;
const FILES_COUNT_QUOTA = 10_000;

interface DeepSeekModel {
  id: string;
  object?: string;
  owned_by?: string;
  name?: string;
  context_window?: number;
  max_output_tokens?: number;
  input_modalities?: string[];
  output_modalities?: string[];
  effort?: { supported_levels?: string[]; default_level?: string };
  api_capabilities?: {
    anthropic_messages?: { system_prompt_update?: string };
  };
}

interface DeepSeekFile {
  id?: string;
  object?: string;
  bytes?: number;
  created_at?: number;
  filename?: string;
  purpose?: string;
  expires_at?: number | null;
}

interface DeepSeekFileList {
  object?: string;
  data?: DeepSeekFile[];
  first_id?: string | null;
  last_id?: string | null;
  has_more?: boolean;
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

function epochToIso(seconds: number | null | undefined): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return "";
  return new Date(seconds * 1000).toISOString();
}

function formatTokens(value: number): string {
  if (!value) return "";
  if (value >= 1024 * 1024 && value % (1024 * 1024) === 0) return `${value / (1024 * 1024)}M`;
  if (value >= 1024 && value % 1024 === 0) return `${value / 1024}K`;
  return value.toLocaleString("en-US");
}

function formatMoney(amount: number, currency: string): string {
  return `${amount.toFixed(2)} ${currency || ""}`.trim();
}

/**
 * DeepSeek plugin client.
 *
 * This is deliberately small because DeepSeek's REST surface is deliberately
 * small: one API key, no admin plane, and three management-shaped endpoint
 * groups. There is no key management API, no usage or cost API, and no
 * speech API, so this plugin does not pretend otherwise. Everything it shows
 * comes from `GET /models`, `GET /user/balance` and the Files API.
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
      case "file":
        return this.listFiles(accountId);
      default:
        throw new Error(`DeepSeek plugin: unknown resource type "${typeId}"`);
    }
  }

  /**
   * GET /models: verified 2026-10-03 against
   * https://api-docs.deepseek.com/api/list-models
   *
   * Note the canonical path has no `/v1`. There is no pagination: the response
   * is a flat `{object:"list", data:[…]}`. Every metadata field is optional
   * here so an older response shape (bare `{id, owned_by}`) still maps.
   */
  private async listModels(accountId: string): Promise<ResourceInstance[]> {
    const body = await this.fetch<DeepSeekModelList>("/models");
    const now = new Date().toISOString();

    return (body.data ?? []).map((model) => {
      const limit = CONCURRENCY_LIMITS[model.id];
      const aliases = LEGACY_ALIASES[model.id] ?? [];
      const contextWindow = Number(model.context_window) || 0;
      const maxOutput = Number(model.max_output_tokens) || 0;
      return {
        id: `${accountId}:model:${model.id}`,
        pluginId: "deepseek",
        resourceTypeId: "model",
        accountId,
        displayName: model.id,
        externalId: model.id,
        fields: {
          modelId: model.id,
          name: str(model.name),
          ownedBy: str(model.owned_by),
          ...(contextWindow ? { contextWindow } : {}),
          ...(maxOutput ? { maxOutputTokens: maxOutput } : {}),
          inputModalities: (model.input_modalities ?? []).join(", "),
          outputModalities: (model.output_modalities ?? []).join(", "),
          effortLevels: (model.effort?.supported_levels ?? []).join(", "),
          defaultEffort: str(model.effort?.default_level),
          anthropicSystemPromptUpdate: str(
            model.api_capabilities?.anthropic_messages?.system_prompt_update,
          ),
          ...(limit !== undefined ? { concurrencyLimit: limit } : {}),
          legacyAliases: aliases.join(", "),
        },
        resolvedOutputs: {
          modelId: model.id,
          ...(contextWindow ? { contextWindow: String(contextWindow) } : {}),
        },
        secretStates: [],
        createdAt: now,
        updatedAt: now,
      } satisfies ResourceInstance;
    });
  }

  /**
   * GET /user/balance: verified 2026-07-28 against
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

  /**
   * GET /files: verified 2026-10-03 against
   * https://api-docs.deepseek.com/api/list-files
   *
   * Cursor pagination: `after` takes the last file id of the previous page and
   * `has_more` says whether to keep going. `limit` maxes out at 1000, which is
   * also the default, and an account holds at most 10,000 files, so the guard
   * below is never the thing that stops the loop on a real account.
   */
  private async listFiles(accountId: string): Promise<ResourceInstance[]> {
    const files: DeepSeekFile[] = [];
    let after = "";
    for (let page = 0; page < 20; page += 1) {
      const params = new URLSearchParams({ limit: "1000", order: "desc" });
      if (after) params.set("after", after);
      const body = await this.fetch<DeepSeekFileList>(`/files?${params.toString()}`);
      const items = body.data ?? [];
      files.push(...items);
      const next = str(body.last_id) || str(items[items.length - 1]?.id);
      if (!body.has_more || !next || next === after) break;
      after = next;
    }
    const now = new Date().toISOString();
    return files
      .filter((file) => Boolean(file.id))
      .map((file) => this.mapFile(accountId, file, now));
  }

  private mapFile(accountId: string, file: DeepSeekFile, now: string): ResourceInstance {
    const id = str(file.id);
    const created = epochToIso(file.created_at);
    return {
      id: `${accountId}:file:${id}`,
      pluginId: "deepseek",
      resourceTypeId: "file",
      accountId,
      displayName: str(file.filename) || id,
      externalId: id,
      fields: {
        fileId: id,
        filename: str(file.filename),
        bytes: Number(file.bytes) || 0,
        purpose: str(file.purpose),
        createdAt: created,
        expiresAt: epochToIso(file.expires_at),
      },
      resolvedOutputs: { fileId: id, filename: str(file.filename) },
      secretStates: [],
      createdAt: created || now,
      updatedAt: now,
    } satisfies ResourceInstance;
  }

  /**
   * DELETE /files/{file_id}: https://api-docs.deepseek.com/api/delete-file
   *
   * Files are the only thing in DeepSeek's API that can be removed. The
   * response is `{id, object, deleted}`; a `deleted: false` is surfaced
   * rather than swallowed.
   */
  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    if (typeId !== "file") {
      throw new Error(`DeepSeek plugin: ${typeId} cannot be deleted`);
    }
    const fileId = externalIdOf(resourceId);
    if (!fileId) throw new Error(`DeepSeek plugin: cannot parse resource id "${resourceId}"`);
    const result = await this.fetch<{ deleted?: boolean }>(`/files/${encodeURIComponent(fileId)}`, {
      method: "DELETE",
    });
    if (result.deleted === false) {
      throw new Error(`DeepSeek plugin: file ${fileId} was not deleted`);
    }
  }

  /**
   * The prepaid balance, one entry per currency.
   *
   * The same `GET /user/balance` the Balance resource type lists, but shaped
   * for the host's credit tracking rather than for a resource table, so the
   * host can collect it on a slow cadence and derive a burn rate from the
   * series. Currency is the pot key: DeepSeek returns CNY and USD separately
   * and summing them would produce a number that means nothing.
   *
   * `granted_balance` is the promotional grant, not the total ever added, so
   * it is deliberately not reported as `granted`: a "12 of 50 remaining" bar
   * built on it would be wrong for any account that has topped up.
   */
  async fetchCreditBalance(): Promise<CreditBalance[]> {
    const body = await this.fetch<DeepSeekBalance>("/user/balance");
    return (body.balance_infos ?? []).map((info) => {
      const currency = str(info.currency) || "USD";
      return {
        key: currency,
        label: `${currency} balance`,
        remaining: money(info.total_balance),
        currency,
      } satisfies CreditBalance;
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
    if (
      (typeId === "model" && outputKey === "modelId") ||
      (typeId === "file" && outputKey === "fileId")
    ) {
      // Cheap path: the model id and the file id *are* the external id.
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
   * is only ever called for those drivers: the generic labelled-stat surface
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
      const contextWindow = Number(fields["contextWindow"]) || 0;
      const maxOutput = Number(fields["maxOutputTokens"]) || 0;
      return [
        { label: "Model", value: str(fields["modelId"]) },
        ...(contextWindow ? [{ label: "Context", value: formatTokens(contextWindow) }] : []),
        ...(maxOutput ? [{ label: "Max output", value: formatTokens(maxOutput) }] : []),
        { label: "Concurrency", value: limit ? String(limit) : "see docs" },
      ];
    }

    if (resourceTypeId === "file") {
      const bytes = Number(fields["bytes"]) || 0;
      const expires = str(fields["expiresAt"]);
      return [
        { label: "Size", value: bytes ? formatBytes(bytes) : "unknown" },
        { label: "Expires", value: expires || "never" },
      ];
    }

    return [];
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    switch (resource.resourceTypeId) {
      case "balance":
        return this.renderBalanceDetail(resource);
      case "file":
        return this.renderFileDetail(resource);
      default:
        return this.renderModelDetail(resource);
    }
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

    if (resource.resourceTypeId === "file") {
      const bytes = Number(fields["bytes"]) || 0;
      return {
        id: resource.id,
        label: resource.displayName,
        status: {
          kind: "status-dot",
          status: "healthy",
          label: bytes ? formatBytes(bytes) : "file",
        },
      };
    }

    return {
      id: resource.id,
      label: resource.displayName,
      status: {
        kind: "status-dot",
        status: "healthy",
        label: str(fields["name"]) || str(fields["ownedBy"]) || "model",
      },
    };
  }

  private renderModelDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const modelId = str(fields["modelId"]);
    const limit = Number(fields["concurrencyLimit"]) || 0;
    const contextWindow = Number(fields["contextWindow"]) || 0;
    const maxOutput = Number(fields["maxOutputTokens"]) || 0;
    const effortLevels = str(fields["effortLevels"]);
    const defaultEffort = str(fields["defaultEffort"]);
    const aliases = str(fields["legacyAliases"]);
    const price = PEAK_PRICES_USD[modelId];

    const sections: SectionNode[] = [
      {
        kind: "section",
        title: "Model",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Model ID", value: modelId, copyable: true },
              ...(str(fields["name"]) ? [{ key: "Name", value: str(fields["name"]) }] : []),
              { key: "Owned By", value: str(fields["ownedBy"]) || "deepseek" },
              {
                key: "Context Window",
                value: contextWindow
                  ? `${contextWindow.toLocaleString("en-US")} tokens (${formatTokens(contextWindow)})`
                  : "not reported",
              },
              {
                key: "Max Output",
                value: maxOutput
                  ? `${maxOutput.toLocaleString("en-US")} tokens (${formatTokens(maxOutput)})`
                  : "not reported",
              },
              { key: "Input Modalities", value: str(fields["inputModalities"]) || "text" },
              { key: "Output Modalities", value: str(fields["outputModalities"]) || "text" },
              {
                key: "Concurrency Limit",
                value: limit ? `${limit} concurrent requests` : "not published for this model",
              },
              ...(aliases ? [{ key: "Legacy Aliases", value: aliases }] : []),
            ],
          },
          {
            kind: "text",
            variant: "muted",
            content:
              "DeepSeek has no RPM or TPM limit. Each request holds one concurrent slot until it completes, and exceeding the per-account cap returns HTTP 429. Capacity increases are free to request.",
          },
          {
            kind: "text",
            variant: "muted",
            content:
              "Call this model at https://api.deepseek.com/chat/completions or, in the OpenAI Responses format, /responses. Paths have no /v1 segment (a /v1 prefix works for OpenAI SDK compatibility), and an Anthropic-compatible alias is at https://api.deepseek.com/anthropic.",
          },
        ],
      },
    ];

    if (effortLevels || str(fields["anthropicSystemPromptUpdate"])) {
      sections.push({
        kind: "section",
        title: "Thinking",
        children: [
          {
            kind: "key-value-list",
            items: [
              ...(effortLevels ? [{ key: "Effort Levels", value: effortLevels }] : []),
              ...(defaultEffort ? [{ key: "Default Effort", value: defaultEffort }] : []),
              ...(str(fields["anthropicSystemPromptUpdate"])
                ? [
                    {
                      key: "Anthropic System Prompt Updates",
                      value: str(fields["anthropicSystemPromptUpdate"]),
                    },
                  ]
                : []),
            ],
          },
        ],
      });
    }

    if (price) {
      const usd = (value: number) => `$${value.toFixed(3).replace(/0$/, "")}`;
      sections.push({
        kind: "section",
        title: "Pricing",
        children: [
          {
            kind: "table",
            emphasizeFirstColumn: true,
            columns: [
              { key: "category", label: "Per 1M tokens" },
              { key: "peak", label: "Peak" },
              { key: "offPeak", label: "Off-peak" },
            ],
            rows: [
              ["Input (cache hit)", price.inputCacheHit],
              ["Input (cache miss)", price.inputCacheMiss],
              ["Output", price.output],
            ].map(([category, peak]) => ({
              cells: {
                category: String(category),
                peak: usd(Number(peak)),
                offPeak: usd(Number(peak) / 2),
              },
            })),
          },
          { kind: "text", variant: "muted", content: PEAK_HOURS },
          {
            kind: "link",
            label: "DeepSeek pricing",
            url: "https://api-docs.deepseek.com/quick_start/pricing",
          },
        ],
      });
    }

    return {
      title: resource.displayName,
      subtitle: str(fields["name"]) || "DeepSeek model",
      status: { kind: "status-dot", status: "healthy", label: "Available" },
      sections,
      headerActions: [refreshAction()],
    };
  }

  private renderFileDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const bytes = Number(fields["bytes"]) || 0;
    const expires = str(fields["expiresAt"]);

    const sections: SectionNode[] = [
      {
        kind: "section",
        title: "File",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "File ID", value: str(fields["fileId"]), copyable: true },
              { key: "Filename", value: str(fields["filename"]) || "unnamed" },
              { key: "Size", value: bytes ? formatBytes(bytes) : "unknown" },
              { key: "Purpose", value: str(fields["purpose"]) || "user_data" },
              { key: "Created", value: str(fields["createdAt"]) || "unknown" },
              { key: "Expires", value: expires || "Never (kept until deleted)" },
            ],
          },
          {
            kind: "text",
            variant: "muted",
            content: `Reference this image by file_id in a "file" content block on POST /chat/completions instead of re-sending it base64-encoded. An account can store up to ${FILES_COUNT_QUOTA.toLocaleString("en-US")} files and ${formatBytes(FILES_STORAGE_QUOTA_BYTES)} in total; uploads are capped at 64 MiB each.`,
          },
        ],
      },
    ];

    return {
      title: resource.displayName,
      subtitle: joinParts(["DeepSeek file", bytes ? formatBytes(bytes) : ""]),
      status: { kind: "status-dot", status: "healthy", label: expires ? "Expiring" : "Stored" },
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
                value: available ? "Yes" : "No (top up to keep calling the API)",
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

function joinParts(parts: string[]): string {
  return parts.filter(Boolean).join(" · ");
}

function refreshAction(): ActionNode {
  return { kind: "action", label: "Refresh", action: { type: "refresh-resource" } };
}
