import type {
  CostFetchRange,
  CostRow,
  CreateResourceConfig,
  CredentialExport,
  DetailViewSchema,
  HostServices,
  MetricSeries,
  PluginClient,
  PreflightResult,
  ResourceCreateReturn,
  ResourceInstance,
  SidebarItemSchema,
  StorageObject,
} from "@infrawrench/plugin-base";
import { CostSetupError, externalIdOf } from "@infrawrench/plugin-base";
import type { SubAccount, Utilization, WasabiContext } from "./api.js";
import { WasabiApiError, statsPaged, statusOf, wacFetch } from "./api.js";
import type { IamAccessKey } from "./iam.js";
import { IAM_ENDPOINT, WasabiIam, bucketPolicyDocument } from "./iam.js";
import { WASABI_REGIONS, endpointFor, regionFromLocation } from "./regions.js";
import { renderWasabiDetail, renderWasabiSidebar } from "./render.js";
import type { S3CorsRule, S3LifecycleRule } from "./s3.js";
import { S3Client, S3Error, parseTagString, tagString } from "./s3.js";
import {
  DEFAULT_METRICS_WINDOW_MS,
  bucketMatches,
  costRows,
  dayOf,
  monthlyEstimate,
  utilizationSeries,
} from "./usage.js";

const PLUGIN_ID = "wasabi";
const GIB = 1024 ** 3;
const SUB_ACCESS = "accessKey";
const SUB_SECRET = "secretKey";

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

export function splitList(raw: string | undefined): string[] {
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

export function validateBucketName(name: string): string | null {
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(name) || name.includes("..")) {
    return "Bucket names are 3 to 63 lowercase letters, digits, dots and hyphens, starting and ending with a letter or digit.";
  }
  return null;
}

const ADMIN_POLICY = /AdministratorAccess|FullAccess/i;

export class WasabiClient implements PluginClient {
  private readonly ctx: WasabiContext;
  private readonly s3: S3Client;
  private readonly iam: WasabiIam;
  private regions = new Map<string, Promise<string>>();

  constructor(
    credentials: Record<string, string>,
    private readonly services?: HostServices,
  ) {
    const accessKey = (credentials["accessKey"] ?? "").trim();
    const secretKey = (credentials["secretKey"] ?? "").trim();
    if (!accessKey || !secretKey)
      throw new Error("Wasabi plugin: missing accessKey or secretKey credential");
    const wacKey = (credentials["wacApiKey"] ?? "").trim();
    const caCert = credentials["caCert"] ?? "";
    this.ctx = {
      accessKey,
      secretKey,
      ...(wacKey ? { wacKey } : {}),
      ...(caCert ? { caCert } : {}),
      ...(services?.http ? { http: services.http } : {}),
    };
    this.s3 = new S3Client({
      endpoint: "https://s3.wasabisys.com",
      region: "us-east-1",
      pathStyle: true,
      accessKey,
      secretKey,
      ...(caCert ? { caCert } : {}),
      ...(services?.http ? { http: services.http } : {}),
    });
    this.iam = new WasabiIam(this.s3.withRegion("us-east-1", IAM_ENDPOINT));
  }

