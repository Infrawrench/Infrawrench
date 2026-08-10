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
import { buildMultipartFileBody } from "./multipart.js";

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
 * Page size for `listFiles`, which accepts up to 100,000 per page.
 *
 * Listing is **not** capped: the loop pages until UploadThing says there is
 * nothing more. That makes a poll cycle's cost proportional to the app's file
 * count — a six-figure app is six figures of rows every cycle — which is the
 * accepted trade for a listing that is actually complete. `fetchFiles` is
 * memoised per client instance so the several call sites in one request share
 * a single walk rather than repeating it.
 */
const FILE_PAGE_SIZE = 500;

/** How many file keys to send per `deleteFiles` call when clearing a folder. */
const DELETE_BATCH_SIZE = 250;

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

/**
 * Largest body `createResource` will pull from a URL. The download is buffered
 * whole before being pushed to UploadThing, and on the cloud that buffer is
 * the API server's heap, not the caller's.
 */
const MAX_URL_UPLOAD_BYTES = 256 * 1024 * 1024;

/** Cap how long a URL-sourced upload may spend downloading or PUTting bytes. */
const URL_UPLOAD_TIMEOUT_MS = 60_000;

/** How many redirects `downloadFromUrl` will follow before giving up. */
const MAX_DOWNLOAD_REDIRECTS = 5;

/**
 * Reject a source URL that would make the server fetch something on its own
 * behalf rather than the user's.
 *
 * `createResource` is the one place in this plugin that dereferences a
 * user-supplied address, and on the cloud it runs inside the API server — so
 * without this, anyone holding `resources:write` could aim it at the metadata
 * service or a service reachable only from inside the cluster and read the
 * response back out as an uploaded file. Scheme and host are both checked:
 * `file://` would read the pod's disk, and a private/loopback/link-local
 * address is never a legitimate place to fetch a user's upload from.
 *
 * This is deliberately a denylist of address *shapes* rather than a resolver
 * check — it cannot stop a hostname that resolves to a private address
 * (DNS rebinding). Closing that needs egress policy, not string parsing; what
 * this does stop is the direct, obvious form.
 */
