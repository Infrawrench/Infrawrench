import type {
  CostFetchRange,
  CostRow,
  CreateFieldConfig,
  CreateResourceConfig,
  CredentialExport,
  DetailViewSchema,
  HostServices,
  MetricSeries,
  PluginClient,
  PreflightResult,
  ResourceCreateReturn,
  ResourceInstance,
  SelectOption,
  SidebarItemSchema,
  StorageObject,
} from "@infrawrench/plugin-base";
import { externalIdOf } from "@infrawrench/plugin-base";
import type { B2Session } from "./api.js";
import { B2Api, B2ApiError, coarseRegionOf, s3RegionOf, statusOf } from "./api.js";
import {
  bucketInstance,
  corsInstance,
  instance,
  keyInstance,
  lifecycleInstance,
  notificationInstance,
  parseHeaders,
  parsePicked,
  replicationInstance,
  splitChildId,
  splitList,
} from "./mappers.js";
import { verifyB2Credentials } from "./preflight.js";
import { renderB2Detail, renderB2Sidebar } from "./render.js";
import { B2Storage } from "./storage.js";
import type {
  B2Bucket,
  B2CorsRule,
  B2CreatedKey,
  B2Key,
  B2LifecycleRule,
  B2NotificationRule,
  B2ReplicationConfiguration,
  B2ReplicationRule,
} from "./types.js";
import { CORS_OPERATIONS, EVENT_TYPES, KEY_CAPABILITIES, unwrapReplication } from "./types.js";
import {
  DEFAULT_METRICS_WINDOW_MS,
  UsageReports,
  fetchB2CostData,
  reportsBucketName,
  usageSeries,
} from "./usage.js";

const BUCKET_CACHE_MS = 30_000;
const APPLICATION_KEY_FIELD = "applicationKey";

const RW_CAPABILITIES = [
  "listBuckets",
  "listFiles",
  "readFiles",
  "writeFiles",
  "deleteFiles",
  "shareFiles",
];
const RO_CAPABILITIES = ["listBuckets", "listFiles", "readFiles", "shareFiles"];

function numOrUndefined(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`"${raw}" is not a number of days.`);
  return Math.floor(n);
}

function bool(raw: string | undefined): boolean | undefined {
  if (raw === undefined || raw === "") return undefined;
  return raw === "true" || raw === "on" || raw === "yes" || raw === "1";
}

