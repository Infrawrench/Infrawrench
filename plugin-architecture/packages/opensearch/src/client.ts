import type {
  ActionNode,
  DashboardStat,
  DetailViewSchema,
  DetailViewTab,
  HostServices,
  MetricSeries,
  PeerPaneContext,
  PeerPaneResource,
  PeerPaneSchema,
  PluginClient,
  ResourceInstance,
  ResourceStatus,
  SectionNode,
  SidebarItemSchema,
  TableNode,
  TableRow,
} from "@infrawrench/plugin-base";
import { decodePromptArgs } from "@infrawrench/plugin-base";
import { osRequest, parseConfig, type OpenSearchConfig } from "./api.js";
import {
  buildAliasesSection,
  buildDataStreamsSection,
  buildIsmPoliciesSection,
  buildSmPoliciesSection,
  buildSnapshotsSection,
  buildTopQueriesSection,
  buildUnassignedShardsSection,
  type CatAlias,
  type CatShard,
  type DataStreamInfo,
  type IsmPolicyEntry,
  type SmPolicyEntry,
  type SnapshotInfo,
  type TopQuery,
} from "./admin.js";

interface ClusterHealth {
  cluster_name: string;
  status: "green" | "yellow" | "red";
  number_of_nodes: number;
  number_of_data_nodes: number;
  active_primary_shards: number;
  active_shards: number;
  relocating_shards: number;
  initializing_shards: number;
  unassigned_shards: number;
  number_of_pending_tasks: number;
  number_of_in_flight_fetch: number;
  active_shards_percent_as_number?: number;
}

interface ClusterRoot {
  name: string;
  cluster_name: string;
  cluster_uuid?: string;
  version: {
    number: string;
    distribution?: string;
    build_flavor?: string;
  };
}

interface ClusterStats {
  indices: {
    count: number;
    docs: { count: number; deleted: number };
    store: { size_in_bytes: number };
  };
  nodes: { count: { total: number; master: number; data: number } };
}

export interface NodeInfo {
  name: string;
  roles?: string[];
  ip?: string;
  os?: {
    available_processors?: number;
    cpu?: { percent?: number; load_average?: { "1m"?: number } };
    mem?: { used_percent?: number };
  };
  indices?: {
    search?: { query_total?: number; query_time_in_millis?: number };
    indexing?: { index_total?: number; index_time_in_millis?: number };
    segments?: { count?: number };
    merges?: { current?: number };
    query_cache?: { memory_size_in_bytes?: number; evictions?: number };
    fielddata?: { memory_size_in_bytes?: number; evictions?: number };
  };
  jvm?: {
    mem?: { heap_used_percent?: number; heap_max_in_bytes?: number };
    gc?: {
      collectors?: Record<
        string,
        { collection_count?: number; collection_time_in_millis?: number }
      >;
    };
  };
  fs?: { total?: { total_in_bytes?: number; available_in_bytes?: number } };
  thread_pool?: Record<string, { queue?: number; rejected?: number; active?: number }>;
  http?: { current_open?: number };
  breakers?: Record<string, { tripped?: number }>;
  transport?: { rx_size_in_bytes?: number; tx_size_in_bytes?: number };
}

interface CatIndex {
  index: string;
  health: "green" | "yellow" | "red";
  status: string;
  uuid: string;
  pri: string;
  rep: string;
  "docs.count": string;
  "docs.deleted": string;
  "store.size": string;
  "pri.store.size": string;
}

function healthToStatus(health: ClusterHealth["status"] | undefined): ResourceStatus {
  switch (health) {
    case "green":
      return "healthy";
    case "yellow":
      return "degraded";
    case "red":
      return "error";
    default:
      return "unknown";
  }
}

function clusterResourceId(accountId: string, endpoint: string): string {
  let host = "cluster";
  try {
    host = new URL(endpoint).host;
  } catch {
    /* leave default */
  }
  return `${accountId}:opensearch-cluster:${host}`;
}

