import type {
  ActionNode,
  CreateResourceConfig,
  DashboardStat,
  DetailViewSchema,
  HostServices,
  PluginClient,
  ResourceInstance,
  SchemaNode,
  SectionNode,
  SidebarItemSchema,
  StorageObject,
} from "@infrawrench/plugin-base";
import { base64ToUtf8, formatBytes, jsonRestFetch } from "@infrawrench/plugin-base";

/**
 * UploadThing plugin client.
 *
 * One Infrawrench account == one UploadThing app. An UploadThing API key is
 * app-scoped and every REST endpoint is implicitly scoped to the app the key
 * belongs to, so there is no "list apps" call to make and no way for a single
 * account to span two apps.
 *
 * Every endpoint below was read off the live OpenAPI document served at
 * https://api.uploadthing.com/openapi-spec.json rather than recalled. Two
 * things about that document are easy to get wrong:
 *
 *  - The versioning is mixed. Almost everything is still `/v6/*`; only
 *    `getAppInfo` and `prepareUpload` have `/v7/` forms, and the v7 ones are
 *    not merely aliases (v7 `prepareUpload` returns a single presigned PUT
 *    target, where v6 returned S3-style POST policies).
 *  - Every call is a POST, including the ones that only read. `listFiles`,
 *    `getUsageInfo` and `getAppInfo` all take a POST with a JSON body.
 *
 * Auth is the `x-uploadthing-api-key` header — not a bearer token.
 */

const API_BASE = "https://api.uploadthing.com";

/**
 * Ceiling on how many files are materialised as resources.
 *
 * `listFiles` will happily page through six figures of files, and an app that
 * size would put one row per file into the resource table on every poll cycle.
 * The app's own `filesUploaded` counter is the honest total; when it exceeds
 * what was listed the app detail view says so out loud rather than letting the
 * short list read as complete. The Files browser is subject to the same cap.
 */
const MAX_LISTED_FILES = 2000;

/** `listFiles` accepts up to 100,000 per page; 500 is its documented default. */
const FILE_PAGE_SIZE = 500;

// ---------------------------------------------------------------------------
// API response shapes
// ---------------------------------------------------------------------------

/** `POST /v7/getAppInfo` */
interface UtAppInfo {
  appId: string;
  defaultACL: string;
  allowACLOverride: boolean;
}

/** `POST /v6/getUsageInfo` */
interface UtUsageInfo {
  /** Bytes counted against the quota. On the free tier this spans every free app. */
  totalBytes: number;
  /** Bytes used by this app alone. */
  appTotalBytes: number;
  filesUploaded: number;
  limitBytes: number;
}

/** One entry of `POST /v6/listFiles`. */
interface UtFile {
  /** Deprecated in the API in favour of `key`; kept because it is still sent. */
  id: string;
  customId: string | null;
  key: string;
  name: string;
  /** "Uploaded" | "Uploading" | "Failed" | "Deletion Pending" */
  status: string;
  size: number;
  /** Epoch milliseconds. */
  uploadedAt: number;
}

interface UtFileList {
  hasMore: boolean;
  files: UtFile[];
}

/** `GET /v6/pollUpload/:fileKey` — the only per-file read, and the only source of MIME type. */
interface UtPollUpload {
  status: string;
  fileData?: {
    fileKey: string;
    fileName: string;
    fileSize: number;
    fileType: string | null;
    fileUrl: string | null;
    customId: string | null;
  };
}

/** `POST /v7/prepareUpload` */
interface UtPreparedUpload {
  key: string;
  url: string;
}