/** Key names: letters, digits and hyphens, at most 100 characters. */
export function keyNameFor(base: string): string {
  const cleaned = base
    .replace(/[^A-Za-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return cleaned.slice(0, 100) || "infrawrench";
}

export function validateBucketName(name: string): string | null {
  if (!/^[a-z0-9-]{6,50}$/i.test(name)) {
    return "Bucket names are 6 to 50 characters of letters, digits and hyphens.";
  }
  if (/^b2-/i.test(name)) return "Bucket names starting with b2- are reserved by Backblaze.";
  return null;
}

function parentExternal(parentResourceId: string | undefined): string {
  return parentResourceId ? externalIdOf(parentResourceId) : "";
}

export class BackblazeB2Client implements PluginClient {
  readonly api: B2Api;
  private readonly storage: B2Storage;
  private readonly reports: UsageReports;
  private bucketsCache: { at: number; value: Promise<B2Bucket[]> } | undefined;

  constructor(
    credentials: Record<string, string>,
    private readonly services?: HostServices,
  ) {
    const keyId = (credentials["applicationKeyId"] ?? "").trim();
    const key = (credentials["applicationKey"] ?? "").trim();
    if (!keyId || !key) {
      throw new Error("Backblaze B2 plugin: missing applicationKeyId or applicationKey credential");
    }
    const caCert = credentials["caCert"] ?? "";
    this.api = new B2Api({
      keyId,
      key,
      ...(caCert ? { caCert } : {}),
      ...(services?.http ? { http: services.http } : {}),
    });
    this.storage = new B2Storage(this.api);
    this.reports = new UsageReports(this.api);
  }

  // ── Buckets ─────────────────────────────────────────────────────────────

  private invalidate(): void {
    this.bucketsCache = undefined;
  }

  async listBuckets(): Promise<B2Bucket[]> {
    if (this.bucketsCache && Date.now() - this.bucketsCache.at < BUCKET_CACHE_MS) {
      return this.bucketsCache.value;
    }
    const value = (async () => {
      const s = await this.api.getSession();
      const res = await this.api.call<{ buckets?: B2Bucket[] }>("b2_list_buckets", {
        body: { accountId: s.accountId },
      });
      return (res?.buckets ?? []).sort((a, b) => a.bucketName.localeCompare(b.bucketName));
    })();
    this.bucketsCache = { at: Date.now(), value };
    value.catch(() => {
      this.bucketsCache = undefined;
    });
    return value;
  }

  private async getBucket(bucketId: string): Promise<B2Bucket> {
    const s = await this.api.getSession();
    const res = await this.api.call<{ buckets?: B2Bucket[] }>("b2_list_buckets", {
      body: { accountId: s.accountId, bucketId },
    });
    const bucket = res?.buckets?.find((b) => b.bucketId === bucketId);
    if (!bucket)
      throw new B2ApiError(404, "not_found", `Backblaze B2: bucket ${bucketId} not found`);
    return bucket;
  }

  private bucketCtx(s: B2Session): { s3Region: string; region: string } {
    const s3Region = s3RegionOf(s.s3ApiUrl);
    return { s3Region, region: coarseRegionOf(s3Region) };
  }

  /** Read-modify-write a bucket, guarded by its revision. */
  private async updateBucket(
    bucketId: string,
    mutate: (b: B2Bucket) => Record<string, unknown>,
  ): Promise<B2Bucket> {
    const s = await this.api.getSession();
    const current = await this.getBucket(bucketId);
    const changes = mutate(current);
    const updated = await this.api.call<B2Bucket>("b2_update_bucket", {
      body: {
        accountId: s.accountId,
        bucketId,
        ...changes,
        ...(current.revision !== undefined ? { ifRevisionIs: Number(current.revision) } : {}),
      },
    });
    this.invalidate();
    return updated;
  }

  // ── Listing ─────────────────────────────────────────────────────────────

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "account":
        return [await this.accountInstance(accountId)];
      case "bucket": {
        const s = await this.api.getSession();
        const ctx = this.bucketCtx(s);
        return (await this.listBuckets()).map((b) => bucketInstance(accountId, b, ctx));
      }
      case "lifecycle-rule":
        return (await this.listBuckets()).flatMap((b) =>
          (b.lifecycleRules ?? []).map((r) => lifecycleInstance(accountId, b, r)),
        );
      case "cors-rule":
        return (await this.listBuckets()).flatMap((b) =>
          (b.corsRules ?? []).map((r) => corsInstance(accountId, b, r)),
        );
      case "replication-rule": {
        const buckets = await this.listBuckets();
        const names = new Map(buckets.map((b) => [b.bucketId, b.bucketName]));
        return buckets.flatMap((b) =>
          (
            unwrapReplication(b.replicationConfiguration).asReplicationSource?.replicationRules ??
            []
          ).map((r) => replicationInstance(accountId, b, r, names)),
        );
      }
      case "notification-rule": {
        const out: ResourceInstance[] = [];
        for (const b of await this.listBuckets()) {
          try {
            const rules = await this.getNotificationRules(b.bucketId);
            out.push(
              ...rules.map((r) => notificationInstance(accountId, b.bucketId, b.bucketName, r)),
            );
          } catch (err) {
            // A key without readBucketNotifications lists none rather than failing the pass.
            if (statusOf(err) === 401 || statusOf(err) === 403) return out;
            throw err;
          }
        }
        return out;
      }
      case "application-key": {
        const [keys, buckets] = await Promise.all([this.listKeys(), this.listBuckets()]);
        const names = new Map(buckets.map((b) => [b.bucketId, b.bucketName]));
        return keys.map((k) => keyInstance(accountId, k, names));
      }
      default:
        return [];
    }
  }

  private async accountInstance(accountId: string): Promise<ResourceInstance> {
    const s = await this.api.getSession();
    const ctx = this.bucketCtx(s);
    let buckets: B2Bucket[] = [];
    try {
      buckets = await this.listBuckets();
    } catch (err) {
      if (statusOf(err) !== 401 && statusOf(err) !== 403) throw err;
    }
    const reports = buckets.some((b) => b.bucketName === reportsBucketName(s.accountId));
    return instance(accountId, "account", s.accountId, `B2 account ${s.accountId}`, {
      accountId: s.accountId,
      region: ctx.region,
      s3Region: ctx.s3Region,
      s3Endpoint: s.s3ApiUrl,
      capabilities: s.capabilities.join(", "),
      keyRestrictedTo: s.allowedBuckets
        ? s.allowedBuckets.map((b) => b.name || b.id).join(", ")
        : "",
      namePrefix: s.namePrefix,
      keyExpiresAt: s.keyExpiresAt ? new Date(s.keyExpiresAt).toISOString() : "",
      bucketCount: buckets.filter((b) => b.bucketName !== reportsBucketName(s.accountId)).length,
      usageReports: reports ? "Enabled" : "Not enabled (ask Backblaze support)",
    });
  }

  private async listKeys(): Promise<B2Key[]> {
    const s = await this.api.getSession();
    const out: B2Key[] = [];
    let start: string | undefined;
    for (let page = 0; page < 50; page++) {
      const res = await this.api.call<{ keys?: B2Key[]; nextApplicationKeyId?: string | null }>(
        "b2_list_keys",
        {
          method: "GET",
          query: { accountId: s.accountId, maxKeyCount: 1000, startApplicationKeyId: start },
        },
      );
      out.push(...(res?.keys ?? []));
      start = res?.nextApplicationKeyId ?? undefined;
      if (!start) break;
    }
    return out;
  }

  private async getNotificationRules(bucketId: string): Promise<B2NotificationRule[]> {
    const res = await this.api.call<{ eventNotificationRules?: B2NotificationRule[] }>(
      "b2_get_bucket_notification_rules",
      { method: "GET", query: { bucketId } },
    );
    return res?.eventNotificationRules ?? [];
  }

  private async setNotificationRules(bucketId: string, rules: B2NotificationRule[]): Promise<void> {
    await this.api.call<unknown>("b2_set_bucket_notification_rules", {
      body: {
        bucketId,
        eventNotificationRules: rules.map((r) => ({
          name: r.name,
          eventTypes: r.eventTypes,
          isEnabled: r.isEnabled,
          objectNamePrefix: r.objectNamePrefix ?? "",
          ...(r.maxEventsPerBatch ? { maxEventsPerBatch: r.maxEventsPerBatch } : {}),
          targetConfiguration: {
            targetType: "webhook",
            url: r.targetConfiguration.url,
            ...(r.targetConfiguration.hmacSha256SigningSecret
              ? { hmacSha256SigningSecret: r.targetConfiguration.hmacSha256SigningSecret }
              : {}),
            ...(r.targetConfiguration.customHeaders?.length
              ? { customHeaders: r.targetConfiguration.customHeaders }
              : {}),
          },
        })),
      },
    });
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const externalId = externalIdOf(resourceId);
    if (typeId === "bucket") {
      const s = await this.api.getSession();
      return bucketInstance(accountId, await this.getBucket(externalId), this.bucketCtx(s));
    }
    const all = await this.listResources(typeId, accountId);
    const found = all.find((r) => r.externalId === externalId || r.id === resourceId);
    if (!found) {
      throw new B2ApiError(
        404,
        "not_found",
        `Backblaze B2 plugin: ${typeId} ${externalId} not found`,
      );
    }
    return found;
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    const s = await this.api.getSession();
    const externalId = externalIdOf(resourceId);
    if (typeId === "account") {
      switch (outputKey) {
        case "accountId":
          return s.accountId;
        case "s3Endpoint":
          return s.s3ApiUrl;
        case "s3Region":
          return s3RegionOf(s.s3ApiUrl);
        case "downloadUrl":
          return s.downloadUrl;
      }
    }
    if (typeId === "bucket") {
      const r = await this.getResource(typeId, resourceId, accountId);
      const name = String(r.fields["name"] ?? "");
      const region = s3RegionOf(s.s3ApiUrl);
      switch (outputKey) {
        case "bucketName":
          return name;
        case "bucketId":
          return externalId;
        case "s3Endpoint":
          return s.s3ApiUrl;
        case "s3Region":
          return region;
        case "friendlyUrl":
          return `${s.downloadUrl}/file/${name}`;
        case "s3Url":
          return `https://${name}.s3.${region}.backblazeb2.com`;
      }
    }
    if (typeId === "application-key") {
      if (outputKey === "applicationKeyId") return externalId;
      if (outputKey === APPLICATION_KEY_FIELD) {
        const secret = await this.services?.secrets?.getPlaintext(
          resourceId,
          APPLICATION_KEY_FIELD,
        );
        if (!secret) {
          throw new Error(
            "B2 only shows an application key's secret when it is created, and this key was not created from Infrawrench. Create a new key to get one.",
          );
        }
        return secret;
      }
    }
    if (typeId === "notification-rule" && outputKey === "signingSecret") {
      const { bucketId, key } = splitChildId(externalId);
      const rule = (await this.getNotificationRules(bucketId)).find((r) => r.name === key);
      return rule?.targetConfiguration.hmacSha256SigningSecret ?? "";
    }
    throw new Error(`Backblaze B2 plugin: unknown output ${outputKey} on ${typeId}`);
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderB2Detail(resource);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderB2Sidebar(resource);
  }

  verifyCredentials(): Promise<PreflightResult> {
    return verifyB2Credentials(this.api);
  }

  // ── Create ──────────────────────────────────────────────────────────────

  private async bucketOptions(): Promise<SelectOption[]> {
    const s = await this.api.getSession();
    return (await this.listBuckets())
      .filter((b) => b.bucketName !== reportsBucketName(s.accountId))
      .map((b) => ({ id: b.bucketId, label: b.bucketName }));
  }

  private async bucketField(
    parentResourceId: string | undefined,
    label = "Bucket",
  ): Promise<CreateFieldConfig[]> {
    if (parentResourceId) return [];
    return [
      {
        key: "bucketId",
        label,
        kind: "select",
        required: true,
        options: await this.bucketOptions(),
      },
    ];
  }

  async getCreateConfig(typeId: string, parentResourceId?: string): Promise<CreateResourceConfig> {
    switch (typeId) {
      case "bucket":
        return {
          fields: [
            {
              key: "name",
              label: "Bucket name",
              kind: "text",
              required: true,
              placeholder: "my-backups",
              description: "Globally unique across B2. 6 to 50 letters, digits and hyphens.",
            },
            {
              key: "bucketType",
              label: "Files in bucket are",
              kind: "select",
              required: true,
              defaultValue: "allPrivate",
              options: [
                { id: "allPrivate", label: "Private", description: "Downloads need authorization" },
                {
                  id: "allPublic",
                  label: "Public",
                  description: "Anyone with the URL can download",
                },
              ],
            },
            {
              key: "encryption",
              label: "Default encryption",
              kind: "select",
              required: true,
              defaultValue: "SSE-B2",
              options: [
                {
                  id: "SSE-B2",
                  label: "Enable (SSE-B2)",
                  description: "AES-256, keys managed by Backblaze",
                },
                { id: "none", label: "Disable" },
              ],
            },
            {
              key: "versions",
              label: "Keep file versions",
              kind: "select",
              required: true,
              defaultValue: "all",
              options: [
                { id: "all", label: "Keep all versions" },
                { id: "latest", label: "Keep only the last version" },
                { id: "30", label: "Keep prior versions for 30 days" },
                { id: "90", label: "Keep prior versions for 90 days" },
              ],
              description: "Adds a lifecycle rule for every file. You can change it later.",
            },
            {
              key: "objectLock",
              label: "Object Lock",
              kind: "select",
              required: true,
              defaultValue: "off",
              options: [
                { id: "off", label: "Disabled" },
                { id: "on", label: "Enabled", description: "Cannot be turned off later" },
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
                {
                  id: "governance",
                  label: "Governance",
                  description: "Keys with bypassGovernance can override",
                },
                {
                  id: "compliance",
                  label: "Compliance",
                  description: "Nobody can shorten or remove it",
                },
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
            ...(await this.bucketField(parentResourceId)),
            {
              key: "fileNamePrefix",
              label: "File name prefix",
              kind: "text",
              required: false,
              placeholder: "logs/",
              description: "Leave empty to apply to every file. One rule per prefix.",
            },
            {
              key: "daysFromUploadingToHiding",
              label: "Hide files after (days since upload)",
              kind: "number",
              required: false,
              minValue: 1,
            },
            {
              key: "daysFromHidingToDeleting",
              label: "Delete hidden versions after (days)",
              kind: "number",
              required: false,
              minValue: 1,
              description: "1 keeps only the newest version of each file.",
            },
            {
              key: "daysFromStartingToCancelingUnfinishedLargeFiles",
              label: "Cancel unfinished large-file uploads after (days)",
              kind: "number",
              required: false,
              minValue: 1,
            },
          ],
        };
      case "cors-rule":
        return {
          fields: [
            ...(await this.bucketField(parentResourceId)),
            {
              key: "corsRuleName",
              label: "Name",
              kind: "text",
              required: true,
              placeholder: "allow-my-app",
              description: "6 to 63 letters, digits and hyphens.",
            },
            {
              key: "allowedOrigins",
              label: "Allowed origins",
              kind: "string-list",
              required: true,
              placeholder: "https://app.example.com",
            },
            {
              key: "allowedOperations",
              label: "Allowed operations",
              kind: "policy-picker",
              required: true,
              policies: CORS_OPERATIONS,
            },
            {
              key: "allowedHeaders",
              label: "Allowed headers",
              kind: "string-list",
              required: false,
              placeholder: "authorization",
            },
            {
              key: "exposeHeaders",
              label: "Exposed headers",
              kind: "string-list",
              required: false,
              placeholder: "x-bz-content-sha1",
            },
            {
              key: "maxAgeSeconds",
              label: "Preflight cache (seconds)",
              kind: "number",
              required: true,
              defaultValue: "3600",
              minValue: 0,
              maxValue: 86400,
            },
          ],
        };
      case "replication-rule": {
        const buckets = await this.bucketOptions();
        const source = parentExternal(parentResourceId);
        return {
          fields: [
            ...(await this.bucketField(parentResourceId, "Source bucket")),
            {
              key: "replicationRuleName",
              label: "Name",
              kind: "text",
              required: true,
              placeholder: "to-backup-bucket",
            },
            {
              key: "destinationBucketId",
              label: "Destination bucket",
              kind: "select",
              required: true,
              options: buckets.filter((b) => b.id !== source),
            },
            {
              key: "fileNamePrefix",
              label: "Only files starting with",
              kind: "text",
              required: false,
            },
            {
              key: "priority",
              label: "Priority",
              kind: "number",
              required: false,
              defaultValue: "1",
              minValue: 1,
            },
            {
              key: "includeExistingFiles",
              label: "Existing files",
              kind: "select",
              required: true,
              defaultValue: "false",
              options: [
                { id: "false", label: "Only replicate new files" },
                { id: "true", label: "Also replicate existing files" },
              ],
            },
          ],
        };
      }
      case "notification-rule":
        return {
          fields: [
            ...(await this.bucketField(parentResourceId)),
            { key: "name", label: "Name", kind: "text", required: true, placeholder: "on-upload" },
            {
              key: "url",
              label: "Webhook URL",
              kind: "text",
              required: true,
              placeholder: "https://hooks.example.com/b2",
            },
            {
              key: "eventTypes",
              label: "Events",
              kind: "policy-picker",
              required: true,
              policies: EVENT_TYPES,
            },
            {
              key: "objectNamePrefix",
              label: "Only objects starting with",
              kind: "text",
              required: false,
            },
            {
              key: "maxEventsPerBatch",
              label: "Events per webhook call",
              kind: "number",
              required: false,
              defaultValue: "1",
              minValue: 1,
              maxValue: 50,
            },
            {
              key: "customHeaders",
              label: "Custom headers",
              kind: "string-list",
              required: false,
              placeholder: "X-Api-Key=secret",
              description: "Name=Value, at most 10.",
            },
          ],
        };
      case "application-key":
        return {
          fields: [
            {
              key: "keyName",
              label: "Name",
              kind: "text",
              required: true,
              placeholder: "ci-uploads",
              description: "Letters, digits and hyphens.",
            },
            {
              key: "capabilities",
              label: "Capabilities",
              kind: "policy-picker",
              required: true,
              policies: KEY_CAPABILITIES,
            },
            {
              key: "bucketIds",
              label: "Limit to buckets",
              kind: "policy-picker",
              required: false,
              policies: (await this.bucketOptions()).map((b) => ({
                id: b.id,
                label: b.label,
                category: "Buckets",
              })),
              description: "Leave empty for every bucket.",
            },
            {
              key: "namePrefix",
              label: "Limit to files starting with",
              kind: "text",
              required: false,
            },
            {
              key: "validDays",
              label: "Expires after (days)",
              kind: "number",
              required: false,
              minValue: 1,
              maxValue: 1000,
              description: "Leave empty for a key that never expires.",
            },
          ],
        };
      default:
        return { fields: [] };
    }
  }

  private bucketFor(fields: Record<string, string>, parentResourceId?: string): string {
    const id = fields["bucketId"] || parentExternal(parentResourceId);
    if (!id) throw new Error("Pick a bucket.");
    return id;
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): Promise<ResourceCreateReturn> {
    const s = await this.api.getSession();
    switch (typeId) {
      case "bucket": {
        const name = (fields["name"] ?? "").trim();
        const invalid = validateBucketName(name);
        if (invalid) throw new Error(invalid);
        const versions = fields["versions"] ?? "all";
        const lifecycleRules: B2LifecycleRule[] =
          versions === "all"
            ? []
            : [
                {
                  fileNamePrefix: "",
                  daysFromHidingToDeleting: versions === "latest" ? 1 : Number(versions),
                  daysFromUploadingToHiding: null,
                },
              ];
        const lock = fields["objectLock"] === "on";
        const mode = fields["retentionMode"] ?? "none";
        const days = numOrUndefined(fields["retentionDays"]);
        const created = await this.api.call<B2Bucket>("b2_create_bucket", {
          body: {
            accountId: s.accountId,
            bucketName: name,
            bucketType: fields["bucketType"] === "allPublic" ? "allPublic" : "allPrivate",
            lifecycleRules,
            ...(fields["encryption"] === "SSE-B2"
              ? { defaultServerSideEncryption: { mode: "SSE-B2", algorithm: "AES256" } }
              : {}),
            ...(lock ? { fileLockEnabled: true } : {}),
          },
        });
        let bucket = created;
        if (lock && mode !== "none" && days) {
          bucket = await this.updateBucket(created.bucketId, () => ({
            defaultRetention: { mode, period: { duration: days, unit: "days" } },
          }));
        }
        this.invalidate();
        return bucketInstance(accountId, bucket, this.bucketCtx(s));
      }
      case "lifecycle-rule": {
        const bucketId = this.bucketFor(fields, parentResourceId);
        const rule = lifecycleFromFields(fields);
        const bucket = await this.updateBucket(bucketId, (b) => {
          const rules = b.lifecycleRules ?? [];
          if (rules.some((r) => (r.fileNamePrefix ?? "") === rule.fileNamePrefix)) {
            throw new Error(
              `This bucket already has a lifecycle rule for "${rule.fileNamePrefix}". Edit that one instead.`,
            );
          }
          return { lifecycleRules: [...rules, rule] };
        });
        return lifecycleInstance(accountId, bucket, rule);
      }
      case "cors-rule": {
        const bucketId = this.bucketFor(fields, parentResourceId);
        const rule = corsFromFields(fields);
        const bucket = await this.updateBucket(bucketId, (b) => {
          const rules = b.corsRules ?? [];
          if (rules.some((r) => r.corsRuleName === rule.corsRuleName)) {
            throw new Error(
              `A CORS rule named ${rule.corsRuleName} already exists on this bucket.`,
            );
          }
          return { corsRules: [...rules, rule] };
        });
        return corsInstance(accountId, bucket, rule);
      }
      case "replication-rule":
        return this.createReplicationRule(accountId, fields, parentResourceId);
      case "notification-rule": {
        const bucketId = this.bucketFor(fields, parentResourceId);
        const bucket = await this.getBucket(bucketId);
        const rule = notificationFromFields(fields);
        const rules = await this.getNotificationRules(bucketId);
        if (rules.some((r) => r.name === rule.name)) {
          throw new Error(
            `An event notification named ${rule.name} already exists on this bucket.`,
          );
        }
        await this.setNotificationRules(bucketId, [...rules, rule]);
        return notificationInstance(accountId, bucketId, bucket.bucketName, rule);
      }
      case "application-key":
        return this.createApplicationKey(accountId, fields);
      default:
        throw new Error(`Backblaze B2 plugin: cannot create ${typeId}`);
    }
  }

  private async mintKey(body: {
    keyName: string;
    capabilities: string[];
    bucketIds?: string[];
    namePrefix?: string;
    validDurationInSeconds?: number;
  }): Promise<B2CreatedKey> {
    const s = await this.api.getSession();
    return this.api.call<B2CreatedKey>("b2_create_key", {
      body: { accountId: s.accountId, ...body },
    });
  }

  private async createApplicationKey(
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceCreateReturn> {
    const keyName = keyNameFor((fields["keyName"] ?? "").trim());
    const capabilities = parsePicked(fields["capabilities"]);
    if (capabilities.length === 0) throw new Error("Pick at least one capability.");
    const bucketIds = parsePicked(fields["bucketIds"]);
    const days = numOrUndefined(fields["validDays"]);
    const created = await this.mintKey({
      keyName,
      capabilities,
      ...(bucketIds.length > 0 ? { bucketIds } : {}),
      ...(fields["namePrefix"] ? { namePrefix: fields["namePrefix"] } : {}),
      ...(days ? { validDurationInSeconds: days * 86_400 } : {}),
    });
    const buckets = await this.listBuckets();
    const resource = keyInstance(
      accountId,
      created,
      new Map(buckets.map((b) => [b.bucketId, b.bucketName])),
    );
    const secrets = this.services?.secrets;
    if (secrets?.setPlaintext) {
      await secrets.setPlaintext(resource.id, APPLICATION_KEY_FIELD, created.applicationKey);
      return resource;
    }
    return {
      resource,
      warnings: [
        {
          code: "secret-not-stored",
          message:
            "The key was created, but this host cannot store its secret, and B2 never shows it again. Use Get credentials on a bucket instead to see a new key's secret.",
        },
      ],
    };
  }

  private async createReplicationRule(
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): Promise<ResourceInstance> {
    const sourceId = this.bucketFor(fields, parentResourceId);
    const destId = fields["destinationBucketId"] ?? "";
    if (!destId) throw new Error("Pick a destination bucket.");
    if (destId === sourceId) throw new Error("A bucket cannot replicate to itself.");
    const name = (fields["replicationRuleName"] ?? "").trim();
    if (!/^[A-Za-z0-9-]{1,64}$/.test(name)) {
      throw new Error("Rule names are letters, digits and hyphens.");
    }
    const [source, dest] = await Promise.all([this.getBucket(sourceId), this.getBucket(destId)]);
    const sourceRepl = unwrapReplication(source.replicationConfiguration);
    const existing = sourceRepl.asReplicationSource?.replicationRules ?? [];
    if (existing.some((r) => r.replicationRuleName === name)) {
      throw new Error(`A replication rule named ${name} already exists on this bucket.`);
    }
    if (existing.length >= 2)
      throw new Error("B2 allows at most two replication rules per source bucket.");

    // 1. The source bucket's replication key: reuse it, or mint one limited to the source.
    let sourceKeyId = sourceRepl.asReplicationSource?.sourceApplicationKeyId ?? "";
    if (!sourceKeyId) {
      const key = await this.mintKey({
        keyName: keyNameFor(`replication-src-${source.bucketName}`),
        capabilities: ["readFiles", "readFileLegalHolds", "readFileRetentions"],
        bucketIds: [sourceId],
      });
      sourceKeyId = key.applicationKeyId;
    }
    // 2. The destination maps that key to a key allowed to write there.
    const destRepl = unwrapReplication(dest.replicationConfiguration);
    const mapping = { ...(destRepl.asReplicationDestination?.sourceToDestinationKeyMapping ?? {}) };
    if (!mapping[sourceKeyId]) {
      const key = await this.mintKey({
        keyName: keyNameFor(`replication-dst-${dest.bucketName}`),
        capabilities: ["writeFiles", "writeFileLegalHolds", "writeFileRetentions"],
        bucketIds: [destId],
      });
      mapping[sourceKeyId] = key.applicationKeyId;
      await this.updateBucket(destId, (b) => ({
        replicationConfiguration: {
          ...replicationBody(unwrapReplication(b.replicationConfiguration)),
          asReplicationDestination: { sourceToDestinationKeyMapping: mapping },
        },
      }));
    }
    // 3. The rule itself on the source.
    const rule: B2ReplicationRule = {
      replicationRuleName: name,
      destinationBucketId: destId,
      fileNamePrefix: fields["fileNamePrefix"] ?? "",
      priority: numOrUndefined(fields["priority"]) ?? 1,
      isEnabled: true,
      includeExistingFiles: fields["includeExistingFiles"] === "true",
    };
    const updated = await this.updateBucket(sourceId, (b) => {
      const repl = unwrapReplication(b.replicationConfiguration);
      return {
        replicationConfiguration: {
          ...replicationBody(repl),
          asReplicationSource: {
            sourceApplicationKeyId: sourceKeyId,
            replicationRules: [...(repl.asReplicationSource?.replicationRules ?? []), rule],
          },
        },
      };
    });
    return replicationInstance(accountId, updated, rule, new Map([[destId, dest.bucketName]]));
  }

  // ── Update ──────────────────────────────────────────────────────────────

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const externalId = externalIdOf(resourceId);
    const s = await this.api.getSession();
    switch (typeId) {
      case "bucket": {
        const bucket = await this.updateBucket(externalId, (b) => {
          const changes: Record<string, unknown> = {};
          if (fields["bucketType"]) changes["bucketType"] = fields["bucketType"];
          if (fields["encryption"] !== undefined) {
            changes["defaultServerSideEncryption"] =
              fields["encryption"] === "SSE-B2"
                ? { mode: "SSE-B2", algorithm: "AES256" }
                : { mode: null };
          }
          const lockOn = b.fileLockConfiguration?.value?.isFileLockEnabled;
          const locked = lockOn === true || lockOn === "true";
          if (fields["objectLock"] !== undefined) {
            const want = bool(fields["objectLock"]);
            if (want === false && locked)
              throw new Error("Object Lock cannot be turned off once it is enabled.");
            if (want && !locked) changes["fileLockEnabled"] = true;
          }
          if (fields["retentionMode"] !== undefined || fields["retentionDays"] !== undefined) {
            const current = b.fileLockConfiguration?.value?.defaultRetention;
            const mode = fields["retentionMode"] ?? current?.mode ?? "none";
            const days =
              numOrUndefined(fields["retentionDays"]) ??
              (current?.period?.unit === "years"
                ? (current.period.duration ?? 0) * 365
                : current?.period?.duration);
            changes["defaultRetention"] =
              mode === "none" || !mode
                ? { mode: null }
                : { mode, period: { duration: days ?? 1, unit: "days" } };
          }
          if (fields["cacheControl"] !== undefined) {
            const info = Object.fromEntries(
              Object.entries(b.bucketInfo ?? {}).filter(
                ([k]) => k.toLowerCase() !== "cache-control",
              ),
            );
            if (fields["cacheControl"].trim())
              info["Cache-Control"] = fields["cacheControl"].trim();
            changes["bucketInfo"] = info;
          }
          return changes;
        });
        return bucketInstance(accountId, bucket, this.bucketCtx(s));
      }
      case "lifecycle-rule": {
        const { bucketId, key } = splitChildId(externalId);
        let next: B2LifecycleRule | undefined;
        const bucket = await this.updateBucket(bucketId, (b) => {
          const rules = b.lifecycleRules ?? [];
          const i = rules.findIndex((r) => (r.fileNamePrefix ?? "") === key);
          if (i < 0)
            throw new B2ApiError(404, "not_found", "That lifecycle rule no longer exists.");
          next = mergeLifecycle(rules[i]!, fields);
          return { lifecycleRules: rules.map((r, j) => (j === i ? next! : r)) };
        });
        return lifecycleInstance(accountId, bucket, next!);
      }
      case "cors-rule": {
        const { bucketId, key } = splitChildId(externalId);
        let next: B2CorsRule | undefined;
        const bucket = await this.updateBucket(bucketId, (b) => {
          const rules = b.corsRules ?? [];
          const i = rules.findIndex((r) => r.corsRuleName === key);
          if (i < 0) throw new B2ApiError(404, "not_found", "That CORS rule no longer exists.");
          next = mergeCors(rules[i]!, fields);
          return { corsRules: rules.map((r, j) => (j === i ? next! : r)) };
        });
        return corsInstance(accountId, bucket, next!);
      }
      case "replication-rule": {
        const { bucketId, key } = splitChildId(externalId);
        let next: B2ReplicationRule | undefined;
        const bucket = await this.updateBucket(bucketId, (b) => {
          const repl = unwrapReplication(b.replicationConfiguration);
          const rules = repl.asReplicationSource?.replicationRules ?? [];
          const i = rules.findIndex((r) => r.replicationRuleName === key);
          if (i < 0)
            throw new B2ApiError(404, "not_found", "That replication rule no longer exists.");
          const cur = rules[i]!;
          next = {
            ...cur,
            ...(fields["fileNamePrefix"] !== undefined
              ? { fileNamePrefix: fields["fileNamePrefix"] }
              : {}),
            ...(fields["priority"] !== undefined
              ? { priority: numOrUndefined(fields["priority"]) ?? 1 }
              : {}),
            ...(fields["isEnabled"] !== undefined
              ? { isEnabled: bool(fields["isEnabled"]) !== false }
              : {}),
          };
          return {
            replicationConfiguration: {
              ...replicationBody(repl),
              asReplicationSource: {
                ...repl.asReplicationSource,
                replicationRules: rules.map((r, j) => (j === i ? next! : r)),
              },
            },
          };
        });
        const buckets = await this.listBuckets();
        return replicationInstance(
          accountId,
          bucket,
          next!,
          new Map(buckets.map((b) => [b.bucketId, b.bucketName])),
        );
      }
      case "notification-rule": {
        const { bucketId, key } = splitChildId(externalId);
        const bucket = await this.getBucket(bucketId);
        const rules = await this.getNotificationRules(bucketId);
        const i = rules.findIndex((r) => r.name === key);
        if (i < 0)
          throw new B2ApiError(404, "not_found", "That event notification no longer exists.");
        const next = mergeNotification(rules[i]!, fields);
        await this.setNotificationRules(
          bucketId,
          rules.map((r, j) => (j === i ? next : r)),
        );
        return notificationInstance(accountId, bucketId, bucket.bucketName, next);
      }
      default:
        throw new Error(`Backblaze B2 plugin: ${typeId} cannot be edited`);
    }
  }

  // ── Delete ──────────────────────────────────────────────────────────────

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    const externalId = externalIdOf(resourceId);
    const s = await this.api.getSession();
    switch (typeId) {
      case "bucket":
        try {
          await this.api.call<unknown>("b2_delete_bucket", {
            body: { accountId: s.accountId, bucketId: externalId },
          });
        } catch (err) {
          if (err instanceof B2ApiError && err.code === "cannot_delete_non_empty_bucket") {
            throw new B2ApiError(
              400,
              err.code,
              "B2 only deletes empty buckets. Delete every file version first (the file browser deletes all versions of what you select), or add a lifecycle rule that deletes them.",
            );
          }
          throw err;
        }
        this.invalidate();
        return;
      case "lifecycle-rule": {
        const { bucketId, key } = splitChildId(externalId);
        await this.updateBucket(bucketId, (b) => ({
          lifecycleRules: (b.lifecycleRules ?? []).filter((r) => (r.fileNamePrefix ?? "") !== key),
        }));
        return;
      }
      case "cors-rule": {
        const { bucketId, key } = splitChildId(externalId);
        await this.updateBucket(bucketId, (b) => ({
          corsRules: (b.corsRules ?? []).filter((r) => r.corsRuleName !== key),
        }));
        return;
      }
      case "replication-rule": {
        const { bucketId, key } = splitChildId(externalId);
        await this.updateBucket(bucketId, (b) => {
          const repl = unwrapReplication(b.replicationConfiguration);
          const rules = (repl.asReplicationSource?.replicationRules ?? []).filter(
            (r) => r.replicationRuleName !== key,
          );
          return {
            replicationConfiguration: {
              ...replicationBody(repl),
              asReplicationSource:
                rules.length > 0 ? { ...repl.asReplicationSource, replicationRules: rules } : null,
            },
          };
        });
        return;
      }
      case "notification-rule": {
        const { bucketId, key } = splitChildId(externalId);
        const rules = await this.getNotificationRules(bucketId);
        await this.setNotificationRules(
          bucketId,
          rules.filter((r) => r.name !== key),
        );
        return;
      }
      case "application-key":
        await this.api.call<unknown>("b2_delete_key", { body: { applicationKeyId: externalId } });
        return;
      default:
        throw new Error(`Backblaze B2 plugin: ${typeId} cannot be deleted`);
    }
  }

  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    _accountId: string,
  ): Promise<void> {
    if (typeId === "notification-rule" && actionId === "resume-notification") {
      const { bucketId, key } = splitChildId(externalIdOf(resourceId));
      const rules = await this.getNotificationRules(bucketId);
      await this.setNotificationRules(
        bucketId,
        rules.map((r) => (r.name === key ? { ...r, isEnabled: true } : r)),
      );
      return;
    }
    throw new Error(`Backblaze B2 plugin: unknown action ${actionId} on ${typeId}`);
  }

  // ── Credentials ─────────────────────────────────────────────────────────

  async exportCredential(
    typeId: string,
    resourceId: string,
    accountId: string,
    formatId: string,
  ): Promise<CredentialExport> {
    const s = await this.api.getSession();
    const readOnly = formatId.endsWith("-ro");
    let bucketIds: string[] | undefined;
    let label = "all-buckets";
    if (typeId === "bucket" && (formatId === "bucket-rw" || formatId === "bucket-ro")) {
      const bucket = await this.getResource(typeId, resourceId, accountId);
      bucketIds = [externalIdOf(resourceId)];
      label = String(bucket.fields["name"] ?? bucketIds[0]);
    } else if (!(
      typeId === "account" &&
      (formatId === "all-buckets-rw" || formatId === "all-buckets-ro")
    )) {
      throw new Error(`Backblaze B2 plugin: unknown credential format ${formatId}`);
    }
    const key = await this.mintKey({
      keyName: keyNameFor(
        `infrawrench-${label}-${readOnly ? "ro" : "rw"}-${Date.now().toString(36)}`,
      ),
      capabilities: readOnly ? RO_CAPABILITIES : RW_CAPABILITIES,
      ...(bucketIds ? { bucketIds } : {}),
    });
    this.invalidate();
    const region = s3RegionOf(s.s3ApiUrl);
    const content = [
      "[default]",
      `aws_access_key_id = ${key.applicationKeyId}`,
      `aws_secret_access_key = ${key.applicationKey}`,
      `region = ${region}`,
      `endpoint_url = ${s.s3ApiUrl}`,
      "",
      "# Backblaze B2 command-line tool",
      `# B2_APPLICATION_KEY_ID=${key.applicationKeyId}`,
      `# B2_APPLICATION_KEY=${key.applicationKey}`,
      "",
    ].join("\n");
    return {
      content,
      filename: `b2-${label}.ini`,
      mimeType: "text/plain",
      fields: [
        { label: "Key ID (S3 access key)", value: key.applicationKeyId },
        {
          label: "Application key (S3 secret key)",
          value: key.applicationKey,
          sensitive: true,
          hint: "Only shown once",
        },
        { label: "S3 endpoint", value: s.s3ApiUrl },
        { label: "Region", value: region },
      ],
      warning: "Save the application key now: Backblaze never shows it again.",
    };
  }

  // ── Storage browser ─────────────────────────────────────────────────────

  listStorageObjects(bucket: string, prefix: string): Promise<StorageObject[]> {
    return this.storage.list(bucket, prefix);
  }

  async uploadStorageObject(
    bucket: string,
    key: string,
    file: File,
    onProgress?: (pct: number) => void,
  ): Promise<void> {
    const body = new Uint8Array(await file.arrayBuffer());
    await this.storage.upload(bucket, key, body, file.type || "b2/x-auto");
    onProgress?.(100);
  }

  makeStorageFolder(bucket: string, key: string): Promise<void> {
    return this.storage.makeFolder(bucket, key);
  }

  deleteStorageObject(bucket: string, key: string): Promise<void> {
    return this.storage.delete(bucket, key);
  }

  // ── Usage ───────────────────────────────────────────────────────────────

  fetchCostData(_accountId: string, range: CostFetchRange): Promise<CostRow[]> {
    return fetchB2CostData(this.reports, range.fromDate, range.toDate);
  }

  async fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    if (resourceTypeId !== "bucket" && resourceTypeId !== "account") return [];
    const end = timeRange?.endMs ?? Date.now();
    const start = timeRange?.startMs ?? end - DEFAULT_METRICS_WINDOW_MS;
    const from = new Date(start).toISOString().slice(0, 10);
    const to = new Date(end).toISOString().slice(0, 10);
    let rows;
    try {
      rows = await this.reports.range(from, to);
    } catch {
      // No usage reports for this account: the tab shows its empty state.
      return [];
    }
    return usageSeries(rows, resourceTypeId === "bucket" ? externalIdOf(resourceId) : undefined);
  }
}

