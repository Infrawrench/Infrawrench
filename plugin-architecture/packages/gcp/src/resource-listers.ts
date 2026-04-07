// ─── Resource listing functions ─────────────────────────────────────────────
//
// Each function corresponds to a GCP resource type and returns ResourceInstance[].
// They receive a context object with the helpers they need from the GcpClient.

import type { ResourceInstance } from "@infrawrench/plugin-base";

export interface ListerContext {
  get: <T>(url: string) => Promise<T>;
  paginate: <T>(baseUrl: string, key: string, params?: Record<string, string>) => Promise<T[]>;
  id: (accountId: string, typeId: string, externalId: string) => string;
  now: () => string;
}

export async function listGceInstances(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.get<{ items?: Record<string, { instances?: unknown[] }> }>(
    `https://compute.googleapis.com/compute/v1/projects/${p}/aggregated/instances`,
  );
  const results: ResourceInstance[] = [];
  for (const zone of Object.values(data.items ?? {})) {
    for (const inst of (zone.instances ?? []) as Record<string, unknown>[]) {
      const name = String(inst["name"]);
      const zone_ = String(inst["zone"]).split("/").pop() ?? "";
      const machineType = String(inst["machineType"]).split("/").pop() ?? "";
      const status = String(inst["status"] ?? "");
      const nets = inst["networkInterfaces"] as Array<Record<string, unknown>> | undefined;
      const externalIp =
        ((nets?.[0]?.["accessConfigs"] as Array<Record<string, unknown>> | undefined)?.[0]?.["natIP"] as string) ?? "";
      const internalIp = (nets?.[0]?.["networkIP"] as string) ?? "";
      results.push({
        id: ctx.id(accountId, "gce-instance", `${p}/${zone_}/${name}`),
        pluginId: "gcp",
        resourceTypeId: "gce-instance",
        accountId,
        displayName: name,
        fields: { name, zone: zone_, machineType, status },
        resolvedOutputs: { externalIp, internalIp },
        secretStates: [],
        externalId: `${p}/${zone_}/${name}`,
        createdAt: String(inst["creationTimestamp"] ?? ctx.now()),
        updatedAt: ctx.now(),
      });
    }
  }
  return results;
}

export async function listGceDisks(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.get<{ items?: Record<string, { disks?: unknown[] }> }>(
    `https://compute.googleapis.com/compute/v1/projects/${p}/aggregated/disks`,
  );
  const results: ResourceInstance[] = [];
  for (const zone of Object.values(data.items ?? {})) {
    for (const disk of (zone.disks ?? []) as Record<string, unknown>[]) {
      const name = String(disk["name"]);
      const zone_ = String(disk["zone"]).split("/").pop() ?? "";
      const type = String(disk["type"]).split("/").pop() ?? "";
      results.push({
        id: ctx.id(accountId, "gce-disk", `${p}/${zone_}/${name}`),
        pluginId: "gcp",
        resourceTypeId: "gce-disk",
        accountId,
        displayName: name,
        fields: {
          name,
          zone: zone_,
          sizeGb: Number(disk["sizeGb"] ?? 0),
          type,
          status: String(disk["status"] ?? ""),
        },
        resolvedOutputs: {},
        secretStates: [],
        externalId: `${p}/${zone_}/${name}`,
        createdAt: String(disk["creationTimestamp"] ?? ctx.now()),
        updatedAt: ctx.now(),
      });
    }
  }
  return results;
}

