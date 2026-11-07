import type { Credentials } from "./plugin.js";
import { attempt, runPluginEffect } from "@infrawrench/plugin-base/effect";
import type { PluginEffect } from "@infrawrench/plugin-base";
import type {
  CostFetchRange,
  CostRow,
  CreateResourceConfig,
  DashboardStat,
  DetailViewSchema,
  HostServices,
  MetricSeries,
  PluginClient,
  PreflightResult,
  ResourceInstance,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import {
  decodePromptArgs,
  externalIdOf,
  pathEncode,
  rethrowIncompleteList,
} from "@infrawrench/plugin-base";
import type { TemporalContext } from "./api.js";
import { createTemporalContext, statusOf, waitForOperation } from "./api.js";
import type { NamespaceIndex } from "./cost-data.js";
import { TemporalCostCollector } from "./cost-data.js";
import {
  CAPACITY_KEY,
  NAMESPACE_IDS_KEY,
  REGIONS_KEY,
  instance,
  mapApiKey,
  mapConnectivityRule,
  mapExportSink,
  mapNamespace,
  mapNexusEndpoint,
  mapServiceAccount,
  mapUser,
  parseExportSinkId,
  encodePayload,
  roleEnum,
} from "./mappers.js";
import { namespaceSeries, scrapeMetrics } from "./metrics.js";
import { verifyTemporalCredentials } from "./preflight.js";
import type { TemporalRates } from "./pricing.js";
import { ratesFromCredentials } from "./pricing.js";
import { renderTemporalDetail, renderTemporalSidebar } from "./render.js";
import type {
  TcAccess,
  TcApiKey,
  TcConnectivityRule,
  TcConnectivityRuleSpec,
  TcExportSink,
  TcExportSinkSpec,
  TcNamespace,
  TcNamespaceSpec,
  TcNexusEndpoint,
  TcNexusEndpointSpec,
  TcPermission,
  TcRegion,
  TcServiceAccount,
  TcServiceAccountSpec,
  TcUser,
} from "./types.js";
import {
  SEARCH_ATTRIBUTE_LIMITS,
  encodeCaCertificate,
  isSearchAttributeType,
  parseTagList,
  validateDescription,
  validateHttpsUrl,
  validateNamespaceName,
  validateNexusEndpointName,
  validateRetention,
  validateSearchAttributeName,
} from "./validation.js";

const ROLE_OPTIONS = [
  { id: "developer", label: "Developer", description: "Create namespaces and Nexus endpoints" },
  { id: "read", label: "Read", description: "Read-only access to the account" },
  { id: "admin", label: "Admin", description: "Manage everything except owners" },
  { id: "financeadmin", label: "Finance Admin", description: "Read access plus billing" },
  { id: "metricsread", label: "Metrics Read-Only", description: "Read metrics only" },
];

const PERMISSION_OPTIONS = [
  { id: "read", label: "Read" },
  { id: "write", label: "Write" },
  { id: "admin", label: "Admin" },
];

const SEARCH_ATTRIBUTE_TYPES = [
  ["SEARCH_ATTRIBUTE_TYPE_KEYWORD", "Keyword"],
  ["SEARCH_ATTRIBUTE_TYPE_TEXT", "Text"],
  ["SEARCH_ATTRIBUTE_TYPE_INT", "Int"],
  ["SEARCH_ATTRIBUTE_TYPE_DOUBLE", "Double"],
  ["SEARCH_ATTRIBUTE_TYPE_BOOL", "Bool"],
  ["SEARCH_ATTRIBUTE_TYPE_DATETIME", "Datetime"],
  ["SEARCH_ATTRIBUTE_TYPE_KEYWORD_LIST", "KeywordList"],
] as const;

export { SEARCH_ATTRIBUTE_TYPES };

const q = pathEncode;

function bool(raw: string | undefined): boolean {
  return raw === "true" || raw === "1" || raw === "yes" || raw === "on";
}

function splitList(raw: string | undefined): string[] {
  const text = (raw ?? "").trim();
  if (!text) return [];
  if (text.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
    } catch {
      // fall through to comma splitting
    }
  }
  return text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const PERMISSIONS = new Map<string, TcPermission>([
  ["read", "PERMISSION_READ"],
  ["write", "PERMISSION_WRITE"],
  ["admin", "PERMISSION_ADMIN"],
]);

function permissionEnum(raw: string): TcPermission {
  const permission = PERMISSIONS.get(raw.trim().toLowerCase());
  if (!permission) throw new Error(`Unknown namespace permission "${raw}"`);
  return permission;
}

export function regionOption(r: TcRegion): { id: string; label: string; location?: string } {
  const provider = (r.cloudProvider ?? "").replace(/^CLOUD_PROVIDER_/, "");
  return {
    id: r.id ?? "",
    label: `${r.location ?? r.cloudProviderRegion ?? r.id} (${r.id})`,
    ...(provider ? { location: provider } : {}),
  };
}

export class TemporalCloudClient implements PluginClient {
  readonly ctx: TemporalContext;
  private readonly rates: TemporalRates;
  private collector?: TemporalCostCollector;

  constructor(credentials: Credentials, services?: HostServices) {
    const apiKey = (credentials["apiKey"] ?? "").trim();
    if (!apiKey) throw new Error("Temporal Cloud plugin: missing apiKey credential");
    const metricsApiKey = (credentials["metricsApiKey"] ?? "").trim() || apiKey;
    const caCert = credentials["caCert"] ?? "";
    this.ctx = createTemporalContext({
      apiKey,
      metricsApiKey,
      ...(caCert ? { caCert } : {}),
      ...(services?.http ? { http: services.http } : {}),
    });
    this.rates = ratesFromCredentials(credentials);
  }

  // -------------------------------------------------------------------------
  // Raw reads
  // -------------------------------------------------------------------------

  private fetchNamespaces(): Promise<TcNamespace[]> {
    return this.ctx.api.getAll("/cloud/namespaces", "namespaces");
  }

  private async fetchNamespace(id: string): Promise<TcNamespace> {
    const res = await this.ctx.api.get(`/cloud/namespaces/${q(id)}`);
    if (!res.namespace) throw new Error(`Temporal Cloud plugin: namespace ${id} not found`);
    return res.namespace;
  }

  private fetchRegions(): Promise<TcRegion[]> {
    return this.ctx.api.get("/cloud/regions").then((r) => r.regions ?? []);
  }

  private fetchUsers(): Promise<TcUser[]> {
    return this.ctx.api.getAll("/cloud/users", "users");
  }

  private fetchServiceAccounts(): Promise<TcServiceAccount[]> {
    return this.ctx.api.getAll("/cloud/service-accounts", "serviceAccount");
  }

  private fetchApiKeys(): Promise<TcApiKey[]> {
    return this.ctx.api.getAll("/cloud/api-keys", "apiKeys");
  }

  private fetchNexusEndpoints(): Promise<TcNexusEndpoint[]> {
    return this.ctx.api.getAll("/cloud/nexus/endpoints", "endpoints");
  }

  private fetchConnectivityRules(): Promise<TcConnectivityRule[]> {
    // The one list whose document states no maximum page size, so it keeps the
    // default and takes more pages to reach 10,000 rows.
    return this.ctx.api.getAll("/cloud/connectivity-rules", "connectivityRules", {
      pageSize: 100,
      maxPages: 100,
    });
  }

  private fetchExportSinks(namespaceId: string): Promise<TcExportSink[]> {
    return this.ctx.api.getAll(`/cloud/namespaces/${q(namespaceId)}/export-sinks`, "sinks");
  }

  private async fetchUser(id: string): Promise<TcUser> {
    const res = await this.ctx.api.get(`/cloud/users/${q(id)}`);
    if (!res.user) throw new Error(`Temporal Cloud plugin: user ${id} not found`);
    return res.user;
  }

  private async fetchServiceAccount(id: string): Promise<TcServiceAccount> {
    const res = await this.ctx.api.get(`/cloud/service-accounts/${q(id)}`);
    if (!res.serviceAccount)
      throw new Error(`Temporal Cloud plugin: service account ${id} not found`);
    return res.serviceAccount;
  }

  private async fetchApiKey(id: string): Promise<TcApiKey> {
    const res = await this.ctx.api.get(`/cloud/api-keys/${q(id)}`);
    if (!res.apiKey) throw new Error(`Temporal Cloud plugin: API key ${id} not found`);
    return res.apiKey;
  }

  private async fetchNexusEndpoint(id: string): Promise<TcNexusEndpoint> {
    const res = await this.ctx.api.get(`/cloud/nexus/endpoints/${q(id)}`);
    if (!res.endpoint) throw new Error(`Temporal Cloud plugin: Nexus endpoint ${id} not found`);
    return res.endpoint;
  }

  private async fetchExportSink(namespaceId: string, name: string): Promise<TcExportSink> {
    const res = await this.ctx.api.get(
      `/cloud/namespaces/${q(namespaceId)}/export-sinks/${q(name)}`,
    );
    if (!res.sink) throw new Error(`Temporal Cloud plugin: export sink ${name} not found`);
    return res.sink;
  }

  private async fetchConnectivityRule(id: string): Promise<TcConnectivityRule> {
    const res = await this.ctx.api.get(`/cloud/connectivity-rules/${q(id)}`);
    if (!res.connectivityRule) {
      throw new Error(`Temporal Cloud plugin: connectivity rule ${id} not found`);
    }
    return res.connectivityRule;
  }

  private async namespaceIndex(): Promise<NamespaceIndex> {
    const index: NamespaceIndex = new Map();
    for (const ns of await this.fetchNamespaces().catch(noRowsIfDenied<TcNamespace>)) {
      const id = ns.namespace ?? "";
      if (!id) continue;
      const region = ns.activeRegion ?? ns.spec?.regions?.[0];
      index.set(id, {
        ...(region ? { region } : {}),
        ...(ns.tags && Object.keys(ns.tags).length > 0 ? { tags: ns.tags } : {}),
      });
    }
    return index;
  }

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  /**
   * A 403 on one list means the key's role does not cover that type (a
   * namespace-scoped or metrics-only key, say); the rest of the account still
   * works, so that type lists empty. A 401 (bad key) still throws.
   */
  private async scoped(load: () => Promise<ResourceInstance[]>): Promise<ResourceInstance[]> {
    try {
      return await load();
    } catch (err) {
      if (statusOf(err) === 403) return [];
      throw err;
    }
  }

  listResources(typeId: string, accountId: string): PluginEffect<ResourceInstance[]> {
    return attempt(async () => {
      switch (typeId) {
        case "account":
          return [await this.loadAccount(accountId, false)];
        case "namespace":
          return this.scoped(async () =>
            (await this.fetchNamespaces()).map((ns) => mapNamespace(accountId, ns)),
          );
        case "export-sink":
          return this.scoped(async () => {
            const out: ResourceInstance[] = [];
            for (const ns of await this.fetchNamespaces()) {
              const id = ns.namespace ?? "";
              if (!id) continue;
              const sinks = await this.fetchExportSinks(id).catch(
                (err: unknown): TcExportSink[] => {
                  if (statusOf(err) === 403 || statusOf(err) === 404) return [];
                  throw err;
                },
              );
              out.push(...sinks.map((s) => mapExportSink(accountId, id, s)));
            }
            return out;
          });
        case "user":
          return this.scoped(async () =>
            (await this.fetchUsers()).map((u) => mapUser(accountId, u)),
          );
        case "service-account":
          return this.scoped(async () =>
            (await this.fetchServiceAccounts()).map((s) => mapServiceAccount(accountId, s)),
          );
        case "api-key":
          return this.scoped(async () => {
            const [keys, owners] = await Promise.all([this.fetchApiKeys(), this.ownerNames()]);
            return keys.map((k) => mapApiKey(accountId, k, owners));
          });
        case "nexus-endpoint":
          return this.scoped(async () =>
            (await this.fetchNexusEndpoints()).map((e) => mapNexusEndpoint(accountId, e)),
          );
        case "connectivity-rule":
          return this.scoped(async () => {
            const [rules, namespaces] = await Promise.all([
              this.fetchConnectivityRules(),
              this.fetchNamespaces().catch(noRowsIfDenied<TcNamespace>),
            ]);
            return rules.map((r) => mapConnectivityRule(accountId, r, attachedRules(namespaces)));
          });
        default:
          throw new Error(`Temporal Cloud plugin: unknown resource type "${typeId}"`);
      }
    });
  }

  private async ownerNames(): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const [users, sas] = await Promise.all([
      this.fetchUsers().catch(noRowsIfDenied<TcUser>),
      this.fetchServiceAccounts().catch(noRowsIfDenied<TcServiceAccount>),
    ]);
    for (const u of users) if (u.id && u.spec?.email) out.set(u.id, u.spec.email);
    for (const s of sas) if (s.id && s.spec?.name) out.set(s.id, s.spec.name);
    return out;
  }

  private async loadAccount(accountId: string, detailed: boolean): Promise<ResourceInstance> {
    // These two decide the row's id. Reading a failure as "none" would list the
    // account under a placeholder, and the sync would prune the real one.
    const [account, identity, namespaces, regions] = await Promise.all([
      this.ctx.api
        .get("/cloud/account")
        .then((r) => r.account)
        .catch((err: unknown) => {
          if (statusOf(err) === 403) return undefined;
          throw err;
        }),
      this.ctx.api.get("/cloud/current-identity").catch(() => undefined),
      this.fetchNamespaces().catch(noRowsIfDenied<TcNamespace>),
      detailed ? this.fetchRegions().catch((): TcRegion[] => []) : Promise.resolve([]),
    ]);
    const accountIdFromNs = namespaces[0]?.namespace?.split(".").slice(1).join(".") ?? "";
    const id = account?.id || accountIdFromNs || "account";
    const who = identity?.user?.spec?.email ?? identity?.serviceAccount?.spec?.name ?? "";
    const role =
      identity?.user?.spec?.access?.accountAccess?.role ??
      identity?.serviceAccount?.spec?.access?.accountAccess?.role ??
      "";
    const r = instance(
      accountId,
      "account",
      id,
      `Temporal Cloud (${id})`,
      {
        accountId: id,
        state: account?.state?.replace(/^RESOURCE_STATE_/, "").toLowerCase(),
        identity: who,
        identityRole: role
          .replace(/^ROLE_/, "")
          .replace(/_/g, " ")
          .toLowerCase(),
        metricsUri: account?.metrics?.uri,
        namespaceCount: namespaces.length,
        regions: regions
          .map((x) => x.id ?? "")
          .filter(Boolean)
          .join(", "),
      },
      { accountId: id },
    );
    if (detailed) r.resolvedOutputs[REGIONS_KEY] = JSON.stringify(regions);
    return r;
  }

  // -------------------------------------------------------------------------
  // Single reads
  // -------------------------------------------------------------------------

  getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const id = externalIdOf(resourceId);
      switch (typeId) {
        case "account":
          return this.loadAccount(accountId, true);
        case "namespace": {
          const [ns, capacity, regions, rules] = await Promise.all([
            this.fetchNamespace(id),
            this.ctx.api
              .get(`/cloud/namespaces/${q(id)}/capacity-info`)
              .then((r) => r.capacityInfo)
              .catch(() => undefined),
            this.fetchRegions().catch((): TcRegion[] => []),
            this.fetchConnectivityRules()
              .then((list) => list.map((r) => mapConnectivityRule(accountId, r, new Map())))
              .catch(noRows<ResourceInstance>),
          ]);
          const r = mapNamespace(accountId, ns);
          if (capacity) r.resolvedOutputs[CAPACITY_KEY] = JSON.stringify(capacity);
          r.resolvedOutputs[REGIONS_KEY] = JSON.stringify(regions);
          r.resolvedOutputs["__ruleOptions__"] = JSON.stringify(
            rules.map((x) => ({ id: x.externalId, label: x.displayName })),
          );
          return r;
        }
        case "export-sink": {
          const { namespaceId, name } = parseExportSinkId(id);
          return mapExportSink(
            accountId,
            namespaceId,
            await this.fetchExportSink(namespaceId, name),
          );
        }
        case "user":
        case "service-account": {
          const [mapped, namespaces] = await Promise.all([
            typeId === "user"
              ? this.fetchUser(id).then((u) => mapUser(accountId, u))
              : this.fetchServiceAccount(id).then((s) => mapServiceAccount(accountId, s)),
            this.fetchNamespaces().catch(noRows<TcNamespace>),
          ]);
          mapped.resolvedOutputs[NAMESPACE_IDS_KEY] = JSON.stringify(
            namespaces.map((n) => n.namespace ?? "").filter(Boolean),
          );
          return mapped;
        }
        case "api-key":
          return mapApiKey(accountId, await this.fetchApiKey(id), await this.ownerNames());
        case "nexus-endpoint":
          return mapNexusEndpoint(accountId, await this.fetchNexusEndpoint(id));
        case "connectivity-rule": {
          const [rule, namespaces] = await Promise.all([
            this.fetchConnectivityRule(id),
            this.fetchNamespaces().catch(noRows<TcNamespace>),
          ]);
          return mapConnectivityRule(accountId, rule, attachedRules(namespaces));
        }
        default:
          throw new Error(`Temporal Cloud plugin: unknown resource type "${typeId}"`);
      }
    });
  }

  resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): PluginEffect<string> {
    return attempt(async () => {
      const resource = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
      const resolved = resource.resolvedOutputs[outputKey];
      if (resolved !== undefined) return resolved;
      const field = resource.fields[outputKey];
      if (field !== undefined) return String(field);
      if (outputKey === "endpointId" || outputKey === "keyId" || outputKey === "ruleId") {
        return resource.externalId ?? "";
      }
      throw new Error(
        `Temporal Cloud plugin: cannot resolve output "${outputKey}" for type "${typeId}"`,
      );
    });
  }

  // -------------------------------------------------------------------------
  // Stats, metrics and costs
  // -------------------------------------------------------------------------

  fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): PluginEffect<DashboardStat[]> {
    return attempt(async () => {
      if (resourceTypeId === "namespace") {
        const id = externalIdOf(resourceId);
        const [ns, samples] = await Promise.all([
          this.fetchNamespace(id),
          scrapeMetrics(this.ctx).catch(() => []),
        ]);
        const series = namespaceSeries(samples, id);
        const value = (label: string) => series.find((s) => s.label === label)?.points[0]?.value;
        const aps = value("Actions/s");
        const failed = value("Workflows failed/s");
        return [
          {
            label: "State",
            value: (ns.state ?? "").replace(/^RESOURCE_STATE_/, "").toLowerCase() || "unknown",
            variant: ns.state === "RESOURCE_STATE_ACTIVE" ? "status-healthy" : "status-degraded",
          },
          { label: "Actions/s", value: aps !== undefined ? aps.toFixed(1) : "—" },
          {
            label: "Failed/s",
            value: failed !== undefined ? failed.toFixed(2) : "—",
            ...(failed !== undefined && failed > 0 ? { variant: "status-degraded" as const } : {}),
          },
          { label: "Retention", value: `${ns.spec?.retentionDays ?? "?"} d` },
        ];
      }
      const r = await runPluginEffect(this.getResource(resourceTypeId, resourceId, accountId));
      switch (resourceTypeId) {
        case "account":
          return [
            { label: "Namespaces", value: String(r.fields["namespaceCount"] ?? 0) },
            { label: "Key role", value: String(r.fields["identityRole"] ?? "—") },
          ];
        case "export-sink":
          return [
            {
              label: "Health",
              value: String(r.fields["health"] ?? "—"),
              variant: r.fields["health"] === "ok" ? "status-healthy" : "status-degraded",
            },
            { label: "Enabled", value: r.fields["enabled"] === true ? "Yes" : "No" },
          ];
        default:
          return [{ label: "State", value: String(r.fields["state"] ?? "—") }];
      }
    });
  }

  fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
  ): PluginEffect<MetricSeries[]> {
    return attempt(async () => {
      if (resourceTypeId !== "namespace") return [];
      return namespaceSeries(await scrapeMetrics(this.ctx), externalIdOf(resourceId));
    });
  }

  fetchCostData(_accountId: string, range: CostFetchRange): PluginEffect<CostRow[]> {
    return attempt(async () => {
      this.collector ??= new TemporalCostCollector(this.ctx, this.rates, () =>
        this.namespaceIndex(),
      );
      return this.collector.fetch(range);
    });
  }

  verifyCredentials(): PluginEffect<PreflightResult> {
    return attempt(async () => {
      return verifyTemporalCredentials(this.ctx);
    });
  }

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------

  private async namespaceOptions(): Promise<Array<{ id: string; label: string }>> {
    return (await this.fetchNamespaces().catch(noRows<TcNamespace>))
      .map((n) => ({ id: n.namespace ?? "", label: n.namespace ?? "" }))
      .filter((o) => o.id)
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  getCreateConfig(typeId: string, parentResourceId?: string): PluginEffect<CreateResourceConfig> {
    return attempt(async () => {
      switch (typeId) {
        case "namespace": {
          const regions = await this.fetchRegions().catch((): TcRegion[] => []);
          return {
            fields: [
              {
                key: "name",
                label: "Name",
                kind: "text",
                required: true,
                placeholder: "payments-prod",
                description:
                  "2 to 39 lowercase letters, digits and hyphens. The account id is appended to form the namespace id. It cannot be changed later.",
              },
              {
                key: "region",
                label: "Region",
                kind: "region-picker",
                required: true,
                regions: regions.map(regionOption),
              },
              {
                key: "retentionDays",
                label: "Retention (days)",
                kind: "number",
                required: true,
                defaultValue: "30",
                minValue: 1,
                maxValue: 90,
                stepValue: 1,
                description: "How long closed workflow histories are kept.",
              },
              {
                key: "auth",
                label: "Client Authentication",
                kind: "select",
                required: true,
                defaultValue: "api-key",
                options: [
                  { id: "api-key", label: "API keys" },
                  { id: "mtls", label: "mTLS certificates" },
                  { id: "both", label: "API keys and mTLS" },
                ],
              },
              {
                key: "caCertificate",
                label: "CA Certificate (PEM)",
                kind: "text",
                multiline: true,
                required: false,
                showWhen: { fieldKey: "auth", fieldValues: ["mtls", "both"] },
                placeholder: "-----BEGIN CERTIFICATE-----",
                description: "The CA that signs your clients' certificates.",
              },
              {
                key: "description",
                label: "Description",
                kind: "text",
                required: false,
              },
              {
                key: "deleteProtection",
                label: "Delete Protection",
                kind: "select",
                required: false,
                defaultValue: "true",
                options: [
                  { id: "true", label: "On" },
                  { id: "false", label: "Off" },
                ],
              },
            ],
          };
        }
        case "export-sink":
          return {
            fields: [
              ...(parentResourceId
                ? []
                : [
                    {
                      key: "namespace",
                      label: "Namespace",
                      kind: "select" as const,
                      required: true,
                      options: await this.namespaceOptions(),
                    },
                  ]),
              {
                key: "name",
                label: "Sink Name",
                kind: "text",
                required: true,
                description: "Unique within the namespace; it cannot be changed later.",
              },
              {
                key: "destination",
                label: "Destination",
                kind: "select",
                required: true,
                defaultValue: "s3",
                options: [
                  { id: "s3", label: "Amazon S3" },
                  { id: "gcs", label: "Google Cloud Storage" },
                ],
              },
              { key: "bucketName", label: "Bucket", kind: "text", required: true },
              {
                key: "bucketRegion",
                label: "Bucket Region",
                kind: "text",
                required: true,
                placeholder: "us-east-1",
              },
              {
                key: "roleName",
                label: "IAM Role Name",
                kind: "text",
                required: false,
                showWhen: { fieldKey: "destination", fieldValue: "s3" },
                description: "The role Temporal Cloud assumes to write to the bucket.",
              },
              {
                key: "awsAccountId",
                label: "AWS Account ID",
                kind: "text",
                required: false,
                showWhen: { fieldKey: "destination", fieldValue: "s3" },
              },
              {
                key: "kmsArn",
                label: "KMS Key ARN",
                kind: "text",
                required: false,
                showWhen: { fieldKey: "destination", fieldValue: "s3" },
              },
              {
                key: "gcpProjectId",
                label: "GCP Project ID",
                kind: "text",
                required: false,
                showWhen: { fieldKey: "destination", fieldValue: "gcs" },
              },
              {
                key: "serviceAccountId",
                label: "Service Account ID",
                kind: "text",
                required: false,
                showWhen: { fieldKey: "destination", fieldValue: "gcs" },
                description: "The service account Temporal Cloud impersonates to write.",
              },
            ],
          };
        case "user":
          return {
            fields: [
              { key: "email", label: "Email", kind: "text", required: true },
              {
                key: "accountRole",
                label: "Account Role",
                kind: "select",
                required: true,
                defaultValue: "developer",
                options: ROLE_OPTIONS,
              },
            ],
          };
        case "service-account":
          return {
            fields: [
              { key: "name", label: "Name", kind: "text", required: true },
              { key: "description", label: "Description", kind: "text", required: false },
              {
                key: "scope",
                label: "Scope",
                kind: "select",
                required: true,
                defaultValue: "account",
                options: [
                  { id: "account", label: "Account", description: "Account role plus namespaces" },
                  {
                    id: "namespace",
                    label: "One namespace",
                    description: "Bound to one namespace",
                  },
                ],
              },
              {
                key: "accountRole",
                label: "Account Role",
                kind: "select",
                required: false,
                defaultValue: "read",
                options: ROLE_OPTIONS,
                showWhen: { fieldKey: "scope", fieldValue: "account" },
              },
              {
                key: "namespace",
                label: "Namespace",
                kind: "select",
                required: false,
                options: await this.namespaceOptions(),
                showWhen: { fieldKey: "scope", fieldValue: "namespace" },
              },
              {
                key: "permission",
                label: "Namespace Permission",
                kind: "select",
                required: false,
                defaultValue: "write",
                options: PERMISSION_OPTIONS,
                showWhen: { fieldKey: "scope", fieldValue: "namespace" },
              },
            ],
          };
        case "nexus-endpoint": {
          const namespaces = await this.namespaceOptions();
          return {
            fields: [
              {
                key: "name",
                label: "Name",
                kind: "text",
                required: true,
                placeholder: "payments-api",
              },
              {
                key: "targetNamespace",
                label: "Target Namespace",
                kind: "select",
                required: true,
                options: namespaces,
              },
              { key: "taskQueue", label: "Target Task Queue", kind: "text", required: true },
              {
                key: "allowedCallers",
                label: "Allowed Caller Namespaces",
                kind: "policy-picker",
                required: false,
                policies: namespaces.map((n) => ({ id: n.id, label: n.label })),
              },
              {
                key: "description",
                label: "Description",
                kind: "text",
                multiline: true,
                required: false,
              },
            ],
          };
        }
        case "connectivity-rule": {
          const regions = await this.fetchRegions().catch((): TcRegion[] => []);
          return {
            fields: [
              {
                key: "type",
                label: "Type",
                kind: "select",
                required: true,
                defaultValue: "private",
                options: [
                  { id: "private", label: "Private connection" },
                  { id: "public", label: "Public internet" },
                ],
              },
              {
                key: "stableIps",
                label: "Stable IPs",
                kind: "select",
                required: false,
                defaultValue: "false",
                options: [
                  { id: "false", label: "Off" },
                  { id: "true", label: "On" },
                ],
                showWhen: { fieldKey: "type", fieldValue: "public" },
              },
              {
                key: "region",
                label: "Region",
                kind: "region-picker",
                required: false,
                regions: regions.map(regionOption),
                showWhen: { fieldKey: "type", fieldValue: "private" },
              },
              {
                key: "connectionId",
                label: "Connection ID",
                kind: "text",
                required: false,
                showWhen: { fieldKey: "type", fieldValue: "private" },
                description:
                  "AWS: the VPC endpoint id (vpce-…). GCP: the Private Service Connect connection id. Azure: leave empty, Temporal Cloud fills it in once the connection is approved.",
              },
              {
                key: "azurePeResourceId",
                label: "Azure Private Endpoint Resource ID",
                kind: "text",
                required: false,
                showWhen: { fieldKey: "type", fieldValue: "private" },
                placeholder:
                  "/subscriptions/…/resourceGroups/…/providers/Microsoft.Network/privateEndpoints/…",
                description: "Only for Azure regions, where it is required.",
              },
              {
                key: "gcpProjectId",
                label: "GCP Project ID",
                kind: "text",
                required: false,
                showWhen: { fieldKey: "type", fieldValue: "private" },
                description: "Only for GCP regions.",
              },
            ],
          };
        }
        default:
          throw new Error(`Temporal Cloud plugin: cannot create "${typeId}" from Infrawrench`);
      }
    });
  }

  createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      switch (typeId) {
        case "namespace":
          return this.createNamespace(accountId, fields);
        case "export-sink": {
          const namespaceId =
            (fields["namespace"] ?? "").trim() ||
            (parentResourceId ? externalIdOf(parentResourceId) : "");
          if (!namespaceId) throw new Error("Pick the namespace to export from");
          const spec = exportSinkSpec(fields, true);
          const res = await this.ctx.api.post(`/cloud/namespaces/${q(namespaceId)}/export-sinks`, {
            body: { spec },
          });
          await waitForOperation(this.ctx, res.asyncOperation, 10_000);
          return this.fetchExportSink(namespaceId, spec.name)
            .then((s) => mapExportSink(accountId, namespaceId, s))
            .catch(() => mapExportSink(accountId, namespaceId, { name: spec.name, spec }));
        }
        case "user": {
          const email = (fields["email"] ?? "").trim();
          if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("Enter a valid email");
          const res = await this.ctx.api.post("/cloud/users", {
            body: {
              spec: {
                email,
                access: { accountAccess: { role: roleEnum(fields["accountRole"] || "read") } },
              },
            },
          });
          await waitForOperation(this.ctx, res.asyncOperation, 10_000);
          if (!res.userId) throw new Error("Temporal Cloud returned no user id");
          return mapUser(accountId, await this.fetchUser(res.userId));
        }
        case "service-account": {
          const name = (fields["name"] ?? "").trim();
          if (!name) throw new Error("A service account needs a name");
          const scoped = fields["scope"] === "namespace";
          const namespace = (fields["namespace"] ?? "").trim();
          if (scoped && !namespace) throw new Error("Pick the namespace to scope it to");
          const spec: TcServiceAccountSpec = {
            name,
            ...(fields["description"] ? { description: fields["description"] } : {}),
            ...(scoped
              ? {
                  namespaceScopedAccess: {
                    namespace,
                    access: { permission: permissionEnum(fields["permission"] || "write") },
                  },
                }
              : {
                  access: { accountAccess: { role: roleEnum(fields["accountRole"] || "read") } },
                }),
          };
          const res = await this.ctx.api.post("/cloud/service-accounts", { body: { spec } });
          await waitForOperation(this.ctx, res.asyncOperation, 10_000);
          if (!res.serviceAccountId)
            throw new Error("Temporal Cloud returned no service account id");
          return mapServiceAccount(accountId, await this.fetchServiceAccount(res.serviceAccountId));
        }
        case "nexus-endpoint": {
          const spec = nexusSpec(fields);
          const res = await this.ctx.api.post("/cloud/nexus/endpoints", { body: { spec } });
          await waitForOperation(this.ctx, res.asyncOperation, 10_000);
          if (!res.endpointId) throw new Error("Temporal Cloud returned no endpoint id");
          return mapNexusEndpoint(accountId, await this.fetchNexusEndpoint(res.endpointId));
        }
        case "connectivity-rule": {
          let spec: TcConnectivityRuleSpec;
          if (fields["type"] === "public") {
            spec = { publicRule: { enableStableIps: bool(fields["stableIps"]) } };
          } else {
            const region = (fields["region"] ?? "").trim();
            if (!region) throw new Error("Pick the region of the private connection");
            spec = { privateRule: privateRule(region, fields) };
          }
          const res = await this.ctx.api.post("/cloud/connectivity-rules", { body: { spec } });
          await waitForOperation(this.ctx, res.asyncOperation, 10_000);
          if (!res.connectivityRuleId) throw new Error("Temporal Cloud returned no rule id");
          return mapConnectivityRule(
            accountId,
            await this.fetchConnectivityRule(res.connectivityRuleId),
            new Map(),
          );
        }
        default:
          throw new Error(`Temporal Cloud plugin: cannot create "${typeId}" from Infrawrench`);
      }
    });
  }

  private async createNamespace(
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const name = validateNamespaceName(fields["name"] ?? "");
    const region = (fields["region"] ?? "").trim();
    if (!region) throw new Error("Pick a region");
    const retentionDays = validateRetention(fields["retentionDays"] || "30");
    const auth = fields["auth"] || "api-key";
    const ca = encodeCaCertificate(fields["caCertificate"] ?? "");
    if ((auth === "mtls" || auth === "both") && !ca) {
      throw new Error(
        "mTLS authentication needs the CA certificate that signs client certificates",
      );
    }
    const description = validateDescription(fields["description"] ?? "");
    const spec: TcNamespaceSpec = {
      name,
      regions: [region],
      retentionDays,
      apiKeyAuth: { enabled: auth === "api-key" || auth === "both" },
      ...(ca ? { mtlsAuth: { enabled: true, acceptedClientCa: ca } } : {}),
      ...(description ? { description } : {}),
      lifecycle: { enableDeleteProtection: fields["deleteProtection"] !== "false" },
    };
    const res = await this.ctx.api.post("/cloud/namespaces", { body: { spec } });
    await waitForOperation(this.ctx, res.asyncOperation, 15_000);
    const id = res.namespace ?? name;
    return this.fetchNamespace(id)
      .then((ns) => mapNamespace(accountId, ns))
      .catch(() =>
        mapNamespace(accountId, { namespace: id, state: "RESOURCE_STATE_ACTIVATING", spec }),
      );
  }

  // -------------------------------------------------------------------------
  // Update
  // -------------------------------------------------------------------------

  updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const id = externalIdOf(resourceId);
      switch (typeId) {
        case "namespace":
          await this.updateNamespace(id, fields);
          return mapNamespace(accountId, await this.fetchNamespace(id));
        case "export-sink": {
          const { namespaceId, name } = parseExportSinkId(id);
          const current = await this.fetchExportSink(namespaceId, name);
          const spec = editedExportSinkSpec(current, name, fields);
          const res = await this.ctx.api.post(
            `/cloud/namespaces/${q(namespaceId)}/export-sinks/${q(name)}`,
            { body: { spec, resourceVersion: current.resourceVersion } },
          );
          await waitForOperation(this.ctx, res.asyncOperation, 10_000);
          return mapExportSink(
            accountId,
            namespaceId,
            await this.fetchExportSink(namespaceId, name),
          );
        }
        case "user": {
          const user = await this.fetchUser(id);
          if ("accountRole" in fields) {
            await this.saveUser(user, {
              ...user.spec?.access,
              accountAccess: {
                ...user.spec?.access?.accountAccess,
                role: roleEnum(fields["accountRole"] ?? ""),
              },
            });
          }
          return mapUser(accountId, await this.fetchUser(id));
        }
        case "service-account": {
          const sa = await this.fetchServiceAccount(id);
          const spec = { ...sa.spec };
          if ("name" in fields) {
            const name = (fields["name"] ?? "").trim();
            if (!name) throw new Error("A service account needs a name");
            spec.name = name;
          }
          if ("description" in fields) spec.description = fields["description"] ?? "";
          if ("accountRole" in fields && fields["accountRole"] && !spec.namespaceScopedAccess) {
            spec.access = {
              ...spec.access,
              accountAccess: {
                ...spec.access?.accountAccess,
                role: roleEnum(fields["accountRole"]),
              },
            };
          }
          await this.saveServiceAccount(sa, spec);
          return mapServiceAccount(accountId, await this.fetchServiceAccount(id));
        }
        case "api-key": {
          const key = await this.fetchApiKey(id);
          const spec = { ...key.spec };
          if ("displayName" in fields) spec.displayName = (fields["displayName"] ?? "").trim();
          if ("description" in fields) spec.description = fields["description"] ?? "";
          await this.saveApiKey(key, spec);
          return mapApiKey(accountId, await this.fetchApiKey(id), await this.ownerNames());
        }
        case "nexus-endpoint": {
          const current = await this.fetchNexusEndpoint(id);
          const merged = {
            ...Object.fromEntries(
              Object.entries(mapNexusEndpoint(accountId, current).fields).map(([k, v]) => [
                k,
                String(v),
              ]),
            ),
            ...fields,
          };
          const known = new Set((await this.namespaceOptions()).map((n) => n.id));
          for (const ns of splitList(merged["allowedCallers"])) {
            if (known.size > 0 && !known.has(ns)) {
              throw new Error(`"${ns}" is not a namespace in this account`);
            }
          }
          const res = await this.ctx.api.post(`/cloud/nexus/endpoints/${q(id)}`, {
            body: { spec: nexusSpec(merged), resourceVersion: current.resourceVersion },
          });
          await waitForOperation(this.ctx, res.asyncOperation, 10_000);
          return mapNexusEndpoint(accountId, await this.fetchNexusEndpoint(id));
        }
        default:
          throw new Error(`Temporal Cloud plugin: "${typeId}" cannot be edited from Infrawrench`);
      }
    });
  }

  private async updateNamespace(id: string, fields: Record<string, string>): Promise<void> {
    const ns = await this.fetchNamespace(id);
    const spec: TcNamespaceSpec = { ...(ns.spec ?? {}) };
    let specChanged = false;
    if ("retentionDays" in fields) {
      spec.retentionDays = validateRetention(fields["retentionDays"] ?? "");
      specChanged = true;
    }
    if ("description" in fields) {
      spec.description = validateDescription(fields["description"] ?? "");
      specChanged = true;
    }
    if ("deleteProtection" in fields) {
      spec.lifecycle = {
        ...spec.lifecycle,
        enableDeleteProtection: bool(fields["deleteProtection"]),
      };
      specChanged = true;
    }
    if ("apiKeyAuth" in fields) {
      const enabled = bool(fields["apiKeyAuth"]);
      if (!enabled && !spec.mtlsAuth?.acceptedClientCa) {
        throw new Error(
          "Turning off API key authentication would leave this namespace with no way for clients to connect: it has no mTLS CA certificate",
        );
      }
      spec.apiKeyAuth = { enabled };
      specChanged = true;
    }
    if ("codecServerEndpoint" in fields) {
      const endpoint = validateHttpsUrl(fields["codecServerEndpoint"] ?? "");
      if (endpoint) spec.codecServer = { ...spec.codecServer, endpoint };
      else delete spec.codecServer;
      specChanged = true;
    }
    if ("taskQueueFairness" in fields) {
      spec.fairness = { taskQueueFairnessEnabled: bool(fields["taskQueueFairness"]) };
      specChanged = true;
    }
    if (specChanged) {
      const res = await this.ctx.api.post(`/cloud/namespaces/${q(id)}`, {
        body: { spec, resourceVersion: ns.resourceVersion },
      });
      await waitForOperation(this.ctx, res.asyncOperation);
    }
    if ("tags" in fields) {
      const next = parseTagList(fields["tags"] ?? "");
      const current = ns.tags ?? {};
      const tagsToUpsert = Object.fromEntries(
        Object.entries(next).filter(([k, v]) => current[k] !== v),
      );
      const tagsToRemove = Object.keys(current).filter((k) => !(k in next));
      if (Object.keys(tagsToUpsert).length > 0 || tagsToRemove.length > 0) {
        const res = await this.ctx.api.post(`/cloud/namespaces/${q(id)}/update-tags`, {
          body: { tagsToUpsert, tagsToRemove },
        });
        await waitForOperation(this.ctx, res.asyncOperation);
      }
    }
  }

  private async saveNamespaceSpec(ns: TcNamespace, spec: TcNamespaceSpec): Promise<void> {
    const res = await this.ctx.api.post(`/cloud/namespaces/${q(ns.namespace ?? "")}`, {
      body: { spec, resourceVersion: ns.resourceVersion },
    });
    await waitForOperation(this.ctx, res.asyncOperation);
  }

  private async saveUser(user: TcUser, access: TcAccess): Promise<void> {
    const res = await this.ctx.api.post(`/cloud/users/${q(user.id ?? "")}`, {
      body: { spec: { ...user.spec, access }, resourceVersion: user.resourceVersion },
    });
    await waitForOperation(this.ctx, res.asyncOperation, 10_000);
  }

  private async saveServiceAccount(
    sa: TcServiceAccount,
    spec: NonNullable<TcServiceAccount["spec"]>,
  ): Promise<void> {
    const res = await this.ctx.api.post(`/cloud/service-accounts/${q(sa.id ?? "")}`, {
      body: { spec, resourceVersion: sa.resourceVersion },
    });
    await waitForOperation(this.ctx, res.asyncOperation, 10_000);
  }

  private async saveApiKey(key: TcApiKey, spec: NonNullable<TcApiKey["spec"]>): Promise<void> {
    const res = await this.ctx.api.post(`/cloud/api-keys/${q(key.id ?? "")}`, {
      body: { spec, resourceVersion: key.resourceVersion },
    });
    await waitForOperation(this.ctx, res.asyncOperation, 10_000);
  }

  // -------------------------------------------------------------------------
  // Delete
  // -------------------------------------------------------------------------

  deleteResource(typeId: string, resourceId: string, _accountId: string): PluginEffect<void> {
    return attempt(async () => {
      const id = externalIdOf(resourceId);
      const res = await this.sendDelete(typeId, id);
      await waitForOperation(this.ctx, res?.asyncOperation, 10_000);
    });
  }

  /** Each object is deleted at the version just read, so a concurrent edit is refused. */
  private async sendDelete(typeId: string, id: string) {
    switch (typeId) {
      case "namespace": {
        const ns = await this.fetchNamespace(id);
        if (ns.spec?.lifecycle?.enableDeleteProtection) {
          throw new Error(
            "Delete protection is on for this namespace. Turn it off with Edit first; deleting a namespace removes all of its workflow data for good.",
          );
        }
        return this.ctx.api.delete(`/cloud/namespaces/${q(id)}`, {
          query: versioned(ns.resourceVersion),
        });
      }
      case "export-sink": {
        const { namespaceId, name } = parseExportSinkId(id);
        const sink = await this.fetchExportSink(namespaceId, name);
        return this.ctx.api.delete(`/cloud/namespaces/${q(namespaceId)}/export-sinks/${q(name)}`, {
          query: versioned(sink.resourceVersion),
        });
      }
      case "user": {
        const user = await this.fetchUser(id);
        return this.ctx.api.delete(`/cloud/users/${q(id)}`, {
          query: versioned(user.resourceVersion),
        });
      }
      case "service-account": {
        const sa = await this.fetchServiceAccount(id);
        return this.ctx.api.delete(`/cloud/service-accounts/${q(id)}`, {
          query: versioned(sa.resourceVersion),
        });
      }
      case "api-key": {
        const key = await this.fetchApiKey(id);
        return this.ctx.api.delete(`/cloud/api-keys/${q(id)}`, {
          query: versioned(key.resourceVersion),
        });
      }
      case "nexus-endpoint": {
        const endpoint = await this.fetchNexusEndpoint(id);
        return this.ctx.api.delete(`/cloud/nexus/endpoints/${q(id)}`, {
          query: versioned(endpoint.resourceVersion),
        });
      }
      case "connectivity-rule": {
        const rule = await this.fetchConnectivityRule(id);
        return this.ctx.api.delete(`/cloud/connectivity-rules/${q(id)}`, {
          query: versioned(rule.resourceVersion),
        });
      }
      default:
        throw new Error(`Temporal Cloud plugin: "${typeId}" cannot be deleted from Infrawrench`);
    }
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    _accountId: string,
  ): PluginEffect<void> {
    return attempt(async () => {
      const id = externalIdOf(resourceId);
      if (typeId === "api-key" && (actionId === "disable" || actionId === "enable")) {
        const key = await this.fetchApiKey(id);
        await this.saveApiKey(key, { ...key.spec, disabled: actionId === "disable" });
        return;
      }
      if (typeId === "export-sink" && (actionId === "enable" || actionId === "disable")) {
        await runPluginEffect(
          this.updateResource(typeId, resourceId, _accountId, {
            enabled: String(actionId === "enable"),
          }),
        );
        return;
      }
      if (typeId === "export-sink" && actionId === "validate") {
        const { namespaceId, name } = parseExportSinkId(id);
        const sink = await this.fetchExportSink(namespaceId, name);
        await this.ctx.api.post(`/cloud/namespaces/${q(namespaceId)}/export-sink-validate`, {
          body: { spec: sink.spec },
        });
        return;
      }
      throw new Error(`Temporal Cloud plugin: unknown action "${actionId}" for "${typeId}"`);
    });
  }

  /** Parameterised actions, posted by `prompt-nosql-command` forms. */
  executeNoSqlCommand(
    typeId: string,
    resourceId: string,
    _accountId: string,
    command: string,
    args: (string | number)[],
  ): PluginEffect<unknown> {
    return attempt(async () => {
      const id = externalIdOf(resourceId);
      const form = decodePromptArgs(args);
      if (typeId === "namespace") return this.namespaceCommand(id, command, form);
      if (
        (typeId === "user" || typeId === "service-account") &&
        command === "set-namespace-access"
      ) {
        return this.setNamespaceAccess(typeId, id, form);
      }
      throw new Error(`Temporal Cloud plugin: command "${command}" not supported for "${typeId}"`);
    });
  }

  private async namespaceCommand(
    id: string,
    command: string,
    form: Record<string, string>,
  ): Promise<{ ok: boolean }> {
    const ns = await this.fetchNamespace(id);
    const spec: TcNamespaceSpec = { ...(ns.spec ?? {}) };
    switch (command) {
      case "add-search-attribute": {
        const name = validateSearchAttributeName(form["name"] ?? "");
        const type = form["type"] ?? "";
        if (!isSearchAttributeType(type)) throw new Error("Pick a search attribute type");
        const existing = spec.searchAttributes ?? {};
        if (name in existing) throw new Error(`"${name}" already exists on this namespace`);
        const sameType = Object.values(existing).filter((t) => t === type).length;
        const limit = SEARCH_ATTRIBUTE_LIMITS[type] ?? 0;
        if (sameType >= limit) {
          throw new Error(
            `This namespace already has the maximum of ${limit} custom search attributes of that type`,
          );
        }
        spec.searchAttributes = { ...existing, [name]: type };
        await this.saveNamespaceSpec(ns, spec);
        return { ok: true };
      }
      case "rename-search-attribute": {
        const from = form["existing"] ?? "";
        const to = validateSearchAttributeName(form["newName"] ?? "");
        const existing = spec.searchAttributes ?? {};
        if (!(from in existing)) throw new Error(`"${from}" is not a custom search attribute here`);
        if (to in existing) throw new Error(`"${to}" already exists on this namespace`);
        const res = await this.ctx.api.post(
          `/cloud/namespaces/${q(id)}/rename-custom-search-attribute`,
          {
            body: {
              existingCustomSearchAttributeName: from,
              newCustomSearchAttributeName: to,
              resourceVersion: ns.resourceVersion,
            },
          },
        );
        await waitForOperation(this.ctx, res.asyncOperation);
        return { ok: true };
      }
      case "failover": {
        const region = form["region"] ?? "";
        const regions = spec.regions ?? [];
        if (regions.length < 2) {
          throw new Error("Failover needs a namespace replicated to more than one region");
        }
        if (!regions.includes(region) || region === ns.activeRegion) {
          throw new Error("Pick a replica region other than the active one");
        }
        if ((form["confirm"] ?? "").trim() !== (spec.name ?? id.split(".")[0])) {
          throw new Error("Type the namespace name to confirm the failover");
        }
        const res = await this.ctx.api.post(`/cloud/namespaces/${q(id)}/failover-region`, {
          body: { region },
        });
        await waitForOperation(this.ctx, res.asyncOperation, 30_000);
        return { ok: true };
      }
      case "add-region": {
        const region = form["region"] ?? "";
        if (!region) throw new Error("Pick a region for the replica");
        if ((spec.regions ?? []).includes(region)) {
          throw new Error("The namespace is already in that region");
        }
        const res = await this.ctx.api.post(`/cloud/namespaces/${q(id)}/add-region`, {
          body: { region, resourceVersion: ns.resourceVersion },
        });
        await waitForOperation(this.ctx, res.asyncOperation);
        return { ok: true };
      }
      case "remove-region": {
        const region = form["region"] ?? "";
        if (region === ns.activeRegion) {
          throw new Error("Fail over away from the active region before removing it");
        }
        if (!(spec.regions ?? []).includes(region)) throw new Error("Pick one of the replicas");
        const res = await this.ctx.api.delete(`/cloud/namespaces/${q(id)}/regions/${q(region)}`, {
          query: versioned(ns.resourceVersion),
        });
        await waitForOperation(this.ctx, res?.asyncOperation);
        return { ok: true };
      }
      case "set-connectivity-rules": {
        spec.connectivityRuleIds = splitList(form["rules"]);
        await this.saveNamespaceSpec(ns, spec);
        return { ok: true };
      }
      default:
        throw new Error(`Temporal Cloud plugin: unknown namespace command "${command}"`);
    }
  }

  private async setNamespaceAccess(
    typeId: "user" | "service-account",
    id: string,
    form: Record<string, string>,
  ): Promise<{ ok: boolean }> {
    const namespace = (form["namespace"] ?? "").trim();
    if (!namespace) throw new Error("Pick a namespace");
    const permission = (form["permission"] ?? "").trim();
    const apply = (accesses: TcAccess["namespaceAccesses"] = {}) => {
      const next = { ...accesses };
      if (permission === "none") delete next[namespace];
      else next[namespace] = { permission: permissionEnum(permission) };
      return next;
    };
    if (typeId === "user") {
      const user = await this.fetchUser(id);
      const role = user.spec?.access?.accountAccess?.role;
      if (role === "ROLE_OWNER" || role === "ROLE_ADMIN") {
        throw new Error("Owners and admins already have access to every namespace");
      }
      await this.saveUser(user, {
        ...user.spec?.access,
        namespaceAccesses: apply(user.spec?.access?.namespaceAccesses),
      });
      return { ok: true };
    }
    const sa = await this.fetchServiceAccount(id);
    const spec = { ...sa.spec };
    if (spec.namespaceScopedAccess) {
      if (spec.namespaceScopedAccess.namespace !== namespace) {
        throw new Error("A namespace-scoped service account can only change its own namespace");
      }
      if (permission === "none") throw new Error("Delete the service account to remove its access");
      spec.namespaceScopedAccess = {
        ...spec.namespaceScopedAccess,
        access: { permission: permissionEnum(permission) },
      };
    } else {
      const role = spec.access?.accountAccess?.role;
      if (role === "ROLE_ADMIN") {
        throw new Error("Admin service accounts already have access to every namespace");
      }
      spec.access = { ...spec.access, namespaceAccesses: apply(spec.access?.namespaceAccesses) };
    }
    await this.saveServiceAccount(sa, spec);
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderTemporalDetail(resource);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderTemporalSidebar(resource);
  }
}