// ── Field → rule converters ────────────────────────────────────────────────

/** The replication config to send back, without the read-only wrapper. */
function replicationBody(repl: B2ReplicationConfiguration): B2ReplicationConfiguration {
  return {
    ...(repl.asReplicationSource ? { asReplicationSource: repl.asReplicationSource } : {}),
    ...(repl.asReplicationDestination
      ? { asReplicationDestination: repl.asReplicationDestination }
      : {}),
  };
}

export function lifecycleFromFields(fields: Record<string, string>): B2LifecycleRule {
  const rule: B2LifecycleRule = {
    fileNamePrefix: fields["fileNamePrefix"] ?? "",
    daysFromUploadingToHiding: numOrUndefined(fields["daysFromUploadingToHiding"]) ?? null,
    daysFromHidingToDeleting: numOrUndefined(fields["daysFromHidingToDeleting"]) ?? null,
  };
  const cancel = numOrUndefined(fields["daysFromStartingToCancelingUnfinishedLargeFiles"]);
  if (cancel) rule.daysFromStartingToCancelingUnfinishedLargeFiles = cancel;
  if (!rule.daysFromUploadingToHiding && !rule.daysFromHidingToDeleting && !cancel) {
    throw new Error("Set at least one of the day counts; a rule with none does nothing.");
  }
  return rule;
}

