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

export async function listCloudDnsZones(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const zones = await ctx.paginate<Record<string, unknown>>(
    `https://dns.googleapis.com/dns/v1/projects/${p}/managedZones`,
    "managedZones",
  );
  return zones.map((z) => {
    const name = String(z["name"]);
    const dnsName = String(z["dnsName"] ?? "");
    const nameservers = Array.isArray(z["nameServers"])
      ? (z["nameServers"] as string[]).join(", ")
      : "";
    const dnssecConfig = z["dnssecConfig"] as Record<string, unknown> | undefined;
    return {
      id: ctx.id(accountId, "cloud-dns-zone", name),
      pluginId: "gcp",
      resourceTypeId: "cloud-dns-zone",
      accountId,
      displayName: dnsName.replace(/\.$/, "") || name,
      fields: {
        name,
        dnsName,
        description: String(z["description"] ?? ""),
        visibility: String(z["visibility"] ?? "public"),
        nameservers,
        dnssecState: String(dnssecConfig?.["state"] ?? "off"),
      },
      resolvedOutputs: { nameservers },
      secretStates: [],
      externalId: name,
      createdAt: String(z["creationTime"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

export async function listCloudDnsRecordSets(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const zones = await ctx.paginate<Record<string, unknown>>(
    `https://dns.googleapis.com/dns/v1/projects/${p}/managedZones`,
    "managedZones",
  );
  const results: ResourceInstance[] = [];
  for (const zone of zones) {
    const zoneName = String(zone["name"]);
    const dnsName = String(zone["dnsName"] ?? "");
    const displayZone = dnsName.replace(/\.$/, "") || zoneName;
    try {
      const rrsets = await ctx.paginate<Record<string, unknown>>(
        `https://dns.googleapis.com/dns/v1/projects/${p}/managedZones/${zoneName}/rrsets`,
        "rrsets",
      );
      for (const rr of rrsets) {
        const type = String(rr["type"] ?? "");
        const name = String(rr["name"] ?? "");
        const rrdatas = Array.isArray(rr["rrdatas"])
          ? (rr["rrdatas"] as string[]).join(", ")
          : "";
        const ttl = Number(rr["ttl"] ?? 300);
        // Use type+name as a composite ID since Cloud DNS doesn't expose record IDs
        const recordKey = `${type}:${name}`;
        const shortName = name.replace(/\.$/, "");
        results.push({
          id: ctx.id(accountId, "cloud-dns-record-set", `${zoneName}/${recordKey}`),
          pluginId: "gcp",
          resourceTypeId: "cloud-dns-record-set",
          accountId,
          displayName: `${type} ${shortName}`,
          fields: {
            type,
            name: shortName,
            rrdatas,
            ttl,
            zoneName: displayZone,
          },
          resolvedOutputs: {},
          secretStates: [],
          externalId: `${zoneName}/${recordKey}`,
          parentResourceId: ctx.id(accountId, "cloud-dns-zone", zoneName),
          createdAt: ctx.now(),
          updatedAt: ctx.now(),
        });
      }
    } catch {
      // Skip zones we can't read records for
    }
  }
  return results;
}

export async function listFirewallRules(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const items = await ctx.paginate<Record<string, unknown>>(
    `https://compute.googleapis.com/compute/v1/projects/${p}/global/firewalls`,
    "items",
  );
  return items.map((fw) => {
    const name = String(fw["name"]);
    const network = String(fw["network"] ?? "").split("/").pop() ?? "";
    const direction = String(fw["direction"] ?? "");
    const priority = Number(fw["priority"] ?? 1000);
    const disabled = fw["disabled"] === true;
    const sourceRanges = Array.isArray(fw["sourceRanges"])
      ? (fw["sourceRanges"] as string[]).join(", ")
      : "";
    const destinationRanges = Array.isArray(fw["destinationRanges"])
      ? (fw["destinationRanges"] as string[]).join(", ")
      : "";
    const allowed = Array.isArray(fw["allowed"])
      ? (fw["allowed"] as Array<Record<string, unknown>>)
          .map((a) => {
            const proto = String(a["IPProtocol"] ?? "");
            const ports = Array.isArray(a["ports"]) ? (a["ports"] as string[]).join(",") : "";
            return ports ? `${proto}:${ports}` : proto;
          })
          .join("; ")
      : "";
    const denied = Array.isArray(fw["denied"])
      ? (fw["denied"] as Array<Record<string, unknown>>)
          .map((d) => {
            const proto = String(d["IPProtocol"] ?? "");
            const ports = Array.isArray(d["ports"]) ? (d["ports"] as string[]).join(",") : "";
            return ports ? `${proto}:${ports}` : proto;
          })
          .join("; ")
      : "";
    const action = allowed ? "ALLOW" : denied ? "DENY" : "";
    return {
      id: ctx.id(accountId, "firewall-rule", name),
      pluginId: "gcp",
      resourceTypeId: "firewall-rule",
      accountId,
      displayName: name,
      fields: { name, network, direction, priority, action, sourceRanges, destinationRanges, allowed, denied, disabled },
      resolvedOutputs: {},
      secretStates: [],
      externalId: name,
      createdAt: String(fw["creationTimestamp"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

export async function listSubnets(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.get<{ items?: Record<string, { subnetworks?: unknown[] }> }>(
    `https://compute.googleapis.com/compute/v1/projects/${p}/aggregated/subnetworks`,
  );
  const results: ResourceInstance[] = [];
  for (const regionData of Object.values(data.items ?? {})) {
    for (const sub of ((regionData as Record<string, unknown>).subnetworks ?? []) as Record<string, unknown>[]) {
      const name = String(sub["name"]);
      const region = String(sub["region"] ?? "").split("/").pop() ?? "";
      const network = String(sub["network"] ?? "").split("/").pop() ?? "";
      results.push({
        id: ctx.id(accountId, "subnet", `${region}/${name}`),
        pluginId: "gcp",
        resourceTypeId: "subnet",
        accountId,
        displayName: name,
        fields: {
          name,
          region,
          network,
          ipCidrRange: String(sub["ipCidrRange"] ?? ""),
          gatewayAddress: String(sub["gatewayAddress"] ?? ""),
          privateIpGoogleAccess: sub["privateIpGoogleAccess"] === true,
          purpose: String(sub["purpose"] ?? "PRIVATE"),
          stackType: String(sub["stackType"] ?? ""),
        },
        resolvedOutputs: {},
        secretStates: [],
        externalId: `${region}/${name}`,
        createdAt: String(sub["creationTimestamp"] ?? ctx.now()),
        updatedAt: ctx.now(),
      });
    }
  }
  return results;
}

export async function listStaticIps(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.get<{ items?: Record<string, { addresses?: unknown[] }> }>(
    `https://compute.googleapis.com/compute/v1/projects/${p}/aggregated/addresses`,
  );
  const results: ResourceInstance[] = [];
  for (const regionData of Object.values(data.items ?? {})) {
    for (const addr of ((regionData as Record<string, unknown>).addresses ?? []) as Record<string, unknown>[]) {
      const name = String(addr["name"]);
      const region = String(addr["region"] ?? "").split("/").pop() ?? "";
      const address = String(addr["address"] ?? "");
      results.push({
        id: ctx.id(accountId, "static-ip", `${region}/${name}`),
        pluginId: "gcp",
        resourceTypeId: "static-ip",
        accountId,
        displayName: name,
        fields: {
          name,
          region,
          address,
          addressType: String(addr["addressType"] ?? ""),
          status: String(addr["status"] ?? ""),
          networkTier: String(addr["networkTier"] ?? ""),
          ipVersion: String(addr["ipVersion"] ?? "IPV4"),
        },
        resolvedOutputs: { address },
        secretStates: [],
        externalId: `${region}/${name}`,
        createdAt: String(addr["creationTimestamp"] ?? ctx.now()),
        updatedAt: ctx.now(),
      });
    }
  }
  return results;
}

export async function listCloudRouters(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.get<{ items?: Record<string, { routers?: unknown[] }> }>(
    `https://compute.googleapis.com/compute/v1/projects/${p}/aggregated/routers`,
  );
  const results: ResourceInstance[] = [];
  for (const regionData of Object.values(data.items ?? {})) {
    for (const router of ((regionData as Record<string, unknown>).routers ?? []) as Record<string, unknown>[]) {
      const name = String(router["name"]);
      const region = String(router["region"] ?? "").split("/").pop() ?? "";
      const network = String(router["network"] ?? "").split("/").pop() ?? "";
      const bgp = router["bgp"] as Record<string, unknown> | undefined;
      const nats = router["nats"] as unknown[] | undefined;
      results.push({
        id: ctx.id(accountId, "cloud-router", `${region}/${name}`),
        pluginId: "gcp",
        resourceTypeId: "cloud-router",
        accountId,
        displayName: name,
        fields: {
          name,
          region,
          network,
          bgpAsn: Number(bgp?.["asn"] ?? 0),
          natCount: Array.isArray(nats) ? nats.length : 0,
        },
        resolvedOutputs: {},
        secretStates: [],
        externalId: `${region}/${name}`,
        createdAt: String(router["creationTimestamp"] ?? ctx.now()),
        updatedAt: ctx.now(),
      });
    }
  }
  return results;
}

export async function listCloudNats(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.get<{ items?: Record<string, { routers?: unknown[] }> }>(
    `https://compute.googleapis.com/compute/v1/projects/${p}/aggregated/routers`,
  );
  const results: ResourceInstance[] = [];
  for (const regionData of Object.values(data.items ?? {})) {
    for (const router of ((regionData as Record<string, unknown>).routers ?? []) as Record<string, unknown>[]) {
      const routerName = String(router["name"]);
      const region = String(router["region"] ?? "").split("/").pop() ?? "";
      const nats = router["nats"] as Array<Record<string, unknown>> | undefined;
      if (!nats) continue;
      for (const nat of nats) {
        const natName = String(nat["name"]);
        results.push({
          id: ctx.id(accountId, "cloud-nat", `${region}/${routerName}/${natName}`),
          pluginId: "gcp",
          resourceTypeId: "cloud-nat",
          accountId,
          displayName: natName,
          fields: {
            name: natName,
            region,
            router: routerName,
            natIpAllocateOption: String(nat["natIpAllocateOption"] ?? ""),
            sourceSubnetworkIpRangesToNat: String(nat["sourceSubnetworkIpRangesToNat"] ?? ""),
            status: "ACTIVE",
          },
          resolvedOutputs: {},
          secretStates: [],
          externalId: `${region}/${routerName}/${natName}`,
          createdAt: ctx.now(),
          updatedAt: ctx.now(),
        });
      }
    }
  }
  return results;
}

export async function listCloudSchedulerJobs(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  let locations: Array<{ name: string; locationId: string }>;
  try {
    const locData = await ctx.get<{ locations?: Array<{ name: string; locationId: string }> }>(
      `https://cloudscheduler.googleapis.com/v1/projects/${p}/locations`,
    );
    locations = locData.locations ?? [];
  } catch {
    return [];
  }
  const results: ResourceInstance[] = [];
  await Promise.all(
    locations.map(async (loc) => {
      try {
        const items = await ctx.paginate<Record<string, unknown>>(
          `https://cloudscheduler.googleapis.com/v1/${loc.name}/jobs`,
          "jobs",
        );
        for (const job of items) {
          const fullName = String(job["name"]);
          const name = fullName.split("/").pop() ?? "";
          const httpTarget = job["httpTarget"] as Record<string, unknown> | undefined;
          const pubsubTarget = job["pubsubTarget"] as Record<string, unknown> | undefined;
          const appEngineTarget = job["appEngineHttpTarget"] as Record<string, unknown> | undefined;
          let targetType = "unknown";
          let targetUri = "";
          if (httpTarget) { targetType = "HTTP"; targetUri = String(httpTarget["uri"] ?? ""); }
          else if (pubsubTarget) { targetType = "Pub/Sub"; targetUri = String(pubsubTarget["topicName"] ?? "").split("/").pop() ?? ""; }
          else if (appEngineTarget) { targetType = "App Engine"; targetUri = String(appEngineTarget["relativeUri"] ?? ""); }
          results.push({
            id: ctx.id(accountId, "cloud-scheduler-job", fullName),
            pluginId: "gcp",
            resourceTypeId: "cloud-scheduler-job",
            accountId,
            displayName: name,
            fields: {
              name,
              region: loc.locationId,
              schedule: String(job["schedule"] ?? ""),
              timeZone: String(job["timeZone"] ?? ""),
              state: String(job["state"] ?? ""),
              targetType,
              targetUri,
              lastAttemptTime: String(job["lastAttemptTime"] ?? ""),
              scheduleTime: String(job["scheduleTime"] ?? ""),
            },
            resolvedOutputs: {},
            secretStates: [],
            externalId: fullName,
            createdAt: ctx.now(),
            updatedAt: ctx.now(),
          });
        }
      } catch {
        // Skip locations we can't access
      }
    }),
  );
  return results;
}

export async function listCloudTasksQueues(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  let locations: Array<{ name: string; locationId: string }>;
  try {
    const locData = await ctx.get<{ locations?: Array<{ name: string; locationId: string }> }>(
      `https://cloudtasks.googleapis.com/v2/projects/${p}/locations`,
    );
    locations = locData.locations ?? [];
  } catch {
    return [];
  }
  const results: ResourceInstance[] = [];
  await Promise.all(
    locations.map(async (loc) => {
      try {
        const items = await ctx.paginate<Record<string, unknown>>(
          `https://cloudtasks.googleapis.com/v2/${loc.name}/queues`,
          "queues",
        );
        for (const queue of items) {
          const fullName = String(queue["name"]);
          const name = fullName.split("/").pop() ?? "";
          const rateLimits = queue["rateLimits"] as Record<string, unknown> | undefined;
          const retryConfig = queue["retryConfig"] as Record<string, unknown> | undefined;
          results.push({
            id: ctx.id(accountId, "cloud-tasks-queue", fullName),
            pluginId: "gcp",
            resourceTypeId: "cloud-tasks-queue",
            accountId,
            displayName: name,
            fields: {
              name,
              region: loc.locationId,
              state: String(queue["state"] ?? ""),
              maxDispatchesPerSecond: Number(rateLimits?.["maxDispatchesPerSecond"] ?? 0),
              maxConcurrentDispatches: Number(rateLimits?.["maxConcurrentDispatches"] ?? 0),
              maxAttempts: Number(retryConfig?.["maxAttempts"] ?? 0),
            },
            resolvedOutputs: {},
            secretStates: [],
            externalId: fullName,
            createdAt: ctx.now(),
            updatedAt: ctx.now(),
          });
        }
      } catch {
        // Skip locations we can't access
      }
    }),
  );
  return results;
}

export async function listCloudBuildTriggers(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  let items: Record<string, unknown>[];
  try {
    items = await ctx.paginate<Record<string, unknown>>(
      `https://cloudbuild.googleapis.com/v1/projects/${p}/triggers`,
      "triggers",
    );
  } catch {
    return [];
  }
  return items.map((trigger) => {
    const name = String(trigger["name"] ?? trigger["description"] ?? "");
    const id_ = String(trigger["id"] ?? "");
    const disabled = trigger["disabled"] === true;
    const repoSource = trigger["triggerTemplate"] as Record<string, unknown> | undefined;
    const github = trigger["github"] as Record<string, unknown> | undefined;
    let triggerType = "Manual";
    let repoName = "";
    let branchName = "";
    if (github) {
      triggerType = "GitHub";
      repoName = `${String(github["owner"] ?? "")}/${String(github["name"] ?? "")}`;
      const push = github["push"] as Record<string, unknown> | undefined;
      branchName = String(push?.["branch"] ?? "");
    } else if (repoSource) {
      triggerType = "Cloud Source";
      repoName = String(repoSource["repoName"] ?? "");
      branchName = String(repoSource["branchName"] ?? "");
    }
    return {
      id: ctx.id(accountId, "cloud-build-trigger", id_),
      pluginId: "gcp",
      resourceTypeId: "cloud-build-trigger",
      accountId,
      displayName: name || id_,
      fields: {
        name: name || id_,
        description: String(trigger["description"] ?? ""),
        disabled,
        triggerType,
        repoName,
        branchName,
        filename: String(trigger["filename"] ?? ""),
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: id_,
      createdAt: String(trigger["createTime"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

export async function listLogSinks(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  let items: Record<string, unknown>[];
  try {
    const data = await ctx.get<{ sinks?: Record<string, unknown>[] }>(
      `https://logging.googleapis.com/v2/projects/${p}/sinks`,
    );
    items = data.sinks ?? [];
  } catch {
    return [];
  }
  return items.map((sink) => {
    const name = String(sink["name"]);
    return {
      id: ctx.id(accountId, "log-sink", name),
      pluginId: "gcp",
      resourceTypeId: "log-sink",
      accountId,
      displayName: name,
      fields: {
        name,
        destination: String(sink["destination"] ?? ""),
        filter: String(sink["filter"] ?? ""),
        disabled: sink["disabled"] === true,
        writerIdentity: String(sink["writerIdentity"] ?? ""),
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: name,
      createdAt: String(sink["createTime"] ?? ctx.now()),
      updatedAt: String(sink["updateTime"] ?? ctx.now()),
    };
  });
}

export async function listAlertPolicies(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  let items: Record<string, unknown>[];
  try {
    items = await ctx.paginate<Record<string, unknown>>(
      `https://monitoring.googleapis.com/v3/projects/${p}/alertPolicies`,
      "alertPolicies",
    );
  } catch {
    return [];
  }
  return items.map((policy) => {
    const fullName = String(policy["name"]);
    const displayName = String(policy["displayName"] ?? "");
    const conditions = policy["conditions"] as unknown[] | undefined;
    const channels = policy["notificationChannels"] as unknown[] | undefined;
    return {
      id: ctx.id(accountId, "alert-policy", fullName),
      pluginId: "gcp",
      resourceTypeId: "alert-policy",
      accountId,
      displayName: displayName || (fullName.split("/").pop() ?? ""),
      fields: {
        name: fullName,
        displayName,
        enabled: policy["enabled"] !== false,
        conditionCount: Array.isArray(conditions) ? conditions.length : 0,
        notificationChannelCount: Array.isArray(channels) ? channels.length : 0,
        combiner: String(policy["combiner"] ?? ""),
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: fullName,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}

export async function listKmsKeyRings(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  let locations: Array<{ name: string; locationId: string }>;
  try {
    const locData = await ctx.get<{ locations?: Array<{ name: string; locationId: string }> }>(
      `https://cloudkms.googleapis.com/v1/projects/${p}/locations`,
    );
    locations = locData.locations ?? [];
  } catch {
    return [];
  }
  const results: ResourceInstance[] = [];
  await Promise.all(
    locations.slice(0, 20).map(async (loc) => {
      try {
        const items = await ctx.paginate<Record<string, unknown>>(
          `https://cloudkms.googleapis.com/v1/${loc.name}/keyRings`,
          "keyRings",
        );
        for (const kr of items) {
          const fullName = String(kr["name"]);
          const name = fullName.split("/").pop() ?? "";
          results.push({
            id: ctx.id(accountId, "kms-key-ring", fullName),
            pluginId: "gcp",
            resourceTypeId: "kms-key-ring",
            accountId,
            displayName: name,
            fields: {
              name,
              location: loc.locationId,
              keyCount: 0,
            },
            resolvedOutputs: {},
            secretStates: [],
            externalId: fullName,
            createdAt: String(kr["createTime"] ?? ctx.now()),
            updatedAt: ctx.now(),
          });
        }
      } catch {
        // Skip locations we can't access
      }
    }),
  );
  return results;
}

export async function listKmsKeys(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  let locations: Array<{ name: string; locationId: string }>;
  try {
    const locData = await ctx.get<{ locations?: Array<{ name: string; locationId: string }> }>(
      `https://cloudkms.googleapis.com/v1/projects/${p}/locations`,
    );
    locations = locData.locations ?? [];
  } catch {
    return [];
  }
  const results: ResourceInstance[] = [];
  await Promise.all(
    locations.slice(0, 20).map(async (loc) => {
      try {
        const keyRings = await ctx.paginate<Record<string, unknown>>(
          `https://cloudkms.googleapis.com/v1/${loc.name}/keyRings`,
          "keyRings",
        );
        for (const kr of keyRings) {
          const krName = String(kr["name"]);
          const krShort = krName.split("/").pop() ?? "";
          try {
            const keys = await ctx.paginate<Record<string, unknown>>(
              `https://cloudkms.googleapis.com/v1/${krName}/cryptoKeys`,
              "cryptoKeys",
            );
            for (const key of keys) {
              const fullName = String(key["name"]);
              const keyName = fullName.split("/").pop() ?? "";
              const primary = key["primary"] as Record<string, unknown> | undefined;
              results.push({
                id: ctx.id(accountId, "kms-key", fullName),
                pluginId: "gcp",
                resourceTypeId: "kms-key",
                accountId,
                displayName: keyName,
                fields: {
                  name: keyName,
                  keyRing: krShort,
                  location: loc.locationId,
                  purpose: String(key["purpose"] ?? ""),
                  algorithm: String(primary?.["algorithm"] ?? ""),
                  protectionLevel: String(primary?.["protectionLevel"] ?? ""),
                  state: String(primary?.["state"] ?? ""),
                  rotationPeriod: String(key["rotationPeriod"] ?? ""),
                },
                resolvedOutputs: {},
                secretStates: [],
                externalId: fullName,
                parentResourceId: ctx.id(accountId, "kms-key-ring", krName),
                createdAt: String(key["createTime"] ?? ctx.now()),
                updatedAt: ctx.now(),
              });
            }
          } catch {
            // Skip key rings we can't list keys for
          }
        }
      } catch {
        // Skip locations we can't access
      }
    }),
  );
  return results;
}

export async function listFilestoreInstances(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  let items: Record<string, unknown>[];
  try {
    items = await ctx.paginate<Record<string, unknown>>(
      `https://file.googleapis.com/v1/projects/${p}/locations/-/instances`,
      "instances",
    );
  } catch {
    return [];
  }
  return items.map((inst) => {
    const fullName = String(inst["name"]);
    const name = fullName.split("/").pop() ?? "";
    const location = fullName.split("/locations/")[1]?.split("/")[0] ?? "";
    const networks = inst["networks"] as Array<Record<string, unknown>> | undefined;
    const network = String(networks?.[0]?.["network"] ?? "").split("/").pop() ?? "";
    const ipAddresses = networks?.[0]?.["ipAddresses"] as string[] | undefined;
    const fileShares = inst["fileShares"] as Array<Record<string, unknown>> | undefined;
    const fileShareName = String(fileShares?.[0]?.["name"] ?? "");
    const capacityGb = Number(fileShares?.[0]?.["capacityGb"] ?? 0);
    return {
      id: ctx.id(accountId, "filestore-instance", fullName),
      pluginId: "gcp",
      resourceTypeId: "filestore-instance",
      accountId,
      displayName: name,
      fields: {
        name,
        location,
        tier: String(inst["tier"] ?? ""),
        state: String(inst["state"] ?? ""),
        capacityGb,
        network,
        fileShareName,
        ipAddress: ipAddresses?.[0] ?? "",
      },
      resolvedOutputs: { ipAddress: ipAddresses?.[0] ?? "" },
      secretStates: [],
      externalId: fullName,
      createdAt: String(inst["createTime"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

export async function listBackendServices(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.get<{ items?: Record<string, { backendServices?: unknown[] }> }>(
    `https://compute.googleapis.com/compute/v1/projects/${p}/aggregated/backendServices`,
  );
  const results: ResourceInstance[] = [];
  for (const regionData of Object.values(data.items ?? {})) {
    for (const bs of ((regionData as Record<string, unknown>).backendServices ?? []) as Record<string, unknown>[]) {
      const name = String(bs["name"]);
      const backends = bs["backends"] as unknown[] | undefined;
      const healthChecks = bs["healthChecks"] as unknown[] | undefined;
      results.push({
        id: ctx.id(accountId, "backend-service", name),
        pluginId: "gcp",
        resourceTypeId: "backend-service",
        accountId,
        displayName: name,
        fields: {
          name,
          protocol: String(bs["protocol"] ?? ""),
          port: Number(bs["port"] ?? 0),
          portName: String(bs["portName"] ?? ""),
          loadBalancingScheme: String(bs["loadBalancingScheme"] ?? ""),
          healthCheckCount: Array.isArray(healthChecks) ? healthChecks.length : 0,
          backendCount: Array.isArray(backends) ? backends.length : 0,
          enableCDN: bs["enableCDN"] === true,
          sessionAffinity: String(bs["sessionAffinity"] ?? "NONE"),
        },
        resolvedOutputs: {},
        secretStates: [],
        externalId: name,
        createdAt: String(bs["creationTimestamp"] ?? ctx.now()),
        updatedAt: ctx.now(),
      });
    }
  }
  return results;
}

export async function listForwardingRules(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.get<{ items?: Record<string, { forwardingRules?: unknown[] }> }>(
    `https://compute.googleapis.com/compute/v1/projects/${p}/aggregated/forwardingRules`,
  );
  const results: ResourceInstance[] = [];
  for (const regionData of Object.values(data.items ?? {})) {
    for (const fr of ((regionData as Record<string, unknown>).forwardingRules ?? []) as Record<string, unknown>[]) {
      const name = String(fr["name"]);
      const region = String(fr["region"] ?? "").split("/").pop() ?? "global";
      const ipAddress = String(fr["IPAddress"] ?? "");
      results.push({
        id: ctx.id(accountId, "forwarding-rule", `${region}/${name}`),
        pluginId: "gcp",
        resourceTypeId: "forwarding-rule",
        accountId,
        displayName: name,
        fields: {
          name,
          region,
          IPAddress: ipAddress,
          IPProtocol: String(fr["IPProtocol"] ?? ""),
          portRange: String(fr["portRange"] ?? ""),
          target: String(fr["target"] ?? "").split("/").pop() ?? "",
          loadBalancingScheme: String(fr["loadBalancingScheme"] ?? ""),
          networkTier: String(fr["networkTier"] ?? ""),
        },
        resolvedOutputs: { IPAddress: ipAddress },
        secretStates: [],
        externalId: `${region}/${name}`,
        createdAt: String(fr["creationTimestamp"] ?? ctx.now()),
        updatedAt: ctx.now(),
      });
    }
  }
  return results;
}

export async function listMemorystoreMemcached(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  let items: Record<string, unknown>[];
  try {
    items = await ctx.paginate<Record<string, unknown>>(
      `https://memcache.googleapis.com/v1/projects/${p}/locations/-/instances`,
      "instances",
    );
  } catch {
    return [];
  }
  return items.map((inst) => {
    const fullName = String(inst["name"]);
    const name = fullName.split("/").pop() ?? "";
    const location = fullName.split("/locations/")[1]?.split("/")[0] ?? "";
    const nodeConfig = inst["nodeConfig"] as Record<string, unknown> | undefined;
    const discoveryEndpoint = String((inst["discoveryEndpoint"] as Record<string, unknown> | undefined)?.["address"] ?? "");
    const discoveryPort = String((inst["discoveryEndpoint"] as Record<string, unknown> | undefined)?.["port"] ?? "");
    const endpoint = discoveryEndpoint ? `${discoveryEndpoint}:${discoveryPort}` : "";
    return {
      id: ctx.id(accountId, "memorystore-memcached", fullName),
      pluginId: "gcp",
      resourceTypeId: "memorystore-memcached",
      accountId,
      displayName: name,
      fields: {
        name,
        location,
        state: String(inst["state"] ?? ""),
        nodeCount: Number(inst["nodeCount"] ?? 0),
        cpuCount: Number(nodeConfig?.["cpuCount"] ?? 0),
        memorySizeMb: Number(nodeConfig?.["memorySizeMb"] ?? 0),
        memcacheVersion: String(inst["memcacheVersion"] ?? ""),
        discoveryEndpoint: endpoint,
      },
      resolvedOutputs: { discoveryEndpoint: endpoint },
      secretStates: [],
      externalId: fullName,
      createdAt: String(inst["createTime"] ?? ctx.now()),
      updatedAt: String(inst["updateTime"] ?? ctx.now()),
    };
  });
}

export async function listVertexAiEndpoints(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const regions = ["us-central1", "us-east1", "us-west1", "europe-west1", "europe-west4", "asia-east1", "asia-northeast1"];
  const results: ResourceInstance[] = [];
  await Promise.all(
    regions.map(async (region) => {
      try {
        const items = await ctx.paginate<Record<string, unknown>>(
          `https://${region}-aiplatform.googleapis.com/v1/projects/${p}/locations/${region}/endpoints`,
          "endpoints",
        );
        for (const ep of items) {
          const fullName = String(ep["name"]);
          const name = fullName.split("/").pop() ?? "";
          const displayName = String(ep["displayName"] ?? name);
          const deployedModels = ep["deployedModels"] as unknown[] | undefined;
          const trafficSplit = ep["trafficSplit"] as Record<string, number> | undefined;
          results.push({
            id: ctx.id(accountId, "vertex-ai-endpoint", fullName),
            pluginId: "gcp",
            resourceTypeId: "vertex-ai-endpoint",
            accountId,
            displayName,
            fields: {
              name: fullName,
              displayName,
              region,
              state: String(ep["state"] ?? ""),
              deployedModelCount: Array.isArray(deployedModels) ? deployedModels.length : 0,
              trafficSplit: trafficSplit ? JSON.stringify(trafficSplit) : "",
            },
            resolvedOutputs: {},
            secretStates: [],
            externalId: fullName,
            createdAt: String(ep["createTime"] ?? ctx.now()),
            updatedAt: String(ep["updateTime"] ?? ctx.now()),
          });
        }
      } catch {
        // Skip regions where Vertex AI is not enabled
      }
    }),
  );
  return results;
}

export async function listComposerEnvironments(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  let items: Record<string, unknown>[];
  try {
    items = await ctx.paginate<Record<string, unknown>>(
      `https://composer.googleapis.com/v1/projects/${p}/locations/-/environments`,
      "environments",
    );
  } catch {
    return [];
  }
  return items.map((env) => {
    const fullName = String(env["name"]);
    const name = fullName.split("/").pop() ?? "";
    const location = fullName.split("/locations/")[1]?.split("/")[0] ?? "";
    const config = env["config"] as Record<string, unknown> | undefined;
    const softwareConfig = config?.["softwareConfig"] as Record<string, unknown> | undefined;
    return {
      id: ctx.id(accountId, "composer-environment", fullName),
      pluginId: "gcp",
      resourceTypeId: "composer-environment",
      accountId,
      displayName: name,
      fields: {
        name,
        location,
        state: String(env["state"] ?? ""),
        imageVersion: String(softwareConfig?.["imageVersion"] ?? ""),
        airflowUri: String(config?.["airflowUri"] ?? ""),
        dagGcsPrefix: String(config?.["dagGcsPrefix"] ?? ""),
      },
      resolvedOutputs: { airflowUri: String(config?.["airflowUri"] ?? "") },
      secretStates: [],
      externalId: fullName,
      createdAt: String(env["createTime"] ?? ctx.now()),
      updatedAt: String(env["updateTime"] ?? ctx.now()),
    };
  });
}

export async function listWorkflows(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  let items: Record<string, unknown>[];
  try {
    items = await ctx.paginate<Record<string, unknown>>(
      `https://workflows.googleapis.com/v1/projects/${p}/locations/-/workflows`,
      "workflows",
    );
  } catch {
    return [];
  }
  return items.map((wf) => {
    const fullName = String(wf["name"]);
    const name = fullName.split("/").pop() ?? "";
    const region = fullName.split("/locations/")[1]?.split("/")[0] ?? "";
    return {
      id: ctx.id(accountId, "workflow", fullName),
      pluginId: "gcp",
      resourceTypeId: "workflow",
      accountId,
      displayName: name,
      fields: {
        name,
        region,
        state: String(wf["state"] ?? ""),
        revisionId: String(wf["revisionId"] ?? ""),
        serviceAccount: String(wf["serviceAccount"] ?? "").split("/").pop() ?? "",
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: fullName,
      createdAt: String(wf["createTime"] ?? ctx.now()),
      updatedAt: String(wf["updateTime"] ?? ctx.now()),
    };
  });
}

export async function listCloudDeployPipelines(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  let items: Record<string, unknown>[];
  try {
    items = await ctx.paginate<Record<string, unknown>>(
      `https://clouddeploy.googleapis.com/v1/projects/${p}/locations/-/deliveryPipelines`,
      "deliveryPipelines",
    );
  } catch {
    return [];
  }
  return items.map((pipeline) => {
    const fullName = String(pipeline["name"]);
    const name = fullName.split("/").pop() ?? "";
    const region = fullName.split("/locations/")[1]?.split("/")[0] ?? "";
    const serialPipeline = pipeline["serialPipeline"] as Record<string, unknown> | undefined;
    const stages = serialPipeline?.["stages"] as Array<Record<string, unknown>> | undefined;
    return {
      id: ctx.id(accountId, "cloud-deploy-pipeline", fullName),
      pluginId: "gcp",
      resourceTypeId: "cloud-deploy-pipeline",
      accountId,
      displayName: name,
      fields: {
        name,
        region,
        description: String(pipeline["description"] ?? ""),
        stageCount: Array.isArray(stages) ? stages.length : 0,
        stages: Array.isArray(stages) ? stages.map((s) => String(s["targetId"] ?? "")).join(", ") : "",
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: fullName,
      createdAt: String(pipeline["createTime"] ?? ctx.now()),
      updatedAt: String(pipeline["updateTime"] ?? ctx.now()),
    };
  });
}

export async function listAppEngineServices(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  let items: Record<string, unknown>[];
  try {
    const data = await ctx.get<{ services?: Record<string, unknown>[] }>(
      `https://appengine.googleapis.com/v1/apps/${p}/services`,
    );
    items = data.services ?? [];
  } catch {
    return [];
  }
  return items.map((svc) => {
    const name = String(svc["id"] ?? svc["name"] ?? "");
    const split = svc["split"] as Record<string, unknown> | undefined;
    const allocations = split?.["allocations"] as Record<string, number> | undefined;
    const trafficSplit = allocations
      ? Object.entries(allocations).map(([v, pct]) => `${v}: ${(pct * 100).toFixed(0)}%`).join(", ")
      : "";
    const latestVersion = allocations ? Object.keys(allocations)[0] ?? "" : "";
    return {
      id: ctx.id(accountId, "app-engine-service", name),
      pluginId: "gcp",
      resourceTypeId: "app-engine-service",
      accountId,
      displayName: name,
      fields: {
        name,
        servingStatus: String(svc["servingStatus"] ?? ""),
        latestVersion,
        trafficSplit,
      },
      resolvedOutputs: { url: `https://${name === "default" ? "" : `${name}-dot-`}${p}.appspot.com` },
      secretStates: [],
      externalId: name,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}

export async function listHealthChecks(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const items = await ctx.paginate<Record<string, unknown>>(
    `https://compute.googleapis.com/compute/v1/projects/${p}/global/healthChecks`,
    "items",
  );
  return items.map((hc) => {
    const name = String(hc["name"]);
    const httpHc = hc["httpHealthCheck"] as Record<string, unknown> | undefined;
    const httpsHc = hc["httpsHealthCheck"] as Record<string, unknown> | undefined;
    const tcpHc = hc["tcpHealthCheck"] as Record<string, unknown> | undefined;
    let type = "TCP";
    let port = 0;
    if (httpHc) { type = "HTTP"; port = Number(httpHc["port"] ?? 80); }
    else if (httpsHc) { type = "HTTPS"; port = Number(httpsHc["port"] ?? 443); }
    else if (tcpHc) { type = "TCP"; port = Number(tcpHc["port"] ?? 0); }
    return {
      id: ctx.id(accountId, "health-check", name),
      pluginId: "gcp",
      resourceTypeId: "health-check",
      accountId,
      displayName: name,
      fields: {
        name,
        type,
        port,
        checkIntervalSec: Number(hc["checkIntervalSec"] ?? 5),
        timeoutSec: Number(hc["timeoutSec"] ?? 5),
        healthyThreshold: Number(hc["healthyThreshold"] ?? 2),
        unhealthyThreshold: Number(hc["unhealthyThreshold"] ?? 2),
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: name,
      createdAt: String(hc["creationTimestamp"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

export async function listSslCertificates(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  let items: Record<string, unknown>[];
  try {
    items = await ctx.paginate<Record<string, unknown>>(
      `https://compute.googleapis.com/compute/v1/projects/${p}/global/sslCertificates`,
      "items",
    );
  } catch {
    return [];
  }
  return items.map((cert) => {
    const name = String(cert["name"]);
    const managed = cert["managed"] as Record<string, unknown> | undefined;
    const domains = managed?.["domains"] as string[] | undefined;
    const status = managed?.["status"] as string | undefined;
    return {
      id: ctx.id(accountId, "ssl-certificate", name),
      pluginId: "gcp",
      resourceTypeId: "ssl-certificate",
      accountId,
      displayName: name,
      fields: {
        name,
        type: String(cert["type"] ?? "SELF_MANAGED"),
        status: status ?? "ACTIVE",
        domains: domains?.join(", ") ?? "",
        expireTime: String(cert["expireTime"] ?? ""),
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: name,
      createdAt: String(cert["creationTimestamp"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

export async function listInstanceGroups(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.get<{ items?: Record<string, { instanceGroupManagers?: unknown[] }> }>(
    `https://compute.googleapis.com/compute/v1/projects/${p}/aggregated/instanceGroupManagers`,
  );
  const results: ResourceInstance[] = [];
  for (const zoneData of Object.values(data.items ?? {})) {
    for (const igm of ((zoneData as Record<string, unknown>).instanceGroupManagers ?? []) as Record<string, unknown>[]) {
      const name = String(igm["name"]);
      const zone = String(igm["zone"] ?? "").split("/").pop() ?? "";
      const region = String(igm["region"] ?? "").split("/").pop() ?? "";
      const instanceTemplate = String(igm["instanceTemplate"] ?? "").split("/").pop() ?? "";
      results.push({
        id: ctx.id(accountId, "instance-group", `${zone || region}/${name}`),
        pluginId: "gcp",
        resourceTypeId: "instance-group",
        accountId,
        displayName: name,
        fields: {
          name,
          zone,
          region,
          size: Number(igm["targetSize"] ?? 0),
          isManaged: true,
          targetSize: Number(igm["targetSize"] ?? 0),
          instanceTemplate,
          status: String(igm["status"] ? "RUNNING" : ""),
        },
        resolvedOutputs: {},
        secretStates: [],
        externalId: `${zone || region}/${name}`,
        createdAt: String(igm["creationTimestamp"] ?? ctx.now()),
        updatedAt: ctx.now(),
      });
    }
  }
  return results;
}
