import type {
  PluginClient,
  HostServices,
  ResourceInstance,
  DetailViewSchema,
  SidebarItemSchema,
  SectionNode,
  ActionNode,
  KVItem,
  DashboardStat,
  MetricSeries,
  MetricSeriesPoint,
  ResourceStatus,
  CreateResourceConfig,
  CostFetchRange,
  CostRow,
} from "@infrawrench/plugin-base";
import { jsonRestFetch, formatBytes, CostSetupError } from "@infrawrench/plugin-base";

const BASE_URL = "https://api.anthropic.com";

/**
 * `anthropic-version` is mandatory on every request, including GETs, and
 * `2023-06-01` is still the only stable value.
 * https://platform.claude.com/docs/en/api/versioning
 */
const ANTHROPIC_VERSION = "2023-06-01";

/**
 * The Files API is still behind a beta header.
 * https://platform.claude.com/docs/en/api/files-list
 */
const FILES_BETA = "files-api-2025-04-14";

/** `limit` ranges 1–1000 on every cursor-paginated Anthropic list endpoint. */
const PAGE_SIZE = 100;

/** Hard stop so a runaway cursor can't loop forever. */
const MAX_LIST_PAGES = 20;

/** Where the user goes to fix a missing Admin key. */
const ADMIN_KEY_DOCS = "https://platform.claude.com/docs/en/manage-claude/admin-api-keys";

const ADMIN_KEY_HINT =
  "This section needs an Anthropic Admin API key (sk-ant-admin…). Add one to this account to enable it — a standard sk-ant-api key returns 401 on every /v1/organizations/* endpoint.";

/** Roles the Admin API will actually accept on invite/update calls. */
const ASSIGNABLE_ROLES: Array<{ id: string; label: string }> = [
  { id: "user", label: "User — Workbench only" },
  { id: "claude_code_user", label: "Claude Code User — Workbench + Claude Code" },
  { id: "developer", label: "Developer — Workbench + manage API keys" },
  { id: "billing", label: "Billing — Workbench + manage billing" },
  { id: "managed", label: "Managed — Claude Enterprise organizations only" },
];

// ---- API response shapes ---------------------------------------------------

/** Every list endpoint returns this envelope. */
interface AnthropicPage<T> {
  data?: T[];
  first_id?: string | null;
  last_id?: string | null;
  has_more?: boolean;
}

interface CapabilitySupport {
  supported?: boolean;
}

interface AnthropicModelCapabilities {
  batch?: CapabilitySupport;
  citations?: CapabilitySupport;
  code_execution?: CapabilitySupport;
  context_management?: CapabilitySupport & Record<string, unknown>;
  effort?: CapabilitySupport & {
    low?: CapabilitySupport;
    medium?: CapabilitySupport;
    high?: CapabilitySupport;
    max?: CapabilitySupport;
    xhigh?: CapabilitySupport;
  };
  image_input?: CapabilitySupport;
  pdf_input?: CapabilitySupport;
  structured_outputs?: CapabilitySupport;
  thinking?: CapabilitySupport & {
    types?: { adaptive?: CapabilitySupport; enabled?: CapabilitySupport };
  };
}

interface AnthropicModel {
  id: string;
  display_name?: string;
  created_at?: string;
  max_input_tokens?: number;
  max_tokens?: number;
  capabilities?: AnthropicModelCapabilities;
}

interface AnthropicMessageBatch {
  id: string;
  processing_status?: "in_progress" | "canceling" | "ended";
  request_counts?: {
    processing?: number;
    succeeded?: number;
    errored?: number;
    canceled?: number;
    expired?: number;
  };
  created_at?: string;
  ended_at?: string | null;
  expires_at?: string | null;
  archived_at?: string | null;
  cancel_initiated_at?: string | null;
  results_url?: string | null;
}

interface AnthropicFile {
  id: string;
  filename?: string;
  mime_type?: string;
  size_bytes?: number;
  created_at?: string;
  downloadable?: boolean;
  scope?: { id?: string; type?: string } | null;
}

interface AnthropicWorkspace {
  id: string;
  name?: string;
  display_color?: string;
  created_at?: string;
  archived_at?: string | null;
  external_key_id?: string | null;
  tags?: Record<string, string> | null;
  data_residency?: {
    workspace_geo?: string;
    default_inference_geo?: string;
    allowed_inference_geos?: string[] | "unrestricted";
  } | null;
}

interface AnthropicUser {
  id: string;
  email?: string;
  name?: string;
  role?: string;
  added_at?: string;
}

interface AnthropicInvite {
  id: string;
  email?: string;
  role?: string;
  status?: string;
  invited_at?: string;
  expires_at?: string;
  accepted_at?: string | null;
}

interface AnthropicApiKey {
  id: string;
  name?: string;
  status?: string;
  partial_key_hint?: string | null;
  workspace_id?: string | null;
  created_at?: string;
  expires_at?: string | null;
  created_by?: { id?: string; type?: string } | null;
  principal?: { id?: string; type?: string } | null;
}

interface UsageResult {
  uncached_input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: {
    ephemeral_1h_input_tokens?: number;
    ephemeral_5m_input_tokens?: number;
  };
  server_tool_use?: { web_search_requests?: number };
}

interface UsageBucket {
  starting_at?: string;
  ending_at?: string;
  results?: UsageResult[];
}

interface UsageReport {
  data?: UsageBucket[];
  has_more?: boolean;
  next_page?: string | null;
}

interface CostResult {
  amount?: string;
  currency?: string;
  description?: string | null;
  cost_type?: string | null;
  model?: string | null;
  service_tier?: string | null;
  token_type?: string | null;
  workspace_id?: string | null;
}

interface CostBucket {
  starting_at?: string;
  ending_at?: string;
  results?: CostResult[];
}

interface CostReport {
  data?: CostBucket[];
  has_more?: boolean;
  next_page?: string | null;
}

// ---- Small helpers ---------------------------------------------------------

