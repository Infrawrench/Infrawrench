/**
 * Detail enrichment for DigitalOcean resources — the async pass that runs
 * before `renderDetail` and stuffs picker catalogs (sizes, distribution
 * images, backups, snapshots) and per-product summaries into
 * `resource.resolvedOutputs`, so the renderers themselves stay synchronous.
 */
import type { ImageOption, ResourceInstance, SizeOption } from "@infrawrench/plugin-base";

/** The slice of `DigitalOceanClient` the enrichers need. */
export interface DoEnrichContext {
  fetch<T>(path: string, options?: RequestInit): Promise<T>;
  /**
   * Catalog caches keyed by the destination prompt-field consumer. Sizes and
   * distribution images almost never change, so a 30-minute TTL is generous.
   */
  dropletCatalogCache: {
    sizes?: { value: SizeOption[]; expiresAt: number };
    distributionImages?: { value: ImageOption[]; expiresAt: number };
  };
  listSpacesBuckets(accountId: string): Promise<ResourceInstance[]>;
}

/** "May 21, 2026" — what people actually read off a backup card. */
function formatBackupDate(isoTimestamp: string): string {
  if (!isoTimestamp) return "unknown date";
  const d = new Date(isoTimestamp);
  if (Number.isNaN(d.getTime())) return isoTimestamp;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/**
 * DO names auto-generated backups like "web-01 2026-05-21 04:50:23". The
 * date is already in the name and we add a relative-friendly version in
 * the same row, so we strip the trailing timestamp to keep the option
 * label short. Falls back to the date when the name is empty.
 */
function formatBackupLabel(name: string, isoTimestamp: string): string {
  const trimmed = name.replace(/\s+\d{4}-\d{2}-\d{2}.*$/, "").trim();
  if (!trimmed) return formatBackupDate(isoTimestamp);
  return `${trimmed} • ${formatBackupDate(isoTimestamp)}`;
}

/**
 * Pre-fetch catalog data the detail page's action prompts need to render
 * pickers instead of raw text inputs (sizes for resize, distribution
 * images + private images for rebuild). Caches both for 30 minutes — the
 * size catalog rarely changes and distribution images only churn on new
 * OS releases. Embedded into resolvedOutputs as JSON so the sync
 * renderDetail can read them without going async.
 */
export async function enrichDoDetail(
  ctx: DoEnrichContext,
  resource: ResourceInstance,
): Promise<ResourceInstance> {
  if (resource.resourceTypeId === "gen-ai-agent") {
    return enrichGenAiAgent(ctx, resource);
  }
  if (resource.resourceTypeId === "gen-ai-knowledge-base") {
    return enrichGenAiKnowledgeBase(ctx, resource);
  }
  if (resource.resourceTypeId === "gen-ai-model-router") {
    return enrichGenAiModelRouter(ctx, resource);
  }
  if (resource.resourceTypeId === "reserved-ip") {
    return enrichReservedIp(ctx, resource);
  }
  if (resource.resourceTypeId !== "droplet") return resource;

  const now = Date.now();
  const CATALOG_TTL_MS = 30 * 60 * 1000;
  const sizesCached = ctx.dropletCatalogCache.sizes;
  const distrosCached = ctx.dropletCatalogCache.distributionImages;
  const needSizes = !sizesCached || sizesCached.expiresAt <= now;
  const needDistros = !distrosCached || distrosCached.expiresAt <= now;

  const externalId = resource.externalId ?? resource.id.split(":").pop() ?? "";
  const backupIdsField = String(resource.fields["backupIds"] ?? "");
  const snapshotIdsField = String(resource.fields["snapshotIds"] ?? "");
  const hasBackups = backupIdsField.length > 0;
  const hasSnapshots = snapshotIdsField.length > 0;

  // The user's own snapshots/images are listable resources, but pulling
  // them in via the existing list endpoints would cost a second round
  // through the host's plugin loop on every detail page render. The
  // images endpoint (`/v2/images?private=true`) is the same call and
  // gives us the freshest view, so we fetch it inline alongside the
  // catalog refreshes (uncached — private inventory does change).
  //
  // Per-droplet backups/snapshots: fetched here so the Restore from
  // Backup picker can show "Daily backup • Mar 21 (5 GB)" instead of
  // raw numeric ids. Skipped entirely when the droplet has neither.
  const [sizesRes, distrosRes, privateImagesRes, backupsRes, snapshotsRes] = await Promise.all([
    needSizes
      ? ctx.fetch<{
          sizes: Array<{
            slug: string;
            memory: number;
            vcpus: number;
            disk: number;
            price_monthly: number;
            available: boolean;
            description: string;
          }>;
        }>("/sizes?per_page=200")
      : Promise.resolve(null),
    needDistros
      ? ctx.fetch<{
          images: Array<{
            id: number;
            slug: string | null;
            name: string;
            distribution: string;
            status: string;
          }>;
        }>("/images?type=distribution&per_page=200")
      : Promise.resolve(null),
    ctx
      .fetch<{
        images: Array<{ id: number; name: string; status: string; type: string }>;
      }>("/images?private=true&per_page=200")
      .catch(() => ({ images: [] })),
    hasBackups && externalId
      ? ctx
          .fetch<{
            backups: Array<{
              id: number;
              name: string;
              created_at: string;
              size_gigabytes: number;
              distribution: string;
            }>;
          }>(`/droplets/${externalId}/backups`)
          .catch(() => ({ backups: [] }))
      : Promise.resolve(null),
    hasSnapshots && externalId
      ? ctx
          .fetch<{
            snapshots: Array<{
              id: number;
              name: string;
              created_at: string;
              size_gigabytes: number;
              distribution: string;
            }>;
          }>(`/droplets/${externalId}/snapshots`)
          .catch(() => ({ snapshots: [] }))
      : Promise.resolve(null),
  ]);

  if (sizesRes) {
    const sizes: SizeOption[] = sizesRes.sizes
      .filter((s) => s.available)
      .map((s) => ({
        id: s.slug,
        label: s.slug,
        vcpus: s.vcpus,
        memoryMb: s.memory,
        diskGb: s.disk,
        priceMonthly: s.price_monthly,
        category: s.description || "Standard",
      }));
    ctx.dropletCatalogCache.sizes = { value: sizes, expiresAt: now + CATALOG_TTL_MS };
  }
  if (distrosRes) {
    const distros: ImageOption[] = distrosRes.images
      .filter((i) => i.status === "available")
      .map((i) => ({
        id: i.slug ?? String(i.id),
        label: i.name,
        category: i.distribution,
      }));
    ctx.dropletCatalogCache.distributionImages = {
      value: distros,
      expiresAt: now + CATALOG_TTL_MS,
    };
  }

  const sizes = ctx.dropletCatalogCache.sizes?.value ?? [];
  const distros = ctx.dropletCatalogCache.distributionImages?.value ?? [];
  const privateImages: ImageOption[] = privateImagesRes.images
    .filter((i) => i.status === "available")
    .map((i) => ({
      id: String(i.id),
      label: i.name,
      category: i.type === "snapshot" ? "My Snapshots" : "My Images",
      isOwned: true,
    }));
  const images = [...distros, ...privateImages];

  // Build the restore-picker options list. Each entry carries `id` (the
  // numeric backup/snapshot id DO expects) and a label structured as
  // "{kind icon} {name/date} • {size}". The `select` field kind doesn't
  // support option groups, so the icon prefix is the only way to make
  // backups vs snapshots scannable in the dropdown. Falls back to raw-id
  // labels in the renderer when this fetch failed.
  type RestoreOption = { id: string; label: string; category: "Backups" | "Snapshots" };
  const restoreOptions: RestoreOption[] = [];
  // Newest first — DO returns oldest-first by default and "most recent"
  // is what people scan for when restoring.
  const sortedBackups = [...(backupsRes?.backups ?? [])].sort((a, b) =>
    String(b.created_at).localeCompare(String(a.created_at)),
  );
  const sortedSnapshots = [...(snapshotsRes?.snapshots ?? [])].sort((a, b) =>
    String(b.created_at).localeCompare(String(a.created_at)),
  );
  for (const b of sortedBackups) {
    restoreOptions.push({
      id: String(b.id),
      label: `[Backup] ${formatBackupLabel(b.name, b.created_at)} — ${b.size_gigabytes} GB`,
      category: "Backups",
    });
  }
  for (const s of sortedSnapshots) {
    restoreOptions.push({
      id: String(s.id),
      label: `[Snapshot] ${s.name || `Snapshot ${s.id}`} — ${formatBackupDate(s.created_at)} — ${s.size_gigabytes} GB`,
      category: "Snapshots",
    });
  }

  return {
    ...resource,
    resolvedOutputs: {
      ...resource.resolvedOutputs,
      __sizes__: JSON.stringify(sizes),
      __images__: JSON.stringify(images),
      __restoreOptions__: JSON.stringify(restoreOptions),
    },
  };
}

/**
 * Pre-fetch the Droplets a reserved IP could be assigned to, so the detail
 * page's Assign prompt shows a **picker** rather than asking for a raw
 * numeric Droplet id. Filtered to the address's own region because
 * DigitalOcean rejects a cross-region assignment; sorted by name so the list
 * reads the same way the sidebar does.
 *
 * Failures degrade to an empty list — the renderer then shows the blocked
 * "no Droplets in this region" prompt instead of crashing the detail page.
 */
async function enrichReservedIp(
  ctx: DoEnrichContext,
  resource: ResourceInstance,
): Promise<ResourceInstance> {
  const region = String(resource.fields["region"] ?? "");
  const data = await ctx
    .fetch<{ droplets?: Array<Record<string, unknown>> | null }>("/droplets?per_page=200")
    .catch(() => ({ droplets: [] }));
  const droplets = (data.droplets ?? [])
    .filter(
      (d) => !region || String((d["region"] as Record<string, unknown>)?.["slug"] ?? "") === region,
    )
    .map((d) => ({
      id: String(d["id"] ?? ""),
      label: String(d["name"] ?? d["id"] ?? ""),
    }))
    .filter((d) => !!d.id)
    .sort((a, b) => a.label.localeCompare(b.label));
  return {
    ...resource,
    resolvedOutputs: {
      ...resource.resolvedOutputs,
      __droplets__: JSON.stringify(droplets),
    },
  };
}

/**
 * Fan out a `GET /v2/gen-ai/agents/{uuid}` to pull attached KBs, function
 * routes, child agents, and other agents (for the "attach child" picker)
 * for the detail view. Failures degrade gracefully — the detail still
 * renders without these sections rather than blanking the page.
 */
async function enrichGenAiAgent(
  ctx: DoEnrichContext,
  resource: ResourceInstance,
): Promise<ResourceInstance> {
  const agentUuid = resource.externalId ?? resource.id.split(":").pop() ?? "";
  if (!agentUuid) return resource;
  const [fullRes, allAgentsRes, allKbsRes, namespacesRes] = await Promise.all([
    ctx.fetch<{ agent: Record<string, unknown> }>(`/gen-ai/agents/${agentUuid}`).catch(() => null),
    ctx
      .fetch<{ agents?: Array<{ uuid?: string; name?: string }> }>("/gen-ai/agents?per_page=200")
      .catch(() => ({ agents: [] })),
    ctx
      .fetch<{
        knowledge_bases?: Array<{ uuid?: string; name?: string }>;
      }>("/gen-ai/knowledge_bases?per_page=200")
      .catch(() => ({ knowledge_bases: [] })),
    // Functions namespaces power the "Add function route" namespace picker.
    // Listing the individual functions within a namespace isn't exposed by
    // the /v2 API (that needs the per-namespace OpenWhisk key), so we only
    // pick the namespace; the function name stays a free-text field.
    ctx
      .fetch<{
        namespaces?: Array<{ namespace?: string; label?: string; region?: string }>;
      }>("/functions/namespaces")
      .catch(() => ({ namespaces: [] })),
  ]);
  const a = fullRes?.agent ?? {};
  const kbs = Array.isArray(a["knowledge_bases"])
    ? (a["knowledge_bases"] as Array<Record<string, unknown>>)
    : [];
  const functions = Array.isArray(a["functions"])
    ? (a["functions"] as Array<Record<string, unknown>>)
    : [];
  const childAgents = Array.isArray(a["child_agents"])
    ? (a["child_agents"] as Array<Record<string, unknown>>)
    : [];
  const allAgents = (allAgentsRes.agents ?? []).filter(
    (other) => String(other.uuid ?? "") !== agentUuid,
  );
  const allKbs = allKbsRes.knowledge_bases ?? [];
  // The chatbot identifier + config power the public embed snippet. The
  // identifier lives in `chatbot_identifiers[].agent_chatbot_identifier`.
  const chatbotIdentifiers = Array.isArray(a["chatbot_identifiers"])
    ? (a["chatbot_identifiers"] as Array<Record<string, unknown>>)
    : [];
  const chatbotId = String(chatbotIdentifiers[0]?.["agent_chatbot_identifier"] ?? "");
  const chatbot = (a["chatbot"] ?? {}) as Record<string, unknown>;
  return {
    ...resource,
    resolvedOutputs: {
      ...resource.resolvedOutputs,
      __attachedKbs__: JSON.stringify(kbs.map((k) => ({ uuid: k["uuid"], name: k["name"] }))),
      __functions__: JSON.stringify(
        functions.map((f) => ({
          uuid: f["uuid"],
          function_name: f["function_name"],
          description: f["description"],
          faas_name: f["faas_name"],
          faas_namespace: f["faas_namespace"],
        })),
      ),
      __childAgents__: JSON.stringify(
        childAgents.map((c) => ({
          uuid: c["uuid"],
          name: c["name"],
          route_name: c["route_name"],
          if_case: c["if_case"],
        })),
      ),
      __allAgents__: JSON.stringify(allAgents),
      __allKbs__: JSON.stringify(allKbs),
      __functionNamespaces__: JSON.stringify(
        (namespacesRes.namespaces ?? []).map((n) => ({
          namespace: n.namespace,
          label: n.label,
          region: n.region,
        })),
      ),
      ...(chatbotId ? { __chatbotId__: chatbotId } : {}),
      __chatbot__: JSON.stringify({
        name: String(chatbot["name"] ?? a["name"] ?? ""),
        primary_color: String(chatbot["primary_color"] ?? "#031B4E"),
        secondary_color: String(chatbot["secondary_color"] ?? "#E5E8ED"),
        button_background_color: String(chatbot["button_background_color"] ?? "#0061EB"),
        starting_message: String(chatbot["starting_message"] ?? ""),
        logo: String(chatbot["logo"] ?? ""),
      }),
    },
  };
}

/**
 * Fetch the router's task presets (valid task slugs + their router-eligible
 * default models) and a model uuid→name map so the policy add/edit form can
 * offer real pickers. Stashed as `__taskPresets__` / `__routerModelOptions__`
 * for the synchronous renderDetail. Best-effort — degrades to empty.
 */
async function enrichGenAiModelRouter(
  ctx: DoEnrichContext,
  resource: ResourceInstance,
): Promise<ResourceInstance> {
  const [taskRes, modelsRes] = await Promise.all([
    ctx
      .fetch<{
        tasks?: Array<{
          task_slug?: string;
          name?: string;
          models?: string[];
          selection_policy?: { prefer?: string };
        }>;
      }>("/gen-ai/models/routers/tasks/presets?per_page=200")
      .catch(() => ({ tasks: [] })),
    ctx
      .fetch<{
        models?: Array<{ uuid?: string; name?: string }>;
      }>("/gen-ai/models?usecases=MODEL_USECASE_SERVERLESS&per_page=200")
      .catch(() => ({ models: [] })),
  ]);
  const nameById = new Map<string, string>();
  for (const m of modelsRes.models ?? []) {
    if (m.uuid) nameById.set(String(m.uuid), String(m.name ?? m.uuid));
  }
  const tasks = (taskRes.tasks ?? [])
    .filter((t) => t.task_slug)
    .map((t) => ({
      task_slug: String(t.task_slug),
      name: String(t.name ?? t.task_slug),
      models: Array.isArray(t.models) ? t.models.map(String) : [],
      prefer: String(t.selection_policy?.prefer ?? ""),
    }));
  // Union of every task's router-eligible models → the multi-select catalog.
  const modelIds = new Set<string>();
  for (const t of tasks) for (const id of t.models) modelIds.add(id);
  const routerModelOptions = [...modelIds].map((id) => ({
    id,
    label: nameById.get(id) ?? id,
  }));
  return {
    ...resource,
    resolvedOutputs: {
      ...resource.resolvedOutputs,
      __taskPresets__: JSON.stringify(tasks),
      __routerModelOptions__: JSON.stringify(routerModelOptions),
    },
  };
}

/**
 * Fan out the per-KB management calls for the detail view: its data sources
 * (GET /v2/gen-ai/knowledge_bases/{uuid}/data_sources) and recent indexing
 * jobs (GET .../indexing_jobs), plus a best-effort Spaces-bucket list so the
 * "Add Spaces source" form can offer a picker. All calls degrade to empty on
 * error so the detail page still renders. Results are stashed as JSON strings
 * in resolvedOutputs for the synchronous renderDetail to read back.
 */
async function enrichGenAiKnowledgeBase(
  ctx: DoEnrichContext,
  resource: ResourceInstance,
): Promise<ResourceInstance> {
  const kbUuid = resource.externalId ?? resource.id.split(":").pop() ?? "";
  if (!kbUuid) return resource;
  const [dsRes, jobsRes, buckets] = await Promise.all([
    ctx
      .fetch<{
        knowledge_base_data_sources?: Array<Record<string, unknown>>;
      }>(`/gen-ai/knowledge_bases/${kbUuid}/data_sources?per_page=100`)
      .catch(() => ({ knowledge_base_data_sources: [] })),
    ctx
      .fetch<{
        jobs?: Array<Record<string, unknown>>;
      }>(`/gen-ai/knowledge_bases/${kbUuid}/indexing_jobs`)
      .catch(() => ({ jobs: [] })),
    // Best-effort — returns [] when the account has no Spaces keys configured.
    ctx.listSpacesBuckets(resource.accountId).catch(() => [] as ResourceInstance[]),
  ]);

  // Flatten each data source to the handful of display/identity fields the
  // table needs. DO nests the actual source under one of the *_data_source
  // keys; derive a single type + human summary from whichever is present.
  const dataSources = (dsRes.knowledge_base_data_sources ?? []).map((d) => {
    const spaces = d["spaces_data_source"] as Record<string, unknown> | undefined;
    const web = d["web_crawler_data_source"] as Record<string, unknown> | undefined;
    const file = d["file_upload_data_source"] as Record<string, unknown> | undefined;
    const lastJob = d["last_datasource_indexing_job"] as Record<string, unknown> | undefined;
    let type = "Unknown";
    let summary = "";
    if (web) {
      type = "Web crawler";
      summary = String(web["base_url"] ?? "");
    } else if (spaces) {
      type = "Spaces bucket";
      const bucket = String(spaces["bucket_name"] ?? "");
      const path = String(spaces["item_path"] ?? "");
      summary = path ? `${bucket}/${path}` : bucket;
    } else if (file) {
      type = "File upload";
      summary = String(file["original_file_name"] ?? "");
    }
    return {
      uuid: String(d["uuid"] ?? ""),
      type,
      summary,
      status: String(lastJob?.["status"] ?? ""),
      created_at: String(d["created_at"] ?? ""),
    };
  });

  const indexingJobs = (jobsRes.jobs ?? []).map((j) => ({
    uuid: String(j["uuid"] ?? ""),
    status: String(j["status"] ?? ""),
    phase: String(j["phase"] ?? ""),
    total_datasources: Number(j["total_datasources"] ?? 0),
    completed_datasources: Number(j["completed_datasources"] ?? 0),
    tokens: String(j["total_tokens"] ?? j["tokens"] ?? ""),
    created_at: String(j["created_at"] ?? ""),
    finished_at: String(j["finished_at"] ?? ""),
  }));

  const spacesBuckets = buckets.map((b) => ({
    name: b.externalId ?? String(b.fields["name"] ?? ""),
    region: String(b.fields["region"] ?? ""),
  }));

  return {
    ...resource,
    resolvedOutputs: {
      ...resource.resolvedOutputs,
      __dataSources__: JSON.stringify(dataSources),
      __indexingJobs__: JSON.stringify(indexingJobs),
      __spacesBuckets__: JSON.stringify(spacesBuckets),
    },
  };
}