export function mergeLifecycle(
  cur: B2LifecycleRule,
  fields: Record<string, string>,
): B2LifecycleRule {
  const merged: Record<string, string> = {
    fileNamePrefix: cur.fileNamePrefix ?? "",
    daysFromUploadingToHiding: cur.daysFromUploadingToHiding?.toString() ?? "",
    daysFromHidingToDeleting: cur.daysFromHidingToDeleting?.toString() ?? "",
    daysFromStartingToCancelingUnfinishedLargeFiles:
      cur.daysFromStartingToCancelingUnfinishedLargeFiles?.toString() ?? "",
    ...fields,
  };
  return lifecycleFromFields(merged);
}

export function corsFromFields(fields: Record<string, string>): B2CorsRule {
  const name = (fields["corsRuleName"] ?? "").trim();
  if (!/^[A-Za-z0-9-]{6,63}$/.test(name) || /^b2-/i.test(name)) {
    throw new Error(
      "CORS rule names are 6 to 63 letters, digits and hyphens, not starting with b2-.",
    );
  }
  const allowedOrigins = splitList(fields["allowedOrigins"]);
  const allowedOperations = parsePicked(fields["allowedOperations"]);
  if (allowedOrigins.length === 0) throw new Error("Add at least one allowed origin.");
  if (allowedOperations.length === 0) throw new Error("Pick at least one allowed operation.");
  const maxAge = Number(fields["maxAgeSeconds"] ?? 3600);
  return {
    corsRuleName: name,
    allowedOrigins,
    allowedOperations,
    allowedHeaders: splitList(fields["allowedHeaders"]),
    exposeHeaders: splitList(fields["exposeHeaders"]),
    maxAgeSeconds: Number.isFinite(maxAge)
      ? Math.min(86_400, Math.max(0, Math.floor(maxAge)))
      : 3600,
  };
}