export async function listGkeClusters(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.get<{ clusters?: Record<string, unknown>[] }>(
    `https://container.googleapis.com/v1/projects/${p}/locations/-/clusters`,
  );
  return (data.clusters ?? []).map((c) => {
    const name = String(c["name"]);
    const location = String(c["location"] ?? "");
    const nodePool = (c["nodePools"] as Array<Record<string, unknown>> | undefined)?.[0];
    const nodeConfig = (nodePool?.["config"] as Record<string, unknown> | undefined) ?? {};
    const nodeCount = Number(
      (nodePool?.["initialNodeCount"] as number | undefined) ?? 0,
    );
    return {
      id: ctx.id(accountId, "gke-cluster", `${p}/${location}/${name}`),
      pluginId: "gcp",
      resourceTypeId: "gke-cluster",
      accountId,
      displayName: name,
      fields: {
        name,
        location,
        version: String(c["currentMasterVersion"] ?? ""),
        machineType: String(nodeConfig["machineType"] ?? ""),
        diskSizeGb: Number(nodeConfig["diskSizeGb"] ?? 0),
        nodeCount,
        status: String(c["status"] ?? ""),
      },
      resolvedOutputs: {
        clusterEndpoint: String(c["endpoint"] ?? ""),
      },
      secretStates: [],
      externalId: name,
      createdAt: String(c["createTime"] ?? ctx.now()),
      updatedAt: String(c["updateTime"] ?? ctx.now()),
    };
  });
}

