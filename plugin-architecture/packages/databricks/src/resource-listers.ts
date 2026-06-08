import type { ResourceInstance } from "@infrawrench/plugin-base";

export interface ListerContext {
  api<T>(method: string, path: string, body?: Record<string, unknown>): Promise<T>;
  id(accountId: string, typeId: string, externalId: string): string;
  now(): string;
  host: string;
}

function timestamp(value: unknown, fallback: string): string {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "string" && Number.isNaN(Number(value))) return value;
  return new Date(Number(value)).toISOString();
}

function hostWithoutScheme(ctx: ListerContext): string {
  return ctx.host.replace(/^https?:\/\//, "");
}

function lastPathSegment(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

async function listPaginated(
  ctx: ListerContext,
  path: string,
  resultKey: string,
  tokenParam = "page_token",
): Promise<Record<string, unknown>[]> {
  const all: Record<string, unknown>[] = [];
  let token = "";
  do {
    const separator = path.includes("?") ? "&" : "?";
    const requestPath = token
      ? `${path}${separator}${tokenParam}=${encodeURIComponent(token)}`
      : path;
    const data = await ctx.api<Record<string, unknown>>("GET", requestPath);
    all.push(
      ...(((data[resultKey] as Record<string, unknown>[] | undefined) ?? []) as Record<
        string,
        unknown
      >[]),
    );
    token = String(data["next_page_token"] ?? "");
  } while (token);
  return all;
}

export async function listClusters(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const clusters = await listPaginated(ctx, "/api/2.1/clusters/list?page_size=100", "clusters");

  return clusters.map((c) => {
    const clusterId = String(c["cluster_id"] ?? "");
    const clusterName = String(c["cluster_name"] ?? "");
    const state = String(c["state"] ?? "UNKNOWN");
    const sparkVersion = String(c["spark_version"] ?? "");
    const nodeTypeId = String(c["node_type_id"] ?? "");
    const driverNodeTypeId = String(c["driver_node_type_id"] ?? nodeTypeId);

    // Autoscale or fixed workers
    const autoscale = c["autoscale"] as Record<string, unknown> | undefined;
    const numWorkers = autoscale
      ? Number(autoscale["max_workers"] ?? 0)
      : Number(c["num_workers"] ?? 0);

    const host = hostWithoutScheme(ctx);
    const jdbcUrl = `jdbc:databricks://${host}:443/default;transportMode=http;ssl=1;httpPath=sql/protocolv1/o/0/${clusterId}`;

    return {
      id: ctx.id(accountId, "databricks-cluster", clusterId),
      pluginId: "databricks",
      resourceTypeId: "databricks-cluster",
      accountId,
      displayName: clusterName || clusterId,
      fields: {
        clusterId,
        clusterName,
        state,
        sparkVersion,
        nodeTypeId,
        driverNodeTypeId,
        numWorkers,
        autoterminationMinutes: Number(c["autotermination_minutes"] ?? 0),
        clusterSource: String(c["cluster_source"] ?? ""),
        creatorUserName: String(c["creator_user_name"] ?? ""),
      },
      resolvedOutputs: {
        clusterId,
        sparkContextId: String(c["spark_context_id"] ?? ""),
        jdbcUrl,
      },
      secretStates: [],
      externalId: clusterId,
      createdAt: c["start_time"] ? new Date(Number(c["start_time"])).toISOString() : ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}

export async function listSqlWarehouses(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.api<{ warehouses?: Record<string, unknown>[] }>(
    "GET",
    "/api/2.0/sql/warehouses",
  );
  const warehouses = data.warehouses ?? [];

  return warehouses.map((w) => {
    const warehouseId = String(w["id"] ?? "");
    const name = String(w["name"] ?? "");
    const state = String(w["state"] ?? "STOPPED");
    const host = ctx.host.replace(/^https?:\/\//, "");
    const httpPath = `/sql/1.0/warehouses/${warehouseId}`;

    return {
      id: ctx.id(accountId, "databricks-sql-warehouse", warehouseId),
      pluginId: "databricks",
      resourceTypeId: "databricks-sql-warehouse",
      accountId,
      displayName: name || warehouseId,
      fields: {
        warehouseId,
        name,
        state,
        clusterSize: String(w["cluster_size"] ?? ""),
        minNumClusters: Number(w["min_num_clusters"] ?? 1),
        maxNumClusters: Number(w["max_num_clusters"] ?? 1),
        autoStopMinutes: Number(w["auto_stop_mins"] ?? 0),
        warehouseType: String(w["warehouse_type"] ?? "PRO"),
        enablePhoton: w["enable_photon"] === true,
        numActiveSessions: Number(
          (w["health"] as Record<string, unknown> | undefined)?.["details"] ? 0 : 0,
        ),
        numRunningQueries: Number(w["num_active_sessions"] ?? 0),
        creatorName: String(w["creator_name"] ?? ""),
      },
      resolvedOutputs: {
        warehouseId,
        jdbcUrl: `jdbc:databricks://${host}:443/default;transportMode=http;ssl=1;httpPath=${httpPath}`,
        odbcUrl: `Driver=Simba Spark;Host=${host};Port=443;SSL=1;ThriftTransport=2;HTTPPath=${httpPath}`,
      },
      secretStates: [],
      externalId: warehouseId,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}

export async function listServingEndpoints(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.api<{ endpoints?: Record<string, unknown>[] }>(
    "GET",
    "/api/2.0/serving-endpoints",
  );
  const endpoints = data.endpoints ?? [];

  return endpoints.map((e) => {
    const name = String(e["name"] ?? "");
    const stateObj = e["state"] as Record<string, unknown> | undefined;
    const ready = String(stateObj?.["ready"] ?? "");
    const state = ready === "READY" ? "READY" : ready === "NOT_READY" ? "NOT_READY" : "UNKNOWN";

    return {
      id: ctx.id(accountId, "databricks-serving-endpoint", name),
      pluginId: "databricks",
      resourceTypeId: "databricks-serving-endpoint",
      accountId,
      displayName: name,
      fields: {
        name,
        state,
        task: String(e["task"] ?? ""),
        creator: String(e["creator"] ?? ""),
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: name,
      createdAt: e["creation_timestamp"]
        ? new Date(Number(e["creation_timestamp"])).toISOString()
        : ctx.now(),
      updatedAt: e["last_updated_timestamp"]
        ? new Date(Number(e["last_updated_timestamp"])).toISOString()
        : ctx.now(),
    };
  });
}

export async function listJobs(ctx: ListerContext, accountId: string): Promise<ResourceInstance[]> {
  const jobs = await listPaginated(ctx, "/api/2.2/jobs/list?limit=100&expand_tasks=false", "jobs");

  return jobs.map((j) => {
    const jobId = Number((j["job_id"] as number | undefined) ?? 0);
    const settings = (j["settings"] as Record<string, unknown>) ?? {};
    const name = String(settings["name"] ?? `Job ${jobId}`);

    // Schedule info
    const schedule = settings["schedule"] as Record<string, unknown> | undefined;
    const scheduleStr = schedule ? String(schedule["quartz_cron_expression"] ?? "") : "";

    // Task count
    const tasks = settings["tasks"] as unknown[] | undefined;
    const taskCount = tasks?.length ?? 0;

    // Last run info from the run_as/recent_runs
    const lastRun = j["last_run"] as Record<string, unknown> | undefined;
    const lastRunState = lastRun
      ? String(
          (lastRun["state"] as Record<string, unknown> | undefined)?.["life_cycle_state"] ?? "",
        )
      : "";
    const lastRunResult = lastRun
      ? String((lastRun["state"] as Record<string, unknown> | undefined)?.["result_state"] ?? "")
      : "";

    const host = hostWithoutScheme(ctx);

    return {
      id: ctx.id(accountId, "databricks-job", String(jobId)),
      pluginId: "databricks",
      resourceTypeId: "databricks-job",
      accountId,
      displayName: name,
      fields: {
        jobId,
        name,
        creatorUserName: String(j["creator_user_name"] ?? ""),
        format: String(settings["format"] ?? "MULTI_TASK"),
        lastRunState,
        lastRunResult,
        schedule: scheduleStr,
        taskCount,
        maxConcurrentRuns: Number(settings["max_concurrent_runs"] ?? 1),
      },
      resolvedOutputs: {
        jobId: String(jobId),
        jobUrl: `https://${host}/jobs/${jobId}`,
      },
      secretStates: [],
      externalId: String(jobId),
      createdAt: j["created_time"] ? new Date(Number(j["created_time"])).toISOString() : ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}

export async function listPipelines(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.api<{ statuses?: Record<string, unknown>[] }>(
    "GET",
    "/api/2.0/pipelines?max_results=100",
  );
  const pipelines = data.statuses ?? [];

  return pipelines.map((p) => {
    const pipelineId = String(p["pipeline_id"] ?? "");
    const name = String(p["name"] ?? pipelineId);
    const state = String(p["state"] ?? "IDLE");
    const host = hostWithoutScheme(ctx);

    return {
      id: ctx.id(accountId, "databricks-pipeline", pipelineId),
      pluginId: "databricks",
      resourceTypeId: "databricks-pipeline",
      accountId,
      displayName: name,
      fields: {
        pipelineId,
        name,
        state,
        creatorUserName: String(p["creator_user_name"] ?? ""),
        target: String((p["spec"] as Record<string, unknown> | undefined)?.["target"] ?? ""),
        catalog: String((p["spec"] as Record<string, unknown> | undefined)?.["catalog"] ?? ""),
        channel: String(
          (p["spec"] as Record<string, unknown> | undefined)?.["channel"] ?? "CURRENT",
        ),
        continuous: (p["spec"] as Record<string, unknown> | undefined)?.["continuous"] === true,
        photon: (p["spec"] as Record<string, unknown> | undefined)?.["photon"] === true,
        lastUpdateState: String(
          p["latest_updates"]
            ? String((p["latest_updates"] as Record<string, unknown>[])?.[0]?.["state"] ?? "")
            : "",
        ),
      },
      resolvedOutputs: {
        pipelineId,
        pipelineUrl: `https://${host}/pipelines/${pipelineId}`,
      },
      secretStates: [],
      externalId: pipelineId,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}

export async function listCatalogs(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const catalogs = await listPaginated(
    ctx,
    "/api/2.1/unity-catalog/catalogs?max_results=0",
    "catalogs",
  );

  return catalogs.map((c) => {
    const name = String(c["name"] ?? "");

    return {
      id: ctx.id(accountId, "databricks-catalog", name),
      pluginId: "databricks",
      resourceTypeId: "databricks-catalog",
      accountId,
      displayName: name,
      fields: {
        name,
        owner: String(c["owner"] ?? ""),
        comment: String(c["comment"] ?? ""),
        catalogType: String(c["catalog_type"] ?? "MANAGED_CATALOG"),
        isolationMode: String(c["isolation_mode"] ?? "OPEN"),
        securable_kind: String(c["securable_kind"] ?? "CATALOG_STANDARD"),
        schemaCount: 0, // Populated lazily
      },
      resolvedOutputs: {
        catalogName: name,
        metastoreId: String(c["metastore_id"] ?? ""),
      },
      secretStates: [],
      externalId: name,
      createdAt: c["created_at"] ? new Date(Number(c["created_at"])).toISOString() : ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}

export async function listSchemas(
  ctx: ListerContext,
  accountId: string,
  catalogName: string,
): Promise<ResourceInstance[]> {
  const schemas = await listPaginated(
    ctx,
    `/api/2.1/unity-catalog/schemas?catalog_name=${encodeURIComponent(catalogName)}&max_results=0`,
    "schemas",
  );

  return schemas.map((s) => {
    const name = String(s["name"] ?? "");
    const fullName = `${catalogName}.${name}`;

    return {
      id: ctx.id(accountId, "databricks-schema", fullName),
      pluginId: "databricks",
      resourceTypeId: "databricks-schema",
      accountId,
      displayName: name,
      parentResourceId: ctx.id(accountId, "databricks-catalog", catalogName),
      fields: {
        name,
        catalogName,
        owner: String(s["owner"] ?? ""),
        comment: String(s["comment"] ?? ""),
        tableCount: 0,
      },
      resolvedOutputs: {
        fullName,
      },
      secretStates: [],
      externalId: fullName,
      createdAt: s["created_at"] ? new Date(Number(s["created_at"])).toISOString() : ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}

export async function listTables(
  ctx: ListerContext,
  accountId: string,
  catalogName: string,
  schemaName: string,
): Promise<ResourceInstance[]> {
  const tables = await listPaginated(
    ctx,
    `/api/2.1/unity-catalog/tables?catalog_name=${encodeURIComponent(catalogName)}&schema_name=${encodeURIComponent(schemaName)}&max_results=0`,
    "tables",
  );

  return tables.map((t) => {
    const name = String(t["name"] ?? "");
    const fullName = `${catalogName}.${schemaName}.${name}`;
    const columns = t["columns"] as Record<string, unknown>[] | undefined;

    return {
      id: ctx.id(accountId, "databricks-table", fullName),
      pluginId: "databricks",
      resourceTypeId: "databricks-table",
      accountId,
      displayName: name,
      parentResourceId: ctx.id(accountId, "databricks-schema", `${catalogName}.${schemaName}`),
      fields: {
        name,
        catalogName,
        schemaName,
        tableType: String(t["table_type"] ?? "MANAGED"),
        dataSourceFormat: String(t["data_source_format"] ?? ""),
        owner: String(t["owner"] ?? ""),
        comment: String(t["comment"] ?? ""),
        storageLocation: String(t["storage_location"] ?? ""),
        columnCount: columns?.length ?? 0,
      },
      resolvedOutputs: {
        fullName,
        storageLocation: String(t["storage_location"] ?? ""),
      },
      secretStates: [],
      externalId: fullName,
      createdAt: t["created_at"] ? new Date(Number(t["created_at"])).toISOString() : ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}

export async function listClusterPolicies(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const policies = await listPaginated(ctx, "/api/2.0/policies/clusters/list", "policies");
  return policies.map((p) => {
    const policyId = String(p["policy_id"] ?? "");
    return {
      id: ctx.id(accountId, "databricks-cluster-policy", policyId),
      pluginId: "databricks",
      resourceTypeId: "databricks-cluster-policy",
      accountId,
      displayName: String(p["name"] ?? policyId),
      fields: {
        policyId,
        name: String(p["name"] ?? policyId),
        description: String(p["description"] ?? ""),
        creatorUserName: String(p["creator_user_name"] ?? ""),
        policyFamilyId: String(p["policy_family_id"] ?? ""),
        isDefault: p["is_default"] === true,
        maxClustersPerUser: Number(p["max_clusters_per_user"] ?? 0),
      },
      resolvedOutputs: { policyId },
      secretStates: [],
      externalId: policyId,
      createdAt: timestamp(p["created_at_timestamp"], ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

export async function listNodeTypes(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.api<{ node_types?: Record<string, unknown>[] }>(
    "GET",
    "/api/2.1/clusters/list-node-types",
  );
  return (data.node_types ?? []).map((n) => {
    const nodeTypeId = String(n["node_type_id"] ?? "");
    return {
      id: ctx.id(accountId, "databricks-node-type", nodeTypeId),
      pluginId: "databricks",
      resourceTypeId: "databricks-node-type",
      accountId,
      displayName: nodeTypeId,
      fields: {
        nodeTypeId,
        category: String(n["category"] ?? ""),
        description: String(n["description"] ?? ""),
        instanceTypeId: String(n["instance_type_id"] ?? ""),
        memoryMb: Number(n["memory_mb"] ?? 0),
        numCores: Number(n["num_cores"] ?? 0),
        numGpus: Number(n["num_gpus"] ?? 0),
        isDeprecated: n["is_deprecated"] === true,
        isHidden: n["is_hidden"] === true,
        photonWorkerCapable: n["photon_worker_capable"] === true,
      },
      resolvedOutputs: { nodeTypeId },
      secretStates: [],
      externalId: nodeTypeId,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}

export async function listWorkspaceObjects(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const roots = ["/Workspace", "/Users", "/Repos"];
  const objects: Record<string, unknown>[] = [];
  for (const root of roots) {
    try {
      const data = await ctx.api<{ objects?: Record<string, unknown>[] }>(
        "GET",
        `/api/2.0/workspace/list?path=${encodeURIComponent(root)}`,
      );
      objects.push(...(data.objects ?? []));
    } catch {
      // Some workspaces do not expose every root to every principal.
    }
  }
  return objects.map((o) => {
    const path = String(o["path"] ?? "");
    const resourceId = String(o["resource_id"] ?? "");
    return {
      id: ctx.id(accountId, "databricks-workspace-object", resourceId || path),
      pluginId: "databricks",
      resourceTypeId: "databricks-workspace-object",
      accountId,
      displayName: lastPathSegment(path),
      fields: {
        objectId: Number(o["object_id"] ?? 0),
        path,
        objectType: String(o["object_type"] ?? ""),
        language: String(o["language"] ?? ""),
        resourceId,
        size: Number(o["size"] ?? 0),
      },
      resolvedOutputs: { path, resourceId },
      secretStates: [],
      externalId: resourceId || path,
      createdAt: timestamp(o["created_at"], ctx.now()),
      updatedAt: timestamp(o["modified_at"], ctx.now()),
    };
  });
}

export async function listRepos(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const repos = await listPaginated(ctx, "/api/2.0/repos", "repos", "next_page_token");
  return repos.map((r) => {
    const repoId = Number(r["id"] ?? 0);
    const path = String(r["path"] ?? "");
    return {
      id: ctx.id(accountId, "databricks-repo", String(repoId || path)),
      pluginId: "databricks",
      resourceTypeId: "databricks-repo",
      accountId,
      displayName: lastPathSegment(path),
      fields: {
        repoId,
        path,
        url: String(r["url"] ?? ""),
        provider: String(r["provider"] ?? ""),
        branch: String(r["branch"] ?? ""),
        headCommitId: String(r["head_commit_id"] ?? ""),
      },
      resolvedOutputs: { repoId: String(repoId), path, url: String(r["url"] ?? "") },
      secretStates: [],
      externalId: String(repoId || path),
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}

export async function listDashboards(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const dashboards = await listPaginated(
    ctx,
    "/api/2.0/lakeview/dashboards?page_size=1000",
    "dashboards",
  );
  const host = hostWithoutScheme(ctx);
  return dashboards.map((d) => {
    const dashboardId = String(d["dashboard_id"] ?? "");
    const displayName = String(d["display_name"] ?? dashboardId);
    return {
      id: ctx.id(accountId, "databricks-dashboard", dashboardId),
      pluginId: "databricks",
      resourceTypeId: "databricks-dashboard",
      accountId,
      displayName,
      fields: {
        dashboardId,
        displayName,
        lifecycleState: String(d["lifecycle_state"] ?? ""),
        warehouseId: String(d["warehouse_id"] ?? ""),
        path: String(d["path"] ?? ""),
      },
      resolvedOutputs: {
        dashboardId,
        dashboardUrl: `https://${host}/dashboardsv3/${dashboardId}`,
      },
      secretStates: [],
      externalId: dashboardId,
      createdAt: timestamp(d["create_time"], ctx.now()),
      updatedAt: timestamp(d["update_time"], ctx.now()),
    };
  });
}

export async function listSqlQueries(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const queries = await listPaginated(ctx, "/api/2.0/sql/queries?page_size=100", "results");
  const host = hostWithoutScheme(ctx);
  return queries.map((q) => {
    const queryId = String(q["id"] ?? "");
    const options = q["options"] as Record<string, unknown> | undefined;
    const user = q["user"] as Record<string, unknown> | undefined;
    return {
      id: ctx.id(accountId, "databricks-sql-query", queryId),
      pluginId: "databricks",
      resourceTypeId: "databricks-sql-query",
      accountId,
      displayName: String(q["display_name"] ?? q["name"] ?? queryId),
      fields: {
        queryId,
        name: String(q["display_name"] ?? q["name"] ?? queryId),
        catalog: String(q["catalog"] ?? options?.["catalog"] ?? ""),
        schema: String(q["schema"] ?? options?.["schema"] ?? ""),
        warehouseId: String(q["warehouse_id"] ?? ""),
        owner: String(user?.["email"] ?? user?.["name"] ?? ""),
        isFavorite: q["is_favorite"] === true,
      },
      resolvedOutputs: { queryId, queryUrl: `https://${host}/sql/editor/queries/${queryId}` },
      secretStates: [],
      externalId: queryId,
      createdAt: timestamp(q["create_time"] ?? q["created_at"], ctx.now()),
      updatedAt: timestamp(q["update_time"] ?? q["updated_at"], ctx.now()),
    };
  });
}

export async function listVolumes(
  ctx: ListerContext,
  accountId: string,
  catalogName: string,
  schemaName: string,
): Promise<ResourceInstance[]> {
  const volumes = await listPaginated(
    ctx,
    `/api/2.1/unity-catalog/volumes?catalog_name=${encodeURIComponent(catalogName)}&schema_name=${encodeURIComponent(schemaName)}&max_results=0`,
    "volumes",
  );
  return volumes.map((v) => {
    const name = String(v["name"] ?? "");
    const fullName = String(v["full_name"] ?? `${catalogName}.${schemaName}.${name}`);
    return {
      id: ctx.id(accountId, "databricks-volume", fullName),
      pluginId: "databricks",
      resourceTypeId: "databricks-volume",
      accountId,
      displayName: name,
      parentResourceId: ctx.id(accountId, "databricks-schema", `${catalogName}.${schemaName}`),
      fields: {
        name,
        catalogName,
        schemaName,
        volumeType: String(v["volume_type"] ?? ""),
        owner: String(v["owner"] ?? ""),
        storageLocation: String(v["storage_location"] ?? ""),
        comment: String(v["comment"] ?? ""),
      },
      resolvedOutputs: {
        fullName,
        volumePath: `/Volumes/${catalogName}/${schemaName}/${name}`,
        storageLocation: String(v["storage_location"] ?? ""),
      },
      secretStates: [],
      externalId: fullName,
      createdAt: timestamp(v["created_at"], ctx.now()),
      updatedAt: timestamp(v["updated_at"], ctx.now()),
    };
  });
}

export async function listFunctions(
  ctx: ListerContext,
  accountId: string,
  catalogName: string,
  schemaName: string,
): Promise<ResourceInstance[]> {
  const functions = await listPaginated(
    ctx,
    `/api/2.1/unity-catalog/functions?catalog_name=${encodeURIComponent(catalogName)}&schema_name=${encodeURIComponent(schemaName)}&max_results=0`,
    "functions",
  );
  return functions.map((f) => {
    const name = String(f["name"] ?? "");
    const fullName = String(f["full_name"] ?? `${catalogName}.${schemaName}.${name}`);
    return {
      id: ctx.id(accountId, "databricks-function", fullName),
      pluginId: "databricks",
      resourceTypeId: "databricks-function",
      accountId,
      displayName: name,
      parentResourceId: ctx.id(accountId, "databricks-schema", `${catalogName}.${schemaName}`),
      fields: {
        name,
        catalogName,
        schemaName,
        dataType: String(f["data_type"] ?? f["full_data_type"] ?? ""),
        routineBody: String(f["routine_body"] ?? ""),
        owner: String(f["owner"] ?? ""),
        comment: String(f["comment"] ?? ""),
      },
      resolvedOutputs: { fullName },
      secretStates: [],
      externalId: fullName,
      createdAt: timestamp(f["created_at"], ctx.now()),
      updatedAt: timestamp(f["updated_at"], ctx.now()),
    };
  });
}

export async function listRegisteredModels(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const models = await listPaginated(
    ctx,
    "/api/2.1/unity-catalog/models?max_results=0",
    "registered_models",
  );
  return models.map((m) => {
    const fullName = String(m["full_name"] ?? m["name"] ?? "");
    const aliases = m["aliases"] as unknown[] | undefined;
    const resource: ResourceInstance = {
      id: ctx.id(accountId, "databricks-registered-model", fullName),
      pluginId: "databricks",
      resourceTypeId: "databricks-registered-model",
      accountId,
      displayName: String(m["name"] ?? fullName),
      fields: {
        name: String(m["name"] ?? fullName),
        catalogName: String(m["catalog_name"] ?? ""),
        schemaName: String(m["schema_name"] ?? ""),
        owner: String(m["owner"] ?? ""),
        aliasCount: aliases?.length ?? 0,
        storageLocation: String(m["storage_location"] ?? ""),
        comment: String(m["comment"] ?? ""),
      },
      resolvedOutputs: {
        fullName,
        storageLocation: String(m["storage_location"] ?? ""),
      },
      secretStates: [],
      externalId: fullName,
      createdAt: timestamp(m["created_at"], ctx.now()),
      updatedAt: timestamp(m["updated_at"], ctx.now()),
    };
    if (m["catalog_name"] && m["schema_name"]) {
      resource.parentResourceId = ctx.id(
        accountId,
        "databricks-schema",
        `${m["catalog_name"]}.${m["schema_name"]}`,
      );
    }
    return resource;
  });
}

export async function listVectorSearchEndpoints(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const endpoints = await listPaginated(ctx, "/api/2.0/vector-search/endpoints", "endpoints");
  return endpoints.map((e) => {
    const name = String(e["name"] ?? "");
    const status = e["endpoint_status"] as Record<string, unknown> | undefined;
    return {
      id: ctx.id(accountId, "databricks-vector-search-endpoint", name),
      pluginId: "databricks",
      resourceTypeId: "databricks-vector-search-endpoint",
      accountId,
      displayName: name,
      fields: {
        name,
        endpointType: String(e["endpoint_type"] ?? ""),
        state: String(status?.["state"] ?? e["state"] ?? ""),
        creator: String(e["creator"] ?? ""),
      },
      resolvedOutputs: { endpointName: name },
      secretStates: [],
      externalId: name,
      createdAt: timestamp(e["creation_timestamp"] ?? e["created_at"], ctx.now()),
      updatedAt: timestamp(e["last_updated_timestamp"] ?? e["updated_at"], ctx.now()),
    };
  });
}

export async function listVectorSearchIndexes(
  ctx: ListerContext,
  accountId: string,
  endpointName: string,
): Promise<ResourceInstance[]> {
  const indexes = await listPaginated(
    ctx,
    `/api/2.0/vector-search/indexes?endpoint_name=${encodeURIComponent(endpointName)}`,
    "vector_indexes",
  );
  return indexes.map((i) => {
    const name = String(i["name"] ?? "");
    return {
      id: ctx.id(accountId, "databricks-vector-search-index", `${endpointName}:${name}`),
      pluginId: "databricks",
      resourceTypeId: "databricks-vector-search-index",
      accountId,
      displayName: name,
      parentResourceId: ctx.id(accountId, "databricks-vector-search-endpoint", endpointName),
      fields: {
        name,
        endpointName,
        indexType: String(i["index_type"] ?? ""),
        indexSubtype: String(i["index_subtype"] ?? ""),
        primaryKey: String(i["primary_key"] ?? ""),
        creator: String(i["creator"] ?? ""),
      },
      resolvedOutputs: { fullName: name },
      secretStates: [],
      externalId: name,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}

export async function listApps(ctx: ListerContext, accountId: string): Promise<ResourceInstance[]> {
  const apps = await listPaginated(ctx, "/api/2.0/apps?page_size=100", "apps");
  return apps.map((a) => {
    const name = String(a["name"] ?? "");
    const appStatus = a["app_status"] as Record<string, unknown> | undefined;
    const computeStatus = a["compute_status"] as Record<string, unknown> | undefined;
    return {
      id: ctx.id(accountId, "databricks-app", name),
      pluginId: "databricks",
      resourceTypeId: "databricks-app",
      accountId,
      displayName: name,
      fields: {
        name,
        description: String(a["description"] ?? ""),
        computeSize: String(a["compute_size"] ?? ""),
        appStatus: String(appStatus?.["state"] ?? a["status"] ?? ""),
        computeStatus: String(computeStatus?.["state"] ?? ""),
        url: String(a["url"] ?? ""),
        budgetPolicyId: String(a["budget_policy_id"] ?? ""),
      },
      resolvedOutputs: { appName: name, appUrl: String(a["url"] ?? "") },
      secretStates: [],
      externalId: name,
      createdAt: timestamp(a["create_time"], ctx.now()),
      updatedAt: timestamp(a["update_time"], ctx.now()),
    };
  });
}

export async function listSecretScopes(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.api<{ scopes?: Record<string, unknown>[] }>(
    "GET",
    "/api/2.0/secrets/scopes/list",
  );
  return (data.scopes ?? []).map((s) => {
    const name = String(s["name"] ?? "");
    const keyvault = s["keyvault_metadata"] as Record<string, unknown> | undefined;
    return {
      id: ctx.id(accountId, "databricks-secret-scope", name),
      pluginId: "databricks",
      resourceTypeId: "databricks-secret-scope",
      accountId,
      displayName: name,
      fields: {
        name,
        backendType: String(s["backend_type"] ?? ""),
        keyVaultDnsName: String(keyvault?.["dns_name"] ?? ""),
        keyVaultResourceId: String(keyvault?.["resource_id"] ?? ""),
      },
      resolvedOutputs: { scopeName: name },
      secretStates: [],
      externalId: name,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}
