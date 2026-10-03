import type {
  PluginClient,
  ResourceInstance,
  DetailViewSchema,
  SidebarItemSchema,
  CreateResourceConfig,
  SectionNode,
  DashboardStat,
  HostServices,
  MetricSeries,
  QuotaUsage,
} from "@infrawrench/plugin-base";
import {
  formatBytes,
  joinSubtitle,
  jsonRestFetch,
  normalizeQuotaUsage,
  withMetricsCapability,
} from "@infrawrench/plugin-base";
import { TRIGGER_AUTH_SCHEMES, TRIGGER_EVENT_TYPES } from "./resources/trigger.js";
import { MediaAssetResourceType } from "./resources/media-asset.js";
import { ProductEnvironmentResourceType } from "./resources/product-environment.js";

/** Minimal shapes for the Cloudinary API responses we use. */

interface CloudinaryResource {
  asset_id: string;
  public_id: string;
  format: string;
  version: number;
  resource_type: string;
  type: string;
  created_at: string;
  bytes: number;
  width?: number;
  height?: number;
  url: string;
  secure_url: string;
  display_name?: string;
  asset_folder?: string;
  tags?: string[];
  access_mode?: string;
}

interface CloudinaryResourceList {
  resources: CloudinaryResource[];
  next_cursor?: string;
}

interface CloudinaryFolder {
  name: string;
  path: string;
  external_id?: string;
}

interface CloudinaryUploadPreset {
  name: string;
  unsigned: boolean;
  settings: Record<string, unknown>;
  external_id?: string;
}

interface CloudinaryTransformation {
  name: string;
  named: boolean;
  used: boolean;
  allowed_for_strict?: boolean;
  derived?: Array<Record<string, unknown>>;
}

interface CloudinaryTransformationList {
  transformations: CloudinaryTransformation[];
  next_cursor?: string;
}

interface CloudinaryUploadPresetList {
  upload_presets?: CloudinaryUploadPreset[];
  presets?: CloudinaryUploadPreset[];
  next_cursor?: string;
}

/** `GET /triggers`. https://cloudinary.com/documentation/admin_api#triggers */
interface CloudinaryTrigger {
  id: string;
  uri?: string;
  uri_type?: string;
  event_type?: string;
  additive?: boolean;
  auth_scheme?: string;
  filter?: unknown;
  filter_language?: string;
  payload_template?: unknown;
  created_at?: string;
  updated_at?: string;
}

/** `GET /upload_mappings`. https://cloudinary.com/documentation/admin_api#upload_mappings */
interface CloudinaryUploadMapping {
  folder: string;
  template?: string;
  external_id?: string;
}

/** A used/limit pair in `GET /usage`; `limit` is absent on credit-based plans. */
interface UsageEntry {
  usage?: number;
  limit?: number;
  used_percent?: number;
  credits_usage?: number;
}

/**
 * `GET /usage`. Without a `date` the `credits` block also carries the plan's
 * monthly `limit` and `used_percent`. Add-on allowances (`cloudinary_ai`,
 * `google_tagging`, ...) appear as further `{usage, limit}` objects whose keys
 * depend on what the environment has enabled.
 * https://cloudinary.com/documentation/admin_api#usage
 */
interface CloudinaryUsage {
  plan?: string;
  last_updated?: string;
  credits?: UsageEntry;
  transformations?: UsageEntry;
  objects?: UsageEntry;
  bandwidth?: UsageEntry;
  storage?: UsageEntry;
  impressions?: UsageEntry;
  seconds_delivered?: UsageEntry;
  requests?: number;
  resources?: number;
  derived_resources?: number;
  media_limits?: Record<string, number>;
  rate_limit_allowed?: number;
  rate_limit_remaining?: number;
  rate_limit_reset_at?: string;
  [key: string]: unknown;
}

/** `GET /config?settings=true`: the folder mode lives under `settings`. */
interface CloudinaryConfig {
  cloud_name?: string;
  created_at?: string;
  settings?: { folder_mode?: string };
}

/** Top-level `GET /usage` keys that are not add-on allowances. */
const CORE_USAGE_KEYS = new Set([
  "plan",
  "last_updated",
  "date_requested",
  "credits",
  "transformations",
  "objects",
  "bandwidth",
  "storage",
  "impressions",
  "seconds_delivered",
  "requests",
  "resources",
  "derived_resources",
  "media_limits",
]);

const GIB = 1024 * 1024 * 1024;

/** The two types with a Metrics tab, for `withMetricsCapability`. */
const METRIC_RESOURCE_TYPES = [MediaAssetResourceType, ProductEnvironmentResourceType];

/**
 * Product environment usage history: one `GET /usage?date=yyyy-mm-dd` per day,
 * which Cloudinary answers for dates up to three months back. Longer ranges
 * are sampled down to {@link USAGE_MAX_DAYS} evenly spaced days so a 90-day
 * chart costs 30 Admin API calls rather than 90.
 * https://cloudinary.com/documentation/admin_api#usage
 */
const USAGE_METRICS_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const USAGE_HISTORY_DAYS = 90;
const USAGE_MAX_DAYS = 30;
const USAGE_CONCURRENCY = 5;

/**
 * Video views from the Video Analytics API, which records views played through
 * the Cloudinary Video Player (1.9.9+) or the `cloudinary-video-analytics`
 * library. Results come back newest first, up to 500 a page.
 * https://cloudinary.com/documentation/video_analytics
 */
const VIEWS_METRICS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const VIEWS_PAGE_SIZE = 500;
const VIEWS_MAX_PAGES = 10;
const VIEWS_BUCKETS = 48;
const DAY_MS = 24 * 60 * 60 * 1000;

/** `GET /video/analytics/views`. */
interface CloudinaryVideoViews {
  next_cursor?: string | null;
  data?: Array<{
    video_public_id?: string;
    video_duration?: number;
    view_watch_time?: number;
    /** ISO 8601 in responses; the `expression` filter takes Unix seconds. */
    view_ended_at?: string | number;
  }>;
}

