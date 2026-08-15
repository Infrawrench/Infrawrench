import type {
  CreateResourceConfig,
  DashboardStat,
  DetailViewSchema,
  HostServices,
  PluginClient,
  ResourceInstance,
  ResourceStatus,
  SchemaNode,
  SectionNode,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { joinSubtitle, jsonRestFetch } from "@infrawrench/plugin-base";

const API_BASE = "https://api.replicate.com/v1";

/**
 * Replicate's list endpoints have no page-size control at all — they return a
 * fixed 100 records per page and hand back a full opaque URL in `next`. These
 * caps bound how far we walk that chain per sync.
 * https://replicate.com/docs/reference/http#predictions.list
 */
const MAX_PAGES_HOT = 3;
const MAX_PAGES_COLD = 10;

// ---------------------------------------------------------------------------
// Wire shapes — mirrored from https://api.replicate.com/openapi.json (1.0.0-a1)
// ---------------------------------------------------------------------------

/**
 * Every list endpoint answers `{next, previous, results}` where the cursors are
 * fully-qualified URLs carrying an opaque `cursor` query param. They must be
 * followed verbatim — there is no documented way to build one by hand.
 * https://replicate.com/docs/reference/http
 */
interface Page<T> {
  next?: string | null;
  previous?: string | null;
  results?: T[];
}

interface ReplicateAccount {
  type?: string;
  username?: string;
  name?: string | null;
  github_url?: string | null;
  avatar_url?: string | null;
}

interface ReplicatePrediction {
  id: string;
  model?: string;
  /** Either a 64-char version id or the literal string `"hidden"` for official models. */
  version?: string;
  input?: Record<string, unknown> | null;
  output?: unknown;
  logs?: string | null;
  error?: string | null;
  status?: string;
  source?: string | null;
  deployment?: string | null;
  deadline?: string | null;
  data_removed?: boolean;
  created_at?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  /** Open bag — only `total_time` is declared in the schema. */
  metrics?: Record<string, number> | null;
  urls?: { web?: string; get?: string; cancel?: string; stream?: string } | null;
}

interface ReplicateVersion {
  id?: string;
  created_at?: string | null;
  cog_version?: string | null;
  openapi_schema?: Record<string, unknown> | null;
}

interface ReplicateModel {
  owner?: string;
  name?: string;
  description?: string | null;
  visibility?: string;
  is_official?: boolean;
  run_count?: number;
  url?: string | null;
  github_url?: string | null;
  paper_url?: string | null;
  license_url?: string | null;
  cover_image_url?: string | null;
  latest_version?: ReplicateVersion | null;
}

/** `GET /v1/collections` items are slim; the detail response adds `models`. */
interface ReplicateCollectionListItem {
  name?: string;
  slug?: string;
  description?: string | null;
}

interface ReplicateCollection extends ReplicateCollectionListItem {
  full_description?: string | null;
  models?: ReplicateModel[];
}

interface ReplicateTraining {
  id?: string;
  model?: string;
  version?: string;
  input?: Record<string, unknown> | null;
  /** Trainings return a structured output, unlike predictions. */
  output?: { version?: string; weights?: string } | null;
  logs?: string | null;
  error?: string | null;
  status?: string;
  source?: string | null;
  created_at?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  metrics?: { predict_time?: number; total_time?: number } | null;
  urls?: { get?: string; cancel?: string; web?: string } | null;
}

interface ReplicateDeployment {
  owner?: string;
  name?: string;
  current_release?: {
    number?: number;
    model?: string;
    version?: string;
    created_at?: string | null;
    created_by?: { type?: string; username?: string; name?: string | null } | null;
    configuration?: {
      hardware?: string;
      min_instances?: number;
      max_instances?: number;
    } | null;
  } | null;
}

interface ReplicateHardware {
  name?: string;
  sku?: string;
}

interface ReplicateFile {
  id?: string;
  name?: string;
  content_type?: string;
  size?: number;
  checksums?: Record<string, string> | null;
  metadata?: Record<string, unknown> | null;
  created_at?: string | null;
  expires_at?: string | null;
  urls?: { get?: string } | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** `{accountId}:{typeId}:{externalId}` → `{externalId}` (may contain `/`). */
function externalIdOf(resourceId: string): string {
  return resourceId.split(":").slice(2).join(":");
}

function nowIso(): string {
  return new Date().toISOString();
}

function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, index);
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function titleCase(value: string): string {
  return value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Replicate's status enum has six members, not the five the prose docs list.
 * `canceled` means "stopped while running (or past its deadline)"; `aborted`
 * means "terminated before it ever started running". They are distinct
 * outcomes and the UI keeps them distinct.
 * https://api.replicate.com/openapi.json — `schemas_prediction_response.status`
 */
function mapRunStatus(status: string | undefined): { status: ResourceStatus; label: string } {
  switch (status) {
    case "succeeded":
      return { status: "healthy", label: "Succeeded" };
    case "processing":
      return { status: "provisioning", label: "Processing" };
    case "starting":
      return { status: "provisioning", label: "Starting" };
    case "failed":
      return { status: "error", label: "Failed" };
    case "canceled":
      return { status: "unknown", label: "Canceled" };
    case "aborted":
      return { status: "degraded", label: "Aborted before start" };
    default:
      return { status: "info", label: status ? titleCase(status) : "Unknown" };
  }
}

/** Pull the first URL-shaped value out of a prediction's free-form `output`. */
function firstOutputUrl(output: unknown): string {
  if (typeof output === "string") return output.startsWith("http") ? output : "";
  if (Array.isArray(output)) {
    for (const entry of output) {
      if (typeof entry === "string" && entry.startsWith("http")) return entry;
    }
  }
  return "";
}

function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 12)}…` : value;
}

/** Compact one-line preview of a prediction/training input map. */
function previewInput(input: Record<string, unknown> | null | undefined): string {
  if (!input) return "";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      const text = String(value);
      parts.push(`${key}=${text.length > 40 ? `${text.slice(0, 37)}…` : text}`);
    }
    if (parts.length >= 3) break;
  }
  return parts.join(" · ");
}

/**
 * Replicate plugin client. One instance per account (per API token).
 *
 * Replicate has **no billing, usage or spend API** — `GET /v1/account` returns
 * identity only — so this plugin deliberately implements no `fetchCostData`
 * and says so in the UI rather than rendering an empty cost chart.
 * https://replicate.com/docs/reference/http#account.get
 */
export class ReplicateClient implements PluginClient {
  private readonly apiToken: string;
  private readonly caCert: string;
  private readonly services: HostServices | undefined;
  private accountCache: ReplicateAccount | null = null;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const apiToken = credentials["apiToken"];
    if (!apiToken) throw new Error("Replicate plugin: missing apiToken credential");
    this.apiToken = apiToken;
    this.caCert = credentials["caCert"] ?? "";
    this.services = services;
  }

  /**
   * Auth is `Authorization: Bearer r8_…`. The older `Token` scheme still
   * appears in some of Replicate's own examples but `bearerAuth` is the only
   * security scheme in the current OpenAPI document.
   * https://replicate.com/docs/reference/http#authentication
   */
  private async request<T>(url: string, options?: RequestInit): Promise<T> {
    return jsonRestFetch<T>({
      vendor: "Replicate",
      url,
      errorPath: url.startsWith(API_BASE) ? url.slice(API_BASE.length) || "/" : url,
      headers: { Authorization: `Bearer ${this.apiToken}`, Accept: "application/json" },
      ...(options ? { init: options } : {}),
      ...(this.services?.http ? { http: this.services.http } : {}),
      ...(this.caCert ? { caCert: this.caCert } : {}),
    });
  }

  private async fetch<T>(path: string, options?: RequestInit): Promise<T> {
    return this.request<T>(`${API_BASE}${path}`, options);
  }

  /**
   * Walk a paginated collection. `next` is an absolute, opaque URL — it is
   * passed straight back to `fetch` rather than decomposed, because the cursor
   * inside it is base64 of a provider-private ordering key.
   */
  private async paginate<T>(path: string, maxPages: number): Promise<T[]> {
    const items: T[] = [];
    let url: string | undefined = `${API_BASE}${path}`;
    for (let page = 0; page < maxPages && url; page += 1) {
      const data: Page<T> = await this.request<Page<T>>(url);
      items.push(...(data.results ?? []));
      url = data.next ?? undefined;
    }
    return items;
  }

  /** `GET /v1/account` — identity only. No billing fields exist on it. */
  private async fetchAccount(): Promise<ReplicateAccount> {
    if (this.accountCache) return this.accountCache;
    const account = await this.fetch<ReplicateAccount>("/account");
    this.accountCache = account;
    return account;
  }

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "prediction": {
        // https://replicate.com/docs/reference/http#predictions.list
        const predictions = await this.paginate<ReplicatePrediction>("/predictions", MAX_PAGES_HOT);
        return predictions.map((prediction) => this.mapPrediction(prediction, accountId));
      }
      case "training": {
        // https://replicate.com/docs/reference/http#trainings.list
        const trainings = await this.paginate<ReplicateTraining>("/trainings", MAX_PAGES_HOT);
        return trainings.map((training) => this.mapTraining(training, accountId));
      }
      case "deployment": {
        // https://replicate.com/docs/reference/http#deployments.list
        const deployments = await this.paginate<ReplicateDeployment>(
          "/deployments",
          MAX_PAGES_COLD,
        );
        return deployments.map((deployment) => this.mapDeployment(deployment, accountId));
      }
      case "collection": {
        // https://replicate.com/docs/reference/http#collections.list
        const collections = await this.paginate<ReplicateCollectionListItem>(
          "/collections",
          MAX_PAGES_COLD,
        );
        return collections.map((collection) => this.mapCollection(collection, accountId));
      }
      case "hardware": {
        // https://replicate.com/docs/reference/http#hardware.list — a bare
        // array, not a paginated envelope.
        const hardware = await this.fetch<ReplicateHardware[]>("/hardware");
        return (Array.isArray(hardware) ? hardware : []).map((entry) =>
          this.mapHardware(entry, accountId),
        );
      }
      case "file": {
        const files = await this.paginate<ReplicateFile>("/files", MAX_PAGES_COLD);
        return files.map((file) => this.mapFile(file, accountId));
      }
      case "model":
        return this.listAccountModels(accountId);
      default:
        throw new Error(`Replicate plugin: unknown resource type "${typeId}"`);
    }
  }

  /**
   * Replicate has no "list my models" endpoint — `GET /v1/models` enumerates
   * the entire public catalogue, which is neither useful nor cheap. Instead we
   * derive the models this account actually touches: everything it owns that
   * shows up as a deployment target, a training destination, or a recent
   * prediction. `getResource` then fetches the full record for whichever one
   * the user opens.
   */
  private async listAccountModels(accountId: string): Promise<ResourceInstance[]> {
    const [account, deployments, trainings, predictions] = await Promise.all([
      this.fetchAccount().catch((): ReplicateAccount => ({})),
      this.paginate<ReplicateDeployment>("/deployments", MAX_PAGES_COLD).catch(
        (): ReplicateDeployment[] => [],
      ),
      this.paginate<ReplicateTraining>("/trainings", MAX_PAGES_HOT).catch(
        (): ReplicateTraining[] => [],
      ),
      this.paginate<ReplicatePrediction>("/predictions", MAX_PAGES_HOT).catch(
        (): ReplicatePrediction[] => [],
      ),
    ]);

    /** `owner/name` → most recently seen version id. */
    const refs = new Map<string, string>();
    const remember = (ref: string | null | undefined, version?: string | null): void => {
      if (!ref || !ref.includes("/")) return;
      const existing = refs.get(ref);
      // `"hidden"` is the placeholder official models use in place of a version.
      const usable = version && version !== "hidden" ? version : "";
      if (existing === undefined || (!existing && usable)) refs.set(ref, usable);
    };

    for (const deployment of deployments) {
      remember(deployment.current_release?.model, deployment.current_release?.version);
    }
    for (const training of trainings) {
      remember(training.model, training.version);
      // The trained weights land in a *different* model — the destination.
      const destination =
        typeof training.input?.["destination"] === "string"
          ? (training.input["destination"] as string)
          : "";
      remember(destination, training.output?.version);
    }
    for (const prediction of predictions) remember(prediction.model, prediction.version);

    const username = account.username ?? "";
    return [...refs.entries()]
      .sort(([a], [b]) => {
        // Models this account owns sort first — they're the ones the user manages.
        const aOwned = username && a.startsWith(`${username}/`) ? 0 : 1;
        const bOwned = username && b.startsWith(`${username}/`) ? 0 : 1;
        return aOwned - bOwned || a.localeCompare(b);
      })
      .map(([ref, version]) => {
        const [owner = "", name = ""] = ref.split("/");
        return this.mapModel(
          { owner, name, ...(version ? { latest_version: { id: version } } : {}) },
          accountId,
        );
      });
  }

  // -------------------------------------------------------------------------
  // Mapping
  // -------------------------------------------------------------------------

  private mapPrediction(prediction: ReplicatePrediction, accountId: string): ResourceInstance {
    const createdAt = prediction.created_at ?? nowIso();
    const metrics = prediction.metrics ?? {};
    const preview = previewInput(prediction.input);
    const displayName = preview
      ? `${prediction.model ?? shortId(prediction.id)} — ${preview}`
      : `${prediction.model ?? "prediction"} · ${shortId(prediction.id)}`;
    const outputUrl = firstOutputUrl(prediction.output);
    return {
      id: `${accountId}:prediction:${prediction.id}`,
      pluginId: "replicate",
      resourceTypeId: "prediction",
      accountId,
      displayName,
      fields: {
        predictionId: prediction.id,
        ...(prediction.status ? { status: prediction.status } : {}),
        ...(prediction.model ? { model: prediction.model } : {}),
        ...(prediction.version ? { version: prediction.version } : {}),
        ...(prediction.source ? { source: prediction.source } : {}),
        ...(prediction.deployment ? { deployment: prediction.deployment } : {}),
        ...(prediction.error ? { error: prediction.error } : {}),
        ...(typeof metrics["predict_time"] === "number"
          ? { predictTime: metrics["predict_time"] }
          : {}),
        ...(typeof metrics["total_time"] === "number" ? { totalTime: metrics["total_time"] } : {}),
        createdAt,
        ...(prediction.started_at ? { startedAt: prediction.started_at } : {}),
        ...(prediction.completed_at ? { completedAt: prediction.completed_at } : {}),
        ...(prediction.deadline ? { deadline: prediction.deadline } : {}),
        dataRemoved: prediction.data_removed ?? false,
        ...(prediction.urls?.web ? { webUrl: prediction.urls.web } : {}),
      },
      resolvedOutputs: {
        predictionId: prediction.id,
        outputUrl,
        status: prediction.status ?? "",
        webUrl: prediction.urls?.web ?? "",
      },
      secretStates: [],
      externalId: prediction.id,
      createdAt,
      updatedAt: prediction.completed_at ?? prediction.started_at ?? createdAt,
    };
  }

  private mapTraining(training: ReplicateTraining, accountId: string): ResourceInstance {
    const id = training.id ?? "";
    const createdAt = training.created_at ?? nowIso();
    const destination =
      typeof training.input?.["destination"] === "string"
        ? (training.input["destination"] as string)
        : "";
    return {
      id: `${accountId}:training:${id}`,
      pluginId: "replicate",
      resourceTypeId: "training",
      accountId,
      displayName: destination || `${training.model ?? "training"} · ${shortId(id)}`,
      fields: {
        trainingId: id,
        ...(training.status ? { status: training.status } : {}),
        ...(training.model ? { model: training.model } : {}),
        ...(training.version ? { version: training.version } : {}),
        ...(destination ? { destination } : {}),
        ...(training.error ? { error: training.error } : {}),
        ...(training.metrics?.predict_time != null
          ? { predictTime: training.metrics.predict_time }
          : {}),
        createdAt,
        ...(training.started_at ? { startedAt: training.started_at } : {}),
        ...(training.completed_at ? { completedAt: training.completed_at } : {}),
      },
      resolvedOutputs: {
        trainingId: id,
        destinationVersion: training.output?.version ?? "",
        status: training.status ?? "",
      },
      secretStates: [],
      externalId: id,
      createdAt,
      updatedAt: training.completed_at ?? training.started_at ?? createdAt,
    };
  }

  private mapDeployment(deployment: ReplicateDeployment, accountId: string): ResourceInstance {
    const owner = deployment.owner ?? "";
    const name = deployment.name ?? "";
    const ref = `${owner}/${name}`;
    const release = deployment.current_release ?? {};
    const configuration = release.configuration ?? {};
    const createdAt = release.created_at ?? nowIso();
    return {
      id: `${accountId}:deployment:${ref}`,
      pluginId: "replicate",
      resourceTypeId: "deployment",
      accountId,
      displayName: ref,
      fields: {
        owner,
        name,
        ...(release.model ? { model: release.model } : {}),
        ...(release.version ? { version: release.version } : {}),
        ...(configuration.hardware ? { hardware: configuration.hardware } : {}),
        ...(configuration.min_instances != null
          ? { minInstances: configuration.min_instances }
          : {}),
        ...(configuration.max_instances != null
          ? { maxInstances: configuration.max_instances }
          : {}),
        ...(release.number != null ? { releaseNumber: release.number } : {}),
        createdAt,
        ...(release.created_by?.username ? { createdBy: release.created_by.username } : {}),
      },
      resolvedOutputs: {
        deploymentRef: ref,
        predictionsUrl: `${API_BASE}/deployments/${ref}/predictions`,
        version: release.version ?? "",
      },
      secretStates: [],
      externalId: ref,
      createdAt,
      updatedAt: createdAt,
    };
  }

  private mapModel(model: ReplicateModel, accountId: string): ResourceInstance {
    const owner = model.owner ?? "";
    const name = model.name ?? "";
    const ref = `${owner}/${name}`;
    const url = model.url ?? `https://replicate.com/${ref}`;
    const createdAt = model.latest_version?.created_at ?? nowIso();
    return {
      id: `${accountId}:model:${ref}`,
      pluginId: "replicate",
      resourceTypeId: "model",
      accountId,
      displayName: ref,
      fields: {
        owner,
        name,
        ...(model.description ? { description: model.description } : {}),
        ...(model.visibility ? { visibility: model.visibility } : {}),
        ...(model.is_official != null ? { isOfficial: model.is_official } : {}),
        ...(model.run_count != null ? { runCount: model.run_count } : {}),
        ...(model.latest_version?.id ? { latestVersion: model.latest_version.id } : {}),
        ...(model.latest_version?.cog_version
          ? { cogVersion: model.latest_version.cog_version }
          : {}),
        ...(model.github_url ? { githubUrl: model.github_url } : {}),
        ...(model.paper_url ? { paperUrl: model.paper_url } : {}),
        ...(model.license_url ? { licenseUrl: model.license_url } : {}),
        ...(model.cover_image_url ? { coverImageUrl: model.cover_image_url } : {}),
        modelUrl: url,
      },
      resolvedOutputs: {
        modelRef: ref,
        latestVersion: model.latest_version?.id ?? "",
        modelUrl: url,
      },
      secretStates: [],
      externalId: ref,
      createdAt,
      updatedAt: createdAt,
    };
  }

  private mapCollection(
    collection: ReplicateCollectionListItem,
    accountId: string,
  ): ResourceInstance {
    const slug = collection.slug ?? "";
    const full = collection as ReplicateCollection;
    const models = full.models ?? [];
    const createdAt = nowIso();
    return {
      id: `${accountId}:collection:${slug}`,
      pluginId: "replicate",
      resourceTypeId: "collection",
      accountId,
      displayName: collection.name ?? slug,
      fields: {
        slug,
        name: collection.name ?? slug,
        ...(collection.description ? { description: collection.description } : {}),
        ...(models.length ? { modelCount: models.length } : {}),
        ...(models.length
          ? { models: models.map((model) => `${model.owner}/${model.name}`).join(", ") }
          : {}),
      },
      resolvedOutputs: {
        slug,
        collectionUrl: `https://replicate.com/collections/${slug}`,
      },
      secretStates: [],
      externalId: slug,
      createdAt,
      updatedAt: createdAt,
    };
  }

  private mapHardware(hardware: ReplicateHardware, accountId: string): ResourceInstance {
    const sku = hardware.sku ?? "";
    const createdAt = nowIso();
    return {
      id: `${accountId}:hardware:${sku}`,
      pluginId: "replicate",
      resourceTypeId: "hardware",
      accountId,
      displayName: hardware.name ?? sku,
      fields: { sku, name: hardware.name ?? sku },
      resolvedOutputs: { sku },
      secretStates: [],
      externalId: sku,
      createdAt,
      updatedAt: createdAt,
    };
  }

  private mapFile(file: ReplicateFile, accountId: string): ResourceInstance {
    const id = file.id ?? "";
    const createdAt = file.created_at ?? nowIso();
    return {
      id: `${accountId}:file:${id}`,
      pluginId: "replicate",
      resourceTypeId: "file",
      accountId,
      displayName: file.name ?? id,
      fields: {
        fileId: id,
        ...(file.name ? { name: file.name } : {}),
        ...(file.content_type ? { contentType: file.content_type } : {}),
        ...(file.size != null ? { size: file.size } : {}),
        ...(file.checksums?.["sha256"] ? { sha256: file.checksums["sha256"] } : {}),
        createdAt,
        ...(file.expires_at ? { expiresAt: file.expires_at } : {}),
      },
      resolvedOutputs: {
        fileId: id,
        fileUrl: file.urls?.get ?? "",
      },
      secretStates: [],
      externalId: id,
      createdAt,
      updatedAt: createdAt,
    };
  }

  // -------------------------------------------------------------------------
  // Single resource
  // -------------------------------------------------------------------------

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const externalId = externalIdOf(resourceId);
    switch (typeId) {
      case "prediction": {
        // https://replicate.com/docs/reference/http#predictions.get
        const prediction = await this.fetch<ReplicatePrediction>(
          `/predictions/${encodeURIComponent(externalId)}`,
        );
        return this.mapPrediction(prediction, accountId);
      }
      case "training": {
        const training = await this.fetch<ReplicateTraining>(
          `/trainings/${encodeURIComponent(externalId)}`,
        );
        return this.mapTraining(training, accountId);
      }
      case "deployment": {
        const deployment = await this.fetch<ReplicateDeployment>(
          `/deployments/${encodePath(externalId)}`,
        );
        return this.mapDeployment(deployment, accountId);
      }
      case "model": {
        // https://replicate.com/docs/reference/http#models.get
        const model = await this.fetch<ReplicateModel>(`/models/${encodePath(externalId)}`);
        return this.mapModel(model, accountId);
      }
      case "collection": {
        // The detail response carries the model list the slim list item lacks.
        const collection = await this.fetch<ReplicateCollection>(
          `/collections/${encodeURIComponent(externalId)}`,
        );
        return this.mapCollection(collection, accountId);
      }
      case "file": {
        const file = await this.fetch<ReplicateFile>(`/files/${encodeURIComponent(externalId)}`);
        return this.mapFile(file, accountId);
      }
      default: {
        const all = await this.listResources(typeId, accountId);
        const found = all.find((resource) => resource.id === resourceId);
        if (!found) throw new Error(`Replicate plugin: resource ${typeId}/${externalId} not found`);
        return found;
      }
    }
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    const resource = await this.getResource(typeId, resourceId, accountId);
    const value = resource.resolvedOutputs[outputKey];
    if (value !== undefined) return value;
    throw new Error(`Replicate plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
  }

  // -------------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------------

  /**
   * `GET /v1/hardware` feeds the deployment create form's hardware picker so
   * the user never has to know a SKU string like `gpu-a40-large`.
   */
  async getCreateConfig(typeId: string): Promise<CreateResourceConfig> {
    if (typeId !== "deployment") {
      throw new Error(`Replicate plugin: createResource not supported for type "${typeId}"`);
    }
    const hardware = await this.fetch<ReplicateHardware[]>("/hardware").catch(
      (): ReplicateHardware[] => [],
    );
    const options = (Array.isArray(hardware) ? hardware : [])
      .filter((entry) => Boolean(entry.sku))
      .map((entry) => ({ id: entry.sku ?? "", label: entry.name ?? entry.sku ?? "" }));

    return {
      fields: [
        {
          key: "name",
          label: "Deployment Name",
          kind: "text",
          required: true,
          description:
            "Lowercase name for the deployment, unique within your account. It becomes the second half of the `owner/name` reference you call.",
          placeholder: "my-app-sdxl",
        },
        {
          key: "model",
          label: "Model",
          kind: "resource-picker",
          required: true,
          description: "The model this deployment serves.",
          associationSources: [
            { pluginId: "replicate", resourceTypeId: "model", outputKey: "modelRef" },
          ],
        },
        {
          key: "version",
          label: "Version",
          kind: "text",
          required: false,
          description:
            "Model version to pin. Leave blank to deploy whatever the model's latest version is at creation time.",
          placeholder: "latest",
        },
        {
          key: "hardware",
          label: "Hardware",
          kind: "select",
          required: true,
          description: "GPU/CPU class each instance runs on.",
          options,
          ...(options[0] ? { defaultValue: options[0].id } : {}),
        },
        {
          key: "min_instances",
          label: "Minimum Instances",
          kind: "number",
          required: true,
          description:
            "Instances kept warm at all times. 0 scales to zero between requests (cheaper, but the first request pays a cold start).",
          defaultValue: "0",
          minValue: 0,
          maxValue: 5,
          stepValue: 1,
        },
        {
          key: "max_instances",
          label: "Maximum Instances",
          kind: "number",
          required: true,
          description: "Upper bound on autoscaling.",
          defaultValue: "1",
          minValue: 0,
          maxValue: 20,
          stepValue: 1,
        },
      ],
    };
  }

  /**
   * `POST /v1/deployments` — all six of name/model/version/hardware/
   * min_instances/max_instances are required by the API. When the user leaves
   * the version blank we resolve the model's `latest_version.id` for them
   * rather than making them paste a 64-character hash.
   * https://replicate.com/docs/reference/http#deployments.create
   */
  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    if (typeId !== "deployment") {
      throw new Error(`Replicate plugin: createResource not supported for type "${typeId}"`);
    }
    const modelRef = (fields["model"] ?? "").trim();
    if (!modelRef.includes("/")) {
      throw new Error("Replicate plugin: model must be an `owner/name` reference");
    }
    let version = (fields["version"] ?? "").trim();
    if (!version || version === "latest") {
      const model = await this.fetch<ReplicateModel>(`/models/${encodePath(modelRef)}`);
      version = model.latest_version?.id ?? "";
      if (!version) {
        throw new Error(
          `Replicate plugin: ${modelRef} has no published version to deploy — pick a version explicitly`,
        );
      }
    }

    const body = {
      name: fields["name"] ?? "",
      model: modelRef,
      version,
      hardware: fields["hardware"] ?? "",
      min_instances: clampInt(fields["min_instances"], 0, 5, 0),
      max_instances: clampInt(fields["max_instances"], 0, 20, 1),
    };
    const created = await this.fetch<ReplicateDeployment>("/deployments", {
      method: "POST",
      body: JSON.stringify(body),
    });
    return this.mapDeployment(created, accountId);
  }

  /**
   * `PATCH /v1/deployments/{owner}/{name}` is the scale affordance — it takes
   * any subset of hardware/version/min_instances/max_instances and bumps the
   * release number. https://replicate.com/docs/reference/http#deployments.update
   */
  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    if (typeId !== "deployment") {
      throw new Error(`Replicate plugin: updateResource not supported for type "${typeId}"`);
    }
    const ref = externalIdOf(resourceId);
    const body: Record<string, string | number> = {};
    if (fields["version"]) body["version"] = fields["version"];
    if (fields["hardware"]) body["hardware"] = fields["hardware"];
    if (fields["minInstances"] !== undefined) {
      body["min_instances"] = clampInt(fields["minInstances"], 0, 5, 0);
    }
    if (fields["maxInstances"] !== undefined) {
      body["max_instances"] = clampInt(fields["maxInstances"], 0, 20, 1);
    }
    if (Object.keys(body).length === 0) {
      return this.getResource(typeId, resourceId, accountId);
    }
    const updated = await this.fetch<ReplicateDeployment>(`/deployments/${encodePath(ref)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    return this.mapDeployment(updated, accountId);
  }

  /**
   * `DELETE /v1/deployments/{owner}/{name}` (204) and
   * `DELETE /v1/files/{file_id}` (204) are the only destructive endpoints this
   * plugin exposes. Replicate refuses to delete a deployment that has not been
   * offline and unused for at least 15 minutes.
   */
  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    const externalId = externalIdOf(resourceId);
    if (!externalId) throw new Error(`Replicate plugin: cannot parse resource id "${resourceId}"`);
    if (typeId === "deployment") {
      await this.fetch<unknown>(`/deployments/${encodePath(externalId)}`, { method: "DELETE" });
      return;
    }
    if (typeId === "file") {
      await this.fetch<unknown>(`/files/${encodeURIComponent(externalId)}`, { method: "DELETE" });
      return;
    }
    throw new Error(`Replicate plugin: deleteResource not supported for type "${typeId}"`);
  }

  /**
   * `POST /v1/predictions/{id}/cancel` and `POST /v1/trainings/{id}/cancel`.
   * Both return the refreshed object; the host re-reads the resource after.
   */
  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    _accountId: string,
  ): Promise<void> {
    if (actionId !== "cancel") {
      throw new Error(`Replicate plugin: unknown action "${actionId}"`);
    }
    const externalId = externalIdOf(resourceId);
    if (typeId === "prediction") {
      await this.fetch<unknown>(`/predictions/${encodeURIComponent(externalId)}/cancel`, {
        method: "POST",
      });
      return;
    }
    if (typeId === "training") {
      await this.fetch<unknown>(`/trainings/${encodeURIComponent(externalId)}/cancel`, {
        method: "POST",
      });
      return;
    }
    throw new Error(`Replicate plugin: cancel not supported for type "${typeId}"`);
  }

  // -------------------------------------------------------------------------
  // Stats
  // -------------------------------------------------------------------------

  async fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    const resource = await this.getResource(resourceTypeId, resourceId, accountId).catch(
      (): ResourceInstance | null => null,
    );
    if (!resource) return [];
    const fields = resource.fields;
    const stats: DashboardStat[] = [];

    switch (resourceTypeId) {
      case "prediction":
      case "training": {
        const raw = String(fields["status"] ?? "");
        const mapped = mapRunStatus(raw);
        stats.push({
          label: "Status",
          value: mapped.label,
          variant:
            mapped.status === "healthy"
              ? "status-healthy"
              : mapped.status === "error"
                ? "status-error"
                : mapped.status === "degraded"
                  ? "status-degraded"
                  : "default",
        });
        if (fields["predictTime"] != null) {
          stats.push({
            label: resourceTypeId === "training" ? "Train Time" : "Predict Time",
            value: `${Number(fields["predictTime"]).toFixed(2)}s`,
          });
        }
        if (fields["totalTime"] != null) {
          stats.push({ label: "Total Time", value: `${Number(fields["totalTime"]).toFixed(2)}s` });
        }
        if (fields["model"]) stats.push({ label: "Model", value: String(fields["model"]) });
        break;
      }
      case "deployment": {
        if (fields["hardware"]) {
          stats.push({ label: "Hardware", value: String(fields["hardware"]) });
        }
        stats.push({
          label: "Instances",
          value: `${fields["minInstances"] ?? 0} – ${fields["maxInstances"] ?? 0}`,
          variant: Number(fields["minInstances"] ?? 0) > 0 ? "status-healthy" : "default",
        });
        if (fields["releaseNumber"] != null) {
          stats.push({ label: "Release", value: `#${fields["releaseNumber"]}` });
        }
        break;
      }
      case "model": {
        if (fields["runCount"] != null) {
          stats.push({ label: "Runs", value: formatNumber(Number(fields["runCount"])) });
        }
        if (fields["visibility"]) {
          stats.push({ label: "Visibility", value: titleCase(String(fields["visibility"])) });
        }
        break;
      }
      case "file": {
        if (fields["size"] != null) {
          stats.push({ label: "Size", value: formatBytes(Number(fields["size"])) });
        }
        if (fields["expiresAt"]) {
          stats.push({ label: "Expires", value: String(fields["expiresAt"]) });
        }
        break;
      }
      case "collection": {
        if (fields["modelCount"] != null) {
          stats.push({ label: "Models", value: String(fields["modelCount"]) });
        }
        break;
      }
      default:
        break;
    }
    return stats;
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    switch (resource.resourceTypeId) {
      case "prediction":
        return this.renderPredictionDetail(resource);
      case "training":
        return this.renderTrainingDetail(resource);
      case "deployment":
        return this.renderDeploymentDetail(resource);
      case "model":
        return this.renderModelDetail(resource);
      case "collection":
        return this.renderCollectionDetail(resource);
      case "file":
        return this.renderFileDetail(resource);
      case "hardware":
        return this.renderHardwareDetail(resource);
      default:
        return this.renderGenericDetail(resource);
    }
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    switch (resource.resourceTypeId) {
      case "prediction":
      case "training": {
        const mapped = mapRunStatus(String(resource.fields["status"] ?? ""));
        return {
          id: resource.id,
          label: resource.displayName,
          status: { kind: "status-dot", status: mapped.status, label: mapped.label },
        };
      }
      case "deployment": {
        const min = Number(resource.fields["minInstances"] ?? 0);
        const max = Number(resource.fields["maxInstances"] ?? 0);
        return {
          id: resource.id,
          label: resource.displayName,
          status: {
            kind: "status-dot",
            status: min > 0 ? "healthy" : "info",
            label: min > 0 ? `${min}–${max} warm` : `Scales to zero (max ${max})`,
          },
        };
      }
      case "model": {
        const visibility = String(resource.fields["visibility"] ?? "");
        return {
          id: resource.id,
          label: resource.displayName,
          status: {
            kind: "status-dot",
            status: "info",
            ...(visibility ? { label: titleCase(visibility) } : {}),
          },
        };
      }
      case "file": {
        const size = Number(resource.fields["size"] ?? 0);
        return {
          id: resource.id,
          label: resource.displayName,
          status: { kind: "status-dot", status: "info", label: formatBytes(size) },
        };
      }
      default:
        return {
          id: resource.id,
          label: resource.displayName,
          status: { kind: "status-dot", status: "info" },
        };
    }
  }

  private renderPredictionDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const mapped = mapRunStatus(String(fields["status"] ?? ""));
    const outputUrl = resource.resolvedOutputs["outputUrl"] ?? "";
    const dataRemoved = fields["dataRemoved"] === true;

    const sections: SectionNode[] = [
      {
        kind: "section",
        title: "Prediction",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Prediction ID", value: String(fields["predictionId"] ?? ""), copyable: true },
              { key: "Status", value: mapped.label },
              ...(fields["model"] ? [{ key: "Model", value: String(fields["model"]) }] : []),
              ...(fields["version"]
                ? [
                    {
                      key: "Version",
                      // Official models report `"hidden"` instead of a version id.
                      value:
                        String(fields["version"]) === "hidden"
                          ? "hidden (official model)"
                          : String(fields["version"]),
                      copyable: String(fields["version"]) !== "hidden",
                    },
                  ]
                : []),
              ...(fields["source"]
                ? [{ key: "Created Via", value: titleCase(String(fields["source"])) }]
                : []),
              ...(fields["deployment"]
                ? [{ key: "Deployment", value: String(fields["deployment"]) }]
                : []),
              ...(fields["deadline"]
                ? [{ key: "Deadline", value: String(fields["deadline"]) }]
                : []),
            ],
          },
        ],
      },
      {
        kind: "section",
        title: "Timing",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Created", value: String(fields["createdAt"] ?? "") },
              ...(fields["startedAt"]
                ? [{ key: "Started", value: String(fields["startedAt"]) }]
                : []),
              ...(fields["completedAt"]
                ? [{ key: "Completed", value: String(fields["completedAt"]) }]
                : []),
              ...(fields["predictTime"] != null
                ? [{ key: "Predict Time", value: `${Number(fields["predictTime"]).toFixed(2)}s` }]
                : []),
              ...(fields["totalTime"] != null
                ? [{ key: "Total Time", value: `${Number(fields["totalTime"]).toFixed(2)}s` }]
                : []),
            ],
          },
        ],
      },
    ];

    if (fields["error"]) {
      sections.push({
        kind: "section",
        title: "Error",
        children: [{ kind: "text", content: String(fields["error"]), variant: "mono" }],
      });
    }

    const outputChildren: SchemaNode[] = [];
    if (outputUrl) outputChildren.push({ kind: "link", label: "Open output file", url: outputUrl });
    outputChildren.push({
      kind: "text",
      // Two different windows, and both bite. Spell them out rather than
      // letting a user wonder why yesterday's link 404s.
      content: dataRemoved
        ? "Input, output and logs have already been removed. Replicate deletes them one hour after an API-created prediction completes; the record itself stays."
        : "Output files delivered on replicate.delivery expire one hour after an API-created prediction completes. Predictions made from the Replicate website keep their files indefinitely. Download anything you need to keep.",
      variant: "muted",
    });
    sections.push({ kind: "section", title: "Output", children: outputChildren });

    const cancellable = mapped.status === "provisioning";
    return {
      title: resource.displayName,
      subtitle: joinSubtitle("Prediction", fields["model"]),
      status: { kind: "status-dot", status: mapped.status, label: mapped.label },
      sections,
      headerActions: [
        ...(cancellable
          ? [
              {
                kind: "action" as const,
                label: "Cancel",
                variant: "danger" as const,
                action: {
                  type: "plugin-action" as const,
                  actionId: "cancel",
                  confirmMessage:
                    "Cancel this prediction? You are still billed for time already spent.",
                  successMessage: "Cancellation requested.",
                },
              },
            ]
          : []),
        ...(fields["webUrl"]
          ? [
              {
                kind: "action" as const,
                label: "Open on Replicate",
                action: { type: "open-url" as const, url: String(fields["webUrl"]) },
              },
            ]
          : []),
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
      ],
    };
  }

  private renderTrainingDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const mapped = mapRunStatus(String(fields["status"] ?? ""));
    const trainedVersion = resource.resolvedOutputs["destinationVersion"] ?? "";
    const sections: SectionNode[] = [
      {
        kind: "section",
        title: "Training",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Training ID", value: String(fields["trainingId"] ?? ""), copyable: true },
              { key: "Status", value: mapped.label },
              ...(fields["model"]
                ? [{ key: "Trainer Model", value: String(fields["model"]) }]
                : []),
              ...(fields["version"]
                ? [{ key: "Trainer Version", value: String(fields["version"]), copyable: true }]
                : []),
              ...(fields["destination"]
                ? [{ key: "Destination Model", value: String(fields["destination"]) }]
                : []),
              ...(trainedVersion
                ? [{ key: "Trained Version", value: trainedVersion, copyable: true }]
                : []),
            ],
          },
        ],
      },
      {
        kind: "section",
        title: "Timing",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Created", value: String(fields["createdAt"] ?? "") },
              ...(fields["startedAt"]
                ? [{ key: "Started", value: String(fields["startedAt"]) }]
                : []),
              ...(fields["completedAt"]
                ? [{ key: "Completed", value: String(fields["completedAt"]) }]
                : []),
              ...(fields["predictTime"] != null
                ? [{ key: "Train Time", value: `${Number(fields["predictTime"]).toFixed(2)}s` }]
                : []),
            ],
          },
        ],
      },
    ];

    if (fields["error"]) {
      sections.push({
        kind: "section",
        title: "Error",
        children: [{ kind: "text", content: String(fields["error"]), variant: "mono" }],
      });
    }

    return {
      title: resource.displayName,
      subtitle: "Training",
      status: { kind: "status-dot", status: mapped.status, label: mapped.label },
      sections,
      headerActions: [
        ...(mapped.status === "provisioning"
          ? [
              {
                kind: "action" as const,
                label: "Cancel",
                variant: "danger" as const,
                action: {
                  type: "plugin-action" as const,
                  actionId: "cancel",
                  confirmMessage:
                    "Cancel this training run? Progress is lost and you are billed for time already spent.",
                  successMessage: "Cancellation requested.",
                },
              },
            ]
          : []),
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
      ],
    };
  }

  private renderDeploymentDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const min = Number(fields["minInstances"] ?? 0);
    const max = Number(fields["maxInstances"] ?? 0);
    const ref = resource.resolvedOutputs["deploymentRef"] ?? resource.displayName;

    return {
      title: resource.displayName,
      subtitle: joinSubtitle("Deployment", fields["model"]),
      status: {
        kind: "status-dot",
        status: min > 0 ? "healthy" : "info",
        label: min > 0 ? `${min}–${max} instances` : `Scales to zero (max ${max})`,
      },
      sections: [
        {
          kind: "section",
          title: "Current Release",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Reference", value: ref, copyable: true },
                ...(fields["releaseNumber"] != null
                  ? [{ key: "Release", value: `#${fields["releaseNumber"]}` }]
                  : []),
                ...(fields["model"] ? [{ key: "Model", value: String(fields["model"]) }] : []),
                ...(fields["version"]
                  ? [{ key: "Version", value: String(fields["version"]), copyable: true }]
                  : []),
                ...(fields["hardware"]
                  ? [{ key: "Hardware", value: String(fields["hardware"]) }]
                  : []),
                { key: "Min Instances", value: String(min) },
                { key: "Max Instances", value: String(max) },
                ...(fields["createdBy"]
                  ? [{ key: "Created By", value: String(fields["createdBy"]) }]
                  : []),
                ...(fields["createdAt"]
                  ? [{ key: "Created", value: String(fields["createdAt"]) }]
                  : []),
              ],
            },
          ],
        },
        {
          kind: "section",
          title: "Calling this deployment",
          children: [
            {
              kind: "text",
              content: `POST ${API_BASE}/deployments/${ref}/predictions`,
              variant: "mono",
              copyable: true,
            },
            {
              kind: "text",
              content:
                "Add `Prefer: wait` (or `Prefer: wait=N`, where N is 1–60 seconds) to block until the prediction finishes instead of polling.",
              variant: "muted",
            },
          ],
        },
        {
          kind: "section",
          title: "Cost",
          children: [
            {
              kind: "text",
              // Stated plainly rather than shown as an empty chart.
              content:
                "Replicate exposes no billing, usage or spend API — `GET /v1/account` returns identity only. Instance-seconds for this deployment are visible in the Replicate dashboard, not here.",
              variant: "muted",
            },
            {
              kind: "link",
              label: "Open Replicate billing",
              url: "https://replicate.com/account/billing",
            },
          ],
        },
      ],
      headerActions: [
        {
          kind: "action",
          label: "Open on Replicate",
          action: { type: "open-url", url: `https://replicate.com/deployments/${ref}` },
        },
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
      ],
    };
  }

  private renderModelDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const links: SchemaNode[] = [];
    for (const [label, key] of [
      ["Open on Replicate", "modelUrl"],
      ["Source code", "githubUrl"],
      ["Paper", "paperUrl"],
      ["License", "licenseUrl"],
    ] as const) {
      if (fields[key]) links.push({ kind: "link", label, url: String(fields[key]) });
    }

    const sections: SectionNode[] = [
      {
        kind: "section",
        title: "Model",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Reference", value: resource.displayName, copyable: true },
              ...(fields["description"]
                ? [{ key: "Description", value: String(fields["description"]) }]
                : []),
              ...(fields["visibility"]
                ? [{ key: "Visibility", value: titleCase(String(fields["visibility"])) }]
                : []),
              ...(fields["isOfficial"] != null
                ? [{ key: "Official Model", value: fields["isOfficial"] ? "Yes" : "No" }]
                : []),
              ...(fields["runCount"] != null
                ? [{ key: "Runs", value: formatNumber(Number(fields["runCount"])) }]
                : []),
              ...(fields["latestVersion"]
                ? [
                    {
                      key: "Latest Version",
                      value: String(fields["latestVersion"]),
                      copyable: true,
                    },
                  ]
                : []),
              ...(fields["cogVersion"]
                ? [{ key: "Cog Version", value: String(fields["cogVersion"]) }]
                : []),
            ],
          },
        ],
      },
    ];
    if (links.length) sections.push({ kind: "section", title: "Links", children: links });

    return {
      title: resource.displayName,
      subtitle: "Model",
      status: { kind: "status-dot", status: "info", label: "Available" },
      sections,
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  private renderCollectionDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const models = String(fields["models"] ?? "")
      .split(", ")
      .filter(Boolean);
    const sections: SectionNode[] = [
      {
        kind: "section",
        title: "Collection",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Slug", value: String(fields["slug"] ?? ""), copyable: true },
              ...(fields["description"]
                ? [{ key: "Description", value: String(fields["description"]) }]
                : []),
              ...(fields["modelCount"] != null
                ? [{ key: "Models", value: String(fields["modelCount"]) }]
                : []),
            ],
          },
        ],
      },
    ];
    if (models.length) {
      sections.push({
        kind: "section",
        title: "Models",
        children: [{ kind: "text", content: models.join("\n"), variant: "mono", copyable: true }],
      });
    }
    return {
      title: resource.displayName,
      subtitle: "Model collection",
      status: { kind: "status-dot", status: "info" },
      sections,
      headerActions: [
        {
          kind: "action",
          label: "Open on Replicate",
          action: {
            type: "open-url",
            url: `https://replicate.com/collections/${String(fields["slug"] ?? "")}`,
          },
        },
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
      ],
    };
  }

  private renderFileDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const size = Number(fields["size"] ?? 0);
    const fileUrl = resource.resolvedOutputs["fileUrl"] ?? "";
    const children: SchemaNode[] = [
      {
        kind: "key-value-list",
        items: [
          { key: "File ID", value: String(fields["fileId"] ?? ""), copyable: true },
          ...(fields["name"] ? [{ key: "Name", value: String(fields["name"]) }] : []),
          ...(fields["contentType"]
            ? [{ key: "Content Type", value: String(fields["contentType"]) }]
            : []),
          { key: "Size", value: formatBytes(size) },
          ...(fields["sha256"]
            ? [{ key: "SHA-256", value: String(fields["sha256"]), copyable: true }]
            : []),
          ...(fields["createdAt"] ? [{ key: "Created", value: String(fields["createdAt"]) }] : []),
          ...(fields["expiresAt"] ? [{ key: "Expires", value: String(fields["expiresAt"]) }] : []),
        ],
      },
      {
        kind: "text",
        // Different window from prediction outputs — worth saying so.
        content:
          "Uploaded input files expire on their own schedule, separate from the one-hour window on prediction output files. Trust the Expires timestamp above rather than a fixed rule of thumb.",
        variant: "muted",
      },
    ];
    if (fileUrl) children.push({ kind: "link", label: "Download", url: fileUrl });

    return {
      title: resource.displayName,
      subtitle: "Uploaded file",
      status: { kind: "status-dot", status: "info", label: formatBytes(size) },
      sections: [{ kind: "section", title: "File", children }],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  private renderHardwareDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    return {
      title: resource.displayName,
      subtitle: "Hardware SKU",
      status: { kind: "status-dot", status: "info" },
      sections: [
        {
          kind: "section",
          title: "Hardware",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Name", value: String(fields["name"] ?? resource.displayName) },
                { key: "SKU", value: String(fields["sku"] ?? ""), copyable: true },
              ],
            },
            {
              kind: "text",
              content:
                "Pass the SKU as `hardware` when creating a deployment. Per-second pricing for each SKU is published on the Replicate pricing page — there is no pricing API.",
              variant: "muted",
            },
          ],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  private renderGenericDetail(resource: ResourceInstance): DetailViewSchema {
    return {
      title: resource.displayName,
      subtitle: resource.resourceTypeId,
      status: { kind: "status-dot", status: "info" },
      sections: [
        {
          kind: "section",
          title: "Details",
          children: [
            {
              kind: "key-value-list",
              items: Object.entries(resource.fields).map(([key, value]) => ({
                key,
                value: String(value),
              })),
            },
          ],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }
}

/** Encode an `owner/name` pair without escaping the separating slash. */
function encodePath(ref: string): string {
  return ref
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function clampInt(raw: string | undefined, min: number, max: number, fallback: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}