/** `POST /v6/requestFileAccess` */
interface UtFileAccess {
  ufsUrl: string;
  /** Deprecated utfs.io form; kept as the fallback when `ufsUrl` is absent. */
  url: string;
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/**
 * Accept either shape of UploadThing credential.
 *
 * v7 replaced the separate `UPLOADTHING_SECRET` / `UPLOADTHING_APP_ID` pair
 * with a single `UPLOADTHING_TOKEN`, which is base64-encoded JSON of
 * `{ apiKey, appId, regions[], ingestHost? }`. That token is what the
 * dashboard's copy button hands out, so pasting it is the likely path — but
 * the REST API wants the bare `sk_live_…` key in the header, and plenty of
 * apps still have a v6 key lying around. Taking both means the user never has
 * to know which one they are holding.
 *
 * The app id in the token is ignored on purpose: `getAppInfo` has to be called
 * anyway for the ACL policy and is authoritative, so trusting a pasted string
 * would only add a way for the two to disagree. The region is the opposite —
 * it exists nowhere in the REST API, so a token is the only place it can come
 * from, and it stays blank for a raw key.
 */
export function decodeApiKey(raw: string): { apiKey: string; region?: string } {
  const value = raw.trim();
  if (!value) return { apiKey: "" };
  // A raw key is never valid base64 JSON, so check it first and cheaply.
  if (value.startsWith("sk_")) return { apiKey: value };
  try {
    const decoded = JSON.parse(base64ToUtf8(value)) as {
      apiKey?: unknown;
      regions?: unknown;
    };
    const apiKey = typeof decoded.apiKey === "string" ? decoded.apiKey : "";
    if (apiKey) {
      const regions = Array.isArray(decoded.regions) ? decoded.regions : [];
      const region = typeof regions[0] === "string" ? regions[0] : undefined;
      return { apiKey, ...(region ? { region } : {}) };
    }
  } catch {
    // Not a token. Fall through and send whatever was pasted — an invalid key
    // produces a 401 from UploadThing, which is a far clearer error than
    // anything this function could invent.
  }
  return { apiKey: value };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** The public serving host for an app: `https://<appId>.ufs.sh`. */
function appUrl(appId: string): string {
  return `https://${appId}.ufs.sh`;
}

/**
 * Public URL for a file. UploadThing serves every file at
 * `https://<APP_ID>.ufs.sh/f/<FILE_KEY>` (and at the same path under a
 * `customId`, when one was set). The older `https://utfs.io/f/<KEY>` form
 * still resolves but is on its way out, so it is not what we store.
 */
function fileUrl(appId: string, key: string): string {
  return `${appUrl(appId)}/f/${key}`;
}

/** Map UploadThing's file status onto the host's health vocabulary. */
function fileStatus(status: string): {
  status: "healthy" | "degraded" | "error" | "provisioning" | "unknown";
  label: string;
} {
  switch (status) {
    case "Uploaded":
      return { status: "healthy", label: "Uploaded" };
    case "Uploading":
      return { status: "provisioning", label: "Uploading" };
    case "Failed":
      return { status: "error", label: "Failed" };
    case "Deletion Pending":
      return { status: "degraded", label: "Deletion pending" };
    default:
      return { status: "unknown", label: status || "Unknown" };
  }
}

function isoFromEpochMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  return new Date(ms).toISOString();
}

/** Percent of quota consumed, clamped and rounded — `null` when there is no quota to divide by. */
function quotaPercent(used: number, limit: number): number | null {
  if (!Number.isFinite(limit) || limit <= 0) return null;
  return Math.min(100, Math.round((used / limit) * 100));
}

/** The last path segment of a URL, used as the default upload filename. */
function fileNameFromUrl(raw: string): string {
  try {
    const parsed = new URL(raw);
    const segment = parsed.pathname.split("/").filter(Boolean).pop();
    if (segment) return decodeURIComponent(segment);
  } catch {
    // Not parseable as a URL — createResource validates that separately.
  }
  return "upload";
}

/** Everything after `{accountId}:{typeId}:` in a resource id. */
function externalIdOf(resourceId: string): string {
  return resourceId.split(":").slice(2).join(":");
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class UploadThingClient implements PluginClient {
  private readonly apiKey: string;
  private readonly region: string;
  private readonly caCert: string;
  private readonly services: HostServices | undefined;

  /**
   * Per-client cache of `getAppInfo`. Every file listed needs the app id (to
   * build its URL) and the ACL policy (to decide whether the ACL actions are
   * offered), and clients are constructed per request — without this a page of
   * 500 files would ask for the same three fields 500 times.
   */
  private appInfoPromise: Promise<UtAppInfo> | undefined;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const raw = credentials["apiKey"];
    if (!raw) throw new Error("UploadThing plugin: missing apiKey credential");
    const decoded = decodeApiKey(raw);
    if (!decoded.apiKey) throw new Error("UploadThing plugin: apiKey credential is empty");
    this.apiKey = decoded.apiKey;
    this.region = decoded.region ?? "";
    this.caCert = credentials["caCert"] ?? "";
    this.services = services;
  }

  /** Every UploadThing endpoint is a POST, including the read-only ones. */
  private async post<T>(path: string, body?: unknown): Promise<T> {
    return jsonRestFetch<T>({
      vendor: "UploadThing",
      url: `${API_BASE}${path}`,
      errorPath: path,
      headers: { "x-uploadthing-api-key": this.apiKey },
      init: { method: "POST", body: JSON.stringify(body ?? {}) },
      ...(this.caCert && this.services?.http
        ? { caCert: this.caCert, http: this.services.http }
        : {}),
    });
  }

  private async get<T>(path: string): Promise<T> {
    return jsonRestFetch<T>({
      vendor: "UploadThing",
      url: `${API_BASE}${path}`,
      errorPath: path,
      headers: { "x-uploadthing-api-key": this.apiKey },
      ...(this.caCert && this.services?.http
        ? { caCert: this.caCert, http: this.services.http }
        : {}),
    });
  }

  private appInfo(): Promise<UtAppInfo> {
    this.appInfoPromise ??= this.post<UtAppInfo>("/v7/getAppInfo");
    return this.appInfoPromise;
  }

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "ut-app":
        return [await this.loadApp(accountId)];
      case "ut-file":
        return this.listFiles(accountId);
      default:
        throw new Error(`UploadThing plugin: unknown resource type "${typeId}"`);
    }
  }

  private async loadApp(accountId: string): Promise<ResourceInstance> {
    const [info, usage] = await Promise.all([
      this.appInfo(),
      this.post<UtUsageInfo>("/v6/getUsageInfo"),
    ]);
    const now = new Date().toISOString();
    return {
      id: `${accountId}:ut-app:${info.appId}`,
      pluginId: "uploadthing",
      resourceTypeId: "ut-app",
      accountId,
      displayName: info.appId,
      fields: {
        appId: info.appId,
        defaultAcl: info.defaultACL,
        allowAclOverride: info.allowACLOverride,
        ...(this.region ? { region: this.region } : {}),
        filesUploaded: usage.filesUploaded,
        appTotalBytes: usage.appTotalBytes,
        totalBytes: usage.totalBytes,
        limitBytes: usage.limitBytes,
      },
      resolvedOutputs: {
        appId: info.appId,
        appUrl: appUrl(info.appId),
        fileUrlPrefix: `${appUrl(info.appId)}/f/`,
      },
      secretStates: [],
      externalId: info.appId,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Page through `POST /v6/listFiles` up to {@link MAX_LISTED_FILES}.
   *
   * The endpoint is offset-paginated (`limit` + `offset`) and reports
   * `hasMore`, so the loop stops on either that flag, a short page, or the cap.
   */
  private async fetchFiles(): Promise<UtFile[]> {
    const files: UtFile[] = [];
    let offset = 0;
    for (;;) {
      const limit = Math.min(FILE_PAGE_SIZE, MAX_LISTED_FILES - files.length);
      if (limit <= 0) break;
      const page = await this.post<UtFileList>("/v6/listFiles", { limit, offset });
      const batch = page.files ?? [];
      files.push(...batch);
      if (!page.hasMore || batch.length === 0) break;
      offset += batch.length;
    }
    return files;
  }

  private async listFiles(accountId: string): Promise<ResourceInstance[]> {
    const [info, files] = await Promise.all([this.appInfo(), this.fetchFiles()]);
    return files.map((file) => this.mapFile(file, info, accountId));
  }

  private mapFile(file: UtFile, info: UtAppInfo, accountId: string): ResourceInstance {
    const uploadedAt = isoFromEpochMs(file.uploadedAt);
    const url = fileUrl(info.appId, file.key);
    return {
      id: `${accountId}:ut-file:${file.key}`,
      pluginId: "uploadthing",
      resourceTypeId: "ut-file",
      accountId,
      displayName: file.name || file.key,
      fields: {
        key: file.key,
        name: file.name ?? "",
        size: file.size ?? 0,
        sizeLabel: formatBytes(file.size ?? 0),
        status: file.status ?? "",
        ...(file.customId ? { customId: file.customId } : {}),
        uploadedAt,
        ufsUrl: url,
        aclOverrideAllowed: info.allowACLOverride,
        appDefaultAcl: info.defaultACL,
      },
      resolvedOutputs: {
        fileKey: file.key,
        ufsUrl: url,
        // `signedUrl` is deliberately absent: minting one costs an API call per
        // file, and the host only ever asks for it through resolveOutput.
      },
      secretStates: [],
      externalId: file.key,
      parentResourceId: `${accountId}:ut-app:${info.appId}`,
      createdAt: uploadedAt || new Date().toISOString(),
      updatedAt: uploadedAt || new Date().toISOString(),
    };
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    if (typeId === "ut-app") return this.loadApp(accountId);

    if (typeId === "ut-file") {
      const key = externalIdOf(resourceId);
      if (!key) throw new Error("UploadThing plugin: cannot parse file key from resource id");
      const [info, files] = await Promise.all([this.appInfo(), this.fetchFiles()]);
      const found = files.find((f) => f.key === key || f.customId === key);
      if (!found) throw new Error(`UploadThing plugin: file "${key}" not found`);
      const resource = this.mapFile(found, info, accountId);

      // `pollUpload` is the only read that returns the MIME type — `listFiles`
      // never does. It is best-effort: it is really an upload-progress endpoint
      // and is not guaranteed to still know about an older file.
      try {
        const poll = await this.get<UtPollUpload>(
          `/v6/pollUpload/${encodeURIComponent(found.key)}`,
        );
        const type = poll.fileData?.fileType;
        if (type) resource.fields["contentType"] = type;
      } catch {
        // No MIME type available — the rest of the resource is unaffected.
      }
      return resource;
    }

    throw new Error(`UploadThing plugin: unknown resource type "${typeId}"`);
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    _accountId: string,
  ): Promise<string> {
    if (typeId === "ut-app") {
      const info = await this.appInfo();
      if (outputKey === "appId") return info.appId;
      if (outputKey === "appUrl") return appUrl(info.appId);
      if (outputKey === "fileUrlPrefix") return `${appUrl(info.appId)}/f/`;
    }

    if (typeId === "ut-file") {
      const key = externalIdOf(resourceId);
      if (outputKey === "fileKey") return key;
      if (outputKey === "ufsUrl") {
        const info = await this.appInfo();
        return fileUrl(info.appId, key);
      }
      if (outputKey === "signedUrl") {
        // Defaults to the app's configured expiry when `expiresIn` is omitted.
        const access = await this.post<UtFileAccess>("/v6/requestFileAccess", { fileKey: key });
        return access.ufsUrl || access.url || "";
      }
    }

    throw new Error(
      `UploadThing plugin: cannot resolve output "${outputKey}" for type "${typeId}"`,
    );
  }

  // -------------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------------

  async getCreateConfig(typeId: string): Promise<CreateResourceConfig> {
    if (typeId !== "ut-file") {
      throw new Error(`UploadThing plugin: no create config for type "${typeId}"`);
    }
    const info = await this.appInfo();
    return {
      fields: [
        {
          key: "sourceUrl",
          label: "File URL",
          kind: "text",
          required: true,
          placeholder: "https://example.com/logo.png",
          description:
            "Infrawrench downloads this URL and uploads the bytes to UploadThing. The URL has to be reachable without authentication.",
        },
        {
          key: "fileName",
          label: "File Name",
          kind: "text",
          required: false,
          description: "Defaults to the last path segment of the URL.",
        },
        {
          key: "customId",
          label: "Custom ID",
          kind: "text",
          required: false,
          description:
            "Optional stable identifier. UploadThing serves the file at this id as well as at its generated key.",
        },
        ...(info.allowACLOverride
          ? [
              {
                key: "acl",
                label: "Access",
                kind: "select" as const,
                required: false,
                defaultValue: info.defaultACL,
                options: [
                  { id: "public-read", label: "Public — served at its URL" },
                  { id: "private", label: "Private — needs a signed URL" },
                ],
                description: `The app default is ${info.defaultACL}.`,
              },
            ]
          : []),
      ],
    };
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    if (typeId !== "ut-file") {
      throw new Error(`UploadThing plugin: createResource not supported for type "${typeId}"`);
    }

    const sourceUrl = (fields["sourceUrl"] ?? "").trim();
    if (!sourceUrl) throw new Error("A file URL is required");

    const download = await fetch(sourceUrl);
    if (!download.ok) {
      throw new Error(`Could not download ${sourceUrl}: HTTP ${download.status}`);
    }
    const blob = await download.blob();
    const name = (fields["fileName"] ?? "").trim() || fileNameFromUrl(sourceUrl);
    const contentType = blob.type || download.headers.get("content-type") || "";

    const key = await this.uploadBlob(blob, name, contentType, {
      ...(fields["customId"] ? { customId: fields["customId"] } : {}),
      ...(fields["acl"] ? { acl: fields["acl"] } : {}),
    });

    const info = await this.appInfo();
    const now = new Date().toISOString();
    return {
      id: `${accountId}:ut-file:${key}`,
      pluginId: "uploadthing",
      resourceTypeId: "ut-file",
      accountId,
      displayName: name,
      fields: {
        key,
        name,
        size: blob.size,
        sizeLabel: formatBytes(blob.size),
        status: "Uploaded",
        ...(fields["customId"] ? { customId: fields["customId"] } : {}),
        ...(contentType ? { contentType } : {}),
        uploadedAt: now,
        ufsUrl: fileUrl(info.appId, key),
        aclOverrideAllowed: info.allowACLOverride,
        appDefaultAcl: info.defaultACL,
      },
      resolvedOutputs: { fileKey: key, ufsUrl: fileUrl(info.appId, key) },
      secretStates: [],
      externalId: key,
      parentResourceId: `${accountId}:ut-app:${info.appId}`,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * The v7 two-step upload: ask for a presigned target, then PUT the bytes to
   * it as multipart form data. `POST /v7/prepareUpload` only requires the name
   * and size — `slug` names a file route and is optional, which is what makes
   * uploading from outside an app's own router possible at all.
   *
   * Returns the file key UploadThing assigned.
   */
  private async uploadBlob(
    blob: Blob,
    name: string,
    contentType: string,
    opts: { customId?: string; acl?: string },
  ): Promise<string> {
    const prepared = await this.post<UtPreparedUpload>("/v7/prepareUpload", {
      fileName: name,
      fileSize: blob.size,
      ...(contentType ? { fileType: contentType } : {}),
      ...(opts.customId ? { customId: opts.customId } : {}),
      ...(opts.acl ? { acl: opts.acl } : {}),
    });

    const form = new FormData();
    form.append("file", blob, name);
    // The presigned URL carries its own signature and headers; sending the API
    // key here as well would be wrong, and setting Content-Type by hand would
    // strip the multipart boundary fetch generates.
    const res = await fetch(prepared.url, { method: "PUT", body: form });
    if (!res.ok) {
      throw new Error(`UploadThing upload failed: HTTP ${res.status} ${await res.text()}`);
    }
    return prepared.key;
  }

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    if (typeId !== "ut-file") {
      throw new Error(`UploadThing plugin: updateResource not supported for type "${typeId}"`);
    }
    const key = externalIdOf(resourceId);
    const newName = (fields["name"] ?? "").trim();
    if (!newName) throw new Error("A file name is required");

    await this.post<{ success: boolean; renamedCount: number }>("/v6/renameFiles", {
      updates: [{ fileKey: key, newName }],
    });

    return this.getResource(typeId, resourceId, accountId);
  }

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    if (typeId !== "ut-file") {
      throw new Error(`UploadThing plugin: deleteResource not supported for type "${typeId}"`);
    }
    const key = externalIdOf(resourceId);
    if (!key) throw new Error("UploadThing plugin: cannot parse file key from resource id");
    await this.post<{ success: boolean; deletedCount: number }>("/v6/deleteFiles", {
      fileKeys: [key],
    });
  }

  /**
   * ACL moves. `POST /v6/updateACL` only succeeds when the app was configured
   * to allow per-file overrides, which is why the detail view hides these
   * actions otherwise rather than letting the user discover it as a 400.
   */
  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    _accountId: string,
  ): Promise<void> {
    if (typeId === "ut-file" && (actionId === "make-public" || actionId === "make-private")) {
      const key = externalIdOf(resourceId);
      const acl = actionId === "make-public" ? "public-read" : "private";
      await this.post<{ success: boolean; updatedCount: number }>("/v6/updateACL", {
        updates: [{ fileKey: key, acl }],
      });
      return;
    }
    throw new Error(`UploadThing plugin: unknown action "${actionId}" for type "${typeId}"`);
  }

  // -------------------------------------------------------------------------
  // Storage browser
  // -------------------------------------------------------------------------

  /**
   * UploadThing's namespace is flat — there are no folders, no delimiters, and
   * no server-side prefix filter. `prefix` is honoured as a case-insensitive
   * match on the file name so the browser's search box still does something
   * useful, and every entry comes back as a file.
   */
  async listStorageObjects(_bucket: string, prefix: string): Promise<StorageObject[]> {
    const files = await this.fetchFiles();
    const needle = prefix.trim().toLowerCase();
    const matched = needle
      ? files.filter((f) => (f.name ?? "").toLowerCase().startsWith(needle))
      : files;
    return matched.map((file) => ({
      key: file.key,
      name: file.name || file.key,
      size: file.size ?? 0,
      lastModified: isoFromEpochMs(file.uploadedAt),
      isDirectory: false,
    }));
  }

  async uploadStorageObject(
    _bucket: string,
    key: string,
    file: File,
    onProgress?: (pct: number) => void,
  ): Promise<void> {
    // The browser passes a target path — for a folder upload that is the
    // picked folder's relative path (`photos/sub/a.png`), for a plain file
    // just the name.
    //
    // Keep the whole thing as the file *name*. UploadThing creates no folder
    // either way (it has none) and assigns its own opaque key, so the slash is
    // just a character in a string here — but keeping it is what stops two
    // files called `a.png` in different subfolders from arriving as two
    // identical-looking rows. `pathMode: "absolute"` browsers prefix a slash;
    // strip it so names don't start with one.
    const name = key.replace(/^\/+/, "") || file.name || "upload";
    onProgress?.(0);
    await this.uploadBlob(file, name, file.type, {});
    onProgress?.(100);
  }

  async deleteStorageObject(_bucket: string, key: string): Promise<void> {
    await this.post<{ success: boolean; deletedCount: number }>("/v6/deleteFiles", {
      fileKeys: [key],
    });
  }

  /**
   * The credential the Node-side driver spends to fetch bytes.
   *
   * For most providers this is a short-lived read token that covers many
   * objects. UploadThing has no such thing: the only read grant it issues is
   * `requestFileAccess`, which mints a presigned URL for **one** file. So the
   * API key itself is what crosses to the driver, and the driver does a
   * per-file grant there. That is also what makes downloading a *private*
   * file work — the public `ufs.sh` URL 403s unless the ACL is public-read.
   *
   * No new exposure: on web the token never leaves the server, and on desktop
   * the renderer already holds these credentials to construct this client.
   */
  async getStorageAccessToken(): Promise<string> {
    return this.apiKey;
  }

  /**
   * Present so the browser's "new folder" button reports the real reason it
   * cannot work here instead of failing on an undefined method.
   */
  async makeStorageFolder(_bucket: string, _key: string): Promise<void> {
    throw new Error(
      "UploadThing stores files in a flat namespace and has no folders. Upload the file directly.",
    );
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  async fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    const resource = await this.getResource(resourceTypeId, resourceId, accountId);
    const fields = resource.fields;

    if (resourceTypeId === "ut-app") {
      const used = Number(fields["appTotalBytes"] ?? 0);
      const limit = Number(fields["limitBytes"] ?? 0);
      const pct = quotaPercent(Number(fields["totalBytes"] ?? used), limit);
      return [
        { label: "Files", value: String(fields["filesUploaded"] ?? 0) },
        { label: "Used", value: formatBytes(used) },
        ...(limit > 0 ? [{ label: "Quota", value: formatBytes(limit) }] : []),
        ...(pct != null
          ? [
              {
                label: "Quota used",
                value: `${pct}%`,
                variant:
                  pct >= 90
                    ? ("status-error" as const)
                    : pct >= 75
                      ? ("status-degraded" as const)
                      : ("default" as const),
              },
            ]
          : []),
      ];
    }

    if (resourceTypeId === "ut-file") {
      const state = fileStatus(String(fields["status"] ?? ""));
      return [
        { label: "Size", value: String(fields["sizeLabel"] ?? formatBytes(0)) },
        {
          label: "Status",
          value: state.label,
          variant:
            state.status === "healthy"
              ? ("status-healthy" as const)
              : state.status === "error"
                ? ("status-error" as const)
                : ("status-degraded" as const),
        },
        ...(fields["contentType"] ? [{ label: "Type", value: String(fields["contentType"]) }] : []),
      ];
    }

    return [];
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return resource.resourceTypeId === "ut-file"
      ? this.renderFileDetail(resource)
      : this.renderAppDetail(resource);
  }

  private renderAppDetail(resource: ResourceInstance): DetailViewSchema {
    const f = resource.fields;
    const appId = String(f["appId"] ?? resource.externalId ?? "");
    const filesUploaded = Number(f["filesUploaded"] ?? 0);
    const appUsed = Number(f["appTotalBytes"] ?? 0);
    const quotaUsed = Number(f["totalBytes"] ?? appUsed);
    const limit = Number(f["limitBytes"] ?? 0);
    const pct = quotaPercent(quotaUsed, limit);
    const overrides = f["allowAclOverride"] === true;
    const defaultAcl = String(f["defaultAcl"] ?? "");

    const storageItems = [
      { key: "Files uploaded", value: String(filesUploaded) },
      { key: "Storage used by this app", value: formatBytes(appUsed) },
      // On the free tier the quota is shared across every free app the account
      // owns, so these two numbers legitimately differ. Saying so beats letting
      // the user wonder which one is the real figure.
      ...(quotaUsed !== appUsed
        ? [{ key: "Counted against quota", value: formatBytes(quotaUsed) }]
        : []),
      ...(limit > 0
        ? [
            { key: "Quota", value: formatBytes(limit) },
            { key: "Remaining", value: formatBytes(Math.max(0, limit - quotaUsed)) },
          ]
        : []),
      ...(pct != null ? [{ key: "Quota used", value: `${pct}%` }] : []),
    ];

    const sections: SectionNode[] = [
      {
        kind: "section",
        title: "App",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "App ID", value: appId, copyable: true },
              ...(f["region"] ? [{ key: "Region", value: String(f["region"]) }] : []),
              { key: "File URL prefix", value: `${appUrl(appId)}/f/`, copyable: true },
            ],
          },
        ],
      },
      {
        kind: "section",
        title: "Storage",
        children: [{ kind: "key-value-list", items: storageItems }],
      },
      {
        kind: "section",
        title: "Access control",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Default ACL", value: defaultAcl || "—" },
              { key: "Per-file overrides", value: overrides ? "Allowed" : "Not allowed" },
            ],
          },
          {
            kind: "text",
            variant: "muted",
            content: overrides
              ? "Individual files can be switched between public and private from their own page."
              : "Every file uses the app default. Turn on ACL overrides in the UploadThing dashboard to change files individually.",
          },
        ],
      },
    ];

    // Be explicit when the synced file list is a truncation rather than the
    // whole app — a short list that silently stands in for 40,000 files is
    // worse than no list.
    if (filesUploaded > MAX_LISTED_FILES) {
      sections.push({
        kind: "section",
        title: "Files",
        children: [
          {
            kind: "text",
            variant: "muted",
            content: `This app has ${filesUploaded.toLocaleString()} files. Infrawrench syncs the first ${MAX_LISTED_FILES.toLocaleString()} as resources; use the Files browser to reach the rest.`,
          },
        ],
      });
    }

    return {
      title: resource.displayName,
      subtitle: "UploadThing app",
      status: {
        kind: "status-dot",
        status: pct != null && pct >= 90 ? "degraded" : "healthy",
        label: pct != null ? `${pct}% of quota` : "Active",
      },
      sections,
      // The Files tab (the storage browser below) is the file listing, and it
      // carries upload, download and delete on the same rows. Repeating those
      // rows on Overview only added a second table that could disagree with
      // it — and for an app over the sync cap it disagrees by definition,
      // since the browser pages the provider while the table shows what synced.
      hiddenChildTypeIds: ["ut-file"],
      storageBrowser: { bucketName: appId },
      headerActions: [
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
        {
          kind: "action",
          label: "Open dashboard",
          variant: "ghost",
          action: { type: "open-url", url: "https://uploadthing.com/dashboard" },
        },
      ],
    };
  }

  private renderFileDetail(resource: ResourceInstance): DetailViewSchema {
    const f = resource.fields;
    const key = String(f["key"] ?? resource.externalId ?? "");
    const url = String(f["ufsUrl"] ?? "");
    const state = fileStatus(String(f["status"] ?? ""));
    const overrides = f["aclOverrideAllowed"] === true;
    const defaultAcl = String(f["appDefaultAcl"] ?? "");
    const sizeLabel = String(f["sizeLabel"] ?? formatBytes(Number(f["size"] ?? 0)));

    const accessChildren: SchemaNode[] = [
      {
        kind: "key-value-list",
        items: [
          ...(url ? [{ key: "URL", value: url, copyable: true }] : []),
          ...(defaultAcl ? [{ key: "App default ACL", value: defaultAcl }] : []),
        ],
      },
      {
        kind: "text",
        variant: "muted",
        content: overrides
          ? "This app allows per-file access control. A private file is not readable at the URL above — resolve its Signed URL output instead."
          : `This app does not allow per-file access control, so this file is ${defaultAcl || "using the app default"}. Change the default in the UploadThing dashboard.`,
      },
    ];
    if (url) accessChildren.push({ kind: "link", label: "Open file", url });

    const sections: SectionNode[] = [
      {
        kind: "section",
        title: "File",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Key", value: key, copyable: true },
              { key: "Name", value: String(f["name"] ?? "") },
              ...(f["customId"]
                ? [{ key: "Custom ID", value: String(f["customId"]), copyable: true }]
                : []),
              { key: "Size", value: sizeLabel },
              ...(f["contentType"]
                ? [{ key: "Content type", value: String(f["contentType"]) }]
                : []),
              { key: "Status", value: state.label },
              ...(f["uploadedAt"] ? [{ key: "Uploaded", value: String(f["uploadedAt"]) }] : []),
            ],
          },
        ],
      },
      { kind: "section", title: "Access", children: accessChildren },
    ];

    const headerActions: ActionNode[] = [
      { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
    ];
    if (url) {
      headerActions.push({
        kind: "action",
        label: "Open file",
        variant: "ghost",
        action: { type: "open-url", url },
      });
    }
    if (overrides) {
      headerActions.push(
        {
          kind: "action",
          label: "Make public",
          variant: "ghost",
          action: {
            type: "plugin-action",
            actionId: "make-public",
            confirmMessage: "Make this file readable by anyone with its URL?",
            successMessage: "File is now public.",
          },
        },
        {
          kind: "action",
          label: "Make private",
          variant: "ghost",
          action: {
            type: "plugin-action",
            actionId: "make-private",
            confirmMessage:
              "Make this file private? Its public URL will stop working and readers will need a signed URL.",
            successMessage: "File is now private.",
          },
        },
      );
    }

    return {
      title: resource.displayName,
      subtitle: `${sizeLabel} · ${state.label}`,
      status: { kind: "status-dot", status: state.status, label: state.label },
      sections,
      headerActions,
    };
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    if (resource.resourceTypeId === "ut-file") {
      const state = fileStatus(String(resource.fields["status"] ?? ""));
      return {
        id: resource.id,
        label: resource.displayName,
        status: { kind: "status-dot", status: state.status, label: state.label },
      };
    }

    const pct = quotaPercent(
      Number(resource.fields["totalBytes"] ?? 0),
      Number(resource.fields["limitBytes"] ?? 0),
    );
    return {
      id: resource.id,
      label: resource.displayName,
      status: {
        kind: "status-dot",
        status: pct != null && pct >= 90 ? "degraded" : "healthy",
        label: pct != null ? `${pct}%` : "Active",
      },
    };
  }
}