function assertFetchableUrl(raw: string): void {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`"${raw}" is not a valid URL.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Only http and https URLs can be uploaded from (got "${parsed.protocol}").`);
  }
  let host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  // `[::ffff:169.254.169.254]` and `[::ffff:a9fe:a9fe]` both reach the same
  // address; fold them to dotted-quad so the IPv4 rules below apply.
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(host);
  if (mapped) {
    const hi = parseInt(mapped[1]!, 16);
    const lo = parseInt(mapped[2]!, 16);
    host = `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  } else if (host.toLowerCase().startsWith("::ffff:")) {
    host = host.slice("::ffff:".length);
  }
  const blocked =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    host === "::" ||
    host === "0.0.0.0" ||
    /^127\./.test(host) ||
    /^0\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2[0-9]|3[01])\./.test(host) ||
    // Link-local, which is where cloud metadata services live.
    /^169\.254\./.test(host) ||
    /^fe80:/i.test(host) ||
    // Unique-local IPv6.
    /^f[cd][0-9a-f]{2}:/i.test(host);
  if (blocked) {
    throw new Error(
      `Refusing to upload from "${parsed.hostname}" — private and loopback addresses are not reachable sources.`,
    );
  }
}

/**
 * Fetch a user-supplied URL for upload, re-checking every redirect hop.
 *
 * Deliberately uses bare `fetch`, not `services.http`. The source is an
 * arbitrary public URL the user typed — not an UploadThing host — so it is
 * never on the bastion egress allowlist. Routing it through a bastion-bound
 * `services.http` would reject every real import with "destination not
 * allowlisted". SSRF is handled here instead: scheme + host denylist, and
 * every redirect hop is re-checked (`redirect: "manual"`).
 *
 * UploadThing API / ingest traffic still goes through `services.http`.
 */
async function downloadFromUrl(sourceUrl: string): Promise<Response> {
  let current = sourceUrl;
  for (let hop = 0; hop <= MAX_DOWNLOAD_REDIRECTS; hop++) {
    assertFetchableUrl(current);
    const res = await fetch(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(URL_UPLOAD_TIMEOUT_MS),
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) {
        throw new Error(`Could not download ${sourceUrl}: redirect ${res.status} with no Location`);
      }
      current = new URL(location, current).href;
      continue;
    }
    return res;
  }
  throw new Error(`Could not download ${sourceUrl}: more than ${MAX_DOWNLOAD_REDIRECTS} redirects`);
}

/** Read a response body, aborting past `limit` rather than buffering it all. */
async function readCappedBlob(res: Response, limit: number): Promise<Blob> {
  if (!res.body) return res.blob();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new Error(`That file exceeds the ${formatBytes(limit)} cap for uploads from a URL.`);
    }
    chunks.push(value);
  }
  return new Blob(chunks as BlobPart[], {
    ...(res.headers.get("content-type") ? { type: res.headers.get("content-type")! } : {}),
  });
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

  /** Memoised full file listing — see {@link fetchFiles}. */
  private filesPromise: Promise<UtFile[]> | undefined;

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
      // Independently spread. Coupling `http` to `caCert` (as the helper this
      // was cribbed from does) means an account with a bastion attached but no
      // custom CA — the normal case — silently falls through to bare `fetch`
      // and skips bastion routing entirely, despite `uploadthing` being in the
      // egress allowlist.
      ...(this.services?.http ? { http: this.services.http } : {}),
      ...(this.caCert ? { caCert: this.caCert } : {}),
    });
  }

  private async get<T>(path: string): Promise<T> {
    return jsonRestFetch<T>({
      vendor: "UploadThing",
      url: `${API_BASE}${path}`,
      errorPath: path,
      headers: { "x-uploadthing-api-key": this.apiKey },
      // Independently spread. Coupling `http` to `caCert` (as the helper this
      // was cribbed from does) means an account with a bastion attached but no
      // custom CA — the normal case — silently falls through to bare `fetch`
      // and skips bastion routing entirely, despite `uploadthing` being in the
      // egress allowlist.
      ...(this.services?.http ? { http: this.services.http } : {}),
      ...(this.caCert ? { caCert: this.caCert } : {}),
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
   * Every file in the app.
   *
   * `POST /v6/listFiles` is offset-paginated and reports `hasMore`, so the walk
   * ends when the data does. An empty page also breaks the loop: `hasMore`
   * comes from the server, and a server that kept asserting it while returning
   * nothing would otherwise spin forever.
   *
   * Memoised for the life of this client — one request may list resources,
   * open the file browser, and resolve a folder delete, and there is no reason
   * for those to each walk the whole app. Clients are constructed per request,
   * so the memo cannot outlive the data by long; mutations clear it explicitly.
   */
  private fetchFiles(): Promise<UtFile[]> {
    this.filesPromise ??= (async () => {
      const files: UtFile[] = [];
      let offset = 0;
      for (;;) {
        const page = await this.post<UtFileList>("/v6/listFiles", {
          limit: FILE_PAGE_SIZE,
          offset,
        });
        const batch = page.files ?? [];
        files.push(...batch);
        if (!page.hasMore || batch.length === 0) break;
        offset += batch.length;
      }
      return files;
    })();
    return this.filesPromise;
  }

  /** Drop the memoised listing after anything that changes it. */
  private invalidateFiles(): void {
    this.filesPromise = undefined;
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

    const download = await downloadFromUrl(sourceUrl);
    if (!download.ok) {
      throw new Error(`Could not download ${sourceUrl}: HTTP ${download.status}`);
    }
    // On the cloud this runs inside the API server, so an unbounded read is
    // the pod's heap. Check the advertised length first, then count bytes as
    // they arrive — `content-length` is the server's claim, not a guarantee.
    const declared = Number(download.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > MAX_URL_UPLOAD_BYTES) {
      throw new Error(
        `That file is ${formatBytes(declared)}; uploads from a URL are capped at ${formatBytes(MAX_URL_UPLOAD_BYTES)}.`,
      );
    }
    const blob = await readCappedBlob(download, MAX_URL_UPLOAD_BYTES);
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

    // UploadThing's docs use multipart FormData for this PUT
    // (https://docs.uploadthing.com/uploading-files). FormData can't go through
    // `services.http` (the host bridge only accepts string | Uint8Array), so we
    // encode the same shape as bytes and prefer the host path — that's what
    // picks up bastion egress for ingest hosts on the allowlist.
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const multipart = buildMultipartFileBody({
      name: "file",
      fileName: name,
      contentType: contentType || "application/octet-stream",
      data: bytes,
    });
    const headers = { "Content-Type": multipart.contentType };

    if (this.services?.http) {
      const result = await this.services.http.request({
        url: prepared.url,
        method: "PUT",
        headers,
        body: multipart.body,
        ...(this.caCert ? { caCert: this.caCert } : {}),
      });
      if (result.status < 200 || result.status >= 300) {
        throw new Error(
          `UploadThing upload failed: HTTP ${result.status} ${result.body.slice(0, 400)}`,
        );
      }
    } else {
      const res = await fetch(prepared.url, {
        method: "PUT",
        headers,
        body: multipart.body as BodyInit,
        signal: AbortSignal.timeout(URL_UPLOAD_TIMEOUT_MS),
      });
      if (!res.ok) {
        throw new Error(`UploadThing upload failed: HTTP ${res.status} ${await res.text()}`);
      }
    }
    this.invalidateFiles();
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
    if (!key) throw new Error("UploadThing plugin: cannot parse file key from resource id");
    const newName = (fields["name"] ?? "").trim();
    if (!newName) throw new Error("A file name is required");

    await this.post<{ success: boolean; renamedCount: number }>("/v6/renameFiles", {
      updates: [{ fileKey: key, newName }],
    });
    // Before the re-read below, which walks the listing.
    this.invalidateFiles();

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
    this.invalidateFiles();
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
      if (!key) throw new Error("UploadThing plugin: cannot parse file key from resource id");
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
   * List one level of the browser's tree.
   *
   * UploadThing's namespace is genuinely flat — no folders, no delimiters, no
   * server-side prefix filter. But names carry the path a folder upload came
   * from (`git-cliff-2.12.0/completions/git-cliff.bash`), so the tree is
   * derivable: split on "/" and fold everything sharing a first segment into a
   * synthesized directory. Without this the browser is one screen of long
   * identical-looking rows, which is what a real archive upload produces.
   *
   * `prefix` is navigation, not search — the browser filters its search box
   * client-side and only calls this to open a directory.
   *
   * Two invariants the rest of this class leans on:
   *  - a **file** entry carries the real UploadThing key, because delete and
   *    download address files by key, not by name;
   *  - a **directory** entry carries the name prefix and always ends in "/",
   *    which a real file key never does. That is what lets `deleteStorageObject`
   *    tell a folder from a file without a host-side signature change.
   */
  async listStorageObjects(_bucket: string, prefix: string): Promise<StorageObject[]> {
    const files = await this.fetchFiles();
    const scope = prefix.replace(/^\/+/, "");

    const dirs = new Map<string, { size: number; latest: number }>();
    const entries: StorageObject[] = [];

    for (const file of files) {
      const name = file.name || file.key;
      if (scope && !name.startsWith(scope)) continue;
      const rest = name.slice(scope.length);
      if (!rest) continue;

      const slash = rest.indexOf("/");
      if (slash === -1) {
        entries.push({
          key: file.key,
          name: rest,
          size: file.size ?? 0,
          lastModified: isoFromEpochMs(file.uploadedAt),
          isDirectory: false,
        });
        continue;
      }

      // Roll the whole subtree up into its top segment: the browser asks for
      // deeper levels by listing this directory's key.
      const dirName = rest.slice(0, slash);
      const agg = dirs.get(dirName);
      dirs.set(dirName, {
        size: (agg?.size ?? 0) + (file.size ?? 0),
        latest: Math.max(agg?.latest ?? 0, file.uploadedAt ?? 0),
      });
    }

    const dirEntries: StorageObject[] = [...dirs].map(([name, agg]) => ({
      key: `${scope}${name}/`,
      name,
      size: agg.size,
      lastModified: isoFromEpochMs(agg.latest),
      isDirectory: true,
    }));

    return [...dirEntries, ...entries];
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

  /**
   * Delete a file, or everything under a synthesized folder.
   *
   * The host's delete signature carries no "is this a directory" flag, so the
   * trailing slash `listStorageObjects` puts on directory keys is what tells
   * them apart — a real UploadThing file key never ends in one. Without this
   * branch, deleting a folder would post its path as a file key and come back
   * `deletedCount: 0`: a silent no-op on a destructive action.
   */
  async deleteStorageObject(_bucket: string, key: string): Promise<void> {
    if (!key.endsWith("/")) {
      await this.post<{ success: boolean; deletedCount: number }>("/v6/deleteFiles", {
        fileKeys: [key],
      });
      this.invalidateFiles();
      return;
    }

    const files = await this.fetchFiles();
    const fileKeys = files.filter((f) => (f.name || f.key).startsWith(key)).map((f) => f.key);
    if (fileKeys.length === 0) return;

    // Chunked: a folder from an archive upload can hold thousands of files and
    // the API documents no ceiling on the array, which is not the same as
    // there being none.
    for (let i = 0; i < fileKeys.length; i += DELETE_BATCH_SIZE) {
      await this.post<{ success: boolean; deletedCount: number }>("/v6/deleteFiles", {
        fileKeys: fileKeys.slice(i, i + DELETE_BATCH_SIZE),
      });
    }
    this.invalidateFiles();
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
   * cannot work here instead of failing on an undefined method. Folders are
   * derived from names, so one with nothing in it has nothing to derive from.
   */
  async makeStorageFolder(_bucket: string, _key: string): Promise<void> {
    throw new Error(
      "UploadThing has no folders — the ones shown here are derived from file names, " +
        "so an empty one cannot exist. Upload a folder, or a file named `folder/file.ext`.",
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
      // carries upload, download and delete on the same rows — and browses the
      // name paths as folders, which a flat table cannot. Repeating the rows on
      // Overview only added a second listing to disagree with it.
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