/** For a list that only fills in a detail view or a picker, where none is a usable answer. */
function noRows<Row>(err: unknown): Row[] {
  rethrowIncompleteList(err);
  return [];
}

/**
 * For a list that decorates rows the sync stores: a key whose role cannot read it
 * gets plain rows, and any other failure, a bad key included, fails the read and
 * leaves what is stored alone.
 */
function noRowsIfDenied<Row>(err: unknown): Row[] {
  if (statusOf(err) === 403) return [];
  throw err;
}

/** A delete's query: a version read as nothing is not sent. */
function versioned(resourceVersion: string | undefined): { resourceVersion?: string } {
  return resourceVersion === undefined ? {} : { resourceVersion };
}

/** Connectivity rule id → the namespaces it is attached to. */
function attachedRules(namespaces: TcNamespace[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const ns of namespaces) {
    for (const rule of ns.spec?.connectivityRuleIds ?? []) {
      out.set(rule, [...(out.get(rule) ?? []), ns.namespace ?? ""]);
    }
  }
  return out;
}

/** What the document gives as the form of `azurePeResourceId`. ARM ids ignore case. */
const AZURE_PRIVATE_ENDPOINT =
  /^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.Network\/privateEndpoints\/[^/]+$/i;

function privateRule(
  region: string,
  fields: Record<string, string>,
): NonNullable<TcConnectivityRuleSpec["privateRule"]> {
  if (region.startsWith("azure-")) {
    const azurePeResourceId = (fields["azurePeResourceId"] ?? "").trim();
    if (!AZURE_PRIVATE_ENDPOINT.test(azurePeResourceId)) {
      throw new Error(
        "Azure private connections need the Private Endpoint's resource id: /subscriptions/…/resourceGroups/…/providers/Microsoft.Network/privateEndpoints/…",
      );
    }
    // Azure's `connectionId` is the provider's to fill in, not the customer's.
    return { region, azurePeResourceId };
  }
  const connectionId = (fields["connectionId"] ?? "").trim();
  if (!connectionId) throw new Error("Enter the connection id of the private endpoint");
  if (!region.startsWith("gcp-")) return { region, connectionId };
  const gcpProjectId = (fields["gcpProjectId"] ?? "").trim();
  if (!gcpProjectId) throw new Error("GCP private connections need the GCP project id");
  return { region, connectionId, gcpProjectId };
}