  /** The bucket's own regional endpoint; Wasabi redirects requests sent elsewhere. */
  private async s3For(bucket: string): Promise<S3Client> {
    let region = this.regions.get(bucket);
    if (!region) {
      region = this.s3.bucketLocation(bucket).then(regionFromLocation);
      region.catch(() => this.regions.delete(bucket));
      this.regions.set(bucket, region);
    }
    const r = await region;
    return this.s3.withRegion(r, endpointFor(r));
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

  private async latestBucketStats(): Promise<Utilization[]> {
    const today = new Date();
    const from = new Date(today.getTime() - 3 * 86_400_000).toISOString().slice(0, 10);
    try {
      return await statsPaged(this.ctx, "/v1/standalone/utilizations/bucket", {
        from,
        to: today.toISOString().slice(0, 10),
      });
    } catch {
      // Stats need a root key or billing permissions; inventory works without.
      return [];
    }
  }

  private async bucketInstance(
    accountId: string,
    b: { name: string; creationDate: string },
    stats: Utilization[],
  ): Promise<ResourceInstance> {
    const s3 = await this.s3For(b.name);
    const [versioning, lock, tags] = await Promise.all([
      s3.getVersioning(b.name).catch(() => ""),
      s3.getObjectLock(b.name).catch(
        () =>
          ({ enabled: false }) as {
            enabled: boolean;
            mode?: string;
            days?: number;
            years?: number;
          },
      ),
      s3.getTags(b.name).catch(() => ({})),
    ]);
    const latest = stats
      .filter((u) => bucketMatches(u.Bucket, b.name))
      .sort((x, y) => dayOf(y).localeCompare(dayOf(x)))[0];
    const fields: Fields = {
      name: b.name,
      region: s3.cfg.region,
      createdAt: b.creationDate,
      objectLock: lock.enabled,
      tags: tagString(tags),
    };
    if (versioning) fields["versioning"] = versioning;
    if (lock.enabled) {
      fields["retentionMode"] = lock.mode ?? "none";
      const d = lock.days ?? (lock.years ? lock.years * 365 : undefined);
      if (d !== undefined) fields["retentionDays"] = d;
    }
    if (latest) {
      fields["activeStorageGib"] =
        Math.round(((latest.PaddedStorageSizeBytes ?? 0) / GIB) * 100) / 100;
      fields["objects"] = latest.NumBillableObjects ?? 0;
    }
    return instance(accountId, "bucket", b.name, b.name, fields);
  }

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "account":
        return [await this.accountInstance(accountId)];
      case "bucket": {
        const [buckets, stats] = await Promise.all([
          this.s3.listBuckets(),
          this.latestBucketStats(),
        ]);
        return this.mapLimit(buckets, (b) => this.bucketInstance(accountId, b, stats));
      }
      case "lifecycle-rule": {
        const buckets = await this.s3.listBuckets();
        const all = await this.mapLimit(buckets, async (b) =>
          (await (await this.s3For(b.name)).getLifecycle(b.name)).map((r) =>
            lifecycleInstance(accountId, b.name, r),
          ),
        );
        return all.flat();
      }
      case "cors-rule": {
        const buckets = await this.s3.listBuckets();
        const all = await this.mapLimit(buckets, async (b) =>
          (await (await this.s3For(b.name)).getCors(b.name)).map((r) =>
            corsInstance(accountId, b.name, r),
          ),
        );
        return all.flat();
      }
      case "iam-user": {
        try {
          const users = await this.iam.listUsers();
          return this.mapLimit(users, async (u) => {
            const [keys, attached, inline, groups] = await Promise.all([
              this.iam.listAccessKeys(u.userName),
              this.iam.attachedPolicies(u.userName),
              this.iam.inlinePolicies(u.userName),
              this.iam.groupsForUser(u.userName),
            ]);
            return instance(accountId, "iam-user", u.userName, u.userName, {
              userName: u.userName,
              userId: u.userId,
              arn: u.arn,
              createdAt: u.createDate,
              policies: attached.map((p) => p.arn).join(", "),
              inlinePolicies: inline.join(", "),
              groups: groups.join(", "),
              accessKeyCount: keys.length,
              isAdmin: attached.some((p) => ADMIN_POLICY.test(p.name)),
            });
          });
        } catch (err) {
          if (statusOf(err) === 403) return [];
          throw err;
        }
      }
      case "access-key": {
        let users;
        try {
          users = await this.iam.listUsers();
        } catch (err) {
          if (statusOf(err) === 403) return [];
          throw err;
        }
        const keys = (
          await this.mapLimit(users, (u) => this.iam.listAccessKeys(u.userName))
        ).flat();
        return this.mapLimit(keys, async (k) =>
          keyInstance(accountId, k, await this.iam.lastUsed(k.accessKeyId)),
        );
      }
      case "sub-account": {
        if (!this.ctx.wacKey) return [];
        const subs = await wacFetch<SubAccount[]>(this.ctx, "/v1/accounts");
        return (subs ?? []).map((s) => subAccountInstance(accountId, s));
      }
      default:
        return [];
    }
  }

  private async accountInstance(accountId: string): Promise<ResourceInstance> {
    const buckets = await this.s3.listBuckets();
    let latest: Utilization | undefined;
    try {
      const records = await statsPaged(this.ctx, "/v1/standalone/utilizations", { latest: true });
      latest = records.sort((a, b) => dayOf(b).localeCompare(dayOf(a)))[0];
    } catch {
      latest = undefined;
    }
    const fields: Fields = {
      acctNum: latest?.AcctNum ? String(latest.AcctNum) : "",
      bucketCount: buckets.length,
      subAccounts: this.ctx.wacKey ? "Connected" : "Not connected",
    };
    if (latest) {
      fields["activeStorageGib"] =
        Math.round(((latest.PaddedStorageSizeBytes ?? 0) / GIB) * 100) / 100;
      fields["deletedStorageGib"] =
        Math.round(((latest.DeletedStorageSizeBytes ?? 0) / GIB) * 100) / 100;
      fields["objects"] = latest.NumBillableObjects ?? 0;
      fields["utilizationDate"] = dayOf(latest);
      const est = monthlyEstimate(latest);
      if (est !== undefined) fields["estimatedMonthlyUsd"] = est;
    }
    const id = latest?.AcctNum ? String(latest.AcctNum) : `key-${this.ctx.accessKey}`;
    return instance(
      accountId,
      "account",
      id,
      latest?.AcctNum ? `Wasabi account ${latest.AcctNum}` : "Wasabi account",
      fields,
    );
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const externalId = externalIdOf(resourceId);
    if (typeId === "bucket") {
      const buckets = await this.s3.listBuckets();
      const b = buckets.find((x) => x.name === externalId);
      if (!b) throw new S3Error(404, "NoSuchBucket", `Wasabi bucket ${externalId} not found`);
      return this.bucketInstance(accountId, b, await this.latestBucketStats());
    }
    if (typeId === "sub-account") {
      return subAccountInstance(
        accountId,
        await wacFetch<SubAccount>(this.ctx, `/v1/accounts/${encodeURIComponent(externalId)}`),
      );
    }
    const found = (await this.listResources(typeId, accountId)).find(
      (r) => r.externalId === externalId,
    );
    if (!found) throw new WasabiApiError(404, `Wasabi plugin: ${typeId} ${externalId} not found`);
    return found;
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    const externalId = externalIdOf(resourceId);
    if (typeId === "account" && outputKey === "s3Endpoint") return "https://s3.wasabisys.com";
    if (typeId === "bucket") {
      const s3 = await this.s3For(externalId);
      switch (outputKey) {
        case "bucketName":
          return externalId;
        case "region":
          return s3.cfg.region;
        case "s3Endpoint":
          return s3.cfg.endpoint;
        case "s3Url":
          return `${s3.cfg.endpoint}/${externalId}`;
      }
    }
    if (typeId === "iam-user" && outputKey === "arn") {
      return String((await this.getResource(typeId, resourceId, accountId)).fields["arn"] ?? "");
    }
    if (typeId === "access-key" && outputKey === "accessKeyId") return splitChild(externalId).key;
    if (typeId === "sub-account" && (outputKey === SUB_ACCESS || outputKey === SUB_SECRET)) {
      const v = await this.services?.secrets?.getPlaintext(resourceId, outputKey);
      if (!v)
        throw new Error(
          "Only sub-accounts created (or whose keys were reset) from Infrawrench have stored keys.",
        );
      return v;
    }
    throw new Error(`Wasabi plugin: unknown output ${outputKey} on ${typeId}`);
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderWasabiDetail(resource);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderWasabiSidebar(resource);
  }

  async verifyCredentials(): Promise<PreflightResult> {
    const checks: PreflightResult["checks"] = [];
    const probe = async (
      id: string,
      fn: () => Promise<unknown>,
      perms: Array<{ id: string; label: string }>,
    ) => {
      try {
        await fn();
        checks.push({ capabilityId: id, status: "ok" });
      } catch (err) {
        const s = statusOf(err);
        if (s === 401 || s === 403)
          checks.push({ capabilityId: id, status: "missing", missingPermissions: perms });
        else
          checks.push({
            capabilityId: id,
            status: "unknown",
            message: err instanceof Error ? err.message : String(err),
          });
      }
    };
    await probe("resources", () => this.s3.listBuckets(), [
      { id: "s3:ListAllMyBuckets", label: "List buckets" },
    ]);
    await probe("iam", () => this.iam.listUsers(), [
      { id: "iam:ListUsers", label: "List IAM users" },
    ]);
    await probe(
      "costs",
      () => statsPaged(this.ctx, "/v1/standalone/utilizations", { latest: true }),
      [{ id: "billing", label: "Root key or billing permissions" }],
    );
    if (this.ctx.wacKey) {
      await probe("sub-accounts", () => wacFetch(this.ctx, "/v1/accounts"), [
        { id: "wac", label: "Wasabi Account Control API key" },
      ]);
    }
    return { checks };
  }

  // ── Create ──────────────────────────────────────────────────────────────

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
              placeholder: "my-backups",
              description: "Globally unique. Lowercase letters, digits, dots and hyphens.",
            },
            {
              key: "region",
              label: "Region",
              kind: "region-picker",
              required: true,
              defaultValue: "us-east-1",
              regions: WASABI_REGIONS.map(({ endpoint: _e, ...r }) => r),
            },
            {
              key: "versioning",
              label: "Versioning",
              kind: "select",
              required: true,
              defaultValue: "off",
              options: [
                { id: "off", label: "Off" },
                {
                  id: "Enabled",
                  label: "Enabled",
                  description: "Keeps every version; can only be suspended later",
                },
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
                {
                  id: "COMPLIANCE",
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
            ...(await bucketPicker()),
            {
              key: "ruleId",
              label: "Rule ID",
              kind: "text",
              required: true,
              placeholder: "expire-logs",
            },
            {
              key: "prefix",
              label: "Prefix",
              kind: "text",
              required: false,
              placeholder: "logs/",
              description: "Leave empty for every object.",
            },
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
              placeholder: "*",
            },
            {
              key: "exposeHeaders",
              label: "Exposed headers",
              kind: "string-list",
              required: false,
              placeholder: "ETag",
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
      case "iam-user": {
        const policies = await this.iam.listPolicies().catch(() => []);
        return {
          fields: [
            {
              key: "userName",
              label: "User name",
              kind: "text",
              required: true,
              placeholder: "backup-agent",
            },
            {
              key: "policies",
              label: "Policies",
              kind: "policy-picker",
              required: false,
              policies: policies
                .filter((p) => p.isAttachable !== false)
                .map((p) => ({
                  id: p.arn,
                  label: p.policyName,
                  ...(p.description ? { description: p.description } : {}),
                  category:
                    p.arn.includes(":aws:policy/") || !/:\d+:policy\//.test(p.arn)
                      ? "Wasabi managed"
                      : "Customer managed",
                })),
            },
          ],
        };
      }
      case "sub-account":
        return {
          fields: [
            {
              key: "acctName",
              label: "Root user email",
              kind: "text",
              required: true,
              placeholder: "customer@example.com",
            },
            { key: "password", label: "Initial password", kind: "password", required: true },
            {
              key: "isTrial",
              label: "Account type",
              kind: "select",
              required: true,
              defaultValue: "false",
              options: [
                { id: "false", label: "Paid" },
                { id: "true", label: "Trial" },
              ],
            },
            {
              key: "numTrialDays",
              label: "Trial length (days)",
              kind: "number",
              required: false,
              showWhen: { fieldKey: "isTrial", fieldValue: "true" },
            },
            {
              key: "quotaGb",
              label: "Trial quota (GB)",
              kind: "number",
              required: false,
              showWhen: { fieldKey: "isTrial", fieldValue: "true" },
            },
            {
              key: "enableFtp",
              label: "FTP/FTPS access",
              kind: "select",
              required: true,
              defaultValue: "false",
              options: [
                { id: "false", label: "Disabled" },
                { id: "true", label: "Enabled" },
              ],
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
  ): Promise<ResourceCreateReturn> {
    const parentBucket = parentResourceId ? externalIdOf(parentResourceId) : "";
    switch (typeId) {
      case "bucket": {
        const name = (fields["name"] ?? "").trim();
        const invalid = validateBucketName(name);
        if (invalid) throw new Error(invalid);
        const region = fields["region"] || "us-east-1";
        const s3 = this.s3.withRegion(region, endpointFor(region));
        const lock = fields["objectLock"] === "on";
        await s3.createBucket(name, { region, objectLock: lock });
        this.regions.set(name, Promise.resolve(region));
        if (!lock && fields["versioning"] === "Enabled") await s3.putVersioning(name, "Enabled");
        const mode = fields["retentionMode"];
        const d = days(fields["retentionDays"]);
        if (lock && mode && mode !== "none" && d) await s3.putObjectLock(name, mode, d);
        return this.bucketInstance(accountId, { name, creationDate: new Date().toISOString() }, []);
      }
      case "lifecycle-rule": {
        const bucket = fields["bucket"] || parentBucket;
        const rule = lifecycleFromFields(fields);
        const s3 = await this.s3For(bucket);
        const rules = await s3.getLifecycle(bucket);
        if (rules.some((r) => r.id === rule.id))
          throw new Error(`A lifecycle rule ${rule.id} already exists on ${bucket}.`);
        await s3.putLifecycle(bucket, [...rules, rule]);
        return lifecycleInstance(accountId, bucket, rule);
      }
      case "cors-rule": {
        const bucket = fields["bucket"] || parentBucket;
        const rule = corsFromFields(fields);
        const s3 = await this.s3For(bucket);
        const rules = await s3.getCors(bucket);
        if (rules.some((r) => r.id === rule.id))
          throw new Error(`A CORS rule ${rule.id} already exists on ${bucket}.`);
        await s3.putCors(bucket, [...rules, rule]);
        return corsInstance(accountId, bucket, rule);
      }
      case "iam-user": {
        const userName = (fields["userName"] ?? "").trim();
        if (!/^[\w+=,.@-]{1,64}$/.test(userName))
          throw new Error("User names are up to 64 letters, digits and +=,.@_- characters.");
        await this.iam.createUser(userName);
        for (const arn of parsePicked(fields["policies"]))
          await this.iam.attachPolicy(userName, arn);
        return this.getResource("iam-user", `${accountId}:iam-user:${userName}`, accountId);
      }
      case "sub-account": {
        const created = await wacFetch<SubAccount>(this.ctx, "/v1/accounts", {
          method: "PUT",
          body: {
            AcctName: (fields["acctName"] ?? "").trim(),
            Password: fields["password"] ?? "",
            IsTrial: fields["isTrial"] === "true",
            EnableFTP: fields["enableFtp"] === "true",
            ...(fields["numTrialDays"] ? { NumTrialDays: Number(fields["numTrialDays"]) } : {}),
            ...(fields["quotaGb"] ? { QuotaGB: Number(fields["quotaGb"]) } : {}),
          },
        });
        const resource = subAccountInstance(accountId, created);
        await this.storeSubKeys(resource.id, created);
        return resource;
      }
      default:
        throw new Error(`Wasabi plugin: cannot create ${typeId}`);
    }
  }

  private async storeSubKeys(resourceId: string, s: SubAccount): Promise<void> {
    const secrets = this.services?.secrets;
    if (!secrets?.setPlaintext || !s.AccessKey || !s.SecretKey) return;
    await secrets.setPlaintext(resourceId, SUB_ACCESS, s.AccessKey);
    await secrets.setPlaintext(resourceId, SUB_SECRET, s.SecretKey);
  }

  // ── Update ──────────────────────────────────────────────────────────────

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const externalId = externalIdOf(resourceId);
    switch (typeId) {
      case "bucket": {
        const s3 = await this.s3For(externalId);
        if (fields["versioning"] === "Enabled" || fields["versioning"] === "Suspended") {
          await s3.putVersioning(externalId, fields["versioning"]);
        } else if (fields["versioning"] === "Unversioned") {
          throw new Error("Versioning cannot be turned off once enabled; suspend it instead.");
        }
        if (fields["retentionMode"] !== undefined || fields["retentionDays"] !== undefined) {
          const lock = await s3.getObjectLock(externalId);
          if (!lock.enabled)
            throw new Error("Default retention needs a bucket created with Object Lock.");
          const mode = fields["retentionMode"] ?? lock.mode ?? "none";
          const d =
            days(fields["retentionDays"]) ??
            lock.days ??
            (lock.years ? lock.years * 365 : undefined);
          await s3.putObjectLock(
            externalId,
            mode === "none" ? undefined : mode,
            mode === "none" ? undefined : (d ?? 1),
          );
        }
        if (fields["tags"] !== undefined)
          await s3.putTags(externalId, parseTagString(fields["tags"]));
        return this.getResource(typeId, resourceId, accountId);
      }
      case "lifecycle-rule": {
        const { parent: bucket, key } = splitChild(externalId);
        const s3 = await this.s3For(bucket);
        const rules = await s3.getLifecycle(bucket);
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
        await s3.putLifecycle(
          bucket,
          rules.map((r, j) => (j === i ? next : r)),
        );
        return lifecycleInstance(accountId, bucket, next);
      }
      case "cors-rule": {
        const { parent: bucket, key } = splitChild(externalId);
        const s3 = await this.s3For(bucket);
        const rules = await s3.getCors(bucket);
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
        await s3.putCors(
          bucket,
          rules.map((r, j) => (j === i ? next : r)),
        );
        return corsInstance(accountId, bucket, next);
      }
      case "iam-user": {
        if (fields["policies"] !== undefined) {
          const want = new Set(splitList(fields["policies"]));
          const have = await this.iam.attachedPolicies(externalId);
          for (const p of have)
            if (!want.has(p.arn)) await this.iam.detachPolicy(externalId, p.arn);
          const haveArns = new Set(have.map((p) => p.arn));
          for (const arn of want)
            if (!haveArns.has(arn)) await this.iam.attachPolicy(externalId, arn);
        }
        return this.getResource(typeId, resourceId, accountId);
      }
      case "sub-account": {
        const body: Record<string, unknown> = {};
        if (fields["quotaGb"] !== undefined) body["QuotaGB"] = Number(fields["quotaGb"]);
        const inactive = bool(fields["inactive"]);
        if (inactive !== undefined) body["Inactive"] = inactive;
        const ftp = bool(fields["enableFtp"]);
        if (ftp !== undefined) body["EnableFTP"] = ftp;
        const del = bool(fields["allowAccountDelete"]);
        if (del !== undefined) body["AllowAccountDelete"] = del;
        await wacFetch(this.ctx, `/v1/accounts/${encodeURIComponent(externalId)}`, {
          method: "POST",
          body,
        });
        return this.getResource(typeId, resourceId, accountId);
      }
      default:
        throw new Error(`Wasabi plugin: ${typeId} cannot be edited`);
    }
  }

  // ── Delete and actions ──────────────────────────────────────────────────

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    const externalId = externalIdOf(resourceId);
    switch (typeId) {
      case "bucket":
        await (await this.s3For(externalId)).deleteBucket(externalId);
        this.regions.delete(externalId);
        return;
      case "lifecycle-rule": {
        const { parent: bucket, key } = splitChild(externalId);
        const s3 = await this.s3For(bucket);
        await s3.putLifecycle(
          bucket,
          (await s3.getLifecycle(bucket)).filter((r) => r.id !== key),
        );
        return;
      }
      case "cors-rule": {
        const { parent: bucket, key } = splitChild(externalId);
        const s3 = await this.s3For(bucket);
        await s3.putCors(
          bucket,
          (await s3.getCors(bucket)).filter((r) => r.id !== key),
        );
        return;
      }
      case "iam-user":
        await this.iam.deleteUser(externalId);
        return;
      case "access-key": {
        const { parent: user, key } = splitChild(externalId);
        await this.iam.deleteAccessKey(user, key);
        return;
      }
      case "sub-account":
        await wacFetch(this.ctx, `/v1/accounts/${encodeURIComponent(externalId)}`, {
          method: "DELETE",
        });
        return;
      default:
        throw new Error(`Wasabi plugin: ${typeId} cannot be deleted`);
    }
  }

  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    _accountId: string,
  ): Promise<void> {
    const externalId = externalIdOf(resourceId);
    if (typeId === "access-key" && (actionId === "activate" || actionId === "deactivate")) {
      const { parent: user, key } = splitChild(externalId);
      await this.iam.updateAccessKey(user, key, actionId === "activate" ? "Active" : "Inactive");
      return;
    }
    if (typeId === "sub-account" && actionId === "convert-to-paid") {
      await wacFetch(this.ctx, `/v1/accounts/${encodeURIComponent(externalId)}`, {
        method: "POST",
        body: { ConvertToPaid: true },
      });
      return;
    }
    if (typeId === "sub-account" && actionId === "reset-access-keys") {
      const res = await wacFetch<SubAccount>(
        this.ctx,
        `/v1/accounts/${encodeURIComponent(externalId)}`,
        {
          method: "POST",
          body: { ResetAccessKeys: true },
        },
      );
      await this.storeSubKeys(resourceId, res);
      return;
    }
    throw new Error(`Wasabi plugin: unknown action ${actionId} on ${typeId}`);
  }

  async exportCredential(
    typeId: string,
    resourceId: string,
    _accountId: string,
    formatId: string,
  ): Promise<CredentialExport> {
    const externalId = externalIdOf(resourceId);
    let userName: string;
    let endpoint = "https://s3.wasabisys.com";
    let region = "us-east-1";
    if (typeId === "iam-user" && formatId === "access-key") {
      userName = externalId;
    } else if (typeId === "bucket" && (formatId === "bucket-rw" || formatId === "bucket-ro")) {
      const readOnly = formatId === "bucket-ro";
      const s3 = await this.s3For(externalId);
      endpoint = s3.cfg.endpoint;
      region = s3.cfg.region;
      userName =
        `infrawrench-${externalId}-${readOnly ? "ro" : "rw"}-${Date.now().toString(36)}`.slice(
          0,
          64,
        );
      await this.iam.createUser(userName);
      await this.iam.putUserPolicy(
        userName,
        `bucket-${readOnly ? "read" : "readwrite"}`,
        bucketPolicyDocument(externalId, readOnly),
      );
    } else {
      throw new Error(`Wasabi plugin: unknown credential format ${formatId}`);
    }
    const key = await this.iam.createAccessKey(userName);
    return {
      content: [
        "[default]",
        `aws_access_key_id = ${key.accessKeyId}`,
        `aws_secret_access_key = ${key.secretAccessKey}`,
        `region = ${region}`,
        `endpoint_url = ${endpoint}`,
        "",
      ].join("\n"),
      filename: `wasabi-${externalId}.ini`,
      mimeType: "text/plain",
      fields: [
        { label: "IAM user", value: userName },
        { label: "Access key", value: key.accessKeyId },
        {
          label: "Secret key",
          value: key.secretAccessKey,
          sensitive: true,
          hint: "Only shown once",
        },
        { label: "Endpoint", value: endpoint },
        { label: "Region", value: region },
      ],
      warning: "Save the secret key now: Wasabi never shows it again.",
    };
  }

  // ── Bucket policy (the host's policy editor) ────────────────────────────

  async getManifest(resourceId: string, _accountId: string): Promise<string> {
    const bucket = externalIdOf(resourceId);
    const raw = await (await this.s3For(bucket)).getPolicy(bucket);
    if (!raw) return "";
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      return raw;
    }
  }

  async applyManifest(resourceId: string, _accountId: string, manifest: string): Promise<void> {
    const bucket = externalIdOf(resourceId);
    await (await this.s3For(bucket)).putPolicy(bucket, manifest);
  }

  // ── Storage browser ─────────────────────────────────────────────────────

  async listStorageObjects(bucket: string, prefix: string): Promise<StorageObject[]> {
    const page = await (await this.s3For(bucket)).listObjects(bucket, prefix);
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
    await (
      await this.s3For(bucket)
    ).putObject(bucket, key, new Uint8Array(await file.arrayBuffer()), file.type);
    onProgress?.(100);
  }

  async makeStorageFolder(bucket: string, key: string): Promise<void> {
    await (
      await this.s3For(bucket)
    ).putObject(
      bucket,
      key.endsWith("/") ? key : `${key}/`,
      new Uint8Array(0),
      "application/x-directory",
    );
  }

  async deleteStorageObject(bucket: string, key: string): Promise<void> {
    const s3 = await this.s3For(bucket);
    if (!key.endsWith("/")) return s3.deleteObject(bucket, key);
    const all = await s3.listObjects(bucket, key, "", 1000);
    const keys = all.objects.map((o) => o.key);
    if (!keys.includes(key)) keys.push(key);
    await s3.deleteObjects(bucket, keys);
  }

  // ── Usage ───────────────────────────────────────────────────────────────

  async fetchCostData(_accountId: string, range: CostFetchRange): Promise<CostRow[]> {
    let records: Utilization[];
    try {
      records = await statsPaged(this.ctx, "/v1/standalone/utilizations/bucket", {
        from: range.fromDate,
        to: range.toDate,
      });
    } catch (err) {
      if (statusOf(err) === 401 || statusOf(err) === 403) {
        throw new CostSetupError(
          "The Wasabi Stats API needs the account's root access key, or a sub-user key whose policy grants billing access. Swap in such a key to see costs.",
          {
            label: "Wasabi Stats API keys",
            url: "https://docs.wasabi.com/apidocs/generating-a-wasabi-stats-api-key",
          },
        );
      }
      throw err;
    }
    const names = (await this.s3.listBuckets().catch(() => [])).map((b) => b.name);
    return costRows(records, names).filter(
      (r) => r.date >= range.fromDate && r.date <= range.toDate,
    );
  }

  async fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    const end = timeRange?.endMs ?? Date.now();
    const start = timeRange?.startMs ?? end - DEFAULT_METRICS_WINDOW_MS;
    const query = {
      from: new Date(start).toISOString().slice(0, 10),
      to: new Date(end).toISOString().slice(0, 10),
    };
    const externalId = externalIdOf(resourceId);
    try {
      if (resourceTypeId === "account") {
        return utilizationSeries(await statsPaged(this.ctx, "/v1/standalone/utilizations", query));
      }
      if (resourceTypeId === "bucket") {
        const records = await statsPaged(this.ctx, "/v1/standalone/utilizations/bucket", query);
        return utilizationSeries(records.filter((u) => bucketMatches(u.Bucket, externalId)));
      }
      if (resourceTypeId === "sub-account") {
        const records = await wacFetch<Utilization[]>(
          this.ctx,
          `/v1/accounts/${encodeURIComponent(externalId)}/utilizations`,
          { query },
        );
        return utilizationSeries(records ?? []);
      }
    } catch {
      return [];
    }
    return [];
  }
}

