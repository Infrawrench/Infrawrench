import type {
  PluginClient,
  HostServices,
  ResourceInstance,
  ResourceCreateReturn,
  DetailViewSchema,
  SidebarItemSchema,
  DashboardStat,
  MetricSeries,
  PeerPaneContext,
  PeerPaneSchema,
  PeerPaneResource,
  CreateResourceConfig,
  PublishMessagePayload,
  PublishMessageResult,
} from "@infrawrench/plugin-base";

/**
 * Kafka plugin client.
 *
 * Uses the KV host services channel to execute Kafka Admin operations. The
 * driver (driver.ts) interprets the `cmd` string as an Admin operation name
 * and parses simple string/number arguments.
 *
 * Command protocol:
 *   cmd = operation name (e.g. "describeCluster", "listTopics", "createTopic")
 *   args = positional args; complex values are JSON-encoded strings
 */
export class KafkaClient implements PluginClient {
  private readonly connectionString: string;
  private readonly services: HostServices | undefined;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const cs = credentials["connectionString"];
    if (!cs) throw new Error("Kafka plugin: missing connectionString credential");
    this.connectionString = cs;
    this.services = services;
  }

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "kafka-cluster":
        return this.listClusters(accountId);
      case "kafka-topic":
        return this.listTopics(accountId);
      case "kafka-consumer-group":
        return this.listConsumerGroups(accountId);
      default:
        throw new Error(`Kafka plugin: unknown resource type "${typeId}"`);
    }
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const all = await this.listResources(typeId, accountId);
    const found = all.find((r) => r.id === resourceId);
    if (!found) throw new Error(`Kafka plugin: resource ${typeId}/${resourceId} not found`);
    return found;
  }

  async resolveOutput(typeId: string, resourceId: string, outputKey: string): Promise<string> {
    if (typeId === "kafka-cluster") {
      if (outputKey === "connectionString") return this.connectionString;
      if (outputKey === "bootstrapServers") return parseBootstrapServers(this.connectionString);
      if (outputKey === "clusterId") {
        const kv = this.services?.kv;
        if (!kv) return "";
        try {
          const raw = (await kv.command("describeCluster")) as { clusterId?: string };
          return raw.clusterId ?? "";
        } catch {
          return "";
        }
      }
    }
    if (typeId === "kafka-topic") {
      const name = topicNameFromId(resourceId);
      if (outputKey === "name") return name;
      if (outputKey === "partitionCount") {
        const kv = this.services?.kv;
        if (!kv) return "";
        try {
          const raw = (await kv.command("describeTopic", name)) as {
            partitions?: unknown[];
          };
          return String(raw.partitions?.length ?? 0);
        } catch {
          return "";
        }
      }
    }
    if (typeId === "kafka-consumer-group") {
      if (outputKey === "groupId") return groupIdFromId(resourceId);
    }
    throw new Error(`Kafka plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
  }

  getCreateConfig(typeId: string): Promise<CreateResourceConfig> {
    if (typeId !== "kafka-topic") {
      throw new Error(`Kafka plugin: createResource not supported for type "${typeId}"`);
    }
    return Promise.resolve({
      fields: [
        {
          key: "name",
          label: "Topic Name",
          kind: "text",
          required: true,
          placeholder: "events",
          description: "Letters, digits, `.`, `_`, and `-`. Must be unique within the cluster.",
        },
        {
          key: "partitions",
          label: "Partitions",
          kind: "number",
          required: true,
          defaultValue: "3",
          minValue: 1,
          stepValue: 1,
          description: "More partitions allow more parallel consumers; can't be reduced later.",
        },
        {
          key: "replicationFactor",
          label: "Replication Factor",
          kind: "number",
          required: true,
          defaultValue: "1",
          minValue: 1,
          stepValue: 1,
          description: "Copies of each partition. Must be ≤ the number of brokers in the cluster.",
        },
      ],
    });
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceCreateReturn> {
    if (typeId !== "kafka-topic") {
      throw new Error(`Kafka plugin: createResource not supported for type "${typeId}"`);
    }
    const kv = this.services?.kv;
    if (!kv) throw new Error("Kafka KV service not available");
    const name = (fields["name"] ?? "").trim();
    if (!name) throw new Error("Topic name is required");
    const partitions = fields["partitions"] ? Number(fields["partitions"]) : 1;
    const replicationFactor = fields["replicationFactor"] ? Number(fields["replicationFactor"]) : 1;
    await kv.command("createTopic", name, partitions, replicationFactor);
    const now = new Date().toISOString();
    return {
      id: topicId(accountId, name),
      pluginId: "kafka",
      resourceTypeId: "kafka-topic",
      accountId,
      displayName: name,
      fields: { name, partitions, replicationFactor },
      resolvedOutputs: {},
      secretStates: [],
      externalId: name,
      createdAt: now,
      updatedAt: now,
    };
  }

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    const kv = this.services?.kv;
    if (!kv) throw new Error("Kafka KV service not available");
    if (typeId === "kafka-topic") {
      await kv.command("deleteTopic", topicNameFromId(resourceId));
      return;
    }
    if (typeId === "kafka-consumer-group") {
      await kv.command("deleteGroup", groupIdFromId(resourceId));
      return;
    }
    throw new Error(`Kafka plugin: deleteResource not supported for type "${typeId}"`);
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    switch (resource.resourceTypeId) {
      case "kafka-cluster":
        return this.renderClusterDetail(resource);
      case "kafka-topic":
        return this.renderTopicDetail(resource);
      case "kafka-consumer-group":
        return this.renderConsumerGroupDetail(resource);
      default:
        throw new Error(`Kafka plugin: unknown resource type "${resource.resourceTypeId}"`);
    }
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return {
      id: resource.id,
      label: resource.displayName,
      status: { kind: "status-dot", status: "info" },
    };
  }

  async renderPeerPane(context: PeerPaneContext): Promise<PeerPaneSchema> {
    // Let listTopics throw: an empty cluster returns `[]`, so a thrown error
    // means the connection/auth actually failed — surface it as a pane error
    // instead of a misleading "connected, nothing to show". Consumer-group
    // listing is secondary (separate ACLs on some clusters), so keep it soft.
    const topics = await this.listTopics(context.accountId);
    const groups = await this.listConsumerGroups(context.accountId).catch(() => []);
    const toPeer = (instances: ResourceInstance[]): PeerPaneResource[] =>
      instances.map((inst) => ({
        id: inst.id,
        pluginId: inst.pluginId,
        resourceTypeId: inst.resourceTypeId,
        displayName: inst.displayName,
        subtitle: "",
        status: "healthy",
        fields: inst.fields,
      }));
    return {
      resourceGroups: [
        {
          title: `Topics (${topics.length})`,
          resourceTypeId: "kafka-topic",
          pluginId: "kafka",
          items: toPeer(topics),
          // Surface a "+ Create" button (incl. when empty) so a fresh cluster
          // isn't a dead-end — topics are created via the Admin API.
          supportsCreate: true,
        },
        {
          // Consumer groups aren't created directly — they materialise when a
          // consumer subscribes — so no create button here.
          title: `Consumer Groups (${groups.length})`,
          resourceTypeId: "kafka-consumer-group",
          pluginId: "kafka",
          items: toPeer(groups),
        },
      ],
    };
  }

  async fetchDashboardStats(
    resourceTypeId: string,
    _resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    const kv = this.services?.kv;
    if (!kv || resourceTypeId !== "kafka-cluster") {
      return [
        { label: "Brokers", value: "" },
        { label: "Topics", value: "" },
        { label: "Groups", value: "" },
      ];
    }
    try {
      const cluster = (await kv.command("describeCluster")) as {
        brokers?: unknown[];
      };
      const [topics, groups] = await Promise.all([
        this.listTopics(accountId).catch(() => []),
        this.listConsumerGroups(accountId).catch(() => []),
      ]);
      return [
        { label: "Brokers", value: String(cluster.brokers?.length ?? 0) },
        { label: "Topics", value: String(topics.length) },
        { label: "Groups", value: String(groups.length) },
      ];
    } catch {
      return [
        { label: "Brokers", value: "" },
        { label: "Topics", value: "" },
        { label: "Groups", value: "" },
      ];
    }
  }

  async fetchMetricSeries(
    resourceTypeId: string,
    _resourceId: string,
    accountId: string,
  ): Promise<MetricSeries[]> {
    if (resourceTypeId !== "kafka-cluster") return [];
    const kv = this.services?.kv;
    if (!kv) return [];
    const ts = Date.now();
    try {
      const cluster = (await kv.command("describeCluster")) as { brokers?: unknown[] };
      const topics = await this.listTopics(accountId).catch(() => []);
      const groups = await this.listConsumerGroups(accountId).catch(() => []);
      return [
        { label: "Brokers", points: [{ timestamp: ts, value: cluster.brokers?.length ?? 0 }] },
        { label: "Topics", points: [{ timestamp: ts, value: topics.length }] },
        { label: "Consumer groups", points: [{ timestamp: ts, value: groups.length }] },
      ];
    } catch {
      return [];
    }
  }

  private async listClusters(accountId: string): Promise<ResourceInstance[]> {
    const now = new Date().toISOString();
    const bootstrap = parseBootstrapServers(this.connectionString);
    const fields: Record<string, string | number | boolean> = {
      bootstrapServers: bootstrap,
    };
    const resolvedOutputs: Record<string, string> = {
      bootstrapServers: bootstrap,
    };
    const kv = this.services?.kv;
    if (kv) {
      try {
        const cluster = (await kv.command("describeCluster")) as {
          clusterId?: string;
          brokers?: unknown[];
          controller?: number;
        };
        if (cluster.clusterId) {
          fields["clusterId"] = cluster.clusterId;
          resolvedOutputs["clusterId"] = cluster.clusterId;
        }
        if (typeof cluster.controller === "number") fields["controllerId"] = cluster.controller;
        if (cluster.brokers) fields["brokerCount"] = cluster.brokers.length;
      } catch {
        /* fall through with bootstrap-only fields */
      }
    }
    const externalId = typeof fields["clusterId"] === "string" ? fields["clusterId"] : null;
    return [
      {
        id: clusterId(accountId),
        pluginId: "kafka",
        resourceTypeId: "kafka-cluster",
        accountId,
        displayName: bootstrap || "Kafka",
        fields,
        resolvedOutputs,
        secretStates: [],
        ...(externalId ? { externalId } : {}),
        createdAt: now,
        updatedAt: now,
      },
    ];
  }

  private async listTopics(accountId: string): Promise<ResourceInstance[]> {
    const kv = this.services?.kv;
    if (!kv) return [];
    const now = new Date().toISOString();
    const names = (await kv.command("listTopics")) as string[];
    const parent = clusterId(accountId);
    const topicNames = names.filter((name) => !name.startsWith("__")).sort();
    const metadata = await Promise.all(
      topicNames.map(async (name) => {
        try {
          return [name, await kv.command("describeTopic", name)] as const;
        } catch {
          return [name, null] as const;
        }
      }),
    );
    const byName = new Map(metadata);
    return topicNames.map((name) => {
      const meta = byName.get(name) as
        { partitions?: Array<{ replicas?: unknown[] }> } | null | undefined;
      const partitions = Array.isArray(meta?.partitions) ? meta.partitions : [];
      const replicationFactor =
        partitions.length > 0 && Array.isArray(partitions[0]?.replicas)
          ? partitions[0]!.replicas!.length
          : undefined;
      return {
        id: topicId(accountId, name),
        pluginId: "kafka",
        resourceTypeId: "kafka-topic",
        accountId,
        displayName: name,
        fields: {
          name,
          ...(partitions.length > 0 ? { partitions: partitions.length } : {}),
          ...(replicationFactor !== undefined ? { replicationFactor } : {}),
        },
        resolvedOutputs: {},
        secretStates: [],
        externalId: name,
        parentResourceId: parent,
        createdAt: now,
        updatedAt: now,
      };
    });
  }

  private async listConsumerGroups(accountId: string): Promise<ResourceInstance[]> {
    const kv = this.services?.kv;
    if (!kv) return [];
    const now = new Date().toISOString();
    const raw = (await kv.command("listGroups")) as Array<{
      groupId: string;
      protocolType: string;
    }>;
    const parent = clusterId(accountId);
    return raw.map((g) => ({
      id: groupResourceId(accountId, g.groupId),
      pluginId: "kafka",
      resourceTypeId: "kafka-consumer-group",
      accountId,
      displayName: g.groupId,
      fields: { groupId: g.groupId, protocol: g.protocolType ?? "" },
      resolvedOutputs: {},
      secretStates: [],
      externalId: g.groupId,
      parentResourceId: parent,
      createdAt: now,
      updatedAt: now,
    }));
  }

  private renderClusterDetail(resource: ResourceInstance): DetailViewSchema {
    const cs = resource.secretStates.find((s) => s.fieldKey === "connectionString");
    const bootstrap = String(resource.fields["bootstrapServers"] ?? "");
    const clusterIdValue = String(resource.fields["clusterId"] ?? "");
    const controllerId = resource.fields["controllerId"];
    const brokerCount = resource.fields["brokerCount"];
    return {
      title: resource.displayName,
      subtitle: clusterIdValue ? `Cluster ${clusterIdValue}` : bootstrap,
      status: { kind: "status-dot", status: "healthy" },
      sections: [
        {
          kind: "section",
          title: "Connection",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Bootstrap Servers", value: bootstrap || "—" },
                {
                  key: "Connection URL",
                  value: cs
                    ? {
                        kind: "secret-placeholder",
                        fieldKey: "connectionString",
                        resolution: cs.resolution,
                      }
                    : this.connectionString,
                  sensitive: true,
                },
                ...(clusterIdValue ? [{ key: "Cluster ID", value: clusterIdValue }] : []),
                ...(controllerId != null
                  ? [{ key: "Controller", value: String(controllerId) }]
                  : []),
                ...(brokerCount != null ? [{ key: "Brokers", value: String(brokerCount) }] : []),
              ],
            },
          ],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
      // `kafka-cluster` declares `supportsMetrics`, so the host fetches broker
      // / topic / consumer-group counts for this view; without the capability
      // it had nowhere to put them. No default window — `fetchMetricSeries`
      // reads the Admin API right now and returns a single point per series.
      metricsCapability: {},
    };
  }

  private renderTopicDetail(resource: ResourceInstance): DetailViewSchema {
    const name = String(resource.fields["name"] ?? resource.displayName);
    const partitions = resource.fields["partitions"];
    const replicationFactor = resource.fields["replicationFactor"];
    return {
      title: name,
      subtitle: "Topic",
      status: { kind: "status-dot", status: "healthy" },
      sections: [
        {
          kind: "section",
          title: "Topic",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Name", value: name },
                ...(partitions != null ? [{ key: "Partitions", value: String(partitions) }] : []),
                ...(replicationFactor != null
                  ? [{ key: "Replication factor", value: String(replicationFactor) }]
                  : []),
              ],
            },
          ],
        },
      ],
      publishPanel: {
        tabLabel: "Produce",
        subtitle: `Produce a record to ${name}`,
        bodyFormat: "text",
        defaultBody: '{"hello":"world"}',
        helpText:
          "Sent through kafkajs producer.send. Body is the record value; headers are sent as Kafka record headers.",
        submitLabel: "Produce",
        extraFields: [
          {
            key: "key",
            label: "Key",
            kind: "text",
            optional: true,
            helpText: "Optional Kafka message key — drives partition assignment.",
          },
          {
            key: "headers",
            label: "Headers",
            kind: "key-value-list",
            helpText: "Sent as Kafka record headers.",
          },
          {
            key: "partition",
            label: "Partition",
            kind: "number",
            optional: true,
            helpText: "Optional zero-based partition number.",
          },
        ],
      },
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  async publishMessage(
    typeId: string,
    resourceId: string,
    _accountId: string,
    payload: PublishMessagePayload,
  ): Promise<PublishMessageResult> {
    if (typeId !== "kafka-topic") {
      throw new Error(`Kafka plugin: publishMessage not supported for type "${typeId}"`);
    }
    const kv = this.services?.kv;
    if (!kv) throw new Error("Kafka plugin: KV host services unavailable.");
    const topic = topicNameFromId(resourceId);
    const key = typeof payload.extras["key"] === "string" ? (payload.extras["key"] as string) : "";
    const partition =
      typeof payload.extras["partition"] === "string"
        ? (payload.extras["partition"] as string).trim()
        : "";
    const headersObj =
      payload.extras["headers"] && typeof payload.extras["headers"] === "object"
        ? (payload.extras["headers"] as Record<string, string>)
        : {};
    // Drop blank header keys so the producer doesn't trip on them.
    const cleanHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(headersObj)) {
      if (k.trim()) cleanHeaders[k] = v;
    }
    const headersJson = Object.keys(cleanHeaders).length > 0 ? JSON.stringify(cleanHeaders) : "";
    const result = (await kv.command(
      "produce",
      topic,
      payload.body,
      key,
      headersJson,
      partition,
    )) as {
      partition?: number;
      offset?: string;
    };
    const id =
      result.partition !== undefined && result.offset !== undefined
        ? `partition ${result.partition} offset ${result.offset}`
        : undefined;
    return {
      ...(id ? { id } : {}),
      summary: id ? `Produced — ${id}` : "Record produced.",
    };
  }

  private renderConsumerGroupDetail(resource: ResourceInstance): DetailViewSchema {
    const groupId = String(resource.fields["groupId"] ?? resource.displayName);
    const state = resource.fields["state"];
    const protocol = resource.fields["protocol"];
    const members = resource.fields["members"];
    return {
      title: groupId,
      subtitle: "Consumer group",
      status: { kind: "status-dot", status: "healthy" },
      sections: [
        {
          kind: "section",
          title: "Group",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Group ID", value: groupId },
                ...(state ? [{ key: "State", value: String(state) }] : []),
                ...(protocol ? [{ key: "Protocol", value: String(protocol) }] : []),
                ...(members != null ? [{ key: "Members", value: String(members) }] : []),
              ],
            },
          ],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }
}

function clusterId(accountId: string): string {
  return `${accountId}:kafka-cluster:cluster`;
}

function topicId(accountId: string, name: string): string {
  return `${accountId}:kafka-topic:${name}`;
}

function topicNameFromId(resourceId: string): string {
  return resourceId.split(":").slice(2).join(":");
}

function groupResourceId(accountId: string, groupId: string): string {
  return `${accountId}:kafka-consumer-group:${groupId}`;
}

function groupIdFromId(resourceId: string): string {
  return resourceId.split(":").slice(2).join(":");
}

/**
 * Parse the bootstrap broker list from a kafka:// URL. The plugin uses a
 * custom URL scheme; the brokers may live in the hostname or in a
 * `brokers=` query param (the latter supports multi-broker lists since
 * commas aren't allowed in a URL host).
 */
export function parseBootstrapServers(connectionString: string): string {
  try {
    const u = new URL(connectionString);
    const fromQuery = u.searchParams.get("brokers");
    if (fromQuery) return fromQuery;
    const host = u.host || u.pathname.replace(/^\/+/, "");
    return host;
  } catch {
    return connectionString;
  }
}