type SinkDestination = "s3" | "gcs" | "azure";

/** The form's fields behind each destination. The form shows them all on any sink. */
const SINK_DESTINATION_FIELDS: Record<SinkDestination, string[]> = {
  s3: ["bucketName", "bucketRegion", "roleName", "awsAccountId", "kmsArn"],
  gcs: ["bucketName", "bucketRegion", "gcpProjectId", "serviceAccountId"],
  azure: [
    "bucketName",
    "bucketRegion",
    "azureTenantId",
    "azureSubscriptionId",
    "azureResourceGroup",
    "azureStorageAccount",
  ],
};

/** A destination as a form or the listed field writes it: `gcs`, `GCS`, `Azure Blob`. */
function sinkDestination(raw: string | undefined): SinkDestination | undefined {
  const name = (raw ?? "").trim().toLowerCase();
  if (name === "s3" || name === "gcs") return name;
  return name === "azure" || name === "azure blob" ? "azure" : undefined;
}

function destinationOf(sink: TcExportSink): SinkDestination {
  return sink.spec?.azureBlob ? "azure" : sink.spec?.gcs ? "gcs" : "s3";
}

function exportSinkFields(sink: TcExportSink): Record<string, string> {
  const s3 = sink.spec?.s3;
  const gcs = sink.spec?.gcs;
  const azure = sink.spec?.azureBlob;
  const out: Record<string, string> = { enabled: String(sink.spec?.enabled ?? false) };
  const set = (k: string, v: string | undefined) => {
    if (v) out[k] = v;
  };
  set("bucketName", s3?.bucketName ?? gcs?.bucketName ?? azure?.containerName);
  set("bucketRegion", s3?.region ?? gcs?.region ?? azure?.region);
  set("roleName", s3?.roleName);
  set("awsAccountId", s3?.awsAccountId);
  set("kmsArn", s3?.kmsArn);
  set("gcpProjectId", gcs?.gcpProjectId);
  set("serviceAccountId", gcs?.saId);
  set("azureTenantId", azure?.tenantId);
  set("azureSubscriptionId", azure?.subscriptionId);
  set("azureResourceGroup", azure?.resourceGroup);
  set("azureStorageAccount", azure?.storageAccount);
  return out;
}