export class OpenSearchClient implements PluginClient {
  private readonly config: OpenSearchConfig;
  private readonly services: HostServices | undefined;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    this.config = parseConfig(credentials);
    this.services = services;
  }

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    if (typeId !== "opensearch-cluster") {
      throw new Error(`OpenSearch plugin: unknown resource type "${typeId}"`);
    }
    const now = new Date().toISOString();
    const id = clusterResourceId(accountId, this.config.endpoint);
    let root: ClusterRoot | undefined;
    let health: ClusterHealth | undefined;
    try {
      const rootResp = await osRequest<ClusterRoot>(this.config, this.services?.http, "/");
      root = rootResp.body;
    } catch {
      /* listing should not throw: surface as unknown */
    }
    try {
      const healthResp = await osRequest<ClusterHealth>(
        this.config,
        this.services?.http,
        "/_cluster/health",
      );
      health = healthResp.body;
    } catch {
      /* same */
    }
    const displayName = root?.cluster_name ?? health?.cluster_name ?? this.endpointHost();
    return [
      {
        id,
        pluginId: "opensearch",
        resourceTypeId: "opensearch-cluster",
        accountId,
        displayName,
        fields: {
          endpoint: this.config.endpoint,
          ...(root?.version?.number ? { version: root.version.number } : {}),
          ...(root?.cluster_name ? { clusterName: root.cluster_name } : {}),
          ...(root?.version?.distribution ? { distribution: root.version.distribution } : {}),
          ...(health?.status ? { status: health.status } : {}),
        },
        resolvedOutputs: {},
        secretStates: [],
        createdAt: now,
        updatedAt: now,
      },
    ];
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const all = await this.listResources(typeId, accountId);
    const found = all.find((r) => r.id === resourceId) ?? all[0];
    if (!found) throw new Error(`OpenSearch plugin: cluster not found for ${resourceId}`);
    return found;
  }

  async resolveOutput(_typeId: string, _resourceId: string, outputKey: string): Promise<string> {
    switch (outputKey) {
      case "endpoint":
        return this.config.endpoint;
      case "clusterName": {
        const r = await osRequest<ClusterRoot>(this.config, this.services?.http, "/");
        return r.body?.cluster_name ?? "";
      }
      case "version": {
        const r = await osRequest<ClusterRoot>(this.config, this.services?.http, "/");
        return r.body?.version?.number ?? "";
      }
      default:
        throw new Error(`OpenSearch plugin: cannot resolve output "${outputKey}"`);
    }
  }

  async enrichDetail(resource: ResourceInstance): Promise<ResourceInstance> {
    const http = this.services?.http;
    const [rootR, healthR, statsR, nodesR, indicesR, reposR] = await Promise.allSettled([
      osRequest<ClusterRoot>(this.config, http, "/"),
      osRequest<ClusterHealth>(this.config, http, "/_cluster/health"),
      osRequest<ClusterStats>(this.config, http, "/_cluster/stats"),
      osRequest<{ nodes: Record<string, NodeInfo> }>(this.config, http, "/_nodes"),
      osRequest<CatIndex[]>(this.config, http, "/_cat/indices", {
        query: {
          format: "json",
          bytes: "b",
          h: "index,health,status,pri,rep,docs.count,docs.deleted,store.size,pri.store.size,uuid",
        },
      }),
      osRequest<Record<string, unknown>>(this.config, http, "/_snapshot/_all"),
    ]);
    const extras = await this.fetchAdminExtras(
      reposR.status === "fulfilled" ? Object.keys(reposR.value.body ?? {}) : [],
    );

    const root = rootR.status === "fulfilled" ? rootR.value.body : undefined;
    const health = healthR.status === "fulfilled" ? healthR.value.body : undefined;
    const stats = statsR.status === "fulfilled" ? statsR.value.body : undefined;
    const nodes =
      nodesR.status === "fulfilled" ? Object.values(nodesR.value.body?.nodes ?? {}) : [];
    const indices = indicesR.status === "fulfilled" ? (indicesR.value.body ?? []) : [];
    const repos = reposR.status === "fulfilled" ? (reposR.value.body ?? {}) : {};

    // Stash JSON-encoded results in fields so renderDetail (sync) can read them.
    return {
      ...resource,
      fields: {
        ...resource.fields,
        ...(root?.version?.number ? { version: root.version.number } : {}),
        ...(root?.cluster_name ? { clusterName: root.cluster_name } : {}),
        ...(root?.version?.distribution ? { distribution: root.version.distribution } : {}),
        ...(health?.status ? { status: health.status } : {}),
        __health: health ? JSON.stringify(health) : "",
        __stats: stats ? JSON.stringify(stats) : "",
        __nodes: JSON.stringify(nodes),
        __indices: JSON.stringify(indices),
        __repos: JSON.stringify(repos),
        ...extras,
      },
    };
  }

  /**
   * Best-effort reads for the admin tabs. Each value is JSON, or "" when the
   * endpoint refused (plugin missing, no permission), which renders as "not
   * available" rather than as an empty list.
   */
  private async fetchAdminExtras(repoNames: string[]): Promise<Record<string, string>> {
    const http = this.services?.http;
    const [aliasesR, streamsR, shardsR, ismR, smR, topR, ...snapshotRs] = await Promise.allSettled([
      osRequest<CatAlias[]>(this.config, http, "/_cat/aliases", { query: { format: "json" } }),
      osRequest<{ data_streams?: DataStreamInfo[] }>(this.config, http, "/_data_stream"),
      osRequest<CatShard[]>(this.config, http, "/_cat/shards", {
        query: { format: "json", h: "index,shard,prirep,state,unassigned.reason,node" },
      }),
      osRequest<{ policies?: IsmPolicyEntry[] }>(this.config, http, "/_plugins/_ism/policies", {
        query: { size: 100 },
      }),
      osRequest<{ policies?: SmPolicyEntry[] }>(this.config, http, "/_plugins/_sm/policies"),
      osRequest<{ top_queries?: TopQuery[] }>(this.config, http, "/_insights/top_queries", {
        query: { type: "latency" },
      }),
      ...repoNames.map((repo) =>
        osRequest<{ snapshots?: SnapshotInfo[] }>(
          this.config,
          http,
          `/_snapshot/${encodeURIComponent(repo)}/_all`,
        ),
      ),
    ]);
    const json = <T>(r: PromiseSettledResult<{ body: T }>, pick: (body: T) => unknown): string =>
      r.status === "fulfilled" ? JSON.stringify(pick(r.value.body) ?? []) : "";
    const snapshots: Record<string, SnapshotInfo[] | null> = {};
    repoNames.forEach((repo, i) => {
      const r = snapshotRs[i];
      const list = r?.status === "fulfilled" ? r.value.body?.snapshots : null;
      snapshots[repo] = Array.isArray(list) ? list : r?.status === "fulfilled" ? [] : null;
    });
    return {
      __aliases: json(aliasesR, (b) => b),
      __dataStreams: json(streamsR, (b) => b?.data_streams),
      __shards: json(shardsR, (b) => b),
      __ismPolicies: json(ismR, (b) => b?.policies),
      __smPolicies: json(smR, (b) => b?.policies),
      __topQueries: json(topR, (b) => b?.top_queries),
      __snapshots: JSON.stringify(snapshots),
    };
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    const health = parseJson<ClusterHealth | undefined>(resource.fields["__health"]);
    const stats = parseJson<ClusterStats | undefined>(resource.fields["__stats"]);
    const nodes = parseJson<NodeInfo[]>(resource.fields["__nodes"]) ?? [];
    const indices = parseJson<CatIndex[]>(resource.fields["__indices"]) ?? [];
    const repos = parseJson<Record<string, { type: string }>>(resource.fields["__repos"]) ?? {};
    const status = healthToStatus(health?.status);
    const aliases = parseJsonArray<CatAlias>(resource.fields["__aliases"]);
    const dataStreams = parseJsonArray<DataStreamInfo>(resource.fields["__dataStreams"]);
    const shards = parseJsonArray<CatShard>(resource.fields["__shards"]) ?? [];
    const ismPolicies = parseJsonArray<IsmPolicyEntry>(resource.fields["__ismPolicies"]);
    const smPolicies = parseJsonArray<SmPolicyEntry>(resource.fields["__smPolicies"]);
    const topQueries = parseJsonArray<TopQuery>(resource.fields["__topQueries"]);
    const snapshotsByRepo =
      parseJson<Record<string, SnapshotInfo[] | null>>(resource.fields["__snapshots"]) ?? {};
    const indexOptions = indices
      .map((i) => i.index)
      .sort()
      .map((name) => ({ id: name, label: name }));
    const repoOptions = Object.keys(repos).map((name) => ({ id: name, label: name }));
    const ismOptions = (ismPolicies ?? [])
      .map((p) => p.policy?.policy_id ?? p._id ?? "")
      .filter((id) => id.length > 0)
      .map((id) => ({ id, label: id }));
    const indexField = (key: string, label: string) =>
      indexOptions.length > 0
        ? {
            key,
            label,
            kind: "select" as const,
            required: true,
            options: indexOptions,
            defaultValue: indexOptions[0]!.id,
          }
        : { key, label, kind: "text" as const, required: true };

    const overviewSection: SectionNode = {
      kind: "section",
      title: "Cluster",
      children: [
        {
          kind: "key-value-list",
          items: [
            { key: "Endpoint", value: String(resource.fields["endpoint"] ?? "—"), copyable: true },
            { key: "Cluster Name", value: String(resource.fields["clusterName"] ?? "—") },
            {
              key: "Distribution",
              value: String(resource.fields["distribution"] ?? "elasticsearch"),
            },
            { key: "Version", value: String(resource.fields["version"] ?? "—") },
            { key: "Health", value: health?.status ?? "unknown" },
          ],
        },
      ],
    };

    const healthSection: SectionNode = {
      kind: "section",
      title: "Health",
      children: [
        {
          kind: "key-value-list",
          items: [
            { key: "Nodes", value: String(health?.number_of_nodes ?? "—") },
            { key: "Data Nodes", value: String(health?.number_of_data_nodes ?? "—") },
            { key: "Active Primary Shards", value: String(health?.active_primary_shards ?? "—") },
            { key: "Active Shards", value: String(health?.active_shards ?? "—") },
            { key: "Relocating Shards", value: String(health?.relocating_shards ?? "—") },
            { key: "Initializing Shards", value: String(health?.initializing_shards ?? "—") },
            { key: "Unassigned Shards", value: String(health?.unassigned_shards ?? "—") },
            { key: "Pending Tasks", value: String(health?.number_of_pending_tasks ?? "—") },
            {
              key: "Total Indices",
              value: String(stats?.indices?.count ?? indices.length ?? "—"),
            },
            { key: "Total Documents", value: String(stats?.indices?.docs?.count ?? "—") },
            {
              key: "Total Store Size",
              value: stats?.indices?.store?.size_in_bytes
                ? formatBytes(stats.indices.store.size_in_bytes)
                : "—",
            },
          ],
        },
      ],
    };

    const nodesSection: SectionNode = {
      kind: "section",
      title: `Nodes (${nodes.length})`,
      children:
        nodes.length > 0
          ? [buildNodesTable(nodes)]
          : [{ kind: "text", variant: "muted", content: "No nodes reported." }],
    };

    const indicesSection: SectionNode = {
      kind: "section",
      title: `Indices (${indices.length})`,
      children:
        indices.length > 0
          ? [buildIndicesTable(indices)]
          : [{ kind: "text", variant: "muted", content: "No indices found." }],
    };

    const repoCount = Object.keys(repos).length;
    const snapshotsTab: DetailViewTab = {
      id: "snapshots",
      label: "Snapshots",
      sections: [
        {
          kind: "section",
          title: `Snapshot repositories (${repoCount})`,
          children:
            repoCount > 0
              ? [buildReposTable(repos)]
              : [
                  {
                    kind: "text",
                    variant: "muted",
                    content: "No snapshot repositories registered.",
                  },
                ],
        },
        ...Object.keys(repos).map((repo) =>
          buildSnapshotsSection(repo, snapshotsByRepo[repo] ?? undefined),
        ),
        buildSmPoliciesSection(smPolicies),
      ],
      headerActions: [
        ...(repoOptions.length > 0 && smPolicies
          ? [
              {
                kind: "action" as const,
                label: "Create snapshot policy",
                action: {
                  type: "prompt-nosql-command" as const,
                  command: "create-sm-policy",
                  title: "Create snapshot policy",
                  description:
                    "Take snapshots on a schedule and delete old ones automatically (Snapshot Management).",
                  fields: [
                    { key: "name", label: "Policy name", kind: "text" as const, required: true },
                    {
                      key: "repository",
                      label: "Repository",
                      kind: "select" as const,
                      required: true,
                      options: repoOptions,
                      defaultValue: repoOptions[0]!.id,
                    },
                    {
                      key: "schedule",
                      label: "Take a snapshot",
                      kind: "select" as const,
                      required: true,
                      options: SM_SCHEDULES.map((s) => ({ id: s.cron, label: s.label })),
                      defaultValue: "0 2 * * *",
                    },
                    {
                      key: "maxAge",
                      label: "Delete snapshots older than",
                      kind: "select" as const,
                      required: false,
                      options: [
                        { id: "", label: "Never" },
                        { id: "7d", label: "7 days" },
                        { id: "14d", label: "14 days" },
                        { id: "30d", label: "30 days" },
                        { id: "90d", label: "90 days" },
                        { id: "365d", label: "1 year" },
                      ],
                      defaultValue: "30d",
                    },
                    {
                      key: "minCount",
                      label: "Always keep at least",
                      kind: "number" as const,
                      required: false,
                      minValue: 1,
                      defaultValue: "7",
                    },
                    {
                      key: "indices",
                      label: "Indices",
                      kind: "text" as const,
                      required: false,
                      defaultValue: "*",
                      description: "Index pattern to include; * takes every index.",
                    },
                  ],
                  submitLabel: "Create",
                },
              },
            ]
          : []),
        {
          kind: "action",
          label: "Register repository",
          action: {
            type: "prompt-nosql-command",
            command: "register-snapshot-repo",
            title: "Register snapshot repository",
            description:
              "Register an S3-compatible snapshot repository. The cluster must already have the repository-s3 plugin installed.",
            fields: [
              { key: "name", label: "Repository name", kind: "text", required: true },
              { key: "bucket", label: "S3 bucket", kind: "text", required: true },
              { key: "region", label: "S3 region", kind: "text", required: false },
              { key: "basePath", label: "Base path", kind: "text", required: false },
            ],
            submitLabel: "Register",
          },
        },
      ],
    };

    const headerActions: ActionNode[] = [
      { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
      {
        kind: "action",
        label: "Create index",
        action: {
          type: "prompt-nosql-command",
          command: "create-index",
          title: "Create index",
          fields: [
            { key: "name", label: "Index name", kind: "text", required: true },
            {
              key: "shards",
              label: "Number of primary shards",
              kind: "number",
              required: false,
              defaultValue: "1",
            },
            {
              key: "replicas",
              label: "Number of replicas",
              kind: "number",
              required: false,
              defaultValue: "1",
            },
            {
              key: "mapping",
              label: "Mapping (JSON, optional)",
              kind: "code",
              codeLanguage: "json",
              required: false,
              description:
                'Optional index mappings, e.g. { "properties": { "title": { "type": "text" } } }. Leave blank to let OpenSearch infer types.',
            },
          ],
          submitLabel: "Create",
        },
      },
      {
        kind: "action",
        label: "Reindex",
        action: {
          type: "prompt-nosql-command",
          command: "reindex",
          title: "Reindex documents",
          description:
            "Copy documents from one index to another on this cluster. Runs as a background task; large copies keep going after the dialog closes.",
          fields: [
            indexField("source", "Source index"),
            {
              key: "dest",
              label: "Destination index",
              kind: "text",
              required: true,
              description: "Created if it does not exist.",
            },
          ],
          submitLabel: "Reindex",
        },
      },
      {
        kind: "action",
        label: "Search",
        action: {
          type: "prompt-nosql-command",
          command: "search",
          title: "Run search query",
          description: "Run a query against an index. Returns the first 10 hits.",
          fields: [
            indexField("index", "Index"),
            {
              key: "query",
              label: "Query DSL (JSON)",
              kind: "code",
              codeLanguage: "json",
              required: true,
              defaultValue: '{ "query": { "match_all": {} } }',
            },
            {
              key: "size",
              label: "Hits to return",
              kind: "number",
              required: false,
              defaultValue: "10",
            },
          ],
          submitLabel: "Run",
        },
      },
    ];

    const unassignedSection = buildUnassignedShardsSection(shards);
    if (unassignedSection) {
      headerActions.push({
        kind: "action",
        label: "Retry allocation",
        action: {
          type: "plugin-action",
          actionId: "retry-allocation",
          confirmMessage:
            "Ask the cluster to retry shards whose allocation failed too many times? Do this after fixing the cause (disk space, node count).",
          successMessage: "Allocation retry requested.",
        },
      });
    }

    const aliasesTab: DetailViewTab = {
      id: "aliases",
      label: "Aliases & streams",
      sections: [buildAliasesSection(aliases), buildDataStreamsSection(dataStreams)],
      headerActions:
        indexOptions.length > 0
          ? [
              {
                kind: "action",
                label: "Add alias",
                action: {
                  type: "prompt-nosql-command",
                  command: "add-alias",
                  title: "Add alias",
                  fields: [
                    indexField("index", "Index"),
                    { key: "alias", label: "Alias name", kind: "text", required: true },
                    {
                      key: "writeIndex",
                      label: "Write index",
                      kind: "select",
                      required: false,
                      options: [
                        { id: "", label: "Not set" },
                        { id: "true", label: "Yes: writes to the alias land here" },
                        { id: "false", label: "No" },
                      ],
                      defaultValue: "",
                    },
                  ],
                  submitLabel: "Add",
                },
              },
            ]
          : [],
    };

    const lifecycleTab: DetailViewTab = {
      id: "lifecycle",
      label: "Index lifecycle",
      sections: [buildIsmPoliciesSection(ismPolicies)],
      headerActions: ismPolicies
        ? [
            {
              kind: "action",
              label: "Create retention policy",
              action: {
                type: "prompt-nosql-command",
                command: "create-ism-policy",
                title: "Create retention policy",
                description:
                  "An ISM policy that deletes indices once they reach an age. New indices matching the pattern pick it up automatically.",
                fields: [
                  { key: "policyId", label: "Policy ID", kind: "text", required: true },
                  {
                    key: "pattern",
                    label: "Index pattern",
                    kind: "text",
                    required: true,
                    placeholder: "logs-*",
                    description: "Avoid a bare *: it would also match system indices.",
                  },
                  {
                    key: "deleteAfter",
                    label: "Delete indices older than",
                    kind: "select",
                    required: true,
                    options: [
                      { id: "1d", label: "1 day" },
                      { id: "7d", label: "7 days" },
                      { id: "14d", label: "14 days" },
                      { id: "30d", label: "30 days" },
                      { id: "90d", label: "90 days" },
                      { id: "365d", label: "1 year" },
                    ],
                    defaultValue: "30d",
                  },
                ],
                submitLabel: "Create",
              },
            },
            ...(ismOptions.length > 0 && indexOptions.length > 0
              ? [
                  {
                    kind: "action" as const,
                    label: "Apply policy to index",
                    action: {
                      type: "prompt-nosql-command" as const,
                      command: "attach-ism-policy",
                      title: "Apply ISM policy",
                      description:
                        "Put an existing index under an ISM policy. An index that already has a policy keeps it; detach it first.",
                      fields: [
                        indexField("index", "Index"),
                        {
                          key: "policyId",
                          label: "Policy",
                          kind: "select" as const,
                          required: true,
                          options: ismOptions,
                          defaultValue: ismOptions[0]!.id,
                        },
                      ],
                      submitLabel: "Apply",
                    },
                  },
                  {
                    kind: "action" as const,
                    label: "Detach policy",
                    action: {
                      type: "prompt-nosql-command" as const,
                      command: "detach-ism-policy",
                      title: "Detach ISM policy",
                      fields: [indexField("index", "Index")],
                      submitLabel: "Detach",
                    },
                  },
                ]
              : []),
          ]
        : [],
    };

    const insightsTab: DetailViewTab = {
      id: "query-insights",
      label: "Query insights",
      sections: [buildTopQueriesSection(topQueries)],
    };

    return {
      title: resource.displayName,
      subtitle: `${this.endpointHost()} · ${resource.fields["version"] ?? "OpenSearch"}`,
      status: { kind: "status-dot", status },
      sections: [
        overviewSection,
        healthSection,
        ...(unassignedSection ? [unassignedSection] : []),
        nodesSection,
        indicesSection,
      ],
      headerActions,
      customTabs: [snapshotsTab, aliasesTab, lifecycleTab, insightsTab],
      metricsCapability: { defaultTimeRangeMs: 60 * 60 * 1000 },
    };
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    const health = String(resource.fields["status"] ?? "");
    return {
      id: resource.id,
      label: resource.displayName,
      status: { kind: "status-dot", status: healthToStatus(health as ClusterHealth["status"]) },
    };
  }

  // Embedded as a tab inside a managed-DB cluster (e.g. DigitalOcean OpenSearch).
  // OpenSearch exposes a single cluster: surface it as one pill that navigates
  // into the cluster detail (indices, nodes, snapshots).
  async renderPeerPane(context: PeerPaneContext): Promise<PeerPaneSchema> {
    const clusters = await this.listResources("opensearch-cluster", context.accountId);
    const items: PeerPaneResource[] = clusters.map((c) => ({
      id: c.id,
      pluginId: c.pluginId,
      resourceTypeId: c.resourceTypeId,
      displayName: c.displayName,
      subtitle: this.endpointHost(),
      status: healthToStatus(c.fields["status"] as ClusterHealth["status"] | undefined),
      fields: c.fields,
    }));
    return {
      resourceGroups: [
        {
          title: `OpenSearch (${items.length})`,
          resourceTypeId: "opensearch-cluster",
          pluginId: "opensearch",
          items,
        },
      ],
    };
  }

  async fetchDashboardStats(): Promise<DashboardStat[]> {
    try {
      const [healthResp, statsResp] = await Promise.all([
        osRequest<ClusterHealth>(this.config, this.services?.http, "/_cluster/health"),
        osRequest<ClusterStats>(this.config, this.services?.http, "/_cluster/stats"),
      ]);
      const health = healthResp.body;
      const stats = statsResp.body;
      const variant =
        health?.status === "green"
          ? "status-healthy"
          : health?.status === "yellow"
            ? "status-degraded"
            : health?.status === "red"
              ? "status-error"
              : "default";
      return [
        { label: "Status", value: health?.status ?? "unknown", variant },
        {
          label: "Nodes",
          value: String(stats?.nodes?.count?.total ?? health?.number_of_nodes ?? 0),
        },
        { label: "Indices", value: String(stats?.indices?.count ?? 0) },
        {
          label: "Docs",
          value: formatCount(stats?.indices?.docs?.count ?? 0),
        },
      ];
    } catch {
      return [
        { label: "Status", value: "unknown" },
        { label: "Nodes", value: "—" },
        { label: "Indices", value: "—" },
        { label: "Docs", value: "—" },
      ];
    }
  }

  async fetchMetricSeries(): Promise<MetricSeries[]> {
    const ts = Date.now();
    try {
      const [healthResp, statsResp, nodesResp] = await Promise.all([
        osRequest<ClusterHealth>(this.config, this.services?.http, "/_cluster/health"),
        osRequest<ClusterStats>(this.config, this.services?.http, "/_cluster/stats"),
        osRequest<{ nodes: Record<string, NodeInfo> }>(
          this.config,
          this.services?.http,
          "/_nodes/stats/jvm,fs,os,indices,thread_pool,http,breaker,transport",
        ),
      ]);
      const health = healthResp.body;
      const stats = statsResp.body;
      const nodes = Object.values(nodesResp.body?.nodes ?? {});
      const heapPctValues = nodes
        .map((n) => n.jvm?.mem?.heap_used_percent)
        .filter((v): v is number => typeof v === "number");
      const avgHeapPct =
        heapPctValues.length > 0
          ? heapPctValues.reduce((a, b) => a + b, 0) / heapPctValues.length
          : 0;
      const fsUsedPctValues = nodes
        .map((n) => {
          const total = n.fs?.total?.total_in_bytes ?? 0;
          const avail = n.fs?.total?.available_in_bytes ?? 0;
          if (!total) return undefined;
          return ((total - avail) / total) * 100;
        })
        .filter((v): v is number => typeof v === "number");
      const avgFsUsedPct =
        fsUsedPctValues.length > 0
          ? fsUsedPctValues.reduce((a, b) => a + b, 0) / fsUsedPctValues.length
          : 0;

      const cpuValues = nodes
        .map((n) => n.os?.cpu?.percent)
        .filter((v): v is number => typeof v === "number");
      const avgCpu =
        cpuValues.length > 0 ? cpuValues.reduce((a, b) => a + b, 0) / cpuValues.length : 0;
      const sum = (pick: (n: NodeInfo) => number | undefined) =>
        nodes.reduce((total, n) => total + (pick(n) ?? 0), 0);

      return [
        {
          label: "Avg CPU %",
          unit: "%",
          points: [{ timestamp: ts, value: Math.round(avgCpu) }],
        },
        {
          label: "Pending tasks",
          points: [{ timestamp: ts, value: health?.number_of_pending_tasks ?? 0 }],
        },
        {
          label: "Search queries (cumulative)",
          points: [{ timestamp: ts, value: sum((n) => n.indices?.search?.query_total) }],
        },
        {
          label: "Indexing operations (cumulative)",
          points: [{ timestamp: ts, value: sum((n) => n.indices?.indexing?.index_total) }],
        },
        {
          label: "Active shards %",
          unit: "%",
          points: [
            { timestamp: ts, value: Math.round(health?.active_shards_percent_as_number ?? 0) },
          ],
        },
        {
          label: "Unassigned shards",
          points: [{ timestamp: ts, value: health?.unassigned_shards ?? 0 }],
        },
        {
          label: "Avg JVM heap %",
          unit: "%",
          points: [{ timestamp: ts, value: Math.round(avgHeapPct) }],
        },
        {
          label: "Avg disk used %",
          unit: "%",
          points: [{ timestamp: ts, value: Math.round(avgFsUsedPct) }],
        },
        {
          label: "Total docs",
          points: [{ timestamp: ts, value: stats?.indices?.docs?.count ?? 0 }],
        },
        {
          label: "Store size",
          unit: "bytes",
          points: [{ timestamp: ts, value: stats?.indices?.store?.size_in_bytes ?? 0 }],
        },
        ...nodeStatsSeries(nodes, ts),
      ];
    } catch {
      return [];
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Actions (per-row buttons in the indices table + header buttons)
  // ─────────────────────────────────────────────────────────────────────────

  async invokeAction(
    _typeId: string,
    _resourceId: string,
    actionId: string,
    _accountId: string,
  ): Promise<void> {
    const [verb, ...rest] = actionId.split(":");
    const arg = rest.join(":");
    switch (verb) {
      case "delete-index":
        await osRequest(this.config, this.services?.http, `/${encodeURIComponent(arg)}`, {
          method: "DELETE",
        });
        return;
      case "refresh-index":
        await osRequest(this.config, this.services?.http, `/${encodeURIComponent(arg)}/_refresh`, {
          method: "POST",
        });
        return;
      case "open-index":
        await osRequest(this.config, this.services?.http, `/${encodeURIComponent(arg)}/_open`, {
          method: "POST",
        });
        return;
      case "close-index":
        await osRequest(this.config, this.services?.http, `/${encodeURIComponent(arg)}/_close`, {
          method: "POST",
        });
        return;
      case "force-merge":
        await osRequest(
          this.config,
          this.services?.http,
          `/${encodeURIComponent(arg)}/_forcemerge`,
          { method: "POST" },
        );
        return;
      case "clear-cache":
        await osRequest(
          this.config,
          this.services?.http,
          `/${encodeURIComponent(arg)}/_cache/clear`,
          { method: "POST" },
        );
        return;
      case "delete-snapshot": {
        const [repo, snap] = arg.split("/");
        if (!repo || !snap) throw new Error(`delete-snapshot: expected repo/snapshot, got ${arg}`);
        await osRequest(
          this.config,
          this.services?.http,
          `/_snapshot/${encodeURIComponent(repo)}/${encodeURIComponent(snap)}`,
          { method: "DELETE" },
        );
        return;
      }
      case "restore-snapshot": {
        const [repo, snap] = arg.split("/");
        if (!repo || !snap) throw new Error(`restore-snapshot: expected repo/snapshot, got ${arg}`);
        // A plain restore fails on any index that still exists, which is
        // nearly always the case; restore beside the originals instead.
        // System (dot) indices and global state are left alone.
        await osRequest(
          this.config,
          this.services?.http,
          `/_snapshot/${encodeURIComponent(repo)}/${encodeURIComponent(snap)}/_restore`,
          {
            method: "POST",
            body: {
              indices: "*,-.*",
              include_global_state: false,
              rename_pattern: "(.+)",
              rename_replacement: "restored-$1",
            },
          },
        );
        return;
      }
      case "delete-repo":
        await osRequest(this.config, this.services?.http, `/_snapshot/${encodeURIComponent(arg)}`, {
          method: "DELETE",
        });
        return;
      case "create-snapshot": {
        // arg = repo. Snapshot name = snap-<unix>.
        const name = `snap-${Date.now()}`;
        await osRequest(
          this.config,
          this.services?.http,
          `/_snapshot/${encodeURIComponent(arg)}/${name}`,
          { method: "PUT", body: { ignore_unavailable: true, include_global_state: false } },
        );
        return;
      }
      case "remove-alias": {
        const slash = arg.indexOf("/");
        if (slash <= 0) throw new Error(`remove-alias: expected index/alias, got ${arg}`);
        await osRequest(this.config, this.services?.http, "/_aliases", {
          method: "POST",
          body: {
            actions: [{ remove: { index: arg.slice(0, slash), alias: arg.slice(slash + 1) } }],
          },
        });
        return;
      }
      case "rollover":
        await osRequest(this.config, this.services?.http, `/${encodeURIComponent(arg)}/_rollover`, {
          method: "POST",
        });
        return;
      case "delete-data-stream":
        await osRequest(
          this.config,
          this.services?.http,
          `/_data_stream/${encodeURIComponent(arg)}`,
          { method: "DELETE" },
        );
        return;
      case "delete-ism-policy":
        await osRequest(
          this.config,
          this.services?.http,
          `/_plugins/_ism/policies/${encodeURIComponent(arg)}`,
          { method: "DELETE" },
        );
        return;
      case "start-sm-policy":
      case "stop-sm-policy":
        await osRequest(
          this.config,
          this.services?.http,
          `/_plugins/_sm/policies/${encodeURIComponent(arg)}/${verb === "start-sm-policy" ? "_start" : "_stop"}`,
          { method: "POST" },
        );
        return;
      case "delete-sm-policy":
        await osRequest(
          this.config,
          this.services?.http,
          `/_plugins/_sm/policies/${encodeURIComponent(arg)}`,
          { method: "DELETE" },
        );
        return;
      case "retry-allocation":
        await osRequest(this.config, this.services?.http, "/_cluster/reroute", {
          method: "POST",
          query: { retry_failed: true },
        });
        return;
      default:
        throw new Error(`OpenSearch plugin: unknown action "${actionId}"`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Forms (prompt-nosql-command targets)
  // ─────────────────────────────────────────────────────────────────────────

  async executeNoSqlCommand(
    _typeId: string,
    _resourceId: string,
    _accountId: string,
    command: string,
    args: (string | number)[],
  ): Promise<unknown> {
    // The host wraps the prompt-modal form values as args = [JSON.stringify(record)]
    // (see app/packages/{desktop,web}/.../onSubmitPromptModal). Decode once.
    const form = decodePromptArgs(args);

    switch (command) {
      case "create-index": {
        const name = required(form["name"], "name");
        const body: Record<string, unknown> = {
          settings: {
            number_of_shards: Number(form["shards"] || 1),
            number_of_replicas: Number(form["replicas"] || 1),
          },
        };
        if (form["mapping"]?.trim()) {
          try {
            body["mappings"] = JSON.parse(form["mapping"]);
          } catch (err) {
            throw new Error(`mapping must be valid JSON: ${(err as Error).message}`);
          }
        }
        const r = await osRequest(
          this.config,
          this.services?.http,
          `/${encodeURIComponent(name)}`,
          { method: "PUT", body },
        );
        return { ok: true, status: r.status };
      }
      case "register-snapshot-repo": {
        const name = required(form["name"], "name");
        const bucket = required(form["bucket"], "bucket");
        const body: Record<string, unknown> = {
          type: "s3",
          settings: {
            bucket,
            ...(form["region"] ? { region: form["region"] } : {}),
            ...(form["basePath"] ? { base_path: form["basePath"] } : {}),
          },
        };
        const r = await osRequest(
          this.config,
          this.services?.http,
          `/_snapshot/${encodeURIComponent(name)}`,
          { method: "PUT", body },
        );
        return { ok: true, status: r.status };
      }
      case "reindex": {
        const source = required(form["source"], "source");
        const dest = required(form["dest"], "dest");
        // Asynchronous: a large reindex outlives the request timeout. The
        // response carries the task id to follow in the Tasks API.
        const r = await osRequest<{ task?: string }>(
          this.config,
          this.services?.http,
          `/_reindex`,
          {
            method: "POST",
            query: { wait_for_completion: false },
            body: { source: { index: source }, dest: { index: dest } },
          },
        );
        return { ok: true, task: r.body?.task };
      }
      case "add-alias": {
        const index = required(form["index"], "index");
        const alias = required(form["alias"], "alias");
        const add: Record<string, unknown> = { index, alias };
        if (form["writeIndex"] === "true" || form["writeIndex"] === "false") {
          add["is_write_index"] = form["writeIndex"] === "true";
        }
        await osRequest(this.config, this.services?.http, "/_aliases", {
          method: "POST",
          body: { actions: [{ add }] },
        });
        return { ok: true };
      }
      case "attach-ism-policy": {
        const index = required(form["index"], "index");
        const policyId = required(form["policyId"], "policyId");
        const r = await osRequest<{
          failures?: boolean;
          failed_indices?: Array<{ reason?: string }>;
        }>(this.config, this.services?.http, `/_plugins/_ism/add/${encodeURIComponent(index)}`, {
          method: "POST",
          body: { policy_id: policyId },
        });
        // A 200 can still carry per-index failures (e.g. the index already
        // has a policy); surface those instead of reporting success.
        if (r.body?.failures) {
          throw new Error(r.body.failed_indices?.[0]?.reason ?? "The policy was not applied");
        }
        return { ok: true };
      }
      case "detach-ism-policy": {
        const index = required(form["index"], "index");
        await osRequest(
          this.config,
          this.services?.http,
          `/_plugins/_ism/remove/${encodeURIComponent(index)}`,
          { method: "POST" },
        );
        return { ok: true };
      }
      case "create-ism-policy": {
        const policyId = required(form["policyId"], "policyId");
        const pattern = required(form["pattern"], "pattern");
        if (pattern === "*") {
          throw new Error("Use a narrower pattern than * so system indices are not deleted");
        }
        const deleteAfter = required(form["deleteAfter"], "deleteAfter");
        await osRequest(
          this.config,
          this.services?.http,
          `/_plugins/_ism/policies/${encodeURIComponent(policyId)}`,
          {
            method: "PUT",
            body: {
              policy: {
                description: `Delete ${pattern} indices older than ${deleteAfter}`,
                default_state: "hot",
                states: [
                  {
                    name: "hot",
                    actions: [],
                    transitions: [
                      { state_name: "delete", conditions: { min_index_age: deleteAfter } },
                    ],
                  },
                  { name: "delete", actions: [{ delete: {} }], transitions: [] },
                ],
                ism_template: [{ index_patterns: [pattern], priority: 100 }],
              },
            },
          },
        );
        return { ok: true };
      }
      case "create-sm-policy": {
        const name = required(form["name"], "name");
        const repository = required(form["repository"], "repository");
        const cron = required(form["schedule"], "schedule");
        const condition: Record<string, unknown> = {};
        if (form["maxAge"]) condition["max_age"] = form["maxAge"];
        if (form["minCount"]) condition["min_count"] = Number(form["minCount"]);
        const body: Record<string, unknown> = {
          description: `Snapshots to ${repository}`,
          creation: { schedule: { cron: { expression: cron, timezone: "UTC" } } },
          snapshot_config: {
            repository,
            indices: form["indices"]?.trim() || "*",
            include_global_state: "false",
          },
        };
        if (Object.keys(condition).length > 0 && condition["max_age"]) {
          body["deletion"] = {
            schedule: { cron: { expression: "0 3 * * *", timezone: "UTC" } },
            condition,
          };
        }
        await osRequest(
          this.config,
          this.services?.http,
          `/_plugins/_sm/policies/${encodeURIComponent(name)}`,
          { method: "POST", body },
        );
        return { ok: true };
      }
      case "search": {
        const index = required(form["index"], "index");
        let query: unknown;
        try {
          query = JSON.parse(form["query"] || '{"query":{"match_all":{}}}');
        } catch (err) {
          throw new Error(`query must be valid JSON: ${(err as Error).message}`);
        }
        const size = Number(form["size"] || 10);
        const r = await osRequest<{
          took: number;
          hits: { total?: { value: number }; hits: Array<{ _id: string; _source?: unknown }> };
        }>(this.config, this.services?.http, `/${encodeURIComponent(index)}/_search`, {
          method: "POST",
          body: { ...(query as object), size },
        });
        return {
          ok: true,
          took: r.body?.took,
          total: r.body?.hits?.total?.value ?? 0,
          hits: (r.body?.hits?.hits ?? []).slice(0, size),
        };
      }
      default:
        throw new Error(`OpenSearch plugin: unknown command "${command}"`);
    }
  }

  private endpointHost(): string {
    try {
      return new URL(this.config.endpoint).host;
    } catch {
      return this.config.endpoint;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Render helpers (module-scoped: no React)
// ─────────────────────────────────────────────────────────────────────────────

function buildNodesTable(nodes: NodeInfo[]): TableNode {
  const rows: TableRow[] = nodes.map((n) => {
    const heap = n.jvm?.mem?.heap_used_percent;
    const fsTotal = n.fs?.total?.total_in_bytes ?? 0;
    const fsAvail = n.fs?.total?.available_in_bytes ?? 0;
    const diskPct = fsTotal ? Math.round(((fsTotal - fsAvail) / fsTotal) * 100) : undefined;
    return {
      cells: {
        name: n.name ?? "—",
        roles: (n.roles ?? []).join(", ") || "—",
        ip: n.ip ?? "—",
        heap: heap != null ? `${heap}%` : "—",
        disk: diskPct != null ? `${diskPct}%` : "—",
      },
    };
  });
  return {
    kind: "table",
    columns: [
      { key: "name", label: "Node" },
      { key: "roles", label: "Roles" },
      { key: "ip", label: "IP" },
      { key: "heap", label: "Heap" },
      { key: "disk", label: "Disk" },
    ],
    rows,
    emphasizeFirstColumn: true,
  };
}

function buildIndicesTable(indices: CatIndex[]): TableNode {
  const rows: TableRow[] = indices.map((idx) => {
    const sizeBytes = Number(idx["store.size"] || 0);
    const rowActions: ActionNode = {
      kind: "action",
      label: "Delete",
      variant: "danger",
      action: {
        type: "plugin-action",
        actionId: `delete-index:${idx.index}`,
        destructive: true,
        confirmMessage: `Delete index "${idx.index}"? This permanently destroys all documents inside.`,
        successMessage: `Deleted index "${idx.index}".`,
      },
    };
    const refresh: ActionNode = {
      kind: "action",
      label: "Refresh",
      action: {
        type: "plugin-action",
        actionId: `refresh-index:${idx.index}`,
        successMessage: `Refreshed index "${idx.index}".`,
      },
    };
    const forceMerge: ActionNode = {
      kind: "action",
      label: "Force merge",
      action: {
        type: "plugin-action",
        actionId: `force-merge:${idx.index}`,
        confirmMessage: `Force-merge segments on "${idx.index}"? This is I/O-heavy and should only be run on read-only indices.`,
        successMessage: `Started force-merge on "${idx.index}".`,
      },
    };
    const openClose: ActionNode =
      idx.status === "close"
        ? {
            kind: "action",
            label: "Open",
            action: {
              type: "plugin-action",
              actionId: `open-index:${idx.index}`,
              confirmMessage: `Open index "${idx.index}"? Shards will be allocated before it becomes searchable.`,
              successMessage: `Started opening index "${idx.index}".`,
            },
          }
        : {
            kind: "action",
            label: "Close",
            action: {
              type: "plugin-action",
              actionId: `close-index:${idx.index}`,
              confirmMessage: `Close index "${idx.index}"? Closed indices cannot be searched or written until reopened.`,
              successMessage: `Started closing index "${idx.index}".`,
            },
          };
    return {
      cells: {
        index: idx.index,
        health: idx.health,
        docs: idx["docs.count"] ?? "0",
        size: formatBytes(sizeBytes),
        shards: `${idx.pri}p / ${idx.rep}r`,
        refresh,
        openClose,
        merge: forceMerge,
        delete: rowActions,
      },
    };
  });
  return {
    kind: "table",
    columns: [
      { key: "index", label: "Index" },
      { key: "health", label: "Health" },
      { key: "docs", label: "Docs" },
      { key: "size", label: "Size" },
      { key: "shards", label: "Shards" },
      { key: "refresh", label: "", width: "narrow" },
      { key: "openClose", label: "", width: "narrow" },
      { key: "merge", label: "", width: "narrow" },
      { key: "delete", label: "", width: "narrow" },
    ],
    rows,
    emphasizeFirstColumn: true,
  };
}

function buildReposTable(repos: Record<string, { type: string }>): TableNode {
  const names = Object.keys(repos);
  const rows: TableRow[] = names.map((name) => {
    const repo = repos[name];
    return {
      cells: {
        name,
        type: repo?.type ?? "—",
        snapshot: {
          kind: "action",
          label: "Snapshot now",
          action: {
            type: "plugin-action",
            actionId: `create-snapshot:${name}`,
            confirmMessage: `Take a snapshot of all indices into repository "${name}"?`,
            successMessage: `Started snapshot in "${name}".`,
          },
        } satisfies ActionNode,
        del: {
          kind: "action",
          label: "Delete",
          variant: "danger",
          action: {
            type: "plugin-action",
            actionId: `delete-repo:${name}`,
            destructive: true,
            confirmMessage: `Unregister repository "${name}"? Snapshots already inside the repo are not deleted from the underlying storage.`,
            successMessage: `Unregistered repository "${name}".`,
          },
        } satisfies ActionNode,
      },
    };
  });
  return {
    kind: "table",
    columns: [
      { key: "name", label: "Repository" },
      { key: "type", label: "Type" },
      { key: "snapshot", label: "", width: "narrow" },
      { key: "del", label: "", width: "narrow" },
    ],
    rows,
    emphasizeFirstColumn: true,
  };
}

const SM_SCHEDULES = [
  { cron: "0 * * * *", label: "Every hour" },
  { cron: "0 */6 * * *", label: "Every 6 hours" },
  { cron: "0 */12 * * *", label: "Every 12 hours" },
  { cron: "0 2 * * *", label: "Daily at 02:00 UTC" },
  { cron: "0 2 * * 0", label: "Weekly, Sunday 02:00 UTC" },
];

function required(v: string | undefined, name: string): string {
  if (!v || !v.trim()) throw new Error(`Missing required field: ${name}`);
  return v.trim();
}

function parseJson<T>(v: unknown): T | undefined {
  if (typeof v !== "string" || !v) return undefined;
  try {
    return JSON.parse(v) as T;
  } catch {
    return undefined;
  }
}

/** Like parseJson, but anything other than an array reads as "not available". */
function parseJsonArray<T>(v: unknown): T[] | undefined {
  const parsed = parseJson<unknown>(v);
  return Array.isArray(parsed) ? (parsed as T[]) : undefined;
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${(n / 1_000_000_000).toFixed(1)}B`;
}

/**
 * The rest of `_nodes/stats`, summed or averaged across nodes
 * (https://docs.opensearch.org/latest/api-reference/nodes-apis/nodes-stats/).
 * Groups a node does not return (the `breaker` and `transport` metrics on
 * some managed services, for instance) drop their series rather than charting
 * a zero. Counters are lifetime totals, labelled so; the latency series are
 * the lifetime mean per operation, which moves slowly but is the only
 * latency the API reports without a second sample to diff against.
 */
export function nodeStatsSeries(nodes: NodeInfo[], ts: number): MetricSeries[] {
  const out: MetricSeries[] = [];
  const nums = (pick: (n: NodeInfo) => number | undefined) =>
    nodes.map(pick).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const push = (label: string, values: number[], combine: "sum" | "avg", unit?: string) => {
    if (values.length === 0) return;
    const total = values.reduce((a, b) => a + b, 0);
    const value = combine === "sum" ? total : total / values.length;
    out.push({
      label,
      ...(unit ? { unit } : {}),
      points: [{ timestamp: ts, value: Math.round(value * 100) / 100 }],
    });
  };
  const ratio = (label: string, time: number[], count: number[]) => {
    const t = time.reduce((a, b) => a + b, 0);
    const c = count.reduce((a, b) => a + b, 0);
    if (c > 0)
      out.push({
        label,
        unit: "ms",
        points: [{ timestamp: ts, value: Math.round((t / c) * 100) / 100 }],
      });
  };

  push(
    "Avg OS memory used %",
    nums((n) => n.os?.mem?.used_percent),
    "avg",
    "%",
  );
  push(
    "Avg load (1m)",
    nums((n) => n.os?.cpu?.load_average?.["1m"]),
    "avg",
  );
  ratio(
    "Avg search query latency (lifetime)",
    nums((n) => n.indices?.search?.query_time_in_millis),
    nums((n) => n.indices?.search?.query_total),
  );
  ratio(
    "Avg indexing latency (lifetime)",
    nums((n) => n.indices?.indexing?.index_time_in_millis),
    nums((n) => n.indices?.indexing?.index_total),
  );
  for (const pool of ["search", "write"] as const) {
    push(
      `${pool === "search" ? "Search" : "Write"} queue`,
      nums((n) => n.thread_pool?.[pool]?.queue),
      "sum",
    );
    push(
      `${pool === "search" ? "Search" : "Write"} rejections (cumulative)`,
      nums((n) => n.thread_pool?.[pool]?.rejected),
      "sum",
    );
  }
  push(
    "Old GC collections (cumulative)",
    nums((n) => n.jvm?.gc?.collectors?.["old"]?.collection_count),
    "sum",
  );
  push(
    "Old GC time (cumulative)",
    nums((n) => n.jvm?.gc?.collectors?.["old"]?.collection_time_in_millis),
    "sum",
    "ms",
  );
  push(
    "Circuit breaker trips (cumulative)",
    nums((n) =>
      n.breakers ? Object.values(n.breakers).reduce((a, b) => a + (b.tripped ?? 0), 0) : undefined,
    ),
    "sum",
  );
  push(
    "Open HTTP connections",
    nums((n) => n.http?.current_open),
    "sum",
  );
  push(
    "Segments",
    nums((n) => n.indices?.segments?.count),
    "sum",
  );
  push(
    "Running merges",
    nums((n) => n.indices?.merges?.current),
    "sum",
  );
  push(
    "Query cache size",
    nums((n) => n.indices?.query_cache?.memory_size_in_bytes),
    "sum",
    "bytes",
  );
  push(
    "Fielddata size",
    nums((n) => n.indices?.fielddata?.memory_size_in_bytes),
    "sum",
    "bytes",
  );
  push(
    "Query cache evictions (cumulative)",
    nums((n) => n.indices?.query_cache?.evictions),
    "sum",
  );
  push(
    "Transport received (cumulative)",
    nums((n) => n.transport?.rx_size_in_bytes),
    "sum",
    "bytes",
  );
  push(
    "Transport sent (cumulative)",
    nums((n) => n.transport?.tx_size_in_bytes),
    "sum",
    "bytes",
  );
  return out;
}
