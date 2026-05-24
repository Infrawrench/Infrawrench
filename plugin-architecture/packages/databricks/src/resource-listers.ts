import type { ResourceInstance } from "@infrawrench/plugin-base";

export interface ListerContext {
  api<T>(method: string, path: string, body?: Record<string, unknown>): Promise<T>;
  id(accountId: string, typeId: string, externalId: string): string;
  now(): string;
  host: string;
}

export async function listClusters(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.api<{ clusters?: Record<string, unknown>[] }>(
    "GET",
    "/api/2.0/clusters/list",
  );
  const clusters = data.clusters ?? [];

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

    const host = ctx.host.replace(/^https?:\/\//, "");
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
  const data = await ctx.api<{ jobs?: Record<string, unknown>[]; has_more?: boolean }>(
    "GET",
    "/api/2.1/jobs/list?limit=100&expand_tasks=false",
  );
  const jobs = data.jobs ?? [];

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

    const host = ctx.host.replace(/^https?:\/\//, "");

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
    const host = ctx.host.replace(/^https?:\/\//, "");

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
  const data = await ctx.api<{ catalogs?: Record<string, unknown>[] }>(
    "GET",
    "/api/2.1/unity-catalog/catalogs",
  );
  const catalogs = data.catalogs ?? [];

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
  const data = await ctx.api<{ schemas?: Record<string, unknown>[] }>(
    "GET",
    `/api/2.1/unity-catalog/schemas?catalog_name=${encodeURIComponent(catalogName)}`,
  );
  const schemas = data.schemas ?? [];

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
  const data = await ctx.api<{ tables?: Record<string, unknown>[] }>(
    "GET",
    `/api/2.1/unity-catalog/tables?catalog_name=${encodeURIComponent(catalogName)}&schema_name=${encodeURIComponent(schemaName)}&max_results=1000`,
  );
  const tables = data.tables ?? [];

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