/**
 * The sink's spec with this edit applied. The update replaces the spec, so all of it
 * goes back, `filter` included. The destination is only rebuilt, and so only checked,
 * when the edit touches it: Enable and Disable must work on whatever the sink holds.
 */
function editedExportSinkSpec(
  current: TcExportSink,
  name: string,
  fields: Record<string, string>,
): TcExportSinkSpec {
  const was = destinationOf(current);
  const destination = sinkDestination(fields["destination"]) ?? was;
  const touched =
    destination !== was || SINK_DESTINATION_FIELDS[destination].some((key) => key in fields);
  const spec: TcExportSinkSpec = {
    ...current.spec,
    name,
    ...("enabled" in fields ? { enabled: bool(fields["enabled"]) } : {}),
  };
  if (!touched) return spec;
  const { s3: _s3, gcs: _gcs, azureBlob: _azureBlob, ...others } = spec;
  const merged = { ...exportSinkFields(current), ...fields, name, destination };
  return { ...others, ...exportSinkSpec(merged, false) };
}

function exportSinkSpec(
  fields: Record<string, string>,
  creating: boolean,
): TcExportSinkSpec & { name: string } {
  const name = (fields["name"] ?? "").trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-_]*$/.test(name)) {
    throw new Error("A sink name uses letters, digits, hyphens and underscores");
  }
  const bucket = (fields["bucketName"] ?? "").trim();
  const region = (fields["bucketRegion"] ?? "").trim();
  const enabled = creating ? true : bool(fields["enabled"]);
  if (fields["destination"] === "azure") {
    if (!bucket || !region) throw new Error("Enter the destination container and its region");
    const tenantId = (fields["azureTenantId"] ?? "").trim();
    const subscriptionId = (fields["azureSubscriptionId"] ?? "").trim();
    const resourceGroup = (fields["azureResourceGroup"] ?? "").trim();
    const storageAccount = (fields["azureStorageAccount"] ?? "").trim();
    if (!tenantId || !subscriptionId || !resourceGroup || !storageAccount) {
      throw new Error(
        "Azure Blob sinks need the tenant id, subscription id, resource group and storage account",
      );
    }
    return {
      name,
      enabled,
      azureBlob: {
        tenantId,
        subscriptionId,
        resourceGroup,
        storageAccount,
        containerName: bucket,
        region,
      },
    };
  }
  if (!bucket || !region) throw new Error("Enter the destination bucket and its region");
  if (fields["destination"] === "gcs") {
    const project = (fields["gcpProjectId"] ?? "").trim();
    const sa = (fields["serviceAccountId"] ?? "").trim();
    if (!project || !sa)
      throw new Error("GCS sinks need the GCP project id and service account id");
    return { name, enabled, gcs: { bucketName: bucket, region, gcpProjectId: project, saId: sa } };
  }
  const roleName = (fields["roleName"] ?? "").trim();
  const awsAccountId = (fields["awsAccountId"] ?? "").trim();
  if (!roleName || !/^\d{12}$/.test(awsAccountId)) {
    throw new Error("S3 sinks need the IAM role name and the 12-digit AWS account id");
  }
  const kmsArn = (fields["kmsArn"] ?? "").trim();
  return {
    name,
    enabled,
    s3: { bucketName: bucket, region, roleName, awsAccountId, ...(kmsArn ? { kmsArn } : {}) },
  };
}

function nexusSpec(fields: Record<string, string>): TcNexusEndpointSpec {
  const name = validateNexusEndpointName(fields["name"] ?? "");
  const namespaceId = (fields["targetNamespace"] ?? "").trim();
  const taskQueue = (fields["taskQueue"] ?? "").trim();
  if (!namespaceId) throw new Error("Pick the target namespace");
  if (!taskQueue) throw new Error("Enter the target task queue");
  const description = (fields["description"] ?? "").trim();
  return {
    name,
    targetSpec: { workerTargetSpec: { namespaceId, taskQueue } },
    policySpecs: splitList(fields["allowedCallers"]).map((ns) => ({
      allowedCloudNamespacePolicySpec: { namespaceId: ns },
    })),
    ...(description ? { description: encodePayload(description) } : {}),
  };
}