// ── Mappers ─────────────────────────────────────────────────────────────────

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

function keyInstance(accountId: string, k: IamAccessKey, lastUsed: string): ResourceInstance {
  return instance(
    accountId,
    "access-key",
    `${k.userName}/${k.accessKeyId}`,
    k.accessKeyId,
    {
      accessKeyId: k.accessKeyId,
      userName: k.userName,
      status: k.status,
      createdAt: k.createDate,
      lastUsedAt: lastUsed,
    },
    { typeId: "iam-user", externalId: k.userName },
  );
}

export function subAccountInstance(accountId: string, s: SubAccount): ResourceInstance {
  const fields: Fields = {
    acctNum: s.AcctNum,
    acctName: s.AcctName ?? "",
    isTrial: s.IsTrial === true,
    inactive: s.Inactive === true,
    mfa: s.StatusMFA === true,
    allowAccountDelete: s.AllowAccountDelete !== false,
    createdAt: s.CreateTime ?? "",
  };
  if (s.TrialExpiry) fields["trialExpiry"] = s.TrialExpiry;
  if (s.QuotaGB !== undefined) fields["quotaGb"] = s.QuotaGB;
  if (s.FTPEnabled !== undefined) fields["enableFtp"] = s.FTPEnabled;
  return instance(
    accountId,
    "sub-account",
    String(s.AcctNum),
    s.AcctName || String(s.AcctNum),
    fields,
  );
}