function titleCase(value: string): string {
  return value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** JSON objects (filters, payload templates) round-trip through string fields. */
function stringifyJson(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object" && Object.keys(value as object).length === 0) return "";
  return JSON.stringify(value);
}

function parseJsonObject(raw: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Cloudinary plugin: ${label} must be valid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Cloudinary plugin: ${label} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/** A form's yes/no `select` or a boolean edit field, both submitted as strings. */
function parseBool(raw: string | undefined): boolean | undefined {
  if (raw === undefined || raw === "") return undefined;
  return raw === "true" || raw === "yes" || raw === "1";
}

/**
 * A preset's `transformation` comes back either as a string: a named
 * reference (`"t_thumb"`) or a raw spec (`"w_100,c_fill"`), or as a
 * structured array/object. Strings are kept verbatim; only the structured
 * forms are serialized.
 *
 * Stringifying unconditionally is what broke `attachResource`: it stored
 * `"\"t_thumb\""` (quotes included) and then compared it against `t_thumb`, so
 * the "already attached" check never held and every attach re-issued the PUT.
 */
function formatTransformationSetting(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * Cloudinary plugin client.
 * Created per account (per API key + secret + cloud name).
 * All API calls use Basic Auth (API key:API secret) over HTTPS.
 */
export class CloudinaryClient implements PluginClient {
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly cloudName: string;
  private readonly caCert: string;
  private readonly services: HostServices | undefined;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const cloudName = credentials["cloudName"];
    const apiKey = credentials["apiKey"];
    const apiSecret = credentials["apiSecret"];
    if (!cloudName) throw new Error("Cloudinary plugin: missing cloudName credential");
    if (!apiKey) throw new Error("Cloudinary plugin: missing apiKey credential");
    if (!apiSecret) throw new Error("Cloudinary plugin: missing apiSecret credential");
    this.cloudName = cloudName;
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.caCert = credentials["caCert"] ?? "";
    this.services = services;
  }

  private get baseUrl(): string {
    return `https://api.cloudinary.com/v1_1/${this.cloudName}`;
  }

  private get authHeader(): string {
    return `Basic ${btoa(`${this.apiKey}:${this.apiSecret}`)}`;
  }

  private async fetch<T>(path: string, options?: RequestInit): Promise<T> {
    return jsonRestFetch<T>({
      vendor: "Cloudinary",
      url: `${this.baseUrl}${path}`,
      errorPath: path,
      headers: { Authorization: this.authHeader },
      ...(options ? { init: options } : {}),
      ...(this.caCert && this.services?.http
        ? { caCert: this.caCert, http: this.services.http }
        : {}),
    });
  }

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "folder":
        return this.listFolders(accountId);
      case "media-asset":
        return this.listMediaAssets(accountId);
      case "upload-preset":
        return this.listUploadPresets(accountId);
      case "transformation":
        return this.listTransformations(accountId);
      case "upload-mapping":
        return this.listUploadMappings(accountId);
      case "trigger":
        return this.listTriggers(accountId);
      case "product-environment":
        return [await this.loadProductEnvironment(accountId)];
      default:
        throw new Error(`Cloudinary plugin: unknown resource type "${typeId}"`);
    }
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    if (typeId === "media-asset") {
      // resourceId format: "{accountId}:media-asset:{resource_type}/{type}/{public_id}"
      const assetPath = resourceId.split(":").slice(2).join(":");
      if (!assetPath) throw new Error("Cannot parse asset path");
      const data = await this.fetch<CloudinaryResource>(`/resources/${assetPath}`);
      return this.mapMediaAsset(data, accountId);
    }
    // For other types, fall back to listing
    const all = await this.listResources(typeId, accountId);
    const found = all.find((r) => r.id === resourceId);
    if (!found) throw new Error(`Cloudinary plugin: resource ${typeId}/${resourceId} not found`);
    return found;
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    if (typeId === "media-asset") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      if (outputKey === "secureUrl") return resource.resolvedOutputs["secureUrl"] ?? "";
      if (outputKey === "url") return resource.resolvedOutputs["url"] ?? "";
      if (outputKey === "publicId") return String(resource.fields["publicId"] ?? "");
    }

    if (typeId === "folder") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      if (outputKey === "path") return String(resource.fields["path"] ?? "");
      if (outputKey === "name") return String(resource.fields["name"] ?? "");
    }

    if (typeId === "upload-preset") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      if (outputKey === "presetName") return String(resource.fields["name"] ?? "");
      if (outputKey === "mode") {
        return String(resource.fields["mode"] ?? "signed");
      }
    }

    if (typeId === "transformation") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      if (outputKey === "transformationName") return String(resource.fields["name"] ?? "");
    }

    if (typeId === "trigger" || typeId === "upload-mapping" || typeId === "product-environment") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const value = resource.resolvedOutputs[outputKey];
      if (value !== undefined) return value;
    }

    throw new Error(`Cloudinary plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
  }

  async getCreateConfig(typeId: string): Promise<CreateResourceConfig> {
    if (typeId === "folder") {
      return {
        fields: [
          {
            key: "path",
            label: "Folder Path",
            kind: "text",
            required: true,
            description: 'Full path for the new folder, e.g. "marketing/banners"',
          },
        ],
      };
    }
    if (typeId === "upload-preset") {
      // Named transformations become `t_<name>` options so the user never
      // types the prefix convention by hand.
      const transformations = await this.listTransformations("").catch(
        (): ResourceInstance[] => [],
      );
      const transformationOptions = transformations.map((t) => {
        const name = String(t.fields["name"] ?? t.displayName);
        const ref = name.startsWith("t_") ? name : `t_${name}`;
        return { id: ref, label: name };
      });
      return {
        fields: [
          { key: "name", label: "Preset Name", kind: "text", required: true },
          {
            key: "mode",
            label: "Mode",
            kind: "select",
            required: true,
            options: [
              { id: "signed", label: "Signed" },
              { id: "unsigned", label: "Unsigned" },
            ],
            defaultValue: "signed",
          },
          {
            key: "folder",
            label: "Target Folder",
            kind: "resource-picker",
            required: false,
            description: "Folder uploads made with this preset are stored in.",
            associationSources: [
              { pluginId: "cloudinary", resourceTypeId: "folder", outputKey: "path" },
            ],
          },
          {
            key: "tags",
            label: "Tags",
            kind: "string-list",
            required: false,
            placeholder: "tag",
            addLabel: "+ Add tag",
          },
          {
            key: "allowed_formats",
            label: "Allowed Formats",
            kind: "string-list",
            required: false,
            description: "File extensions this preset accepts. Leave empty to accept any format.",
            placeholder: "jpg",
            addLabel: "+ Add format",
          },
          ...(transformationOptions.length
            ? [
                {
                  key: "transformation",
                  label: "Incoming Transformation",
                  kind: "select" as const,
                  required: false,
                  description: "Named transformation applied to every upload before it is stored.",
                  options: [{ id: "", label: "None" }, ...transformationOptions],
                  defaultValue: "",
                },
              ]
            : []),
          {
            key: "disallow_public_id",
            label: "Disallow Public ID",
            kind: "select",
            required: false,
            description:
              "Ignore any public ID passed in the upload call. Recommended for unsigned presets.",
            options: [
              { id: "false", label: "No" },
              { id: "true", label: "Yes" },
            ],
            defaultValue: "false",
          },
        ],
      };
    }
    if (typeId === "trigger") {
      return {
        fields: [
          {
            key: "uri",
            label: "Notification URL",
            kind: "text",
            required: true,
            description: "HTTPS endpoint Cloudinary POSTs the notification to.",
            placeholder: "https://example.com/cloudinary-webhook",
          },
          {
            key: "event_type",
            label: "Event Type",
            kind: "select",
            required: true,
            options: TRIGGER_EVENT_TYPES.map((event) => ({
              id: event,
              label: event === "all" ? "All events" : titleCase(event),
            })),
            defaultValue: "upload",
          },
          {
            key: "additive",
            label: "Additive",
            kind: "select",
            required: false,
            description:
              "Also fire when an upload call or preset sets its own notification_url for this event.",
            options: [
              { id: "false", label: "No" },
              { id: "true", label: "Yes" },
            ],
            defaultValue: "false",
          },
          {
            key: "auth_scheme",
            label: "Signature Scheme",
            kind: "select",
            required: false,
            description: "Which webhook signature headers are sent.",
            options: TRIGGER_AUTH_SCHEMES.map((scheme) => ({
              id: scheme,
              label:
                scheme === "eddsa_v2"
                  ? "EdDSA (v2)"
                  : scheme === "legacy_hmac"
                    ? "Legacy HMAC"
                    : "Default",
            })),
            defaultValue: "default",
          },
          {
            key: "filter",
            label: "Filter (JSONLogic)",
            kind: "code",
            codeLanguage: "json",
            required: false,
            description:
              'Only notify when this JSONLogic rule is true, e.g. {"==": [{"var": "resource_type"}, "image"]}. Supports startsWith, endsWith, contains and matches.',
          },
          {
            key: "payload_template",
            label: "Payload Template",
            kind: "code",
            codeLanguage: "json",
            required: false,
            description:
              'Custom JSON body with Mustache placeholders, e.g. {"id": "{{asset.public_id}}"}. Leave empty for the default body.',
          },
        ],
      };
    }
    if (typeId === "upload-mapping") {
      return {
        fields: [
          {
            key: "folder",
            label: "Folder",
            kind: "text",
            required: true,
            description:
              "Name used in delivery URLs. Requesting <folder>/<path> fetches <prefix><path> and stores it.",
            placeholder: "remote",
          },
          {
            key: "template",
            label: "Remote URL Prefix",
            kind: "text",
            required: true,
            placeholder: "https://images.example.com/assets/",
          },
        ],
      };
    }
    if (typeId === "transformation") {
      return {
        fields: [
          {
            key: "name",
            label: "Transformation Name",
            kind: "text",
            required: true,
            description: "Name for this named transformation (e.g. my_thumbnail)",
          },
          {
            key: "transformation",
            label: "Transformation String",
            kind: "text",
            required: true,
            description: "Transformation parameters (e.g. w_200,h_200,c_fill)",
          },
        ],
      };
    }
    throw new Error(`No create config for type "${typeId}"`);
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    if (typeId === "folder") {
      const folderPath = fields["path"];
      if (!folderPath) throw new Error("Folder path is required");
      await this.fetch<{ success: boolean }>(`/folders/${encodeURIComponent(folderPath)}`, {
        method: "POST",
      });
      const name = folderPath.split("/").pop() ?? folderPath;
      return {
        id: `${accountId}:folder:${folderPath}`,
        pluginId: "cloudinary",
        resourceTypeId: "folder",
        accountId,
        displayName: name,
        fields: { name, path: folderPath },
        resolvedOutputs: { path: folderPath, name },
        secretStates: [],
        externalId: folderPath,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }
    if (typeId === "upload-preset") {
      const presetName = fields["name"] ?? "";
      const body: Record<string, unknown> = {
        name: presetName,
        unsigned: fields["mode"] === "unsigned",
      };
      if (fields["folder"]) body["folder"] = fields["folder"];
      if (fields["tags"]) body["tags"] = fields["tags"];
      if (fields["allowed_formats"]) body["allowed_formats"] = fields["allowed_formats"];
      if (fields["transformation"]) body["transformation"] = fields["transformation"];
      if (parseBool(fields["disallow_public_id"])) body["disallow_public_id"] = true;
      await this.fetch<Record<string, unknown>>("/upload_presets", {
        method: "POST",
        body: JSON.stringify(body),
      });
      const mode = fields["mode"] ?? "signed";
      const now = new Date().toISOString();
      return {
        id: `${accountId}:upload-preset:${presetName}`,
        pluginId: "cloudinary",
        resourceTypeId: "upload-preset",
        accountId,
        displayName: presetName,
        fields: {
          name: presetName,
          mode,
          ...(fields["folder"] ? { folder: fields["folder"] } : {}),
          ...(fields["tags"] ? { tags: fields["tags"] } : {}),
          ...(fields["allowed_formats"] ? { allowedFormats: fields["allowed_formats"] } : {}),
          ...(fields["transformation"] ? { transformation: fields["transformation"] } : {}),
        },
        resolvedOutputs: { presetName, mode },
        secretStates: [],
        externalId: presetName,
        createdAt: now,
        updatedAt: now,
      };
    }
    if (typeId === "transformation") {
      const name = fields["name"] ?? "";
      const transformation = fields["transformation"] ?? "";
      await this.fetch<Record<string, unknown>>(`/transformations/${encodeURIComponent(name)}`, {
        method: "POST",
        body: JSON.stringify({ transformation }),
      });
      const now = new Date().toISOString();
      return {
        id: `${accountId}:transformation:${name}`,
        pluginId: "cloudinary",
        resourceTypeId: "transformation",
        accountId,
        displayName: name,
        fields: { name, named: true, used: false, usageCount: 0 },
        resolvedOutputs: { transformationName: name },
        secretStates: [],
        externalId: name,
        createdAt: now,
        updatedAt: now,
      };
    }
    if (typeId === "trigger") {
      const body: Record<string, unknown> = {
        uri: (fields["uri"] ?? "").trim(),
        event_type: fields["event_type"] || "upload",
      };
      if (!body["uri"]) throw new Error("Cloudinary plugin: a notification URL is required");
      const additive = parseBool(fields["additive"]);
      if (additive !== undefined) body["additive"] = additive;
      if (fields["auth_scheme"]) body["auth_scheme"] = fields["auth_scheme"];
      if (fields["filter"]?.trim()) {
        body["filter"] = parseJsonObject(fields["filter"], "filter");
      }
      if (fields["payload_template"]?.trim()) {
        body["payload_template"] = parseJsonObject(fields["payload_template"], "payload template");
      }
      const created = await this.fetch<CloudinaryTrigger>("/triggers", {
        method: "POST",
        body: JSON.stringify(body),
      });
      return this.mapTrigger(created, accountId);
    }
    if (typeId === "upload-mapping") {
      const folder = (fields["folder"] ?? "").trim();
      const template = (fields["template"] ?? "").trim();
      if (!folder || !template) {
        throw new Error("Cloudinary plugin: an upload mapping needs a folder and a URL prefix");
      }
      const created = await this.fetch<{ external_id?: string }>("/upload_mappings", {
        method: "POST",
        body: JSON.stringify({ folder, template }),
      });
      return this.mapUploadMapping(
        { folder, template, ...(created?.external_id ? { external_id: created.external_id } : {}) },
        accountId,
      );
    }
    throw new Error(`Cloudinary plugin: createResource not supported for type "${typeId}"`);
  }

  /**
   * Edits, one Admin API endpoint per type:
   * - folder: `PUT /folders/:folder?to_folder=` renames or moves it (dynamic
   *   folder mode only).
   * - media-asset: `PUT /resources/:asset_id` sets display name, asset folder
   *   and tags.
   * - upload-preset: `PUT /upload_presets/:name`.
   * - transformation: `PUT /transformations/:transformation`; a new definition
   *   goes in `unsafe_update`.
   * - trigger: `PUT /triggers/:id` (`new_uri`, not `uri`).
   * - upload-mapping: `PUT /upload_mappings` with folder + template.
   * https://cloudinary.com/documentation/admin_api
   */
  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const key = resourceId.split(":").slice(2).join(":");
    if (!key) throw new Error(`Cloudinary plugin: cannot parse resource id "${resourceId}"`);
    switch (typeId) {
      case "folder": {
        const toFolder = (fields["path"] ?? "").trim().replace(/^\/+|\/+$/g, "");
        if (!toFolder || toFolder === key) return this.getResource(typeId, resourceId, accountId);
        const result = await this.fetch<{ to?: { name?: string; path?: string } }>(
          `/folders/${encodeURIComponent(key)}?to_folder=${encodeURIComponent(toFolder)}`,
          { method: "PUT" },
        );
        const path = result?.to?.path ?? toFolder;
        const name = result?.to?.name ?? path.split("/").pop() ?? path;
        const now = new Date().toISOString();
        return {
          id: `${accountId}:folder:${path}`,
          pluginId: "cloudinary",
          resourceTypeId: "folder",
          accountId,
          displayName: name,
          fields: { name, path },
          resolvedOutputs: { path, name },
          secretStates: [],
          externalId: path,
          createdAt: now,
          updatedAt: now,
        };
      }
      case "media-asset": {
        const current = await this.getResource(typeId, resourceId, accountId);
        const assetId = current.externalId ?? "";
        if (!assetId) throw new Error("Cloudinary plugin: asset has no asset_id to update");
        const body: Record<string, string> = {};
        if (fields["displayName"] !== undefined)
          body["display_name"] = fields["displayName"].trim();
        if (fields["folder"] !== undefined) body["asset_folder"] = fields["folder"].trim();
        if (fields["tags"] !== undefined) {
          body["tags"] = fields["tags"]
            .split(",")
            .map((tag) => tag.trim())
            .filter(Boolean)
            .join(",");
        }
        if (Object.keys(body).length === 0) return current;
        const updated = await this.fetch<CloudinaryResource>(
          `/resources/${encodeURIComponent(assetId)}`,
          { method: "PUT", body: JSON.stringify(body) },
        );
        return this.mapMediaAsset(updated, accountId);
      }
      case "upload-preset": {
        const body: Record<string, unknown> = {};
        if (fields["mode"] !== undefined) body["unsigned"] = fields["mode"] === "unsigned";
        if (fields["folder"] !== undefined) body["folder"] = fields["folder"].trim();
        if (fields["tags"] !== undefined) body["tags"] = fields["tags"].trim();
        if (fields["allowedFormats"] !== undefined) {
          body["allowed_formats"] = fields["allowedFormats"].replace(/\s+/g, "");
        }
        if (fields["transformation"] !== undefined) {
          body["transformation"] = fields["transformation"].trim();
        }
        const disallow = parseBool(fields["disallowPublicId"]);
        if (disallow !== undefined) body["disallow_public_id"] = disallow;
        if (Object.keys(body).length) {
          await this.fetch<unknown>(`/upload_presets/${encodeURIComponent(key)}`, {
            method: "PUT",
            body: JSON.stringify(body),
          });
        }
        return this.getResource(typeId, resourceId, accountId);
      }
      case "transformation": {
        const body: Record<string, unknown> = {};
        const strict = parseBool(fields["allowedForStrict"]);
        if (strict !== undefined) body["allowed_for_strict"] = strict;
        if (fields["definition"]?.trim()) body["unsafe_update"] = fields["definition"].trim();
        if (Object.keys(body).length) {
          await this.fetch<unknown>(`/transformations/${encodeURIComponent(key)}`, {
            method: "PUT",
            body: JSON.stringify(body),
          });
        }
        return this.getResource(typeId, resourceId, accountId);
      }
      case "trigger": {
        const body: Record<string, unknown> = {};
        if (fields["uri"]?.trim()) body["new_uri"] = fields["uri"].trim();
        const additive = parseBool(fields["additive"]);
        if (additive !== undefined) body["additive"] = additive;
        if (fields["authScheme"]) body["auth_scheme"] = fields["authScheme"];
        if (fields["filter"] !== undefined) {
          // An empty filter object means "no filter", which is how one is cleared.
          body["filter"] = fields["filter"].trim()
            ? parseJsonObject(fields["filter"], "filter")
            : {};
        }
        if (fields["payloadTemplate"]?.trim()) {
          body["payload_template"] = parseJsonObject(fields["payloadTemplate"], "payload template");
        }
        if (Object.keys(body).length) {
          await this.fetch<unknown>(`/triggers/${encodeURIComponent(key)}`, {
            method: "PUT",
            body: JSON.stringify(body),
          });
        }
        return this.getResource(typeId, resourceId, accountId);
      }
      case "upload-mapping": {
        const template = (fields["template"] ?? "").trim();
        if (template) {
          await this.fetch<unknown>("/upload_mappings", {
            method: "PUT",
            body: JSON.stringify({ folder: key, template }),
          });
        }
        return this.getResource(typeId, resourceId, accountId);
      }
      default:
        throw new Error(`Cloudinary plugin: updateResource not supported for type "${typeId}"`);
    }
  }

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    if (typeId === "media-asset") {
      // resourceId format: "{accountId}:media-asset:{resource_type}/{type}/{public_id}"
      const assetPath = resourceId.split(":").slice(2).join(":");
      if (!assetPath) throw new Error("Cannot parse asset path");
      const parts = assetPath.split("/");
      const resourceType = parts[0];
      const uploadType = parts[1];
      const publicId = parts.slice(2).join("/");
      if (!resourceType || !uploadType || !publicId)
        throw new Error("Cannot parse asset path components");
      await this.fetch<unknown>(`/resources/${resourceType}/${uploadType}`, {
        method: "DELETE",
        body: JSON.stringify({ public_ids: [publicId] }),
      });
      return;
    }
    if (typeId === "folder") {
      const path = resourceId.split(":").slice(2).join(":");
      if (!path) throw new Error("Cannot parse folder path");
      await this.fetch<unknown>(`/folders/${encodeURIComponent(path)}`, { method: "DELETE" });
      return;
    }
    if (typeId === "upload-preset") {
      const name = resourceId.split(":").slice(2).join(":");
      if (!name) throw new Error("Cannot parse upload preset name");
      await this.fetch<unknown>(`/upload_presets/${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
      return;
    }
    if (typeId === "transformation") {
      const name = resourceId.split(":").slice(2).join(":");
      if (!name) throw new Error("Cannot parse transformation name");
      await this.fetch<unknown>(`/transformations/${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
      return;
    }
    if (typeId === "trigger") {
      const id = resourceId.split(":").slice(2).join(":");
      if (!id) throw new Error("Cannot parse trigger id");
      await this.fetch<unknown>(`/triggers/${encodeURIComponent(id)}`, { method: "DELETE" });
      return;
    }
    if (typeId === "upload-mapping") {
      const folder = resourceId.split(":").slice(2).join(":");
      if (!folder) throw new Error("Cannot parse upload mapping folder");
      await this.fetch<unknown>(`/upload_mappings?folder=${encodeURIComponent(folder)}`, {
        method: "DELETE",
      });
      return;
    }
    throw new Error(`Cloudinary plugin: deleteResource not supported for type "${typeId}"`);
  }

  async attachResource(
    sourceTypeId: string,
    sourceResourceId: string,
    targetTypeId: string,
    targetResourceId: string,
    accountId: string,
  ): Promise<void> {
    if (sourceTypeId === "transformation" && targetTypeId === "upload-preset") {
      const [transformation, preset] = await Promise.all([
        this.getResource(sourceTypeId, sourceResourceId, accountId),
        this.getResource(targetTypeId, targetResourceId, accountId),
      ]);
      const transformationName = String(
        transformation.fields["name"] ?? transformation.externalId ?? "",
      );
      const presetName = String(preset.fields["name"] ?? preset.externalId ?? "");
      if (!transformationName || !presetName) {
        throw new Error("Cannot determine Cloudinary transformation or upload preset identity");
      }
      // Cloudinary's own list sample already reports named transformations
      // with the `t_` reference prefix; never double it.
      const namedReference = transformationName.startsWith("t_")
        ? transformationName
        : `t_${transformationName}`;
      if (String(preset.fields["transformation"] ?? "") === namedReference) return;
      await this.fetch<Record<string, unknown>>(
        `/upload_presets/${encodeURIComponent(presetName)}`,
        {
          method: "PUT",
          body: JSON.stringify({ transformation: namedReference }),
        },
      );
      return;
    }

    throw new Error(
      `Cloudinary plugin: attachResource not supported for ${sourceTypeId} → ${targetTypeId}`,
    );
  }

  async fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    const resource = await this.getResource(resourceTypeId, resourceId, accountId);
    const f = resource.fields;

    switch (resourceTypeId) {
      case "folder":
        return [
          { label: "Path", value: String(f["path"] ?? "") },
          { label: "Name", value: String(f["name"] ?? "") },
        ];
      case "media-asset":
        return [
          { label: "Type", value: String(f["resourceType"] ?? "") },
          { label: "Format", value: String(f["format"] ?? "") },
          ...(f["width"] && f["height"]
            ? [{ label: "Dimensions", value: `${f["width"]}×${f["height"]}` }]
            : []),
          { label: "Size", value: formatBytes(Number(f["bytes"] ?? 0)) },
        ];
      case "upload-preset":
        return [
          { label: "Name", value: String(f["name"] ?? "") },
          { label: "Mode", value: String(f["mode"] ?? "signed") },
          ...(f["folder"] ? [{ label: "Folder", value: String(f["folder"]) }] : []),
        ];
      case "transformation":
        return [
          { label: "Name", value: String(f["name"] ?? "") },
          { label: "Named", value: f["named"] ? "Yes" : "No" },
          { label: "Used", value: f["used"] ? "Yes" : "No" },
        ];
      case "trigger":
        return [
          { label: "Event", value: String(f["eventType"] ?? "") },
          { label: "Signature", value: String(f["authScheme"] ?? "default") },
          { label: "Filtered", value: f["filter"] ? "Yes" : "No" },
        ];
      case "upload-mapping":
        return [
          { label: "Folder", value: String(f["folder"] ?? "") },
          { label: "Prefix", value: String(f["template"] ?? "") },
        ];
      case "product-environment": {
        const stats: DashboardStat[] = [];
        if (f["plan"]) stats.push({ label: "Plan", value: String(f["plan"]) });
        if (f["creditsUsed"] != null) {
          const percent = Number(f["creditsUsedPercent"] ?? 0);
          stats.push({
            label: "Credits",
            value:
              f["creditsLimit"] != null
                ? `${Number(f["creditsUsed"]).toFixed(2)} / ${String(f["creditsLimit"])}`
                : Number(f["creditsUsed"]).toFixed(2),
            variant: percent >= 90 ? "status-error" : percent >= 75 ? "status-degraded" : "default",
          });
        }
        if (f["storageBytes"] != null) {
          stats.push({ label: "Storage", value: formatBytes(Number(f["storageBytes"])) });
        }
        if (f["bandwidthBytes"] != null) {
          stats.push({ label: "Bandwidth", value: formatBytes(Number(f["bandwidthBytes"])) });
        }
        if (f["assets"] != null) {
          stats.push({ label: "Assets", value: Number(f["assets"]).toLocaleString("en-US") });
        }
        return stats;
      }
      default:
        return [];
    }
  }

  // -------------------------------------------------------------------------
  // Metrics
  // -------------------------------------------------------------------------

  async fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    if (resourceTypeId === "product-environment") return this.fetchUsageSeries(timeRange);
    if (resourceTypeId === "media-asset") return this.fetchVideoViewSeries(resourceId, timeRange);
    return [];
  }

  /**
   * Daily usage as `GET /usage?date=` reports it. Storage and the asset counts
   * are a snapshot as of each date; bandwidth, transformations, requests and
   * credits are the figures Cloudinary's report gives for that date. A day
   * the API refuses (too old, not yet reported) is a gap, not a zero.
   */
  private async fetchUsageSeries(timeRange?: {
    startMs: number;
    endMs: number;
  }): Promise<MetricSeries[]> {
    const endMs = Math.min(timeRange?.endMs ?? Date.now(), Date.now());
    const earliest = endMs - USAGE_HISTORY_DAYS * DAY_MS;
    const startMs = Math.max(timeRange?.startMs ?? endMs - USAGE_METRICS_WINDOW_MS, earliest);
    const firstDay = Math.floor(startMs / DAY_MS) * DAY_MS;
    const lastDay = Math.floor(endMs / DAY_MS) * DAY_MS;
    const totalDays = Math.floor((lastDay - firstDay) / DAY_MS) + 1;
    const stride = Math.max(1, Math.ceil(totalDays / USAGE_MAX_DAYS));
    const days: number[] = [];
    for (let day = lastDay; day >= firstDay; day -= stride * DAY_MS) days.unshift(day);

    const reports: Array<{ day: number; usage: CloudinaryUsage }> = [];
    for (let i = 0; i < days.length; i += USAGE_CONCURRENCY) {
      const batch = await Promise.all(
        days.slice(i, i + USAGE_CONCURRENCY).map(async (day) => {
          const date = new Date(day).toISOString().slice(0, 10);
          const usage = await this.fetch<CloudinaryUsage>(`/usage?date=${date}`).catch(() => null);
          return usage ? { day, usage } : null;
        }),
      );
      for (const entry of batch) if (entry) reports.push(entry);
    }

    const series = (
      label: string,
      unit: string,
      pick: (usage: CloudinaryUsage) => unknown,
    ): MetricSeries => ({
      label,
      unit,
      points: reports.flatMap(({ day, usage }) => {
        const value = pick(usage);
        return typeof value === "number" && Number.isFinite(value)
          ? [{ timestamp: day, value }]
          : [];
      }),
    });
    return [
      series("Storage", "bytes", (u) => u.storage?.usage),
      series("Bandwidth", "bytes", (u) => u.bandwidth?.usage),
      series("Transformations", "count", (u) => u.transformations?.usage),
      series("Credits used", "credits", (u) => u.credits?.usage),
      series("Requests", "count", (u) => u.requests),
      series("Assets", "count", (u) => u.resources),
      series("Derived assets", "count", (u) => u.derived_resources),
    ].filter((s) => s.points.length > 0);
  }

  /**
   * Views and watch time for a video asset. Images and raw files have no
   * view data, so they answer no series and the tab stays empty.
   */
  private async fetchVideoViewSeries(
    resourceId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    // resourceId format: "{accountId}:media-asset:{resource_type}/{type}/{public_id}"
    const assetPath = resourceId.split(":").slice(2).join(":");
    const [resourceType, , ...rest] = assetPath.split("/");
    const publicId = rest.join("/");
    if (resourceType !== "video" || !publicId) return [];

    const endMs = timeRange?.endMs ?? Date.now();
    let startMs = timeRange?.startMs ?? endMs - VIEWS_METRICS_WINDOW_MS;
    const expression = [
      `video_public_id=${publicId}`,
      `view_ended_at>${Math.floor(startMs / 1000)}`,
      `view_ended_at<${Math.ceil(endMs / 1000)}`,
    ].join(" AND ");

    const views: NonNullable<CloudinaryVideoViews["data"]> = [];
    let cursor: string | undefined;
    let truncated = false;
    for (let page = 0; ; page += 1) {
      if (page >= VIEWS_MAX_PAGES) {
        truncated = true;
        break;
      }
      const qs = new URLSearchParams({ expression, max_results: String(VIEWS_PAGE_SIZE) });
      if (cursor) qs.set("next_cursor", cursor);
      const data = await this.fetch<CloudinaryVideoViews>(`/video/analytics/views?${qs}`);
      views.push(...(data.data ?? []));
      cursor = data.next_cursor ?? undefined;
      if (!cursor || (data.data ?? []).length === 0) break;
    }
    const endedAt = (raw: string | number | undefined): number =>
      typeof raw === "number" ? raw * 1000 : Date.parse(raw ?? "");
    if (truncated) {
      // Newest first, so the last one read is the oldest the chart can vouch for.
      const oldest = endedAt(views[views.length - 1]?.view_ended_at);
      if (Number.isFinite(oldest) && oldest > startMs) startMs = oldest;
    }

    const bucketMs = Math.max(60 * 60 * 1000, Math.ceil((endMs - startMs) / VIEWS_BUCKETS));
    const firstBucket = Math.floor(startMs / bucketMs) * bucketMs;
    const counts: number[] = [];
    const watch: number[] = [];
    for (let t = firstBucket; t < endMs; t += bucketMs) {
      counts.push(0);
      watch.push(0);
    }
    for (const view of views) {
      const at = endedAt(view.view_ended_at);
      if (!Number.isFinite(at) || at < startMs || at >= endMs) continue;
      const index = Math.floor((at - firstBucket) / bucketMs);
      if (index < 0 || index >= counts.length) continue;
      counts[index] = (counts[index] ?? 0) + 1;
      watch[index] = (watch[index] ?? 0) + (Number(view.view_watch_time) || 0);
    }
    return [
      {
        label: "Views",
        unit: "count",
        points: counts.map((value, i) => ({ timestamp: firstBucket + i * bucketMs, value })),
      },
      {
        label: "Watch time",
        unit: "s",
        points: watch.map((value, i) => ({ timestamp: firstBucket + i * bucketMs, value })),
      },
    ];
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    switch (resource.resourceTypeId) {
      case "media-asset":
        return withMetricsCapability(
          this.renderMediaAssetDetail(resource),
          METRIC_RESOURCE_TYPES,
          "media-asset",
          VIEWS_METRICS_WINDOW_MS,
        );
      case "folder":
        return this.renderFolderDetail(resource);
      case "upload-preset":
        return this.renderUploadPresetDetail(resource);
      case "transformation":
        return this.renderTransformationDetail(resource);
      case "trigger":
        return this.renderTriggerDetail(resource);
      case "upload-mapping":
        return this.renderUploadMappingDetail(resource);
      case "product-environment":
        return withMetricsCapability(
          this.renderProductEnvironmentDetail(resource),
          METRIC_RESOURCE_TYPES,
          "product-environment",
          USAGE_METRICS_WINDOW_MS,
        );
      default:
        return this.renderGenericDetail(resource);
    }
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    switch (resource.resourceTypeId) {
      case "media-asset": {
        const format = String(resource.fields["format"] ?? "");
        const rType = String(resource.fields["resourceType"] ?? "image");
        const badge = rType === "video" ? "video" : rType === "raw" ? "raw" : format;
        return {
          id: resource.id,
          label: resource.displayName,
          status: { kind: "status-dot", status: "healthy", label: badge },
        };
      }
      case "folder":
        return {
          id: resource.id,
          label: resource.displayName,
          status: { kind: "status-dot", status: "healthy", label: "Folder" },
        };
      case "upload-preset": {
        const mode = String(resource.fields["mode"] ?? "signed");
        return {
          id: resource.id,
          label: resource.displayName,
          status: {
            kind: "status-dot",
            status: mode === "unsigned" ? "degraded" : "healthy",
            label: mode,
          },
        };
      }
      case "transformation":
        return {
          id: resource.id,
          label: resource.displayName,
          status: {
            kind: "status-dot",
            status: resource.fields["used"] ? "healthy" : "degraded",
            label: resource.fields["used"] ? "In use" : "Unused",
          },
        };
      case "trigger":
        return {
          id: resource.id,
          label: resource.displayName,
          status: {
            kind: "status-dot",
            status: "healthy",
            label: String(resource.fields["eventType"] ?? ""),
          },
        };
      case "product-environment": {
        const percent = Number(resource.fields["creditsUsedPercent"] ?? 0);
        return {
          id: resource.id,
          label: resource.displayName,
          status: {
            kind: "status-dot",
            status: percent >= 90 ? "error" : percent >= 75 ? "degraded" : "healthy",
            label:
              resource.fields["creditsUsedPercent"] != null
                ? `${percent.toFixed(0)}% of credits`
                : String(resource.fields["plan"] ?? ""),
          },
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

  private renderTriggerDetail(resource: ResourceInstance): DetailViewSchema {
    const f = resource.fields;
    const sections: SectionNode[] = [
      {
        kind: "section",
        title: "Webhook",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Trigger ID", value: resource.externalId ?? "", copyable: true },
              { key: "Notification URL", value: String(f["uri"] ?? ""), copyable: true },
              { key: "Event Type", value: String(f["eventType"] ?? "") },
              { key: "Additive", value: f["additive"] ? "Yes" : "No" },
              { key: "Signature Scheme", value: String(f["authScheme"] ?? "default") },
              ...(f["createdAt"] ? [{ key: "Created", value: String(f["createdAt"]) }] : []),
              ...(f["updatedAt"] ? [{ key: "Updated", value: String(f["updatedAt"]) }] : []),
            ],
          },
        ],
      },
    ];
    if (f["filter"]) {
      sections.push({
        kind: "section",
        title: "Filter (JSONLogic)",
        children: [{ kind: "text", content: String(f["filter"]), variant: "mono", copyable: true }],
      });
    }
    if (f["payloadTemplate"]) {
      sections.push({
        kind: "section",
        title: "Payload Template",
        children: [
          { kind: "text", content: String(f["payloadTemplate"]), variant: "mono", copyable: true },
        ],
      });
    }
    return {
      title: resource.displayName,
      subtitle: joinSubtitle("Webhook notification", f["eventType"]),
      status: { kind: "status-dot", status: "healthy", label: "Active" },
      sections,
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  private renderUploadMappingDetail(resource: ResourceInstance): DetailViewSchema {
    const f = resource.fields;
    const folder = String(f["folder"] ?? "");
    return {
      title: resource.displayName,
      subtitle: "Auto-upload mapping",
      status: { kind: "status-dot", status: "healthy", label: "Mapped" },
      sections: [
        {
          kind: "section",
          title: "Mapping",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Folder", value: folder, copyable: true },
                { key: "Remote URL Prefix", value: String(f["template"] ?? ""), copyable: true },
              ],
            },
            {
              kind: "text",
              content: `Requesting https://res.cloudinary.com/${this.cloudName}/image/upload/${folder}/<path> fetches <prefix><path> on first access and stores it as a regular asset.`,
              variant: "muted",
            },
          ],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  private renderProductEnvironmentDetail(resource: ResourceInstance): DetailViewSchema {
    const f = resource.fields;
    const bytes = (key: string): string => formatBytes(Number(f[key] ?? 0));
    const count = (key: string): string => Number(f[key] ?? 0).toLocaleString("en-US");
    const percent = Number(f["creditsUsedPercent"] ?? 0);
    return {
      title: resource.displayName,
      subtitle: joinSubtitle("Product environment", f["plan"]),
      status: {
        kind: "status-dot",
        status: percent >= 90 ? "error" : percent >= 75 ? "degraded" : "healthy",
        ...(f["creditsUsedPercent"] != null
          ? { label: `${percent.toFixed(1)}% of monthly credits` }
          : {}),
      },
      sections: [
        {
          kind: "section",
          title: "Plan",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Cloud Name", value: String(f["cloudName"] ?? ""), copyable: true },
                ...(f["plan"] ? [{ key: "Plan", value: String(f["plan"]) }] : []),
                ...(f["folderMode"]
                  ? [{ key: "Folder Mode", value: String(f["folderMode"]) }]
                  : []),
                ...(f["creditsUsed"] != null
                  ? [
                      {
                        key: "Credits Used",
                        value:
                          f["creditsLimit"] != null
                            ? `${Number(f["creditsUsed"]).toFixed(2)} of ${String(f["creditsLimit"])} (${percent.toFixed(1)}%)`
                            : Number(f["creditsUsed"]).toFixed(2),
                      },
                    ]
                  : []),
                ...(f["lastUpdated"]
                  ? [{ key: "Usage Last Updated", value: String(f["lastUpdated"]) }]
                  : []),
              ],
            },
          ],
        },
        {
          kind: "section",
          title: "Usage",
          children: [
            {
              kind: "key-value-list",
              items: [
                ...(f["storageBytes"] != null
                  ? [{ key: "Storage", value: bytes("storageBytes") }]
                  : []),
                ...(f["bandwidthBytes"] != null
                  ? [{ key: "Bandwidth", value: bytes("bandwidthBytes") }]
                  : []),
                ...(f["transformations"] != null
                  ? [{ key: "Transformations", value: count("transformations") }]
                  : []),
                ...(f["assets"] != null ? [{ key: "Assets", value: count("assets") }] : []),
                ...(f["derivedAssets"] != null
                  ? [{ key: "Derived Assets", value: count("derivedAssets") }]
                  : []),
                ...(f["requests"] != null ? [{ key: "Requests", value: count("requests") }] : []),
              ],
            },
          ],
        },
        {
          kind: "section",
          title: "Upload Limits",
          children: [
            {
              kind: "key-value-list",
              items: [
                ...(f["imageMaxBytes"] != null
                  ? [{ key: "Max Image Size", value: bytes("imageMaxBytes") }]
                  : []),
                ...(f["videoMaxBytes"] != null
                  ? [{ key: "Max Video Size", value: bytes("videoMaxBytes") }]
                  : []),
                ...(f["rawMaxBytes"] != null
                  ? [{ key: "Max Raw File Size", value: bytes("rawMaxBytes") }]
                  : []),
              ],
            },
          ],
        },
      ],
      headerActions: [
        {
          kind: "action",
          label: "Open usage in Console",
          action: {
            type: "open-url",
            url: "https://console.cloudinary.com/settings/billing/usage",
          },
        },
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
      ],
    };
  }

  private renderMediaAssetDetail(resource: ResourceInstance): DetailViewSchema {
    const f = resource.fields;
    const secureUrl = resource.resolvedOutputs["secureUrl"] ?? "";
    const dimensions =
      f["width"] && f["height"] ? `${String(f["width"])} × ${String(f["height"])}` : "N/A";
    const sections: SectionNode[] = [
      {
        kind: "section",
        title: "Asset Info",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Public ID", value: String(f["publicId"] ?? ""), copyable: true },
              ...(f["assetId"]
                ? [{ key: "Asset ID", value: String(f["assetId"]), copyable: true }]
                : []),
              { key: "Resource Type", value: String(f["resourceType"] ?? "") },
              ...(f["deliveryType"]
                ? [{ key: "Delivery Type", value: String(f["deliveryType"]) }]
                : []),
              ...(f["accessMode"] ? [{ key: "Access Mode", value: String(f["accessMode"]) }] : []),
              ...(f["tags"] ? [{ key: "Tags", value: String(f["tags"]) }] : []),
              { key: "Format", value: String(f["format"] ?? "") },
              { key: "Dimensions", value: dimensions },
              { key: "Size", value: formatBytes(Number(f["bytes"] ?? 0)) },
              { key: "Created", value: String(f["createdAt"] ?? "") },
            ],
          },
        ],
      },
      {
        kind: "section",
        title: "Delivery",
        children: [
          {
            kind: "key-value-list",
            items: [
              ...(secureUrl ? [{ key: "Secure URL", value: secureUrl, copyable: true }] : []),
              ...(f["folder"] ? [{ key: "Folder", value: String(f["folder"]) }] : []),
            ],
          },
        ],
      },
    ];

    return {
      title: resource.displayName,
      subtitle: joinSubtitle(String(f["resourceType"] ?? "image"), f["format"]),
      status: { kind: "status-dot", status: "healthy", label: "Available" },
      sections,
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  private renderFolderDetail(resource: ResourceInstance): DetailViewSchema {
    const f = resource.fields;
    const sections: SectionNode[] = [
      {
        kind: "section",
        title: "Folder Info",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Name", value: String(f["name"] ?? ""), copyable: true },
              { key: "Path", value: String(f["path"] ?? ""), copyable: true },
            ],
          },
        ],
      },
    ];

    return {
      title: resource.displayName,
      subtitle: "Media Library Folder",
      status: { kind: "status-dot", status: "healthy", label: "Active" },
      sections,
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  private renderUploadPresetDetail(resource: ResourceInstance): DetailViewSchema {
    const f = resource.fields;
    const sections: SectionNode[] = [
      {
        kind: "section",
        title: "Preset Configuration",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Name", value: String(f["name"] ?? ""), copyable: true },
              { key: "Mode", value: String(f["mode"] ?? "signed") },
              ...(f["folder"] ? [{ key: "Target Folder", value: String(f["folder"]) }] : []),
              ...(f["tags"] ? [{ key: "Tags", value: String(f["tags"]) }] : []),
              ...(f["allowedFormats"]
                ? [{ key: "Allowed Formats", value: String(f["allowedFormats"]) }]
                : []),
              ...(f["transformation"]
                ? [{ key: "Transformation", value: String(f["transformation"]) }]
                : []),
              ...(f["disallowPublicId"] != null
                ? [{ key: "Disallow Public ID", value: f["disallowPublicId"] ? "Yes" : "No" }]
                : []),
            ],
          },
        ],
      },
    ];

    const mode = String(f["mode"] ?? "signed");
    return {
      title: resource.displayName,
      subtitle: `Upload Preset · ${mode}`,
      status: {
        kind: "status-dot",
        status: mode === "unsigned" ? "degraded" : "healthy",
        label: mode === "unsigned" ? "Unsigned (public)" : "Signed",
      },
      sections,
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  private renderTransformationDetail(resource: ResourceInstance): DetailViewSchema {
    const f = resource.fields;
    const sections: SectionNode[] = [
      {
        kind: "section",
        title: "Transformation Info",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Name", value: String(f["name"] ?? ""), copyable: true },
              { key: "Named", value: f["named"] ? "Yes" : "No" },
              { key: "Used", value: f["used"] ? "Yes" : "No" },
              ...(f["usageCount"] != null
                ? [{ key: "Derived Assets", value: String(f["usageCount"]) }]
                : []),
              ...(f["allowedForStrict"] != null
                ? [{ key: "Allowed for Strict", value: f["allowedForStrict"] ? "Yes" : "No" }]
                : []),
            ],
          },
        ],
      },
    ];

    return {
      title: resource.displayName,
      subtitle: "Named Transformation",
      status: {
        kind: "status-dot",
        status: f["used"] ? "healthy" : "degraded",
        label: f["used"] ? "In use" : "Unused",
      },
      sections,
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

  private async listFolders(accountId: string): Promise<ResourceInstance[]> {
    const data = await this.fetch<{ folders: CloudinaryFolder[] }>("/folders");
    const results: ResourceInstance[] = [];

    for (const folder of data.folders ?? []) {
      results.push({
        id: `${accountId}:folder:${folder.path}`,
        pluginId: "cloudinary",
        resourceTypeId: "folder",
        accountId,
        displayName: folder.name,
        fields: {
          name: folder.name,
          path: folder.path,
          ...(folder.external_id ? { externalId: folder.external_id } : {}),
        },
        resolvedOutputs: { path: folder.path, name: folder.name },
        secretStates: [],
        externalId: folder.path,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      // Fetch subfolders one level deep
      try {
        const subData = await this.fetch<{ folders: CloudinaryFolder[] }>(
          `/folders/${encodeURIComponent(folder.path)}`,
        );
        for (const sub of subData.folders ?? []) {
          results.push({
            id: `${accountId}:folder:${sub.path}`,
            pluginId: "cloudinary",
            resourceTypeId: "folder",
            accountId,
            displayName: sub.name,
            fields: {
              name: sub.name,
              path: sub.path,
              ...(sub.external_id ? { externalId: sub.external_id } : {}),
            },
            resolvedOutputs: { path: sub.path, name: sub.name },
            secretStates: [],
            externalId: sub.path,
            parentResourceId: `${accountId}:folder:${folder.path}`,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
        }
      } catch {
        // Subfolder listing may fail for empty folders
      }
    }

    return results;
  }

  private async listMediaAssets(accountId: string): Promise<ResourceInstance[]> {
    // Fetch images, videos, and raw files.
    const resourceTypes = ["image", "video", "raw"] as const;
    const results: ResourceInstance[] = [];

    for (const rType of resourceTypes) {
      try {
        let nextCursor: string | undefined;
        do {
          const cursor = nextCursor ? `&next_cursor=${encodeURIComponent(nextCursor)}` : "";
          const data = await this.fetch<CloudinaryResourceList>(
            `/resources/${rType}?max_results=500&tags=true${cursor}`,
          );
          for (const asset of data.resources ?? []) {
            results.push(this.mapMediaAsset(asset, accountId));
          }
          nextCursor = data.next_cursor;
        } while (nextCursor);
      } catch {
        // Skip resource types that fail (e.g. no raw files)
      }
    }

    return results;
  }

  private mapMediaAsset(asset: CloudinaryResource, accountId: string): ResourceInstance {
    const displayName = asset.display_name ?? asset.public_id.split("/").pop() ?? asset.public_id;
    return {
      id: `${accountId}:media-asset:${asset.resource_type}/${asset.type}/${asset.public_id}`,
      pluginId: "cloudinary",
      resourceTypeId: "media-asset",
      accountId,
      displayName,
      fields: {
        publicId: asset.public_id,
        displayName,
        resourceType: asset.resource_type,
        format: asset.format ?? "",
        bytes: asset.bytes ?? 0,
        ...(asset.width != null ? { width: asset.width } : {}),
        ...(asset.height != null ? { height: asset.height } : {}),
        ...(asset.type ? { deliveryType: asset.type } : {}),
        ...(asset.asset_folder ? { folder: asset.asset_folder } : {}),
        ...(asset.tags?.length ? { tags: asset.tags.join(", ") } : {}),
        ...(asset.access_mode ? { accessMode: asset.access_mode } : {}),
        ...(asset.asset_id ? { assetId: asset.asset_id } : {}),
        createdAt: asset.created_at ?? "",
      },
      resolvedOutputs: {
        secureUrl: asset.secure_url ?? "",
        url: asset.url ?? "",
        publicId: asset.public_id,
      },
      secretStates: [],
      externalId: asset.asset_id,
      createdAt: asset.created_at ?? new Date().toISOString(),
      updatedAt: asset.created_at ?? new Date().toISOString(),
    };
  }

  private async listUploadPresets(accountId: string): Promise<ResourceInstance[]> {
    const presets: CloudinaryUploadPreset[] = [];
    let nextCursor: string | undefined;
    do {
      const cursor = nextCursor ? `&next_cursor=${encodeURIComponent(nextCursor)}` : "";
      const data = await this.fetch<CloudinaryUploadPresetList | CloudinaryUploadPreset[]>(
        `/upload_presets?max_results=500${cursor}`,
      );
      if (Array.isArray(data)) {
        presets.push(...data);
        nextCursor = undefined;
      } else {
        presets.push(...(data.upload_presets ?? data.presets ?? []));
        nextCursor = data.next_cursor;
      }
    } while (nextCursor);

    return presets.map((preset) => {
      const mode = preset.unsigned ? "unsigned" : "signed";
      const settings = preset.settings ?? {};
      return {
        id: `${accountId}:upload-preset:${preset.name}`,
        pluginId: "cloudinary",
        resourceTypeId: "upload-preset",
        accountId,
        displayName: preset.name,
        fields: {
          name: preset.name,
          mode,
          ...(settings["folder"] ? { folder: String(settings["folder"]) } : {}),
          ...(Array.isArray(settings["tags"])
            ? { tags: (settings["tags"] as string[]).join(", ") }
            : {}),
          ...(settings["allowed_formats"]
            ? { allowedFormats: String(settings["allowed_formats"]) }
            : {}),
          ...(settings["transformation"]
            ? { transformation: formatTransformationSetting(settings["transformation"]) }
            : {}),
          ...(settings["disallow_public_id"] != null
            ? { disallowPublicId: Boolean(settings["disallow_public_id"]) }
            : {}),
          ...(preset.external_id ? { externalId: preset.external_id } : {}),
        },
        resolvedOutputs: { presetName: preset.name, mode },
        secretStates: [],
        externalId: preset.name,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    });
  }

  private async listTransformations(accountId: string): Promise<ResourceInstance[]> {
    const transformations: CloudinaryTransformation[] = [];
    let nextCursor: string | undefined;
    do {
      const cursor = nextCursor ? `&next_cursor=${encodeURIComponent(nextCursor)}` : "";
      const data = await this.fetch<CloudinaryTransformationList>(
        `/transformations?named=true&max_results=500${cursor}`,
      );
      transformations.push(...(data.transformations ?? []));
      nextCursor = data.next_cursor;
    } while (nextCursor);

    return transformations.map((t) => ({
      id: `${accountId}:transformation:${t.name}`,
      pluginId: "cloudinary",
      resourceTypeId: "transformation",
      accountId,
      displayName: t.name,
      fields: {
        name: t.name,
        named: t.named ?? false,
        used: t.used ?? false,
        usageCount: t.derived?.length ?? 0,
        ...(t.allowed_for_strict != null ? { allowedForStrict: t.allowed_for_strict } : {}),
      },
      resolvedOutputs: { transformationName: t.name },
      secretStates: [],
      externalId: t.name,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
  }

  private mapTrigger(trigger: CloudinaryTrigger, accountId: string): ResourceInstance {
    const now = new Date().toISOString();
    const event = trigger.event_type ?? "";
    return {
      id: `${accountId}:trigger:${trigger.id}`,
      pluginId: "cloudinary",
      resourceTypeId: "trigger",
      accountId,
      displayName: event ? `${event} → ${trigger.uri ?? ""}` : (trigger.uri ?? trigger.id),
      fields: {
        uri: trigger.uri ?? "",
        eventType: event,
        additive: trigger.additive ?? false,
        authScheme: trigger.auth_scheme ?? "default",
        ...(stringifyJson(trigger.filter) ? { filter: stringifyJson(trigger.filter) } : {}),
        ...(stringifyJson(trigger.payload_template)
          ? { payloadTemplate: stringifyJson(trigger.payload_template) }
          : {}),
        ...(trigger.created_at ? { createdAt: trigger.created_at } : {}),
        ...(trigger.updated_at ? { updatedAt: trigger.updated_at } : {}),
      },
      resolvedOutputs: { triggerId: trigger.id, uri: trigger.uri ?? "" },
      secretStates: [],
      externalId: trigger.id,
      createdAt: trigger.created_at ?? now,
      updatedAt: trigger.updated_at ?? trigger.created_at ?? now,
    };
  }

  private async listTriggers(accountId: string): Promise<ResourceInstance[]> {
    const data = await this.fetch<{ triggers?: CloudinaryTrigger[] }>("/triggers");
    return (data.triggers ?? []).map((trigger) => this.mapTrigger(trigger, accountId));
  }

  private mapUploadMapping(mapping: CloudinaryUploadMapping, accountId: string): ResourceInstance {
    const now = new Date().toISOString();
    return {
      id: `${accountId}:upload-mapping:${mapping.folder}`,
      pluginId: "cloudinary",
      resourceTypeId: "upload-mapping",
      accountId,
      displayName: mapping.folder,
      fields: {
        folder: mapping.folder,
        template: mapping.template ?? "",
        ...(mapping.external_id ? { externalId: mapping.external_id } : {}),
      },
      resolvedOutputs: { folder: mapping.folder, template: mapping.template ?? "" },
      secretStates: [],
      externalId: mapping.folder,
      createdAt: now,
      updatedAt: now,
    };
  }

  private async listUploadMappings(accountId: string): Promise<ResourceInstance[]> {
    const mappings: CloudinaryUploadMapping[] = [];
    let nextCursor: string | undefined;
    do {
      const cursor = nextCursor ? `&next_cursor=${encodeURIComponent(nextCursor)}` : "";
      const data = await this.fetch<{ mappings?: CloudinaryUploadMapping[]; next_cursor?: string }>(
        `/upload_mappings?max_results=500${cursor}`,
      );
      mappings.push(...(data.mappings ?? []));
      nextCursor = data.next_cursor;
    } while (nextCursor);
    return mappings.map((mapping) => this.mapUploadMapping(mapping, accountId));
  }

  /** `GET /usage` plus `GET /config?settings=true` for the folder mode. */
  private async loadProductEnvironment(accountId: string): Promise<ResourceInstance> {
    const [usage, config] = await Promise.all([
      this.fetch<CloudinaryUsage>("/usage"),
      this.fetch<CloudinaryConfig>("/config?settings=true").catch((): CloudinaryConfig => ({})),
    ]);
    const limits = usage.media_limits ?? {};
    const now = new Date().toISOString();
    const num = (value: unknown): number | undefined =>
      typeof value === "number" && Number.isFinite(value) ? value : undefined;
    const entries: Record<string, number | undefined> = {
      creditsUsed: num(usage.credits?.usage),
      creditsLimit: num(usage.credits?.limit),
      creditsUsedPercent: num(usage.credits?.used_percent),
      storageBytes: num(usage.storage?.usage),
      bandwidthBytes: num(usage.bandwidth?.usage),
      transformations: num(usage.transformations?.usage),
      assets: num(usage.resources),
      derivedAssets: num(usage.derived_resources),
      requests: num(usage.requests),
      imageMaxBytes: num(limits["image_max_size_bytes"]),
      videoMaxBytes: num(limits["video_max_size_bytes"]),
      rawMaxBytes: num(limits["raw_max_size_bytes"]),
    };
    const numeric: Record<string, number> = {};
    for (const [key, value] of Object.entries(entries)) {
      if (value !== undefined) numeric[key] = value;
    }
    return {
      id: `${accountId}:product-environment:${this.cloudName}`,
      pluginId: "cloudinary",
      resourceTypeId: "product-environment",
      accountId,
      displayName: this.cloudName,
      fields: {
        cloudName: this.cloudName,
        ...(usage.plan ? { plan: usage.plan } : {}),
        ...(config.settings?.folder_mode ? { folderMode: config.settings.folder_mode } : {}),
        ...numeric,
        ...(usage.last_updated ? { lastUpdated: usage.last_updated } : {}),
      },
      resolvedOutputs: { cloudName: this.cloudName },
      secretStates: [],
      externalId: this.cloudName,
      createdAt: config.created_at ?? now,
      updatedAt: usage.last_updated ?? now,
    };
  }

  /**
   * Every used/limit pair `GET /usage` reports, as quota readings. Credit
   * plans carry one `credits` allowance; legacy plans carry separate
   * transformation, storage and bandwidth limits instead. Add-on allowances
   * (AI tagging, background removal, ...) are whatever extra `{usage, limit}`
   * objects the environment has, so they are discovered rather than listed.
   * The Admin API's hourly request budget comes back on the same response.
   */
  async fetchQuotas(_accountId: string): Promise<QuotaUsage[]> {
    const usage = await this.fetch<CloudinaryUsage>("/usage");
    const readings: QuotaUsage[] = [];
    const pair = (entry: UsageEntry | undefined): { used: number; limit: number } | null =>
      entry && typeof entry.usage === "number" && typeof entry.limit === "number"
        ? { used: entry.usage, limit: entry.limit }
        : null;

    const credits = pair(usage.credits);
    if (credits) {
      readings.push({
        id: "credits",
        service: "plan",
        name: "Monthly credits",
        ...credits,
        unit: "credits",
        adjustable: true,
      });
    }
    const transformations = pair(usage.transformations);
    if (transformations) {
      readings.push({
        id: "transformations",
        service: "plan",
        name: "Transformations",
        ...transformations,
        adjustable: true,
      });
    }
    for (const key of ["storage", "bandwidth"] as const) {
      const reading = pair(usage[key]);
      if (reading) {
        readings.push({
          id: key,
          service: "plan",
          name: titleCase(key),
          used: reading.used / GIB,
          limit: reading.limit / GIB,
          unit: "GB",
          adjustable: true,
        });
      }
    }
    for (const [key, value] of Object.entries(usage)) {
      if (CORE_USAGE_KEYS.has(key) || !value || typeof value !== "object") continue;
      const reading = pair(value as UsageEntry);
      if (reading) {
        readings.push({
          id: `addon/${key}`,
          service: "add-ons",
          name: titleCase(key),
          ...reading,
          adjustable: true,
        });
      }
    }
    if (
      typeof usage.rate_limit_allowed === "number" &&
      typeof usage.rate_limit_remaining === "number"
    ) {
      readings.push({
        id: "admin-api-rate-limit",
        service: "admin-api",
        name: "Admin API requests this hour",
        used: usage.rate_limit_allowed - usage.rate_limit_remaining,
        limit: usage.rate_limit_allowed,
        unit: "requests",
      });
    }
    return normalizeQuotaUsage(readings);
  }
}
