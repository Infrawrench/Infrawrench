import type {
  PluginClient,
  ResourceInstance,
  DetailViewSchema,
  SidebarItemSchema,
  CreateResourceConfig,
  SectionNode,
  DashboardStat,
  HostServices,
} from "@infrawrench/plugin-base";
import { formatBytes, joinSubtitle, jsonRestFetch } from "@infrawrench/plugin-base";

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
}

interface CloudinaryTransformation {
  name: string;
  named: boolean;
  used: boolean;
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

/**
 * A preset's `transformation` comes back either as a string — a named
 * reference (`"t_thumb"`) or a raw spec (`"w_100,c_fill"`) — or as a
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
          { key: "folder", label: "Target Folder", kind: "text", required: false },
          {
            key: "tags",
            label: "Tags",
            kind: "string-list",
            required: false,
            placeholder: "tag",
            addLabel: "+ Add tag",
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
    throw new Error(`Cloudinary plugin: createResource not supported for type "${typeId}"`);
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
      const namedReference = `t_${transformationName}`;
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
      default:
        return [];
    }
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    switch (resource.resourceTypeId) {
      case "media-asset":
        return this.renderMediaAssetDetail(resource);
      case "folder":
        return this.renderFolderDetail(resource);
      case "upload-preset":
        return this.renderUploadPresetDetail(resource);
      case "transformation":
        return this.renderTransformationDetail(resource);
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
      default:
        return {
          id: resource.id,
          label: resource.displayName,
          status: { kind: "status-dot", status: "info" },
        };
    }
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
              { key: "Resource Type", value: String(f["resourceType"] ?? "") },
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
            `/resources/${rType}?max_results=500${cursor}`,
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
        ...(asset.asset_folder ? { folder: asset.asset_folder } : {}),
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
      },
      resolvedOutputs: { transformationName: t.name },
      secretStates: [],
      externalId: t.name,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
  }
}