export function mergeCors(cur: B2CorsRule, fields: Record<string, string>): B2CorsRule {
  return corsFromFields({
    corsRuleName: cur.corsRuleName,
    allowedOrigins: cur.allowedOrigins.join(","),
    allowedOperations: cur.allowedOperations.join(","),
    allowedHeaders: (cur.allowedHeaders ?? []).join(","),
    exposeHeaders: (cur.exposeHeaders ?? []).join(","),
    maxAgeSeconds: String(cur.maxAgeSeconds ?? 0),
    ...fields,
  });
}

export function notificationFromFields(fields: Record<string, string>): B2NotificationRule {
  const name = (fields["name"] ?? "").trim();
  if (!/^[A-Za-z0-9-]{1,63}$/.test(name)) throw new Error("Names are letters, digits and hyphens.");
  const url = (fields["url"] ?? "").trim();
  if (!/^https:\/\//i.test(url)) throw new Error("The webhook URL must use HTTPS.");
  const eventTypes = parsePicked(fields["eventTypes"]);
  if (eventTypes.length === 0) throw new Error("Pick at least one event type.");
  const batch = Number(fields["maxEventsPerBatch"] || 1);
  const headers = parseHeaders(fields["customHeaders"] ?? "");
  if (headers.length > 10) throw new Error("At most 10 custom headers.");
  return {
    name,
    eventTypes,
    isEnabled: bool(fields["isEnabled"]) !== false,
    objectNamePrefix: fields["objectNamePrefix"] ?? "",
    maxEventsPerBatch: Number.isFinite(batch) ? Math.min(50, Math.max(1, Math.floor(batch))) : 1,
    targetConfiguration: {
      targetType: "webhook",
      url,
      ...(headers.length > 0 ? { customHeaders: headers } : {}),
    },
  };
}

export function mergeNotification(
  cur: B2NotificationRule,
  fields: Record<string, string>,
): B2NotificationRule {
  const next = notificationFromFields({
    name: cur.name,
    url: cur.targetConfiguration.url,
    eventTypes: cur.eventTypes.join(","),
    objectNamePrefix: cur.objectNamePrefix ?? "",
    isEnabled: String(cur.isEnabled !== false),
    maxEventsPerBatch: String(cur.maxEventsPerBatch ?? 1),
    customHeaders: (cur.targetConfiguration.customHeaders ?? [])
      .map((h) => `${h.name}=${h.value}`)
      .join(","),
    ...fields,
  });
  // Keep the signing secret so subscribers keep verifying.
  if (cur.targetConfiguration.hmacSha256SigningSecret) {
    next.targetConfiguration.hmacSha256SigningSecret =
      cur.targetConfiguration.hmacSha256SigningSecret;
  }
  return next;
}