export async function listCloudSqlInstances(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const items = await ctx.paginate<Record<string, unknown>>(
    `https://sqladmin.googleapis.com/v1/projects/${p}/instances`,
    "items",
  );
  return items.map((db) => {
    const ip = (db["ipAddresses"] as Array<Record<string, unknown>> | undefined)?.find(
      (a) => a["type"] === "PRIMARY",
    );
    return {
      id: ctx.id(accountId, "cloudsql-instance", String(db["name"])),
      pluginId: "gcp",
      resourceTypeId: "cloudsql-instance",
      accountId,
      displayName: String(db["name"]),
      fields: {
        name: String(db["name"]),
        databaseVersion: String(db["databaseVersion"] ?? ""),
        region: String(db["region"] ?? ""),
        tier: String(
          (db["settings"] as Record<string, unknown> | undefined)?.["tier"] ?? "",
        ),
        state: String(db["state"] ?? ""),
        availabilityType: String(
          (db["settings"] as Record<string, unknown> | undefined)?.["availabilityType"] ?? "",
        ),
      },
      resolvedOutputs: {
        connectionName: String(db["connectionName"] ?? ""),
        ipAddress: String(ip?.["ipAddress"] ?? ""),
      },
      secretStates: [],
      externalId: String(db["name"]),
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}

export async function listSpannerInstances(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const items = await ctx.paginate<Record<string, unknown>>(
    `https://spanner.googleapis.com/v1/projects/${p}/instances`,
    "instances",
  );
  return items.map((inst) => {
    const name = String(inst["name"]).split("/").pop() ?? "";
    return {
      id: ctx.id(accountId, "spanner-instance", name),
      pluginId: "gcp",
      resourceTypeId: "spanner-instance",
      accountId,
      displayName: String(inst["displayName"] ?? name),
      fields: {
        name,
        displayName: String(inst["displayName"] ?? ""),
        config: String(inst["config"] ?? "").split("/").pop() ?? "",
        nodeCount: Number(inst["nodeCount"] ?? 0),
        processingUnits: Number(inst["processingUnits"] ?? 0),
        state: String(inst["state"] ?? ""),
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: name,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}

export async function listBigtableInstances(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.get<{ instances?: Record<string, unknown>[] }>(
    `https://bigtableadmin.googleapis.com/v2/projects/${p}/instances`,
  );
  return (data.instances ?? []).map((inst) => {
    const name = String(inst["name"]).split("/").pop() ?? "";
    return {
      id: ctx.id(accountId, "bigtable-instance", name),
      pluginId: "gcp",
      resourceTypeId: "bigtable-instance",
      accountId,
      displayName: String(inst["displayName"] ?? name),
      fields: {
        name,
        displayName: String(inst["displayName"] ?? ""),
        type: String(inst["type"] ?? ""),
        state: String(inst["state"] ?? ""),
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: name,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}

export async function listFirestoreDatabases(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.get<{ databases?: Record<string, unknown>[] }>(
    `https://firestore.googleapis.com/v1/projects/${p}/databases`,
  );
  return (data.databases ?? []).map((db) => {
    const name = String(db["name"]).split("/").pop() ?? "";
    return {
      id: ctx.id(accountId, "firestore-database", `${p}/${name}`),
      pluginId: "gcp",
      resourceTypeId: "firestore-database",
      accountId,
      displayName: name === "(default)" ? `${p} (default)` : name,
      fields: {
        name,
        locationId: String(db["locationId"] ?? ""),
        type: String(db["type"] ?? ""),
        concurrencyMode: String(db["concurrencyMode"] ?? ""),
        state: String(db["state"] ?? ""),
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: name,
      createdAt: String(db["createTime"] ?? ctx.now()),
      updatedAt: String(db["updateTime"] ?? ctx.now()),
    };
  });
}

export async function listMemorystoreRedis(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const items = await ctx.paginate<Record<string, unknown>>(
    `https://redis.googleapis.com/v1/projects/${p}/locations/-/instances`,
    "instances",
  );
  return items.map((inst) => {
    const fullName = String(inst["name"]);
    const name = fullName.split("/").pop() ?? "";
    const region = fullName.split("/")[3] ?? "";
    return {
      id: ctx.id(accountId, "memorystore-redis", fullName),
      pluginId: "gcp",
      resourceTypeId: "memorystore-redis",
      accountId,
      displayName: name,
      fields: {
        name,
        region,
        tier: String(inst["tier"] ?? ""),
        memorySizeGb: Number(inst["memorySizeGb"] ?? 0),
        redisVersion: String(inst["redisVersion"] ?? ""),
        state: String(inst["state"] ?? ""),
      },
      resolvedOutputs: {
        host: String(inst["host"] ?? ""),
        port: String(inst["port"] ?? "6379"),
      },
      secretStates: [],
      externalId: fullName,
      createdAt: String(inst["createTime"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

export async function listAlloyDbClusters(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const items = await ctx.paginate<Record<string, unknown>>(
    `https://alloydb.googleapis.com/v1/projects/${p}/locations/-/clusters`,
    "clusters",
  );
  return items.map((c) => {
    const fullName = String(c["name"]);
    const name = fullName.split("/").pop() ?? "";
    const location = fullName.split("/")[3] ?? "";
    const primary = c["primaryConfig"] as Record<string, unknown> | undefined;
    const endpoint = String(
      (primary?.["nodes"] as Array<Record<string, unknown>> | undefined)?.[0]?.["ipAddress"] ?? "",
    );
    return {
      id: ctx.id(accountId, "alloydb-cluster", fullName),
      pluginId: "gcp",
      resourceTypeId: "alloydb-cluster",
      accountId,
      displayName: String(c["displayName"] ?? name),
      fields: {
        name,
        location,
        databaseVersion: String(c["databaseVersion"] ?? ""),
        state: String(c["state"] ?? ""),
        clusterType: String(c["clusterType"] ?? ""),
      },
      resolvedOutputs: { primaryEndpoint: endpoint },
      secretStates: [],
      externalId: fullName,
      createdAt: String(c["createTime"] ?? ctx.now()),
      updatedAt: String(c["updateTime"] ?? ctx.now()),
    };
  });
}

export async function listGcsBuckets(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const items = await ctx.paginate<Record<string, unknown>>(
    `https://storage.googleapis.com/storage/v1/b`,
    "items",
    { project: p },
  );
  return items.map((b) => {
    const name = String(b["name"]);
    const versioning = !!(b["versioning"] as Record<string, unknown> | undefined)?.["enabled"];
    return {
      id: ctx.id(accountId, "gcs-bucket", name),
      pluginId: "gcp",
      resourceTypeId: "gcs-bucket",
      accountId,
      displayName: name,
      fields: {
        name,
        location: String(b["location"] ?? ""),
        storageClass: String(b["storageClass"] ?? ""),
        publicAccessPrevention: String(
          (b["iamConfiguration"] as Record<string, unknown> | undefined)?.["publicAccessPrevention"] ?? "",
        ),
        versioning,
      },
      resolvedOutputs: { endpoint: `https://storage.googleapis.com/${name}` },
      secretStates: [],
      externalId: name,
      createdAt: String(b["timeCreated"] ?? ctx.now()),
      updatedAt: String(b["updated"] ?? ctx.now()),
    };
  });
}

export async function listPubSubTopics(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const items = await ctx.paginate<Record<string, unknown>>(
    `https://pubsub.googleapis.com/v1/projects/${p}/topics`,
    "topics",
  );
  return items.map((t) => {
    const fullName = String(t["name"]);
    const name = fullName.split("/").pop() ?? "";
    return {
      id: ctx.id(accountId, "pubsub-topic", fullName),
      pluginId: "gcp",
      resourceTypeId: "pubsub-topic",
      accountId,
      displayName: name,
      fields: {
        name,
        kmsKeyName: String(t["kmsKeyName"] ?? ""),
        messageRetentionDuration: String(t["messageRetentionDuration"] ?? ""),
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: fullName,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}

export async function listPubSubSubscriptions(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const items = await ctx.paginate<Record<string, unknown>>(
    `https://pubsub.googleapis.com/v1/projects/${p}/subscriptions`,
    "subscriptions",
  );
  return items.map((s) => {
    const fullName = String(s["name"]);
    const name = fullName.split("/").pop() ?? "";
    const topicFull = String(s["topic"] ?? "");
    const topic = topicFull.split("/").pop() ?? topicFull;
    return {
      id: ctx.id(accountId, "pubsub-subscription", fullName),
      pluginId: "gcp",
      resourceTypeId: "pubsub-subscription",
      accountId,
      displayName: name,
      fields: {
        name,
        topic,
        ackDeadlineSeconds: Number(s["ackDeadlineSeconds"] ?? 10),
        messageRetentionDuration: String(s["messageRetentionDuration"] ?? ""),
        filter: String(s["filter"] ?? ""),
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: fullName,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}

export async function listCloudRunServices(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const items = await ctx.paginate<Record<string, unknown>>(
    `https://run.googleapis.com/v2/projects/${p}/locations/-/services`,
    "services",
  );
  return items.map((svc) => {
    const fullName = String(svc["name"]);
    const name = fullName.split("/").pop() ?? "";
    const region = fullName.split("/")[3] ?? "";
    const cond = (svc["conditions"] as Array<Record<string, unknown>> | undefined)?.find(
      (c) => c["type"] === "Ready",
    );
    const state = cond ? String(cond["state"] ?? "") : "UNKNOWN";
    return {
      id: ctx.id(accountId, "cloud-run-service", fullName),
      pluginId: "gcp",
      resourceTypeId: "cloud-run-service",
      accountId,
      displayName: name,
      fields: {
        name,
        region,
        latestRevision: String(svc["latestReadyRevision"] ?? "").split("/").pop() ?? "",
        state,
        ingress: String(svc["ingress"] ?? ""),
      },
      resolvedOutputs: { url: String(svc["uri"] ?? "") },
      secretStates: [],
      externalId: fullName,
      createdAt: String(svc["createTime"] ?? ctx.now()),
      updatedAt: String(svc["updateTime"] ?? ctx.now()),
    };
  });
}

export async function listCloudFunctions(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const items = await ctx.paginate<Record<string, unknown>>(
    `https://cloudfunctions.googleapis.com/v2/projects/${p}/locations/-/functions`,
    "functions",
  );
  return items.map((fn) => {
    const fullName = String(fn["name"]);
    const name = fullName.split("/").pop() ?? "";
    const region = fullName.split("/")[3] ?? "";
    const serviceConfig = fn["serviceConfig"] as Record<string, unknown> | undefined;
    const buildConfig = fn["buildConfig"] as Record<string, unknown> | undefined;
    return {
      id: ctx.id(accountId, "cloud-function", fullName),
      pluginId: "gcp",
      resourceTypeId: "cloud-function",
      accountId,
      displayName: name,
      fields: {
        name,
        region,
        runtime: String(buildConfig?.["runtime"] ?? ""),
        state: String(fn["state"] ?? ""),
        availableMemory: String(serviceConfig?.["availableMemory"] ?? ""),
        timeout: String(serviceConfig?.["timeoutSeconds"] ?? ""),
      },
      resolvedOutputs: {
        url: String(serviceConfig?.["uri"] ?? ""),
      },
      secretStates: [],
      externalId: fullName,
      createdAt: String(fn["createTime"] ?? ctx.now()),
      updatedAt: String(fn["updateTime"] ?? ctx.now()),
    };
  });
}

export async function listVpcNetworks(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const items = await ctx.paginate<Record<string, unknown>>(
    `https://compute.googleapis.com/compute/v1/projects/${p}/global/networks`,
    "items",
  );
  return items.map((net) => {
    const name = String(net["name"]);
    const subnetCount = (net["subnetworks"] as unknown[] | undefined)?.length ?? 0;
    return {
      id: ctx.id(accountId, "vpc-network", `${p}/${name}`),
      pluginId: "gcp",
      resourceTypeId: "vpc-network",
      accountId,
      displayName: name,
      fields: {
        name,
        description: String(net["description"] ?? ""),
        autoCreateSubnetworks: Boolean(net["autoCreateSubnetworks"]),
        mtu: Number(net["mtu"] ?? 1460),
        subnetCount,
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: `${p}/${name}`,
      createdAt: String(net["creationTimestamp"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

export async function listBigQueryDatasets(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const items = await ctx.paginate<Record<string, unknown>>(
    `https://bigquery.googleapis.com/bigquery/v2/projects/${p}/datasets`,
    "datasets",
  );
  return items.map((ds) => {
    const ref = ds["datasetReference"] as Record<string, string> | undefined;
    const datasetId = ref?.["datasetId"] ?? String(ds["id"]).split(":").pop() ?? "";
    const meta = ds["friendlyName"] as string | undefined;
    return {
      id: ctx.id(accountId, "bigquery-dataset", `${p}:${datasetId}`),
      pluginId: "gcp",
      resourceTypeId: "bigquery-dataset",
      accountId,
      displayName: meta ?? datasetId,
      fields: {
        name: datasetId,
        location: String(ds["location"] ?? ""),
        description: String(ds["description"] ?? ""),
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: `${p}:${datasetId}`,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}

export async function listArtifactRegistryRepos(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const items = await ctx.paginate<Record<string, unknown>>(
    `https://artifactregistry.googleapis.com/v1/projects/${p}/locations/-/repositories`,
    "repositories",
  );
  return items.map((repo) => {
    const fullName = String(repo["name"]);
    const name = fullName.split("/").pop() ?? "";
    const location = fullName.split("/")[3] ?? "";
    const sizeBytes = Number(repo["sizeBytes"] ?? 0);
    const sizeLabel =
      sizeBytes > 1_073_741_824
        ? `${(sizeBytes / 1_073_741_824).toFixed(1)} GB`
        : sizeBytes > 1_048_576
        ? `${(sizeBytes / 1_048_576).toFixed(1)} MB`
        : `${Math.round(sizeBytes / 1024)} KB`;
    return {
      id: ctx.id(accountId, "artifact-registry-repo", fullName),
      pluginId: "gcp",
      resourceTypeId: "artifact-registry-repo",
      accountId,
      displayName: name,
      fields: {
        name,
        location,
        format: String(repo["format"] ?? ""),
        description: String(repo["description"] ?? ""),
        sizeBytes: sizeLabel,
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: fullName,
      createdAt: String(repo["createTime"] ?? ctx.now()),
      updatedAt: String(repo["updateTime"] ?? ctx.now()),
    };
  });
}

export async function listServiceAccounts(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const items = await ctx.paginate<Record<string, unknown>>(
    `https://iam.googleapis.com/v1/projects/${p}/serviceAccounts`,
    "accounts",
  );
  return items.map((sa) => {
    const email = String(sa["email"]);
    return {
      id: ctx.id(accountId, "gcp-service-account", email),
      pluginId: "gcp",
      resourceTypeId: "gcp-service-account",
      accountId,
      displayName: String(sa["displayName"] ?? email.split("@")[0] ?? email),
      fields: {
        name: String(sa["name"]).split("/").pop() ?? "",
        email,
        displayName: String(sa["displayName"] ?? ""),
        disabled: Boolean(sa["disabled"]),
        description: String(sa["description"] ?? ""),
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: email,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}

export async function listCloudArmorPolicies(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const items = await ctx.paginate<Record<string, unknown>>(
    `https://compute.googleapis.com/compute/v1/projects/${p}/global/securityPolicies`,
    "items",
  );
  return items.map((policy) => {
    const name = String(policy["name"]);
    const rules = policy["rules"] as unknown[] | undefined;
    return {
      id: ctx.id(accountId, "cloud-armor-policy", `${p}/${name}`),
      pluginId: "gcp",
      resourceTypeId: "cloud-armor-policy",
      accountId,
      displayName: name,
      fields: {
        name,
        description: String(policy["description"] ?? ""),
        type: String(policy["type"] ?? "CLOUD_ARMOR"),
        ruleCount: rules?.length ?? 0,
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: `${p}/${name}`,
      createdAt: String(policy["creationTimestamp"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

export async function listSecretManagerSecrets(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const items = await ctx.paginate<Record<string, unknown>>(
    `https://secretmanager.googleapis.com/v1/projects/${p}/secrets`,
    "secrets",
  );
  return items.map((secret) => {
    const fullName = String(secret["name"]);
    const name = fullName.split("/").pop() ?? "";
    const replication = secret["replication"] as Record<string, unknown> | undefined;
    const replicationType = replication?.["automatic"]
      ? "automatic"
      : replication?.["userManaged"]
      ? "user-managed"
      : "unknown";
    return {
      id: ctx.id(accountId, "secret-manager-secret", fullName),
      pluginId: "gcp",
      resourceTypeId: "secret-manager-secret",
      accountId,
      displayName: name,
      fields: {
        name,
        replicationType,
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: fullName,
      createdAt: String(secret["createTime"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

export async function listDataflowJobs(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const items = await ctx.paginate<Record<string, unknown>>(
    `https://dataflow.googleapis.com/v1b3/projects/${p}/jobs`,
    "jobs",
    { filter: "ACTIVE" },
  );
  return items.map((job) => {
    const name = String(job["name"]);
    const region = String(job["location"] ?? "");
    const sdkVersion = (job["jobMetadata"] as Record<string, unknown> | undefined)?.["sdkVersion"] as
      | Record<string, string>
      | undefined;
    return {
      id: ctx.id(accountId, "dataflow-job", String(job["id"])),
      pluginId: "gcp",
      resourceTypeId: "dataflow-job",
      accountId,
      displayName: name,
      fields: {
        name,
        region,
        type: String(job["type"] ?? ""),
        state: String(job["currentState"] ?? ""),
        sdkVersion: sdkVersion?.["version"] ?? "",
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: String(job["id"]),
      createdAt: String(job["createTime"] ?? ctx.now()),
      updatedAt: String(job["currentStateTime"] ?? ctx.now()),
    };
  });
}
