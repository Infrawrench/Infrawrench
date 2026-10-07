import type {
  CreateResourceConfig,
  DetailViewSchema,
  HostServices,
  MetricSeries,
  PluginClient,
  PreflightResult,
  ResourceInstance,
  SidebarItemSchema,
  StorageObject,
} from "@infrawrench/plugin-base";
import { externalIdOf } from "@infrawrench/plugin-base";
import type { MinioDataUsage, MinioInfo } from "./minio.js";
import { MinioAdmin, detectServer } from "./minio.js";
import { renderS3Detail, renderS3Sidebar } from "./render.js";
import type { S3Config, S3CorsRule, S3LifecycleRule } from "./s3.js";
import { S3Client, S3Error, parseTagString, tagString } from "./s3.js";

export const PLUGIN_ID = "s3-compatible";

type Fields = Record<string, string | number | boolean>;

function instance(
  accountId: string,
  typeId: string,
  externalId: string,
  displayName: string,
  fields: Fields,
  parent?: { typeId: string; externalId: string },
): ResourceInstance {
  const now = new Date().toISOString();
  return {
    id: `${accountId}:${typeId}:${externalId}`,
    pluginId: PLUGIN_ID,
    resourceTypeId: typeId,
    accountId,
    displayName,
    fields,
    resolvedOutputs: {},
    secretStates: [],
    externalId,
    ...(parent ? { parentResourceId: `${accountId}:${parent.typeId}:${parent.externalId}` } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

function splitChild(externalId: string): { parent: string; key: string } {
  const i = externalId.indexOf("/");
  return i < 0
    ? { parent: externalId, key: "" }
    : { parent: externalId.slice(0, i), key: externalId.slice(i + 1) };
}

function splitList(raw: string | undefined): string[] {
  return [
    ...new Set(
      (raw ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}

function parsePicked(raw: string | undefined): string[] {
  const t = (raw ?? "").trim();
  if (t.startsWith("[")) {
    try {
      const v = JSON.parse(t) as unknown;
      if (Array.isArray(v)) return v.map(String).filter(Boolean);
    } catch {
      // fall through
    }
  }
  return splitList(t);
}

function days(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`"${raw}" is not a number of days.`);
  return Math.floor(n) || undefined;
}

function bool(raw: string | undefined): boolean | undefined {
  if (raw === undefined || raw === "") return undefined;
  return raw === "true" || raw === "on" || raw === "1" || raw === "yes";
}

/** Normalise the endpoint the user typed into an origin with a scheme. */
export function normalizeEndpoint(raw: string): string {
  const t = raw.trim().replace(/\/+$/, "");
  if (!t) return "";
  const withScheme = /^https?:\/\//i.test(t) ? t : `https://${t}`;
  const u = new URL(withScheme);
  return `${u.protocol}//${u.host}`;
}

/** Statuses meaning "this server does not implement that S3 feature". */
function unsupported(err: unknown): boolean {
  return err instanceof S3Error && (err.status === 501 || err.code === "NotImplemented");
}

export function validateBucketName(name: string): string | null {
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(name) || name.includes("..")) {
    return "Bucket names are 3 to 63 lowercase letters, digits, dots and hyphens, starting and ending with a letter or digit.";
  }
  return null;
}

export class S3CompatibleClient implements PluginClient {
  readonly cfg: S3Config;
  private readonly s3: S3Client;
  private readonly admin: MinioAdmin;
  private serverHeader: Promise<string> | undefined;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const endpoint = normalizeEndpoint(credentials["endpoint"] ?? "");
    const accessKey = (credentials["accessKey"] ?? "").trim();
    const secretKey = (credentials["secretKey"] ?? "").trim();
    if (!endpoint || !accessKey || !secretKey) {
      throw new Error("S3-compatible plugin: endpoint, accessKey and secretKey are required");
    }
    const caCert = credentials["caCert"] ?? "";
    const sessionToken = (credentials["sessionToken"] ?? "").trim();
    this.cfg = {
      endpoint,
      region: (credentials["region"] ?? "").trim() || "us-east-1",
      pathStyle: (credentials["addressing"] ?? "path") !== "virtual",
      accessKey,
      secretKey,
      ...(sessionToken ? { sessionToken } : {}),
      ...(caCert ? { caCert } : {}),
      ...(services?.http ? { http: services.http } : {}),
    };
    this.s3 = new S3Client(this.cfg);
    this.admin = new MinioAdmin(this.cfg);
  }

  /** The `Server` header of a ListBuckets answer, which names the software. */
  private server(): Promise<string> {
    this.serverHeader ??= this.s3
      .send("GET", {}, "ListBuckets")
      .then((r) => detectServer(r.headers["server"]));
    this.serverHeader.catch(() => {
      this.serverHeader = undefined;
    });
    return this.serverHeader;
  }

  private async isMinio(): Promise<boolean> {
    return (await this.server().catch(() => "")) === "MinIO";
  }

  private async minio(): Promise<{ info?: MinioInfo; usage?: MinioDataUsage; error?: string }> {
    if (!(await this.isMinio())) return {};
    try {
      const [info, usage] = await Promise.all([
        this.admin.info(),
        this.admin.dataUsage().catch(() => undefined),
      ]);
      return { info, ...(usage ? { usage } : {}) };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  private host(): string {
    return new URL(this.cfg.endpoint).host;
  }

  // ── Listing ─────────────────────────────────────────────────────────────

  private async mapLimit<T, R>(items: T[], fn: (t: T) => Promise<R>, limit = 4): Promise<R[]> {
    const out = new Array<R>(items.length);
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
          const i = next++;
          out[i] = await fn(items[i]!);
        }
      }),
    );
    return out;
  }

  private async bucketInstance(
    accountId: string,
    b: { name: string; creationDate: string },
    usage: MinioDataUsage | undefined,
  ): Promise<ResourceInstance> {
    const [location, versioning, lock, tags, policy] = await Promise.all([
      this.s3.bucketLocation(b.name).catch(() => ""),
      this.s3.getVersioning(b.name).catch(() => ""),
      this.s3.getObjectLock(b.name).catch(
        () =>
          ({ enabled: false }) as {
            enabled: boolean;
            mode?: string;
            days?: number;
            years?: number;
          },
      ),
      this.s3.getTags(b.name).catch(() => ({})),
      this.s3.getPolicy(b.name).catch(() => ""),
    ]);
    const fields: Fields = {
      name: b.name,
      region: location || this.cfg.region,
      createdAt: b.creationDate,
      objectLock: lock.enabled,
      tags: tagString(tags),
      hasPolicy: policy.trim() !== "",
    };
    if (versioning) fields["versioning"] = versioning;
    if (lock.enabled) {
      fields["retentionMode"] = lock.mode ?? "none";
      const d = lock.days ?? (lock.years ? lock.years * 365 : undefined);
      if (d !== undefined) fields["retentionDays"] = d;
    }
    const u = usage?.bucketsUsageInfo?.[b.name];
    if (u) {
      fields["sizeBytes"] = u.size ?? 0;
      fields["objects"] = u.objectsCount ?? 0;
    }
    return instance(accountId, "bucket", b.name, b.name, fields);
  }

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "endpoint":
        return [await this.endpointInstance(accountId)];
      case "minio-server": {
        const { info } = await this.minio();
        return (info?.servers ?? []).map((s) => serverInstance(accountId, this.host(), s));
      }
      case "bucket": {
        const [buckets, m] = await Promise.all([this.s3.listBuckets(), this.minio()]);
        return this.mapLimit(buckets, (b) => this.bucketInstance(accountId, b, m.usage));
      }
      case "lifecycle-rule": {
        const buckets = await this.s3.listBuckets();
        const all = await this.mapLimit(buckets, async (b) => {
          try {
            return (await this.s3.getLifecycle(b.name)).map((r) =>
              lifecycleInstance(accountId, b.name, r),
            );
          } catch (err) {
            if (
              unsupported(err) ||
              (err instanceof S3Error && err.code === "NoSuchLifecycleConfiguration")
            )
              return [];
            throw err;
          }
        });
        return all.flat();
      }
      case "cors-rule": {
        const buckets = await this.s3.listBuckets();
        const all = await this.mapLimit(buckets, async (b) => {
          try {
            return (await this.s3.getCors(b.name)).map((r) => corsInstance(accountId, b.name, r));
          } catch (err) {
            if (
              unsupported(err) ||
              (err instanceof S3Error && err.code === "NoSuchCORSConfiguration")
            )
              return [];
            throw err;
          }
        });
        return all.flat();
      }
      default:
        return [];
    }
  }

  private async endpointInstance(accountId: string): Promise<ResourceInstance> {
    const [buckets, server] = await Promise.all([this.s3.listBuckets(), this.server()]);
    const fields: Fields = {
      endpoint: this.cfg.endpoint,
      region: this.cfg.region,
      addressing: this.cfg.pathStyle ? "Path-style" : "Virtual-hosted",
      server,
      bucketCount: buckets.length,
    };
    if (server === "MinIO") {
      const { info, usage, error } = await this.minio();
      if (error) fields["adminApi"] = `Unavailable: ${error.slice(0, 160)}`;
      if (info) {
        fields["adminApi"] = "Connected";
        if (info.mode) fields["minioMode"] = info.mode;
        if (info.deploymentID) fields["deploymentId"] = info.deploymentID;
        const servers = info.servers ?? [];
        const version = servers.find((s) => s.version)?.version;
        if (version) fields["minioVersion"] = version;
        fields["serversTotal"] = servers.length;
        fields["serversOnline"] = servers.filter(
          (s) => (s.state ?? "").toLowerCase() === "online",
        ).length;
        const drives = servers.flatMap((s) => s.drives ?? []);
        fields["drivesTotal"] = drives.length;
        fields["drivesOnline"] = drives.filter(
          (d) => (d.state ?? "").toLowerCase() === "ok",
        ).length;
        if (info.objects?.count !== undefined) fields["objects"] = info.objects.count;
        if (info.usage?.size !== undefined) fields["usedBytes"] = info.usage.size;
      }
      if (usage) {
        if (usage.capacity) fields["capacityBytes"] = usage.capacity;
        if (usage.freeCapacity !== undefined) fields["freeBytes"] = usage.freeCapacity;
        if (usage.objectsCount !== undefined) fields["objects"] = usage.objectsCount;
        if (usage.objectsTotalSize !== undefined) fields["usedBytes"] = usage.objectsTotalSize;
      }
    }
    return instance(accountId, "endpoint", this.host(), this.host(), fields);
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const externalId = externalIdOf(resourceId);
    if (typeId === "bucket") {
      const b = (await this.s3.listBuckets()).find((x) => x.name === externalId);
      if (!b) throw new S3Error(404, "NoSuchBucket", `Bucket ${externalId} not found`);
      return this.bucketInstance(accountId, b, (await this.minio()).usage);
    }
    const found = (await this.listResources(typeId, accountId)).find(
      (r) => r.externalId === externalId,
    );
    if (!found)
      throw new S3Error(404, "NotFound", `S3-compatible plugin: ${typeId} ${externalId} not found`);
    return found;
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    _accountId: string,
  ): Promise<string> {
    const externalId = externalIdOf(resourceId);
    if (outputKey === "endpoint") return this.cfg.endpoint;
    if (outputKey === "region") return this.cfg.region;
    if (typeId === "bucket") {
      if (outputKey === "bucketName") return externalId;
      if (outputKey === "s3Url") return this.s3.url(externalId, undefined).replace(/\/$/, "");
    }
    throw new Error(`S3-compatible plugin: unknown output ${outputKey} on ${typeId}`);
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderS3Detail(resource);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderS3Sidebar(resource);
  }

  async verifyCredentials(): Promise<PreflightResult> {
    const checks: PreflightResult["checks"] = [];
    let server = "";
    try {
      server = await this.server();
      checks.push({ capabilityId: "resources", status: "ok" });
    } catch (err) {
      const s = err instanceof S3Error ? err.status : 0;
      if (s === 401 || s === 403) {
        checks.push({
          capabilityId: "resources",
          status: "missing",
          missingPermissions: [{ id: "s3:ListAllMyBuckets", label: "List buckets" }],
          message: err instanceof Error ? err.message : "",
        });
      } else {
        checks.push({
          capabilityId: "resources",
          status: "unknown",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (server === "MinIO") {
      try {
        await this.admin.info();
        checks.push({ capabilityId: "minio-admin", status: "ok" });
      } catch (err) {
        checks.push({
          capabilityId: "minio-admin",
          status: "missing",
          missingPermissions: [{ id: "admin:ServerInfo", label: "Read server info" }],
          message: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      checks.push({
        capabilityId: "minio-admin",
        status: "unknown",
        message: `Not a MinIO server (${server || "unknown"}).`,
      });
    }
    return { checks, ...(server ? { identity: `${server} at ${this.cfg.endpoint}` } : {}) };
  }

  // ── Create / update / delete ────────────────────────────────────────────

  async getCreateConfig(typeId: string, parentResourceId?: string): Promise<CreateResourceConfig> {
    const bucketPicker = async () =>
      parentResourceId
        ? []
        : [
            {
              key: "bucket",
              label: "Bucket",
              kind: "select" as const,
              required: true,
              options: (await this.s3.listBuckets()).map((b) => ({ id: b.name, label: b.name })),
            },
          ];
    switch (typeId) {
      case "bucket":
        return {
          fields: [
            {
              key: "name",
              label: "Bucket name",
              kind: "text",
              required: true,
              placeholder: "my-bucket",
            },
            {
              key: "versioning",
              label: "Versioning",
              kind: "select",
              required: true,
              defaultValue: "off",
              options: [
                { id: "off", label: "Off" },
                { id: "Enabled", label: "Enabled" },
              ],
            },
            {
              key: "objectLock",
              label: "Object Lock",
              kind: "select",
              required: true,
              defaultValue: "off",
              options: [
                { id: "off", label: "Off" },
                {
                  id: "on",
                  label: "Enabled",
                  description: "Turns versioning on; cannot be turned off",
                },
              ],
            },
            {
              key: "retentionMode",
              label: "Default retention",
              kind: "select",
              required: false,
              defaultValue: "none",
              showWhen: { fieldKey: "objectLock", fieldValue: "on" },
              options: [
                { id: "none", label: "None" },
                { id: "GOVERNANCE", label: "Governance" },
                { id: "COMPLIANCE", label: "Compliance" },
              ],
            },
            {
              key: "retentionDays",
              label: "Retention period (days)",
              kind: "number",
              required: false,
              defaultValue: "30",
              minValue: 1,
              showWhen: {
                allOf: [
                  { fieldKey: "objectLock", fieldValue: "on" },
                  { fieldKey: "retentionMode", fieldValuesNot: ["none"] },
                ],
              },
            },
          ],
        };
      case "lifecycle-rule":
        return {
          fields: [
            ...(await bucketPicker()),
            {
              key: "ruleId",
              label: "Rule ID",
              kind: "text",
              required: true,
              placeholder: "expire-logs",
            },
            { key: "prefix", label: "Prefix", kind: "text", required: false, placeholder: "logs/" },
            {
              key: "expirationDays",
              label: "Expire objects after (days)",
              kind: "number",
              required: false,
              minValue: 1,
            },
            {
              key: "noncurrentDays",
              label: "Expire previous versions after (days)",
              kind: "number",
              required: false,
              minValue: 1,
            },
            {
              key: "abortMultipartDays",
              label: "Abort incomplete uploads after (days)",
              kind: "number",
              required: false,
              minValue: 1,
            },
          ],
        };
      case "cors-rule":
        return {
          fields: [
            ...(await bucketPicker()),
            {
              key: "ruleId",
              label: "Rule ID",
              kind: "text",
              required: true,
              placeholder: "allow-app",
            },
            {
              key: "allowedOrigins",
              label: "Allowed origins",
              kind: "string-list",
              required: true,
              placeholder: "https://app.example.com",
            },
            {
              key: "allowedMethods",
              label: "Allowed methods",
              kind: "policy-picker",
              required: true,
              policies: ["GET", "PUT", "POST", "DELETE", "HEAD"].map((m) => ({ id: m, label: m })),
            },
            {
              key: "allowedHeaders",
              label: "Allowed headers",
              kind: "string-list",
              required: false,
            },
            {
              key: "exposeHeaders",
              label: "Exposed headers",
              kind: "string-list",
              required: false,
            },
            {
              key: "maxAgeSeconds",
              label: "Preflight cache (seconds)",
              kind: "number",
              required: false,
              defaultValue: "3600",
              minValue: 0,
            },
          ],
        };
      default:
        return { fields: [] };
    }
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): Promise<ResourceInstance> {
    const parentBucket = parentResourceId ? externalIdOf(parentResourceId) : "";
    switch (typeId) {
      case "bucket": {
        const name = (fields["name"] ?? "").trim();
        const invalid = validateBucketName(name);
        if (invalid) throw new Error(invalid);
        const lock = fields["objectLock"] === "on";
        await this.s3.createBucket(name, { region: this.cfg.region, objectLock: lock });
        if (!lock && fields["versioning"] === "Enabled")
          await this.s3.putVersioning(name, "Enabled");
        const mode = fields["retentionMode"];
        const d = days(fields["retentionDays"]);
        if (lock && mode && mode !== "none" && d) await this.s3.putObjectLock(name, mode, d);
        return this.bucketInstance(
          accountId,
          { name, creationDate: new Date().toISOString() },
          undefined,
        );
      }
      case "lifecycle-rule": {
        const bucket = fields["bucket"] || parentBucket;
        const rule = lifecycleFromFields(fields);
        const rules = await this.s3.getLifecycle(bucket);
        if (rules.some((r) => r.id === rule.id))
          throw new Error(`A lifecycle rule ${rule.id} already exists on ${bucket}.`);
        await this.s3.putLifecycle(bucket, [...rules, rule]);
        return lifecycleInstance(accountId, bucket, rule);
      }
      case "cors-rule": {
        const bucket = fields["bucket"] || parentBucket;
        const rule = corsFromFields(fields);
        let rules: S3CorsRule[];
        try {
          rules = await this.s3.getCors(bucket);
        } catch (err) {
          if (unsupported(err))
            throw new Error("This server does not support bucket CORS configuration.");
          throw err;
        }
        if (rules.some((r) => r.id === rule.id))
          throw new Error(`A CORS rule ${rule.id} already exists on ${bucket}.`);
        await this.s3.putCors(bucket, [...rules, rule]);
        return corsInstance(accountId, bucket, rule);
      }
      default:
        throw new Error(`S3-compatible plugin: cannot create ${typeId}`);
    }
  }

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const externalId = externalIdOf(resourceId);
    switch (typeId) {
      case "bucket": {
        if (fields["versioning"] === "Enabled" || fields["versioning"] === "Suspended") {
          await this.s3.putVersioning(externalId, fields["versioning"]);
        } else if (fields["versioning"] === "Unversioned") {
          throw new Error("Versioning cannot be turned off once enabled; suspend it instead.");
        }
        if (fields["retentionMode"] !== undefined || fields["retentionDays"] !== undefined) {
          const lock = await this.s3.getObjectLock(externalId);
          if (!lock.enabled)
            throw new Error("Default retention needs a bucket created with Object Lock.");
          const mode = fields["retentionMode"] ?? lock.mode ?? "none";
          const d =
            days(fields["retentionDays"]) ??
            lock.days ??
            (lock.years ? lock.years * 365 : undefined);
          await this.s3.putObjectLock(
            externalId,
            mode === "none" ? undefined : mode,
            mode === "none" ? undefined : (d ?? 1),
          );
        }
        if (fields["tags"] !== undefined)
          await this.s3.putTags(externalId, parseTagString(fields["tags"]));
        return this.getResource(typeId, resourceId, accountId);
      }
      case "lifecycle-rule": {
        const { parent: bucket, key } = splitChild(externalId);
        const rules = await this.s3.getLifecycle(bucket);
        const i = rules.findIndex((r) => r.id === key);
        if (i < 0) throw new S3Error(404, "NoSuchRule", "That lifecycle rule no longer exists.");
        const cur = rules[i]!;
        const next = lifecycleFromFields({
          ruleId: cur.id,
          prefix: cur.prefix,
          enabled: String(cur.enabled),
          expirationDays: cur.expirationDays?.toString() ?? "",
          noncurrentDays: cur.noncurrentDays?.toString() ?? "",
          abortMultipartDays: cur.abortMultipartDays?.toString() ?? "",
          ...fields,
        });
        if (cur.expiredDeleteMarker && !next.expirationDays) next.expiredDeleteMarker = true;
        await this.s3.putLifecycle(
          bucket,
          rules.map((r, j) => (j === i ? next : r)),
        );
        return lifecycleInstance(accountId, bucket, next);
      }
      case "cors-rule": {
        const { parent: bucket, key } = splitChild(externalId);
        const rules = await this.s3.getCors(bucket);
        const i = rules.findIndex((r) => r.id === key);
        if (i < 0) throw new S3Error(404, "NoSuchRule", "That CORS rule no longer exists.");
        const cur = rules[i]!;
        const next = corsFromFields({
          ruleId: cur.id,
          allowedOrigins: cur.allowedOrigins.join(","),
          allowedMethods: cur.allowedMethods.join(","),
          allowedHeaders: cur.allowedHeaders.join(","),
          exposeHeaders: cur.exposeHeaders.join(","),
          maxAgeSeconds: cur.maxAgeSeconds?.toString() ?? "",
          ...fields,
        });
        await this.s3.putCors(
          bucket,
          rules.map((r, j) => (j === i ? next : r)),
        );
        return corsInstance(accountId, bucket, next);
      }
      default:
        throw new Error(`S3-compatible plugin: ${typeId} cannot be edited`);
    }
  }

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    const externalId = externalIdOf(resourceId);
    switch (typeId) {
      case "bucket":
        await this.s3.deleteBucket(externalId);
        return;
      case "lifecycle-rule": {
        const { parent: bucket, key } = splitChild(externalId);
        await this.s3.putLifecycle(
          bucket,
          (await this.s3.getLifecycle(bucket)).filter((r) => r.id !== key),
        );
        return;
      }
      case "cors-rule": {
        const { parent: bucket, key } = splitChild(externalId);
        await this.s3.putCors(
          bucket,
          (await this.s3.getCors(bucket)).filter((r) => r.id !== key),
        );
        return;
      }
      default:
        throw new Error(`S3-compatible plugin: ${typeId} cannot be deleted`);
    }
  }

  // ── Bucket policy (the host's policy editor) ────────────────────────────

  async getManifest(resourceId: string, _accountId: string): Promise<string> {
    const raw = await this.s3.getPolicy(externalIdOf(resourceId));
    if (!raw) return "";
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      return raw;
    }
  }

  async applyManifest(resourceId: string, _accountId: string, manifest: string): Promise<void> {
    await this.s3.putPolicy(externalIdOf(resourceId), manifest);
  }

  // ── Storage browser ─────────────────────────────────────────────────────

  async listStorageObjects(bucket: string, prefix: string): Promise<StorageObject[]> {
    const page = await this.s3.listObjects(bucket, prefix);
    return [
      ...page.folders.map((key) => ({
        key,
        name: key.slice(prefix.length).replace(/\/$/, ""),
        size: 0,
        lastModified: "",
        isDirectory: true,
      })),
      ...page.objects
        .filter((o) => o.key !== prefix)
        .map((o) => ({
          key: o.key,
          name: o.key.slice(prefix.length),
          size: o.size,
          lastModified: o.lastModified,
          isDirectory: false,
        })),
    ];
  }

  async uploadStorageObject(
    bucket: string,
    key: string,
    file: File,
    onProgress?: (pct: number) => void,
  ): Promise<void> {
    await this.s3.putObject(bucket, key, new Uint8Array(await file.arrayBuffer()), file.type);
    onProgress?.(100);
  }

  async makeStorageFolder(bucket: string, key: string): Promise<void> {
    await this.s3.putObject(
      bucket,
      key.endsWith("/") ? key : `${key}/`,
      new Uint8Array(0),
      "application/x-directory",
    );
  }

  async deleteStorageObject(bucket: string, key: string): Promise<void> {
    if (!key.endsWith("/")) return this.s3.deleteObject(bucket, key);
    const all = await this.s3.listObjects(bucket, key, "", 1000);
    const keys = all.objects.map((o) => o.key);
    if (!keys.includes(key)) keys.push(key);
    await this.s3.deleteObjects(bucket, keys);
  }

  // ── Metrics (MinIO only) ────────────────────────────────────────────────

  /**
   * Point-in-time readings from the MinIO admin API. The admin API keeps no
   * history, so each fetch is one point at "now"; the host's metric store
   * builds the series over successive polls.
   */
  async fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
  ): Promise<MetricSeries[]> {
    const { info, usage } = await this.minio();
    if (!info && !usage) return [];
    const now = Date.now();
    const point = (label: string, unit: string, value: number | undefined): MetricSeries[] =>
      value === undefined ? [] : [{ label, unit, points: [{ timestamp: now, value }] }];
    const gib = (b: number | undefined) =>
      b === undefined ? undefined : Math.round((b / 1024 ** 3) * 1000) / 1000;
    if (resourceTypeId === "endpoint") {
      const servers = info?.servers ?? [];
      const drives = servers.flatMap((s) => s.drives ?? []);
      return [
        ...point("Used", "GiB", gib(usage?.objectsTotalSize ?? info?.usage?.size)),
        ...point("Free capacity", "GiB", gib(usage?.freeCapacity)),
        ...point("Objects", "objects", usage?.objectsCount ?? info?.objects?.count),
        ...point("Buckets", "buckets", usage?.bucketsCount ?? info?.buckets?.count),
        ...point(
          "Servers online",
          "servers",
          servers.filter((s) => (s.state ?? "").toLowerCase() === "online").length,
        ),
        ...point(
          "Drives offline",
          "drives",
          drives.filter((d) => (d.state ?? "").toLowerCase() !== "ok").length,
        ),
      ];
    }
    if (resourceTypeId === "minio-server") {
      const s = (info?.servers ?? []).find(
        (x) => x.endpoint === externalIdOf(resourceId).split("/").slice(1).join("/"),
      );
      if (!s) return [];
      const drives = s.drives ?? [];
      return [
        ...point("Drive used", "GiB", gib(drives.reduce((a, d) => a + (d.usedspace ?? 0), 0))),
        ...point(
          "Drives online",
          "drives",
          drives.filter((d) => (d.state ?? "").toLowerCase() === "ok").length,
        ),
        ...point(
          "Uptime",
          "hours",
          s.uptime !== undefined ? Math.round(s.uptime / 36) / 100 : undefined,
        ),
      ];
    }
    if (resourceTypeId === "bucket") {
      const u = usage?.bucketsUsageInfo?.[externalIdOf(resourceId)];
      if (!u) return [];
      return [
        ...point("Size", "GiB", gib(u.size)),
        ...point("Objects", "objects", u.objectsCount),
        ...point("Versions", "versions", u.versionsCount),
      ];
    }
    return [];
  }
}

// ── Mappers ─────────────────────────────────────────────────────────────────

export function serverInstance(
  accountId: string,
  host: string,
  s: NonNullable<MinioInfo["servers"]>[number],
): ResourceInstance {
  const drives = s.drives ?? [];
  const endpoint = s.endpoint ?? "unknown";
  const fields: Fields = {
    endpoint,
    state: s.state ?? "",
    version: s.version ?? "",
    drivesTotal: drives.length,
    drivesOnline: drives.filter((d) => (d.state ?? "").toLowerCase() === "ok").length,
    drivesHealing: drives.filter((d) => d.healing).length,
    usedBytes: drives.reduce((a, d) => a + (d.usedspace ?? 0), 0),
    totalBytes: drives.reduce((a, d) => a + (d.totalspace ?? 0), 0),
    drives: JSON.stringify(
      drives.map((d) => ({
        path: d.path ?? d.endpoint ?? "",
        state: d.state ?? "",
        healing: d.healing === true,
        usedspace: d.usedspace,
        totalspace: d.totalspace,
      })),
    ),
  };
  if (s.edition) fields["edition"] = s.edition;
  if (s.uptime !== undefined) fields["uptimeSeconds"] = s.uptime;
  if (s.poolNumber !== undefined) fields["pool"] = s.poolNumber;
  return instance(accountId, "minio-server", `${host}/${endpoint}`, endpoint, fields, {
    typeId: "endpoint",
    externalId: host,
  });
}

export function lifecycleFromFields(fields: Record<string, string>): S3LifecycleRule {
  const id = (fields["ruleId"] ?? "").trim();
  if (!id || id.length > 255) throw new Error("Give the rule an ID.");
  const rule: S3LifecycleRule = {
    id,
    enabled: bool(fields["enabled"]) !== false,
    prefix: fields["prefix"] ?? "",
  };
  const exp = days(fields["expirationDays"]);
  const nc = days(fields["noncurrentDays"]);
  const abort = days(fields["abortMultipartDays"]);
  if (exp) rule.expirationDays = exp;
  if (nc) rule.noncurrentDays = nc;
  if (abort) rule.abortMultipartDays = abort;
  if (!exp && !nc && !abort)
    throw new Error("Set at least one of the day counts; a rule with none does nothing.");
  return rule;
}

export function corsFromFields(fields: Record<string, string>): S3CorsRule {
  const id = (fields["ruleId"] ?? "").trim();
  if (!id) throw new Error("Give the rule an ID.");
  const allowedOrigins = parsePicked(fields["allowedOrigins"]);
  const allowedMethods = parsePicked(fields["allowedMethods"]).map((m) => m.toUpperCase());
  if (allowedOrigins.length === 0) throw new Error("Add at least one allowed origin.");
  const bad = allowedMethods.filter((m) => !["GET", "PUT", "POST", "DELETE", "HEAD"].includes(m));
  if (allowedMethods.length === 0 || bad.length > 0)
    throw new Error("Allowed methods are GET, PUT, POST, DELETE and HEAD.");
  const age = fields["maxAgeSeconds"] ? Number(fields["maxAgeSeconds"]) : undefined;
  return {
    id,
    allowedOrigins,
    allowedMethods,
    allowedHeaders: parsePicked(fields["allowedHeaders"]),
    exposeHeaders: parsePicked(fields["exposeHeaders"]),
    ...(age !== undefined && Number.isFinite(age)
      ? { maxAgeSeconds: Math.max(0, Math.floor(age)) }
      : {}),
  };
}

export function lifecycleInstance(
  accountId: string,
  bucket: string,
  r: S3LifecycleRule,
): ResourceInstance {
  const fields: Fields = { bucket, ruleId: r.id, prefix: r.prefix, enabled: r.enabled };
  if (r.expirationDays !== undefined) fields["expirationDays"] = r.expirationDays;
  if (r.noncurrentDays !== undefined) fields["noncurrentDays"] = r.noncurrentDays;
  if (r.abortMultipartDays !== undefined) fields["abortMultipartDays"] = r.abortMultipartDays;
  return instance(accountId, "lifecycle-rule", `${bucket}/${r.id}`, r.id, fields, {
    typeId: "bucket",
    externalId: bucket,
  });
}

export function corsInstance(accountId: string, bucket: string, r: S3CorsRule): ResourceInstance {
  return instance(
    accountId,
    "cors-rule",
    `${bucket}/${r.id}`,
    r.id,
    {
      bucket,
      ruleId: r.id,
      allowedOrigins: r.allowedOrigins.join(", "),
      allowedMethods: r.allowedMethods.join(", "),
      allowedHeaders: r.allowedHeaders.join(", "),
      exposeHeaders: r.exposeHeaders.join(", "),
      ...(r.maxAgeSeconds !== undefined ? { maxAgeSeconds: r.maxAgeSeconds } : {}),
    },
    { typeId: "bucket", externalId: bucket },
  );
}