function str(value: unknown): string {
  if (value == null) return "";
  return typeof value === "string" ? value : String(value);
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** `{accountId}:{typeId}:{externalId}` → `{externalId}`. */
function externalIdOf(resourceId: string): string {
  return resourceId.split(":").slice(2).join(":");
}

function supported(cap: CapabilitySupport | undefined): boolean {
  return cap?.supported === true;
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Anthropic plugin client — one per account (one inference key, optionally one
 * Admin key).
 *
 * Two credentials, two disjoint halves of the API:
 *   - `apiKey` (sk-ant-api…) covers `/v1/models`, `/v1/messages/batches` and
 *     `/v1/files`.
 *   - `adminApiKey` (sk-ant-admin…) covers everything under
 *     `/v1/organizations/*` — note the **plural**, unlike OpenAI's singular
 *     `/v1/organization/*`.
 *
 * The Admin key is optional. Without it the four admin resource types list
 * empty and the metrics charts come back empty rather than failing the whole
 * account; only `fetchCostData` raises (as a `CostSetupError`, which is the
 * host's "the user has to do something" channel).
 */
export class AnthropicClient implements PluginClient {
  private readonly apiKey: string;
  private readonly adminApiKey: string;
  private readonly caCert: string;
  private readonly services: HostServices | undefined;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const apiKey = credentials["apiKey"];
    if (!apiKey) throw new Error("Anthropic plugin: missing apiKey credential");
    this.apiKey = apiKey;
    this.adminApiKey = credentials["adminApiKey"] ?? "";
    this.caCert = credentials["caCert"] ?? "";
    this.services = services;
  }

  /** True when the account carries the Admin key `/v1/organizations/*` needs. */
  private get hasAdminKey(): boolean {
    return this.adminApiKey.length > 0;
  }

  private async fetch<T>(
    path: string,
    init?: RequestInit,
    opts: { admin?: boolean; beta?: string } = {},
  ): Promise<T> {
    if (opts.admin && !this.hasAdminKey) {
      throw new Error(`Anthropic plugin: ${path} requires an Admin API key. ${ADMIN_KEY_HINT}`);
    }
    const headers: Record<string, string> = {
      "x-api-key": opts.admin ? this.adminApiKey : this.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      Accept: "application/json",
    };
    if (opts.beta) headers["anthropic-beta"] = opts.beta;

    return jsonRestFetch<T>({
      vendor: "Anthropic",
      url: `${BASE_URL}${path}`,
      errorPath: path,
      headers,
      ...(init ? { init } : {}),
      ...(this.services?.http ? { http: this.services.http } : {}),
      ...(this.caCert ? { caCert: this.caCert } : {}),
    });
  }

  /**
   * Walk Anthropic's uniform `after_id` / `has_more` / `last_id` cursor.
   * Every list endpoint on the API uses this exact shape.
   */
  private async listPaginated<T>(
    path: string,
    params: Record<string, string>,
    opts: { admin?: boolean; beta?: string } = {},
  ): Promise<T[]> {
    const out: T[] = [];
    let afterId: string | undefined;

    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const query = new URLSearchParams(params);
      query.set("limit", String(PAGE_SIZE));
      if (afterId) query.set("after_id", afterId);
      const body = await this.fetch<AnthropicPage<T>>(
        `${path}?${query.toString()}`,
        undefined,
        opts,
      );
      out.push(...(body.data ?? []));
      if (!body.has_more || !body.last_id) break;
      afterId = body.last_id;
    }

    return out;
  }

  // ---- Listing -------------------------------------------------------------

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "model":
        return (await this.fetchModels()).map((m) => this.mapModel(accountId, m));
      case "message-batch":
        return (await this.fetchBatches()).map((b) => this.mapBatch(accountId, b));
      case "file":
        return (await this.fetchFiles()).map((f) => this.mapFile(accountId, f));
      case "workspace":
        return (await this.fetchWorkspaces()).map((w) => this.mapWorkspace(accountId, w));
      case "organization-user":
        return (await this.fetchUsers()).map((u) => this.mapUser(accountId, u));
      case "invite":
        return (await this.fetchInvites()).map((i) => this.mapInvite(accountId, i));
      case "api-key":
        return (await this.fetchApiKeys()).map((k) => this.mapApiKey(accountId, k));
      default:
        throw new Error(`Anthropic plugin: unknown resource type "${typeId}"`);
    }
  }

  /**
   * GET /v1/models — verified 2026-07-28 against
   * https://platform.claude.com/docs/en/api/models-list
   */
  private fetchModels(): Promise<AnthropicModel[]> {
    return this.listPaginated<AnthropicModel>("/v1/models", {});
  }

  /**
   * GET /v1/messages/batches — verified 2026-07-28 against
   * https://platform.claude.com/docs/en/api/listing-message-batches
   */
  private fetchBatches(): Promise<AnthropicMessageBatch[]> {
    return this.listPaginated<AnthropicMessageBatch>("/v1/messages/batches", {});
  }

  /**
   * GET /v1/files — verified 2026-07-28 against
   * https://platform.claude.com/docs/en/api/files-list
   * Still gated behind the `files-api-2025-04-14` beta header.
   */
  private fetchFiles(): Promise<AnthropicFile[]> {
    return this.listPaginated<AnthropicFile>("/v1/files", {}, { beta: FILES_BETA });
  }

  /**
   * GET /v1/organizations/workspaces — verified 2026-07-28 against
   * https://platform.claude.com/docs/en/api/admin-api/workspaces/list-workspaces
   *
   * Archived workspaces are requested explicitly so the user can still see the
   * ones they retired; the Default Workspace has no ID and never appears here.
   */
  private async fetchWorkspaces(): Promise<AnthropicWorkspace[]> {
    if (!this.hasAdminKey) return [];
    return this.listPaginated<AnthropicWorkspace>(
      "/v1/organizations/workspaces",
      { include_archived: "true" },
      { admin: true },
    );
  }

  /**
   * GET /v1/organizations/users — verified 2026-07-28 against
   * https://platform.claude.com/docs/en/api/admin-api/users/list-users
   */
  private async fetchUsers(): Promise<AnthropicUser[]> {
    if (!this.hasAdminKey) return [];
    return this.listPaginated<AnthropicUser>("/v1/organizations/users", {}, { admin: true });
  }

  /**
   * GET /v1/organizations/invites — verified 2026-07-28 against
   * https://platform.claude.com/docs/en/api/admin-api/invites/list-invites
   */
  private async fetchInvites(): Promise<AnthropicInvite[]> {
    if (!this.hasAdminKey) return [];
    return this.listPaginated<AnthropicInvite>("/v1/organizations/invites", {}, { admin: true });
  }

  /**
   * GET /v1/organizations/api_keys — verified 2026-07-28 against
   * https://platform.claude.com/docs/en/api/admin-api/apikeys/list-api-keys
   */
  private async fetchApiKeys(): Promise<AnthropicApiKey[]> {
    if (!this.hasAdminKey) return [];
    return this.listPaginated<AnthropicApiKey>("/v1/organizations/api_keys", {}, { admin: true });
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const externalId = externalIdOf(resourceId);

    // Single-object GETs exist for batches and files and are much cheaper than
    // re-listing, especially while a batch is still counting up.
    if (typeId === "message-batch") {
      const batch = await this.fetch<AnthropicMessageBatch>(
        `/v1/messages/batches/${encodeURIComponent(externalId)}`,
      );
      return this.mapBatch(accountId, batch);
    }
    if (typeId === "file") {
      const file = await this.fetch<AnthropicFile>(
        `/v1/files/${encodeURIComponent(externalId)}`,
        undefined,
        { beta: FILES_BETA },
      );
      return this.mapFile(accountId, file);
    }

    const all = await this.listResources(typeId, accountId);
    const found = all.find((r) => r.id === resourceId);
    if (!found) throw new Error(`Anthropic plugin: resource ${typeId}/${resourceId} not found`);
    return found;
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    const resource = await this.getResource(typeId, resourceId, accountId);
    const direct = resource.resolvedOutputs[outputKey];
    if (direct !== undefined) return direct;
    throw new Error(`Anthropic plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
  }

  // ---- Mutations -----------------------------------------------------------

  async getCreateConfig(typeId: string): Promise<CreateResourceConfig> {
    if (typeId === "workspace") {
      return {
        fields: [
          {
            key: "name",
            label: "Workspace Name",
            kind: "text",
            required: true,
            placeholder: "Production",
            description:
              "Shown in the Console workspace switcher. Up to 100 workspaces per organization; archived ones don't count.",
          },
        ],
      };
    }
    if (typeId === "invite") {
      return {
        fields: [
          {
            key: "email",
            label: "Email",
            kind: "text",
            required: true,
            placeholder: "teammate@example.com",
          },
          {
            key: "role",
            label: "Role",
            kind: "select",
            required: true,
            options: ASSIGNABLE_ROLES,
            defaultValue: "user",
            description:
              "The admin role cannot be assigned through the API. On seat-based plans the invite consumes a seat from the lowest tier with availability and fails when none is free.",
          },
        ],
      };
    }
    if (typeId === "api-key") {
      throw new Error(
        "Anthropic plugin: API keys cannot be created through the API. Create them in the Claude Console under Settings → API keys.",
      );
    }
    throw new Error(`Anthropic plugin: no create config for type "${typeId}"`);
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    if (typeId === "workspace") {
      // POST /v1/organizations/workspaces — verified 2026-07-28 against
      // https://platform.claude.com/docs/en/manage-claude/workspaces
      const name = fields["name"]?.trim();
      if (!name) throw new Error("Workspace name is required");
      const created = await this.fetch<AnthropicWorkspace>(
        "/v1/organizations/workspaces",
        { method: "POST", body: JSON.stringify({ name }) },
        { admin: true },
      );
      return this.mapWorkspace(accountId, created);
    }
    if (typeId === "invite") {
      // POST /v1/organizations/invites — verified 2026-07-28 against
      // https://platform.claude.com/docs/en/api/admin-api/invites/create-invite
      const email = fields["email"]?.trim();
      const role = fields["role"] ?? "user";
      if (!email) throw new Error("Invite email is required");
      const created = await this.fetch<AnthropicInvite>(
        "/v1/organizations/invites",
        { method: "POST", body: JSON.stringify({ email, role }) },
        { admin: true },
      );
      return this.mapInvite(accountId, created);
    }
    throw new Error(`Anthropic plugin: createResource not supported for type "${typeId}"`);
  }

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const externalId = externalIdOf(resourceId);

    if (typeId === "workspace") {
      // POST /v1/organizations/workspaces/{id} — verified 2026-07-28 against
      // https://platform.claude.com/docs/en/api/admin-api/workspaces/update-workspace
      const body: Record<string, unknown> = {};
      if (fields["name"] !== undefined) body["name"] = fields["name"];
      const updated = await this.fetch<AnthropicWorkspace>(
        `/v1/organizations/workspaces/${encodeURIComponent(externalId)}`,
        { method: "POST", body: JSON.stringify(body) },
        { admin: true },
      );
      return this.mapWorkspace(accountId, updated);
    }

    if (typeId === "organization-user") {
      // POST /v1/organizations/users/{id} — verified 2026-07-28 against
      // https://platform.claude.com/docs/en/api/admin-api/users/update-user
      const role = fields["role"];
      if (!role) throw new Error("Anthropic plugin: role is the only editable field on a member");
      const updated = await this.fetch<AnthropicUser>(
        `/v1/organizations/users/${encodeURIComponent(externalId)}`,
        { method: "POST", body: JSON.stringify({ role }) },
        { admin: true },
      );
      return this.mapUser(accountId, updated);
    }

    if (typeId === "api-key") {
      // POST /v1/organizations/api_keys/{id} — verified 2026-07-28 against
      // https://platform.claude.com/docs/en/api/admin-api/apikeys/update-api-key
      //
      // This is also how a key is *revoked*: there is no DELETE endpoint, so
      // "delete" is `{"status":"inactive"}`.
      const body: Record<string, unknown> = {};
      if (fields["name"] !== undefined) body["name"] = fields["name"];
      if (fields["status"] !== undefined) {
        const status = fields["status"];
        if (status === "expired") {
          throw new Error(
            'Anthropic plugin: "expired" is a state the API reports, not one you can set. Use active, inactive or archived.',
          );
        }
        body["status"] = status;
      }
      const updated = await this.fetch<AnthropicApiKey>(
        `/v1/organizations/api_keys/${encodeURIComponent(externalId)}`,
        { method: "POST", body: JSON.stringify(body) },
        { admin: true },
      );
      return this.mapApiKey(accountId, updated);
    }

    throw new Error(`Anthropic plugin: updateResource not supported for type "${typeId}"`);
  }

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    const externalId = externalIdOf(resourceId);

    switch (typeId) {
      case "message-batch":
        // DELETE /v1/messages/batches/{id} — only allowed once processing has
        // ended; cancel an in-progress batch first.
        // https://platform.claude.com/docs/en/api/deleting-message-batches
        await this.fetch<unknown>(`/v1/messages/batches/${encodeURIComponent(externalId)}`, {
          method: "DELETE",
        });
        return;
      case "file":
        // DELETE /v1/files/{id}
        // https://platform.claude.com/docs/en/api/files-delete
        await this.fetch<unknown>(
          `/v1/files/${encodeURIComponent(externalId)}`,
          { method: "DELETE" },
          { beta: FILES_BETA },
        );
        return;
      case "organization-user":
        // DELETE /v1/organizations/users/{id}. Members holding the admin,
        // owner or primary_owner role cannot be removed through the API.
        await this.fetch<unknown>(
          `/v1/organizations/users/${encodeURIComponent(externalId)}`,
          { method: "DELETE" },
          { admin: true },
        );
        return;
      case "invite":
        // DELETE /v1/organizations/invites/{id}
        await this.fetch<unknown>(
          `/v1/organizations/invites/${encodeURIComponent(externalId)}`,
          { method: "DELETE" },
          { admin: true },
        );
        return;
      case "api-key":
        throw new Error(
          'Anthropic plugin: API keys cannot be deleted through the API. Use the "Deactivate key" action instead — it sets status to inactive, which revokes the key.',
        );
      case "workspace":
        throw new Error(
          'Anthropic plugin: workspaces cannot be deleted. Use the "Archive workspace" action — note that archiving is irreversible and immediately revokes every API key scoped to the workspace.',
        );
      default:
        throw new Error(`Anthropic plugin: deleteResource not supported for type "${typeId}"`);
    }
  }

  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    _accountId: string,
  ): Promise<void> {
    const externalId = externalIdOf(resourceId);

    if (typeId === "message-batch" && actionId === "cancel-batch") {
      // POST /v1/messages/batches/{id}/cancel — verified 2026-07-28 against
      // https://platform.claude.com/docs/en/api/canceling-message-batches
      await this.fetch<unknown>(`/v1/messages/batches/${encodeURIComponent(externalId)}/cancel`, {
        method: "POST",
      });
      return;
    }

    if (typeId === "workspace" && actionId === "archive-workspace") {
      // POST /v1/organizations/workspaces/{id}/archive — verified 2026-07-28
      // against https://platform.claude.com/docs/en/api/admin-api/workspaces/archive-workspace
      //
      // "Archiving a workspace immediately revokes all API keys in that
      // workspace. This action cannot be undone." There is no unarchive.
      await this.fetch<unknown>(
        `/v1/organizations/workspaces/${encodeURIComponent(externalId)}/archive`,
        { method: "POST" },
        { admin: true },
      );
      return;
    }

    if (typeId === "api-key" && (actionId === "deactivate-key" || actionId === "activate-key")) {
      const status = actionId === "deactivate-key" ? "inactive" : "active";
      await this.fetch<unknown>(
        `/v1/organizations/api_keys/${encodeURIComponent(externalId)}`,
        { method: "POST", body: JSON.stringify({ status }) },
        { admin: true },
      );
      return;
    }

    throw new Error(`Anthropic plugin: unknown action "${actionId}" for type "${typeId}"`);
  }

  // ---- Metrics and cost ----------------------------------------------------

  /**
   * GET /v1/organizations/usage_report/messages — verified 2026-07-28 against
   * https://platform.claude.com/docs/en/api/admin-api/usage-cost/get-messages-usage-report
   *
   * Scoped per resource: a model row filters on `models[]`, a workspace row on
   * `workspace_ids[]`. Admin-key only, so this returns an empty chart rather
   * than an error when the account has no Admin key.
   */
  async fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    if (!this.hasAdminKey) return [];

    const externalId = externalIdOf(resourceId);
    const filter = new URLSearchParams();
    if (resourceTypeId === "model") filter.append("models[]", externalId);
    else if (resourceTypeId === "workspace") filter.append("workspace_ids[]", externalId);
    else return [];

    const endMs = timeRange?.endMs ?? Date.now();
    const startMs = timeRange?.startMs ?? endMs - 7 * 24 * 60 * 60 * 1000;

    // bucket_width caps: 1d → 31 buckets, 1h → 168, 1m → 1440. Pick the
    // finest granularity the requested window fits into.
    const spanMs = Math.max(endMs - startMs, 60_000);
    const useHourly = spanMs <= 7 * 24 * 60 * 60 * 1000;
    filter.set("bucket_width", useHourly ? "1h" : "1d");
    filter.set("limit", useHourly ? "168" : "31");
    filter.set("starting_at", new Date(startMs).toISOString());
    filter.set("ending_at", new Date(endMs).toISOString());

    const buckets: UsageBucket[] = [];
    let page: string | undefined;
    for (let i = 0; i < 5; i++) {
      const query = new URLSearchParams(filter);
      if (page) query.set("page", page);
      const body = await this.fetch<UsageReport>(
        `/v1/organizations/usage_report/messages?${query.toString()}`,
        undefined,
        { admin: true },
      );
      buckets.push(...(body.data ?? []));
      if (!body.has_more || !body.next_page) break;
      page = body.next_page;
    }

    const inputPoints: MetricSeriesPoint[] = [];
    const outputPoints: MetricSeriesPoint[] = [];
    const cacheReadPoints: MetricSeriesPoint[] = [];
    const cacheWritePoints: MetricSeriesPoint[] = [];
    const webSearchPoints: MetricSeriesPoint[] = [];

    for (const bucket of buckets) {
      const timestamp = Date.parse(str(bucket.starting_at));
      if (!Number.isFinite(timestamp)) continue;
      let input = 0;
      let output = 0;
      let cacheRead = 0;
      let cacheWrite = 0;
      let webSearch = 0;
      for (const result of bucket.results ?? []) {
        input += num(result.uncached_input_tokens);
        output += num(result.output_tokens);
        cacheRead += num(result.cache_read_input_tokens);
        cacheWrite +=
          num(result.cache_creation?.ephemeral_1h_input_tokens) +
          num(result.cache_creation?.ephemeral_5m_input_tokens);
        webSearch += num(result.server_tool_use?.web_search_requests);
      }
      inputPoints.push({ timestamp, value: input });
      outputPoints.push({ timestamp, value: output });
      cacheReadPoints.push({ timestamp, value: cacheRead });
      cacheWritePoints.push({ timestamp, value: cacheWrite });
      webSearchPoints.push({ timestamp, value: webSearch });
    }

    return [
      { label: "Input tokens (uncached)", unit: "tokens", points: inputPoints },
      { label: "Output tokens", unit: "tokens", points: outputPoints },
      { label: "Cache read tokens", unit: "tokens", points: cacheReadPoints },
      { label: "Cache write tokens", unit: "tokens", points: cacheWritePoints },
      { label: "Web search requests", unit: "requests", points: webSearchPoints },
    ];
  }

  /**
   * GET /v1/organizations/cost_report — verified 2026-07-28 against
   * https://platform.claude.com/docs/en/api/admin-api/usage-cost/get-cost-report
   *
   * Two things the docs are easy to misread:
   *   1. `bucket_width` accepts **only** `1d` here — there is no hourly cost.
   *   2. `amount` is a decimal string in the currency's *lowest units*, i.e.
   *      **cents**: `"123.45"` in USD means $1.2345, not $123.45. We divide by
   *      100 on the way into `CostRow.amount`.
   *
   * Priority Tier spend is excluded from this report by Anthropic, so totals
   * here can be lower than the invoice for organizations on Priority Tier.
   */
  async fetchCostData(_accountId: string, range: CostFetchRange): Promise<CostRow[]> {
    if (!this.hasAdminKey) {
      throw new CostSetupError(
        "Anthropic cost reporting needs an Admin API key (sk-ant-admin…). Add one to this account — the standard API key returns 401 on /v1/organizations/cost_report.",
        { label: "Create an Admin API key", url: ADMIN_KEY_DOCS },
      );
    }

    // `ending_at` is exclusive (buckets that *end before* this timestamp).
    // Anthropic rejects a future `ending_at` with 400 "Invalid date range:
    // ending date must be after starting date" — their own cookbook always
    // ends at start-of-today UTC so only completed days are requested. Cap
    // here so a host window that includes "today" (monthChunks does) still
    // works; a today-only chunk becomes an empty range and we skip the call.
    // https://github.com/anthropics/anthropic-cookbook/blob/main/observability/usage_cost_api.ipynb
    const today = new Date().toISOString().slice(0, 10);
    const exclusiveEnd = addDays(range.toDate, 1);
    const endingDay = exclusiveEnd > today ? today : exclusiveEnd;
    if (range.fromDate >= endingDay) {
      return [];
    }

    const base = new URLSearchParams();
    base.set("starting_at", `${range.fromDate}T00:00:00Z`);
    base.set("ending_at", `${endingDay}T00:00:00Z`);
    base.set("bucket_width", "1d");
    base.set("limit", "31");
    base.append("group_by[]", "description");
    base.append("group_by[]", "workspace_id");

    const buckets: CostBucket[] = [];
    let page: string | undefined;
    for (let i = 0; i < 30; i++) {
      const query = new URLSearchParams(base);
      if (page) query.set("page", page);
      const body = await this.fetch<CostReport>(
        `/v1/organizations/cost_report?${query.toString()}`,
        undefined,
        { admin: true },
      );
      buckets.push(...(body.data ?? []));
      if (!body.has_more || !body.next_page) break;
      page = body.next_page;
    }

    const rows: CostRow[] = [];
    for (const bucket of buckets) {
      const date = str(bucket.starting_at).slice(0, 10);
      if (date.length !== 10) continue;
      for (const result of bucket.results ?? []) {
        const cents = Number(result.amount);
        if (!Number.isFinite(cents)) continue;
        rows.push({
          date,
          service: str(result.description) || str(result.cost_type) || "Claude API usage",
          resourceId: str(result.workspace_id) || "default-workspace",
          currency: str(result.currency) || "USD",
          // Lowest currency units → major units.
          amount: cents / 100,
        });
      }
    }

    return rows;
  }

  async fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    const resource = await this.getResource(resourceTypeId, resourceId, accountId);
    const fields = resource.fields;

    switch (resourceTypeId) {
      case "model":
        return [
          { label: "Context", value: `${num(fields["maxInputTokens"]).toLocaleString()} tok` },
          { label: "Max output", value: `${num(fields["maxTokens"]).toLocaleString()} tok` },
          { label: "Vision", value: fields["vision"] ? "Yes" : "No" },
        ];
      case "message-batch": {
        const status = str(fields["processingStatus"]);
        return [
          {
            label: "Status",
            value: status,
            variant: status === "ended" ? "status-healthy" : "default",
          },
          { label: "Succeeded", value: String(num(fields["succeeded"])) },
          {
            label: "Errored",
            value: String(num(fields["errored"])),
            variant: num(fields["errored"]) > 0 ? "status-error" : "default",
          },
        ];
      }
      case "file":
        return [
          { label: "Size", value: formatBytes(num(fields["sizeBytes"])) },
          { label: "Type", value: str(fields["mimeType"]) || "unknown" },
        ];
      case "workspace":
        return [
          {
            label: "State",
            value: fields["archivedAt"] ? "Archived" : "Active",
            variant: fields["archivedAt"] ? "status-degraded" : "status-healthy",
          },
          { label: "Created", value: str(fields["createdAt"]).slice(0, 10) },
        ];
      case "organization-user":
        return [
          { label: "Role", value: str(fields["role"]) },
          { label: "Joined", value: str(fields["addedAt"]).slice(0, 10) },
        ];
      case "invite": {
        const status = str(fields["status"]);
        return [
          {
            label: "Status",
            value: status,
            variant: status === "pending" ? "default" : "status-degraded",
          },
          { label: "Expires", value: str(fields["expiresAt"]).slice(0, 10) },
        ];
      }
      case "api-key": {
        const status = str(fields["status"]);
        return [
          {
            label: "Status",
            value: status,
            variant: status === "active" ? "status-healthy" : "status-degraded",
          },
          { label: "Hint", value: str(fields["partialKeyHint"]) || "—" },
        ];
      }
      default:
        return [];
    }
  }

  // ---- Mapping -------------------------------------------------------------

  private mapModel(accountId: string, model: AnthropicModel): ResourceInstance {
    const caps = model.capabilities ?? {};
    const effortLevels = (["low", "medium", "high", "max", "xhigh"] as const)
      .filter((level) => supported(caps.effort?.[level]))
      .join(", ");
    const thinkingTypes = (["adaptive", "enabled"] as const)
      .filter((type) => supported(caps.thinking?.types?.[type]))
      .join(", ");
    const createdAt = str(model.created_at) || new Date().toISOString();

    return {
      id: `${accountId}:model:${model.id}`,
      pluginId: "anthropic",
      resourceTypeId: "model",
      accountId,
      displayName: str(model.display_name) || model.id,
      externalId: model.id,
      fields: {
        modelId: model.id,
        displayName: str(model.display_name) || model.id,
        releasedAt: str(model.created_at),
        maxInputTokens: num(model.max_input_tokens),
        maxTokens: num(model.max_tokens),
        vision: supported(caps.image_input),
        pdfInput: supported(caps.pdf_input),
        batch: supported(caps.batch),
        citations: supported(caps.citations),
        codeExecution: supported(caps.code_execution),
        structuredOutputs: supported(caps.structured_outputs),
        thinking: supported(caps.thinking),
        contextManagement: supported(caps.context_management),
        thinkingTypes,
        effortLevels,
      },
      resolvedOutputs: {
        modelId: model.id,
        displayName: str(model.display_name) || model.id,
        maxInputTokens: String(num(model.max_input_tokens)),
      },
      secretStates: [],
      createdAt,
      updatedAt: createdAt,
    };
  }

  private mapBatch(accountId: string, batch: AnthropicMessageBatch): ResourceInstance {
    const counts = batch.request_counts ?? {};
    const total =
      num(counts.processing) +
      num(counts.succeeded) +
      num(counts.errored) +
      num(counts.canceled) +
      num(counts.expired);
    const createdAt = str(batch.created_at) || new Date().toISOString();

    return {
      id: `${accountId}:message-batch:${batch.id}`,
      pluginId: "anthropic",
      resourceTypeId: "message-batch",
      accountId,
      displayName: batch.id,
      externalId: batch.id,
      fields: {
        processingStatus: str(batch.processing_status) || "in_progress",
        processing: num(counts.processing),
        succeeded: num(counts.succeeded),
        errored: num(counts.errored),
        canceled: num(counts.canceled),
        expired: num(counts.expired),
        totalRequests: total,
        createdAt: str(batch.created_at),
        endedAt: str(batch.ended_at),
        expiresAt: str(batch.expires_at),
        archivedAt: str(batch.archived_at),
        cancelInitiatedAt: str(batch.cancel_initiated_at),
        resultsUrl: str(batch.results_url),
      },
      resolvedOutputs: {
        batchId: batch.id,
        resultsUrl: str(batch.results_url),
        processingStatus: str(batch.processing_status),
      },
      secretStates: [],
      createdAt,
      updatedAt: str(batch.ended_at) || createdAt,
    };
  }

  private mapFile(accountId: string, file: AnthropicFile): ResourceInstance {
    const createdAt = str(file.created_at) || new Date().toISOString();
    return {
      id: `${accountId}:file:${file.id}`,
      pluginId: "anthropic",
      resourceTypeId: "file",
      accountId,
      displayName: str(file.filename) || file.id,
      externalId: file.id,
      fields: {
        filename: str(file.filename),
        mimeType: str(file.mime_type),
        sizeBytes: num(file.size_bytes),
        createdAt: str(file.created_at),
        downloadable: file.downloadable === true,
        scopeType: str(file.scope?.type),
        scopeId: str(file.scope?.id),
      },
      resolvedOutputs: { fileId: file.id, filename: str(file.filename) },
      secretStates: [],
      createdAt,
      updatedAt: createdAt,
    };
  }

  private mapWorkspace(accountId: string, workspace: AnthropicWorkspace): ResourceInstance {
    const residency = workspace.data_residency ?? {};
    const allowed = residency.allowed_inference_geos;
    const createdAt = str(workspace.created_at) || new Date().toISOString();
    const tags = workspace.tags ?? {};

    return {
      id: `${accountId}:workspace:${workspace.id}`,
      pluginId: "anthropic",
      resourceTypeId: "workspace",
      accountId,
      displayName: str(workspace.name) || workspace.id,
      externalId: workspace.id,
      fields: {
        name: str(workspace.name),
        displayColor: str(workspace.display_color),
        createdAt: str(workspace.created_at),
        archivedAt: str(workspace.archived_at),
        workspaceGeo: str(residency.workspace_geo),
        defaultInferenceGeo: str(residency.default_inference_geo),
        allowedInferenceGeos: Array.isArray(allowed) ? allowed.join(", ") : str(allowed),
        externalKeyId: str(workspace.external_key_id),
        tags: Object.entries(tags)
          .map(([k, v]) => `${k}=${v}`)
          .join(", "),
      },
      resolvedOutputs: {
        workspaceId: workspace.id,
        workspaceName: str(workspace.name) || workspace.id,
      },
      secretStates: [],
      createdAt,
      updatedAt: str(workspace.archived_at) || createdAt,
    };
  }

  private mapUser(accountId: string, user: AnthropicUser): ResourceInstance {
    const createdAt = str(user.added_at) || new Date().toISOString();
    return {
      id: `${accountId}:organization-user:${user.id}`,
      pluginId: "anthropic",
      resourceTypeId: "organization-user",
      accountId,
      displayName: str(user.name) || str(user.email) || user.id,
      externalId: user.id,
      fields: {
        email: str(user.email),
        name: str(user.name),
        role: str(user.role),
        addedAt: str(user.added_at),
      },
      resolvedOutputs: { userId: user.id, email: str(user.email) },
      secretStates: [],
      createdAt,
      updatedAt: createdAt,
    };
  }

  private mapInvite(accountId: string, invite: AnthropicInvite): ResourceInstance {
    const createdAt = str(invite.invited_at) || new Date().toISOString();
    return {
      id: `${accountId}:invite:${invite.id}`,
      pluginId: "anthropic",
      resourceTypeId: "invite",
      accountId,
      displayName: str(invite.email) || invite.id,
      externalId: invite.id,
      fields: {
        email: str(invite.email),
        role: str(invite.role),
        status: str(invite.status),
        invitedAt: str(invite.invited_at),
        expiresAt: str(invite.expires_at),
        acceptedAt: str(invite.accepted_at),
      },
      resolvedOutputs: { inviteId: invite.id, email: str(invite.email) },
      secretStates: [],
      createdAt,
      updatedAt: str(invite.accepted_at) || createdAt,
    };
  }

  private mapApiKey(accountId: string, key: AnthropicApiKey): ResourceInstance {
    const createdAt = str(key.created_at) || new Date().toISOString();
    const workspaceId = str(key.workspace_id);
    return {
      id: `${accountId}:api-key:${key.id}`,
      pluginId: "anthropic",
      resourceTypeId: "api-key",
      accountId,
      displayName: str(key.name) || key.id,
      externalId: key.id,
      // Keys in the Default Workspace come back with a null workspace_id, so
      // they simply have no parent to hang off.
      ...(workspaceId ? { parentResourceId: `${accountId}:workspace:${workspaceId}` } : {}),
      fields: {
        name: str(key.name),
        status: str(key.status),
        partialKeyHint: str(key.partial_key_hint),
        workspaceId: workspaceId || "Default Workspace",
        createdAt: str(key.created_at),
        expiresAt: str(key.expires_at),
        createdById: str(key.created_by?.id),
        principalType: str(key.principal?.type),
        principalId: str(key.principal?.id),
      },
      resolvedOutputs: {
        apiKeyId: key.id,
        keyName: str(key.name),
        status: str(key.status),
      },
      secretStates: [],
      createdAt,
      updatedAt: createdAt,
    };
  }

  // ---- Rendering -----------------------------------------------------------

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    switch (resource.resourceTypeId) {
      case "model":
        return this.renderModelDetail(resource);
      case "message-batch":
        return this.renderBatchDetail(resource);
      case "file":
        return this.renderFileDetail(resource);
      case "workspace":
        return this.renderWorkspaceDetail(resource);
      case "organization-user":
        return this.renderUserDetail(resource);
      case "invite":
        return this.renderInviteDetail(resource);
      case "api-key":
        return this.renderApiKeyDetail(resource);
      default:
        return {
          title: resource.displayName,
          subtitle: resource.resourceTypeId,
          status: { kind: "status-dot", status: "info" },
          sections: [{ kind: "section", title: "Details", children: [] }],
          headerActions: [refreshAction()],
        };
    }
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    const fields = resource.fields;

    switch (resource.resourceTypeId) {
      case "model":
        return {
          id: resource.id,
          label: resource.displayName,
          status: {
            kind: "status-dot",
            status: "healthy",
            label: fields["vision"] ? "vision" : "text",
          },
        };
      case "message-batch": {
        const status = str(fields["processingStatus"]);
        return {
          id: resource.id,
          label: resource.displayName,
          status: { kind: "status-dot", status: batchStatus(status), label: status },
        };
      }
      case "file":
        return {
          id: resource.id,
          label: resource.displayName,
          status: {
            kind: "status-dot",
            status: "healthy",
            label: formatBytes(num(fields["sizeBytes"])),
          },
        };
      case "workspace": {
        const archived = Boolean(fields["archivedAt"]);
        return {
          id: resource.id,
          label: resource.displayName,
          status: {
            kind: "status-dot",
            status: archived ? "degraded" : "healthy",
            label: archived ? "archived" : "active",
          },
        };
      }
      case "organization-user":
        return {
          id: resource.id,
          label: resource.displayName,
          status: { kind: "status-dot", status: "healthy", label: str(fields["role"]) },
        };
      case "invite": {
        const status = str(fields["status"]);
        return {
          id: resource.id,
          label: resource.displayName,
          status: {
            kind: "status-dot",
            status:
              status === "pending"
                ? "provisioning"
                : status === "accepted"
                  ? "healthy"
                  : "degraded",
            label: status,
          },
        };
      }
      case "api-key": {
        const status = str(fields["status"]);
        return {
          id: resource.id,
          label: resource.displayName,
          status: {
            kind: "status-dot",
            status: status === "active" ? "healthy" : "degraded",
            label: status,
          },
        };
      }
      default:
        return { id: resource.id, label: resource.displayName };
    }
  }

  private renderModelDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    // Rendered as a key-value list rather than a TableNode: `schemaNodeSchema`
    // in plugin-base deliberately omits TableNode from its discriminated
    // union, so a table here would fail the shared contract test.
    const capabilityItems: KVItem[] = (
      [
        ["Image input (vision)", fields["vision"]],
        ["PDF input", fields["pdfInput"]],
        ["Batch API", fields["batch"]],
        ["Citations", fields["citations"]],
        ["Code execution", fields["codeExecution"]],
        ["Structured outputs", fields["structuredOutputs"]],
        ["Extended thinking", fields["thinking"]],
        ["Context management", fields["contextManagement"]],
      ] as const
    ).map(([label, value]) => ({ key: label, value: value ? "Yes" : "No" }));

    const sections: SectionNode[] = [
      {
        kind: "section",
        title: "Model",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Model ID", value: str(fields["modelId"]), copyable: true },
              { key: "Display Name", value: str(fields["displayName"]) },
              { key: "Released", value: str(fields["releasedAt"]) || "—" },
              {
                key: "Context Window",
                value: `${num(fields["maxInputTokens"]).toLocaleString()} tokens`,
              },
              {
                key: "Max Output",
                value: `${num(fields["maxTokens"]).toLocaleString()} tokens`,
              },
            ],
          },
        ],
      },
      {
        kind: "section",
        title: "Capabilities",
        children: [
          { kind: "key-value-list", items: capabilityItems },
          ...(str(fields["thinkingTypes"])
            ? [
                {
                  kind: "text" as const,
                  variant: "muted" as const,
                  content: `Thinking modes: ${str(fields["thinkingTypes"])}`,
                },
              ]
            : []),
          ...(str(fields["effortLevels"])
            ? [
                {
                  kind: "text" as const,
                  variant: "muted" as const,
                  content: `Effort levels: ${str(fields["effortLevels"])}`,
                },
              ]
            : []),
        ],
      },
    ];

    return {
      title: resource.displayName,
      subtitle: str(fields["modelId"]),
      status: { kind: "status-dot", status: "healthy", label: "Available" },
      sections,
      headerActions: [refreshAction()],
      metricsCapability: { defaultTimeRangeMs: 7 * 24 * 60 * 60 * 1000 },
    };
  }

  private renderBatchDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const status = str(fields["processingStatus"]);
    const resultsUrl = str(fields["resultsUrl"]);

    const sections: SectionNode[] = [
      {
        kind: "section",
        title: "Batch",
        children: [
          {
            kind: "key-value-list",
            items: [
              {
                key: "Batch ID",
                value: str(fields["batchId"]) || resource.externalId || "",
                copyable: true,
              },
              { key: "Status", value: status },
              { key: "Created", value: str(fields["createdAt"]) || "—" },
              { key: "Ended", value: str(fields["endedAt"]) || "—" },
              { key: "Expires", value: str(fields["expiresAt"]) || "—" },
              ...(str(fields["cancelInitiatedAt"])
                ? [{ key: "Cancellation Started", value: str(fields["cancelInitiatedAt"]) }]
                : []),
              ...(str(fields["archivedAt"])
                ? [{ key: "Archived", value: str(fields["archivedAt"]) }]
                : []),
            ],
          },
        ],
      },
      {
        kind: "section",
        title: "Requests",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Processing", value: String(num(fields["processing"])) },
              { key: "Succeeded", value: String(num(fields["succeeded"])) },
              { key: "Errored", value: String(num(fields["errored"])) },
              { key: "Canceled", value: String(num(fields["canceled"])) },
              { key: "Expired", value: String(num(fields["expired"])) },
              { key: "Total", value: String(num(fields["totalRequests"])) },
            ],
          },
        ],
      },
      {
        kind: "section",
        title: "Results",
        children: resultsUrl
          ? [
              { kind: "link", label: "Download results (.jsonl)", url: resultsUrl },
              {
                kind: "text",
                variant: "muted",
                content:
                  "Results are JSON Lines — one JSON object per line, not a JSON array — and arrive in arbitrary order. Match each line back to its request on custom_id, never on position.",
              },
            ]
          : [
              {
                kind: "text",
                variant: "muted",
                content:
                  "No results yet. results_url is only populated once every request in the batch has succeeded, errored, been canceled, or expired.",
              },
            ],
      },
    ];

    const headerActions: ActionNode[] = [refreshAction()];
    if (status === "in_progress") {
      headerActions.push({
        kind: "action",
        label: "Cancel batch",
        variant: "danger",
        action: {
          type: "plugin-action",
          actionId: "cancel-batch",
          confirmMessage:
            "Cancel this batch? Requests already in flight may still complete and still be billed — cancellation is best-effort, not a refund.",
          successMessage: "Cancellation initiated.",
        },
      });
    }

    return {
      title: resource.displayName,
      subtitle: `Message Batch · ${status}`,
      status: { kind: "status-dot", status: batchStatus(status), label: status },
      sections,
      headerActions,
    };
  }

  private renderFileDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    return {
      title: resource.displayName,
      subtitle: str(fields["mimeType"]) || "File",
      status: { kind: "status-dot", status: "healthy", label: "Stored" },
      sections: [
        {
          kind: "section",
          title: "File",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "File ID", value: resource.externalId ?? "", copyable: true },
                { key: "Filename", value: str(fields["filename"]) },
                { key: "MIME Type", value: str(fields["mimeType"]) || "—" },
                { key: "Size", value: formatBytes(num(fields["sizeBytes"])) },
                { key: "Created", value: str(fields["createdAt"]) || "—" },
                { key: "Downloadable", value: fields["downloadable"] ? "Yes" : "No" },
                ...(str(fields["scopeType"])
                  ? [
                      {
                        key: "Scope",
                        value: `${str(fields["scopeType"])} ${str(fields["scopeId"])}`.trim(),
                      },
                    ]
                  : []),
              ],
            },
            {
              kind: "text",
              variant: "muted",
              content:
                "Files are scoped to the workspace that owns the API key. Reference this file from a message content block by its file_id.",
            },
          ],
        },
      ],
      headerActions: [refreshAction()],
    };
  }

  private renderWorkspaceDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const archived = Boolean(str(fields["archivedAt"]));

    const headerActions: ActionNode[] = [refreshAction()];
    if (!archived) {
      headerActions.push({
        kind: "action",
        label: "Archive workspace…",
        variant: "danger",
        action: {
          type: "plugin-action",
          actionId: "archive-workspace",
          confirmMessage:
            "Archive this workspace? This immediately revokes EVERY API key scoped to it, and there is no unarchive endpoint — the only way back is to create a new workspace and new keys. Historical usage and cost data is preserved for reporting.",
          successMessage: "Workspace archived. Its API keys have been revoked.",
        },
      });
    }

    return {
      title: resource.displayName,
      subtitle: archived ? "Workspace · archived" : "Workspace",
      status: {
        kind: "status-dot",
        status: archived ? "degraded" : "healthy",
        label: archived ? "Archived" : "Active",
      },
      sections: [
        {
          kind: "section",
          title: "Workspace",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Workspace ID", value: resource.externalId ?? "", copyable: true },
                { key: "Name", value: str(fields["name"]) },
                { key: "Display Color", value: str(fields["displayColor"]) || "—" },
                { key: "Created", value: str(fields["createdAt"]) || "—" },
                ...(archived ? [{ key: "Archived", value: str(fields["archivedAt"]) }] : []),
                ...(str(fields["tags"]) ? [{ key: "Tags", value: str(fields["tags"]) }] : []),
              ],
            },
          ],
        },
        {
          kind: "section",
          title: "Data Residency",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Workspace Geo", value: str(fields["workspaceGeo"]) || "—" },
                { key: "Default Inference Geo", value: str(fields["defaultInferenceGeo"]) || "—" },
                {
                  key: "Allowed Inference Geos",
                  value: str(fields["allowedInferenceGeos"]) || "—",
                },
                ...(str(fields["externalKeyId"])
                  ? [{ key: "CMEK Key", value: str(fields["externalKeyId"]) }]
                  : []),
              ],
            },
            {
              kind: "text",
              variant: "muted",
              content:
                "Workspace geo is immutable after creation. Archiving is irreversible and revokes every API key in the workspace — there is no unarchive endpoint.",
            },
          ],
        },
      ],
      headerActions,
      metricsCapability: { defaultTimeRangeMs: 7 * 24 * 60 * 60 * 1000 },
    };
  }

  private renderUserDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const role = str(fields["role"]);
    const consoleOnly = ["admin", "owner", "primary_owner", "membership_admin"].includes(role);

    return {
      title: resource.displayName,
      subtitle: str(fields["email"]),
      status: { kind: "status-dot", status: "healthy", label: role || "member" },
      sections: [
        {
          kind: "section",
          title: "Member",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "User ID", value: resource.externalId ?? "", copyable: true },
                { key: "Name", value: str(fields["name"]) || "—" },
                { key: "Email", value: str(fields["email"]), copyable: true },
                { key: "Role", value: role },
                { key: "Joined", value: str(fields["addedAt"]) || "—" },
              ],
            },
            ...(consoleOnly
              ? [
                  {
                    kind: "text" as const,
                    variant: "muted" as const,
                    content:
                      "Members holding an admin or owner role cannot be re-roled or removed through the API — change their organization role in the Claude Console first.",
                  },
                ]
              : []),
          ],
        },
      ],
      headerActions: [refreshAction()],
    };
  }

  private renderInviteDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const status = str(fields["status"]);

    return {
      title: resource.displayName,
      subtitle: `Invite · ${status}`,
      status: {
        kind: "status-dot",
        status:
          status === "pending" ? "provisioning" : status === "accepted" ? "healthy" : "degraded",
        label: status,
      },
      sections: [
        {
          kind: "section",
          title: "Invite",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Invite ID", value: resource.externalId ?? "", copyable: true },
                { key: "Email", value: str(fields["email"]), copyable: true },
                { key: "Role", value: str(fields["role"]) },
                { key: "Status", value: status },
                { key: "Invited", value: str(fields["invitedAt"]) || "—" },
                { key: "Expires", value: str(fields["expiresAt"]) || "—" },
                ...(str(fields["acceptedAt"])
                  ? [{ key: "Accepted", value: str(fields["acceptedAt"]) }]
                  : []),
              ],
            },
            {
              kind: "text",
              variant: "muted",
              content:
                "Invites expire 21 days after creation and the expiry cannot be changed. Deleting an invite frees the seat it consumed.",
            },
          ],
        },
      ],
      headerActions: [refreshAction()],
    };
  }

  private renderApiKeyDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const status = str(fields["status"]);

    const headerActions: ActionNode[] = [refreshAction()];
    if (status === "active") {
      headerActions.push({
        kind: "action",
        label: "Deactivate key",
        variant: "danger",
        action: {
          type: "plugin-action",
          actionId: "deactivate-key",
          confirmMessage:
            "Deactivate this API key? Anything using it stops working immediately. Anthropic has no delete endpoint for keys — inactive is as revoked as it gets, and you can flip it back to active later.",
          successMessage: "Key deactivated.",
        },
      });
    } else if (status === "inactive") {
      headerActions.push({
        kind: "action",
        label: "Reactivate key",
        action: {
          type: "plugin-action",
          actionId: "activate-key",
          successMessage: "Key reactivated.",
        },
      });
    }

    return {
      title: resource.displayName,
      subtitle: `API Key · ${status}`,
      status: {
        kind: "status-dot",
        status: status === "active" ? "healthy" : "degraded",
        label: status,
      },
      sections: [
        {
          kind: "section",
          title: "Key",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Key ID", value: resource.externalId ?? "", copyable: true },
                { key: "Name", value: str(fields["name"]) },
                { key: "Status", value: status },
                { key: "Hint", value: str(fields["partialKeyHint"]) || "—" },
                { key: "Workspace", value: str(fields["workspaceId"]) },
                { key: "Created", value: str(fields["createdAt"]) || "—" },
                { key: "Expires", value: str(fields["expiresAt"]) || "never" },
                ...(str(fields["principalType"])
                  ? [
                      {
                        key: "Acts As",
                        value:
                          `${str(fields["principalType"])} ${str(fields["principalId"])}`.trim(),
                      },
                    ]
                  : []),
              ],
            },
            {
              kind: "text",
              variant: "muted",
              content:
                "New API keys can only be created in the Claude Console — the Admin API has no create endpoint, and no delete endpoint either. Revoking is a status change to inactive.",
            },
          ],
        },
      ],
      headerActions,
    };
  }
}

function refreshAction(): ActionNode {
  return { kind: "action", label: "Refresh", action: { type: "refresh-resource" } };
}

function batchStatus(processingStatus: string): ResourceStatus {
  switch (processingStatus) {
    case "ended":
      return "healthy";
    case "canceling":
      return "degraded";
    case "in_progress":
      return "provisioning";
    default:
      return "unknown";
  }
}
