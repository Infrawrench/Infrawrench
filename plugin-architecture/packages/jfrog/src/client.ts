import type {
  CreateFieldConfig,
  CreateResourceConfig,
  DashboardStat,
  DetailViewSchema,
  HostServices,
  MetricSeries,
  PluginClient,
  PreflightResult,
  ResourceInstance,
  SidebarItemSchema,
  StorageObject,
} from "@infrawrench/plugin-base";
import { base64ToUtf8, externalIdOf } from "@infrawrench/plugin-base";
import type { JfrogContext } from "./api.js";
import {
  accessPaged,
  encodePath,
  jfrogFetch,
  jfrogText,
  normaliseBaseUrl,
  statusOf,
} from "./api.js";
import type {
  AccessGroup,
  AccessPermission,
  AccessToken,
  AccessUser,
  JfrogBuildInfo,
  JfrogBuildRuns,
  JfrogBuildsList,
  JfrogRepoConfig,
  JfrogRepoStorage,
  JfrogRepoSummary,
  JfrogStorageInfo,
  JfrogVersion,
  XrayPolicy,
  XrayViolation,
  XrayWatch,
} from "./mappers.js";
import {
  lastSegment,
  mapBuild,
  mapBuildRun,
  mapGroup,
  mapPermission,
  mapPlatform,
  mapPolicy,
  mapRepository,
  mapToken,
  mapUser,
  mapViolation,
  mapWatch,
  parseBuildRunId,
  parseSize,
  repoClass,
} from "./mappers.js";
import { platformSeries, repositorySeries } from "./metrics.js";
import { verifyJfrogCredentials } from "./preflight.js";
import { reindexPath } from "./reindex.js";
import {
  BUILD_MODULES_KEY,
  PERMISSION_KEY,
  POLICY_RULES_KEY,
  REPO_STORAGE_KEY,
  renderJfrogDetail,
  renderJfrogSidebar,
} from "./render.js";

const enc = encodeURIComponent;

/** Package types Artifactory accepts for new repositories (its `packageType` values). */
export const PACKAGE_TYPES = [
  "alpine",
  "ansible",
  "bower",
  "cargo",
  "chef",
  "cocoapods",
  "composer",
  "conan",
  "conda",
  "cran",
  "debian",
  "docker",
  "gems",
  "generic",
  "gitlfs",
  "go",
  "gradle",
  "helm",
  "helmoci",
  "hex",
  "huggingfaceml",
  "ivy",
  "maven",
  "nix",
  "npm",
  "nuget",
  "oci",
  "opkg",
  "p2",
  "pub",
  "puppet",
  "pypi",
  "rpm",
  "sbt",
  "swift",
  "terraform",
  "vagrant",
];

const TOKEN_LIFETIMES = [
  { id: "86400", label: "1 day" },
  { id: "604800", label: "7 days" },
  { id: "2592000", label: "30 days" },
  { id: "7776000", label: "90 days" },
  { id: "31536000", label: "1 year" },
  { id: "0", label: "Never expires", description: "Admin only, and not recommended" },
];

const MAX_BUILDS = 50;
const RUNS_PER_BUILD = 25;
const MAX_DETAIL_LOOKUPS = 200;
const VIOLATIONS_LIMIT = 100;

/** Run `fn` over `items` with at most `limit` in flight. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}

const list = (raw: string | undefined): string[] =>
  (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/** Create-form JSON-array values (`policy-picker`), tolerating a plain comma list. */
function pickList(raw: string | undefined): string[] {
  const value = (raw ?? "").trim();
  if (!value) return [];
  if (value.startsWith("[")) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
    } catch {
      // fall through
    }
  }
  return list(value);
}

const bool = (raw: string | undefined): boolean => /^(true|yes|1|on)$/i.test((raw ?? "").trim());

/** The `jti` (token id) inside a JFrog access token, which is a JWT. */
export function tokenIdFromJwt(token: string): string | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const claims = JSON.parse(base64ToUtf8(padded)) as { jti?: unknown };
    return typeof claims.jti === "string" ? claims.jti : undefined;
  } catch {
    return undefined;
  }
}

export class JfrogClient implements PluginClient {
  private readonly ctx: JfrogContext;
  private readonly services: HostServices | undefined;
  private storageCache: Promise<JfrogStorageInfo | undefined> | undefined;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const baseUrl = normaliseBaseUrl(credentials["baseUrl"] ?? "");
    if (!baseUrl) throw new Error("JFrog plugin: missing the platform URL");
    const token = (credentials["accessToken"] ?? "").trim();
    if (!token) throw new Error("JFrog plugin: missing accessToken credential");
    const caCert = credentials["caCert"] ?? "";
    this.ctx = {
      baseUrl,
      token,
      ...(caCert ? { caCert } : {}),
      ...(services?.http ? { http: services.http } : {}),
    };
    this.services = services;
  }

  get baseUrl(): string {
    return this.ctx.baseUrl;
  }

  // -------------------------------------------------------------------------
  // Shared reads
  // -------------------------------------------------------------------------

  /** Storage summary, shared by every lister in one pass; undefined when the token cannot read it. */
  private storage(fresh = false): Promise<JfrogStorageInfo | undefined> {
    if (fresh) this.storageCache = undefined;
    this.storageCache ??= jfrogFetch<JfrogStorageInfo>(
      this.ctx,
      "/artifactory/api/storageinfo",
    ).catch(() => undefined);
    return this.storageCache;
  }

  private async repoStorage(): Promise<Map<string, JfrogRepoStorage>> {
    const s = await this.storage();
    return new Map((s?.repositoriesSummaryList ?? []).map((r) => [r.repoKey, r]));
  }

  /**
   * Every repository's configuration. One call (`/repositories/configurations`,
   * Artifactory 7.61.3+, admin) where available; otherwise one GET per
   * repository, bounded, and finally nothing (the summary still lists them).
   */
  private async repoConfigs(summaries: JfrogRepoSummary[]): Promise<Map<string, JfrogRepoConfig>> {
    try {
      const all = await jfrogFetch<Record<string, JfrogRepoConfig[]>>(
        this.ctx,
        "/artifactory/api/repositories/configurations",
      );
      const out = new Map<string, JfrogRepoConfig>();
      for (const [cls, configs] of Object.entries(all ?? {})) {
        for (const c of Array.isArray(configs) ? configs : []) {
          out.set(c.key, { ...c, rclass: c.rclass ?? cls.toLowerCase() });
        }
      }
      if (out.size > 0) return out;
    } catch {
      // Older platform or a non-admin token: fall back to per-repository reads.
    }
    const configs = await mapLimit(summaries.slice(0, MAX_DETAIL_LOOKUPS), 8, (s) =>
      this.repoConfig(s.key).catch(() => undefined),
    );
    return new Map(configs.filter((c): c is JfrogRepoConfig => !!c).map((c) => [c.key, c]));
  }

  private repoConfig(key: string): Promise<JfrogRepoConfig> {
    return jfrogFetch<JfrogRepoConfig>(this.ctx, `/artifactory/api/repositories/${enc(key)}`);
  }

  private async repoSummaries(): Promise<JfrogRepoSummary[]> {
    const res = await jfrogFetch<JfrogRepoSummary[]>(this.ctx, "/artifactory/api/repositories");
    return Array.isArray(res) ? res : [];
  }

  /** Builds are a Pro feature; a platform without any answers 404. */
  private async buildNames(): Promise<Array<{ name: string; lastStarted?: string }>> {
    try {
      const res = await jfrogFetch<JfrogBuildsList>(this.ctx, "/artifactory/api/build");
      return (res?.builds ?? [])
        .map((b) => ({
          name: lastSegment(b.uri),
          ...(b.lastStarted ? { lastStarted: b.lastStarted } : {}),
        }))
        .filter((b) => b.name);
    } catch (err) {
      if (statusOf(err) === 404) return [];
      throw err;
    }
  }

  private async buildRuns(name: string): Promise<Array<{ number: string; started?: string }>> {
    try {
      const res = await jfrogFetch<JfrogBuildRuns>(this.ctx, `/artifactory/api/build/${enc(name)}`);
      return (res?.buildsNumbers ?? [])
        .map((b) => ({ number: lastSegment(b.uri), ...(b.started ? { started: b.started } : {}) }))
        .filter((b) => b.number)
        .sort((a, b) => (b.started ?? "").localeCompare(a.started ?? ""));
    } catch (err) {
      if (statusOf(err) === 404) return [];
      throw err;
    }
  }

  /** Xray lists answer 404 when Xray is not part of the subscription: that is "none", not an error. */
  private async xray<T>(
    path: string,
    init: Parameters<typeof jfrogFetch>[2] = {},
  ): Promise<T | undefined> {
    try {
      return await jfrogFetch<T>(this.ctx, path, init);
    } catch (err) {
      if (statusOf(err) === 404) return undefined;
      throw err;
    }
  }

  private async violations(filters: Record<string, string> = {}): Promise<XrayViolation[]> {
    const res = await this.xray<{ violations?: XrayViolation[] }>("/xray/api/v1/violations", {
      method: "POST",
      body: {
        filters,
        pagination: { order_by: "created", direction: "desc", limit: VIOLATIONS_LIMIT, offset: 1 },
      },
    });
    return res?.violations ?? [];
  }

  private user(name: string): Promise<AccessUser> {
    return jfrogFetch<AccessUser>(this.ctx, `/access/api/v2/users/${enc(name)}`);
  }

  private group(name: string): Promise<AccessGroup> {
    return jfrogFetch<AccessGroup>(this.ctx, `/access/api/v2/groups/${enc(name)}`);
  }

  private permission(name: string): Promise<AccessPermission> {
    return jfrogFetch<AccessPermission>(this.ctx, `/access/api/v2/permissions/${enc(name)}`);
  }

  private watch(name: string): Promise<XrayWatch> {
    return jfrogFetch<XrayWatch>(this.ctx, `/xray/api/v2/watches/${enc(name)}`);
  }

  private policy(name: string): Promise<XrayPolicy> {
    return jfrogFetch<XrayPolicy>(this.ctx, `/xray/api/v1/policies/${enc(name)}`);
  }

  private async userNames(): Promise<string[]> {
    const users = await accessPaged<{ username: string }>(
      this.ctx,
      "/access/api/v2/users",
      "users",
    );
    return users.map((u) => u.username).filter(Boolean);
  }

  private async groupNames(): Promise<string[]> {
    const groups = await accessPaged<{ group_name?: string; name?: string }>(
      this.ctx,
      "/access/api/v2/groups",
      "groups",
    );
    return groups.map((g) => g.group_name ?? g.name ?? "").filter(Boolean);
  }

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "jfrog-platform":
        return [await this.platform(accountId, true)];
      case "jfrog-repository": {
        this.storageCache = undefined;
        const summaries = await this.repoSummaries();
        const [configs, storage] = await Promise.all([
          this.repoConfigs(summaries),
          this.repoStorage(),
        ]);
        return summaries.map((s) =>
          mapRepository(accountId, this.ctx.baseUrl, s, configs.get(s.key), storage.get(s.key)),
        );
      }
      case "jfrog-build":
        return (await this.buildNames()).map((b) => mapBuild(accountId, b.name, b.lastStarted));
      case "jfrog-build-run": {
        const builds = (await this.buildNames()).slice(0, MAX_BUILDS);
        const runs = await mapLimit(builds, 6, async (b) =>
          (await this.buildRuns(b.name))
            .slice(0, RUNS_PER_BUILD)
            .map((r) => mapBuildRun(accountId, b.name, r.number, r.started)),
        );
        return runs.flat();
      }
      case "jfrog-xray-watch":
        return ((await this.xray<XrayWatch[]>("/xray/api/v2/watches")) ?? [])
          .filter((w) => w.general_data?.name)
          .map((w) => mapWatch(accountId, w));
      case "jfrog-xray-policy":
        return ((await this.xray<XrayPolicy[]>("/xray/api/v1/policies")) ?? []).map((p) =>
          this.withRules(mapPolicy(accountId, p), p),
        );
      case "jfrog-xray-violation":
        return (await this.violations()).map((v) => mapViolation(accountId, v));
      case "jfrog-access-token": {
        const res = await jfrogFetch<{ tokens?: AccessToken[] }>(this.ctx, "/access/api/v1/tokens");
        return (res?.tokens ?? []).filter((t) => t.token_id).map((t) => mapToken(accountId, t));
      }
      case "jfrog-user": {
        const users = await accessPaged<AccessUser>(this.ctx, "/access/api/v2/users", "users");
        return mapLimit(users, 8, async (u, i) => {
          if (i >= MAX_DETAIL_LOOKUPS) return mapUser(accountId, u);
          return mapUser(accountId, await this.user(u.username).catch(() => u));
        });
      }
      case "jfrog-group": {
        const names = await this.groupNames();
        return mapLimit(names, 8, async (name) =>
          mapGroup(accountId, await this.group(name).catch(() => ({ name }))),
        );
      }
      case "jfrog-permission": {
        const perms = await accessPaged<{ name: string }>(
          this.ctx,
          "/access/api/v2/permissions",
          "permissions",
        );
        return mapLimit(perms, 8, async (p) => {
          const full = await this.permission(p.name).catch(
            () => ({ name: p.name }) as AccessPermission,
          );
          return this.withGrants(mapPermission(accountId, full), full);
        });
      }
      default:
        throw new Error(`JFrog plugin: unknown resource type "${typeId}"`);
    }
  }

  private async platform(accountId: string, fresh: boolean): Promise<ResourceInstance> {
    const [version, storage] = await Promise.all([
      jfrogFetch<JfrogVersion>(this.ctx, "/artifactory/api/system/version").catch(() => undefined),
      this.storage(fresh),
    ]);
    if (!version && !storage) {
      // Neither answered: make the token's actual problem visible.
      await jfrogFetch(this.ctx, "/artifactory/api/repositories");
    }
    const r = mapPlatform(accountId, this.ctx.baseUrl, version, storage);
    const top = (storage?.repositoriesSummaryList ?? [])
      .filter((x) => x.repoKey !== "TOTAL")
      .sort(
        (a, b) =>
          (b.usedSpaceInBytes ?? parseSize(b.usedSpace) ?? 0) -
          (a.usedSpaceInBytes ?? parseSize(a.usedSpace) ?? 0),
      )
      .slice(0, 15);
    return top.length
      ? { ...r, resolvedOutputs: { ...r.resolvedOutputs, [REPO_STORAGE_KEY]: JSON.stringify(top) } }
      : r;
  }

  private withRules(r: ResourceInstance, p: XrayPolicy): ResourceInstance {
    return {
      ...r,
      resolvedOutputs: { ...r.resolvedOutputs, [POLICY_RULES_KEY]: JSON.stringify(p.rules ?? []) },
    };
  }

  private withGrants(r: ResourceInstance, p: AccessPermission): ResourceInstance {
    return {
      ...r,
      resolvedOutputs: {
        ...r.resolvedOutputs,
        [PERMISSION_KEY]: JSON.stringify(p.resources ?? {}),
      },
    };
  }

  // -------------------------------------------------------------------------
  // Single reads
  // -------------------------------------------------------------------------

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const id = externalIdOf(resourceId);
    switch (typeId) {
      case "jfrog-platform":
        return this.platform(accountId, false);
      case "jfrog-repository": {
        const [config, storage] = await Promise.all([this.repoConfig(id), this.repoStorage()]);
        return mapRepository(
          accountId,
          this.ctx.baseUrl,
          {
            key: config.key ?? id,
            ...(config.packageType ? { packageType: config.packageType } : {}),
          },
          config,
          storage.get(id),
        );
      }
      case "jfrog-build": {
        const runs = await this.buildRuns(id);
        if (runs.length === 0)
          throw Object.assign(new Error(`JFrog plugin: build "${id}" not found`), { status: 404 });
        return mapBuild(accountId, id, runs[0]?.started, runs.length, runs[0]?.number);
      }
      case "jfrog-build-run": {
        const { name, number } = parseBuildRunId(id);
        const res = await jfrogFetch<JfrogBuildInfo>(
          this.ctx,
          `/artifactory/api/build/${enc(name)}/${enc(number)}`,
        );
        const r = mapBuildRun(accountId, name, number, undefined, res?.buildInfo);
        return {
          ...r,
          resolvedOutputs: {
            ...r.resolvedOutputs,
            number,
            [BUILD_MODULES_KEY]: JSON.stringify(res?.buildInfo?.modules ?? []),
          },
        };
      }
      case "jfrog-xray-watch":
        return mapWatch(accountId, await this.watch(id));
      case "jfrog-xray-policy": {
        const p = await this.policy(id);
        return this.withRules(mapPolicy(accountId, p), p);
      }
      case "jfrog-xray-violation": {
        const found = (await this.violations()).map((v) => mapViolation(accountId, v));
        const hit = found.find((v) => v.externalId === id);
        if (!hit)
          throw Object.assign(new Error(`JFrog plugin: violation "${id}" not found`), {
            status: 404,
          });
        return hit;
      }
      case "jfrog-access-token": {
        const t = await jfrogFetch<AccessToken>(this.ctx, `/access/api/v1/tokens/${enc(id)}`);
        return mapToken(accountId, { ...t, token_id: t.token_id ?? id });
      }
      case "jfrog-user":
        return mapUser(accountId, await this.user(id));
      case "jfrog-group":
        return mapGroup(accountId, await this.group(id));
      case "jfrog-permission": {
        const p = await this.permission(id);
        return this.withGrants(mapPermission(accountId, p), p);
      }
      default:
        throw new Error(`JFrog plugin: unknown resource type "${typeId}"`);
    }
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    if (typeId === "jfrog-access-token" && outputKey === "accessToken") {
      const value = await this.services?.secrets?.getPlaintext(resourceId, "accessToken");
      if (value) return value;
      throw new Error(
        "JFrog plugin: the token's value is only kept for tokens created from Infrawrench, and JFrog never shows it again.",
      );
    }
    const resource = await this.getResource(typeId, resourceId, accountId);
    const resolved = resource.resolvedOutputs[outputKey];
    if (resolved !== undefined) return resolved;
    const field = resource.fields[outputKey];
    if (field !== undefined) return String(field);
    throw new Error(`JFrog plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
  }

  // -------------------------------------------------------------------------
  // Stats, metrics, preflight
  // -------------------------------------------------------------------------

  async fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    const r = await this.getResource(resourceTypeId, resourceId, accountId);
    const f = r.fields;
    const show = (v: unknown) =>
      v === undefined || v === ""
        ? "—"
        : typeof v === "number"
          ? v.toLocaleString("en-US")
          : String(v);
    switch (resourceTypeId) {
      case "jfrog-platform":
        return [
          { label: "Artifacts", value: show(f["artifactsCount"]) },
          { label: "Storage", value: show(f["artifactsSize"]) },
        ];
      case "jfrog-repository":
        return [
          { label: "Files", value: show(f["filesCount"]) },
          { label: "Used", value: show(f["usedSpace"]) },
        ];
      case "jfrog-xray-watch":
        return [
          {
            label: "Status",
            value: f["active"] === true ? "active" : "disabled",
            variant: f["active"] === true ? "status-healthy" : "status-degraded",
          },
        ];
      case "jfrog-access-token":
        return [
          { label: "Expires", value: f["neverExpires"] === true ? "never" : show(f["expiresAt"]) },
        ];
      default:
        return [];
    }
  }

  async fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
  ): Promise<MetricSeries[]> {
    const storage = await this.storage(true);
    if (!storage) return [];
    if (resourceTypeId === "jfrog-platform") return platformSeries(storage);
    if (resourceTypeId === "jfrog-repository") {
      const key = externalIdOf(resourceId);
      const row = storage.repositoriesSummaryList?.find((x) => x.repoKey === key);
      return row ? repositorySeries(row) : [];
    }
    return [];
  }

  verifyCredentials(): Promise<PreflightResult> {
    return verifyJfrogCredentials(this.ctx);
  }

  // -------------------------------------------------------------------------
  // Storage browser (artifacts inside a repository)
  // -------------------------------------------------------------------------

  async listStorageObjects(bucket: string, prefix: string): Promise<StorageObject[]> {
    const folder = prefix.replace(/^\/+/, "");
    const base = folder && !folder.endsWith("/") ? `${folder}/` : folder;
    const path = `/artifactory/api/storage/${enc(bucket)}${base ? `/${encodePath(base)}` : ""}`;
    try {
      const res = await jfrogFetch<{
        files?: Array<{
          uri?: string;
          size?: number | string;
          lastModified?: string;
          folder?: boolean | string;
        }>;
      }>(this.ctx, path, { query: { list: true, deep: 0, listFolders: 1 } });
      return (res?.files ?? []).map((file) => {
        const name = (file.uri ?? "").replace(/^\/+/, "");
        const isDirectory = file.folder === true || file.folder === "true";
        const size = Number(file.size);
        return {
          key: `${base}${name}${isDirectory ? "/" : ""}`,
          name,
          size: isDirectory || !Number.isFinite(size) || size < 0 ? 0 : size,
          lastModified: file.lastModified ?? "",
          isDirectory,
        };
      });
    } catch (err) {
      // File List needs Artifactory Pro; Folder Info works everywhere (no sizes).
      if (statusOf(err) !== 400 && statusOf(err) !== 403 && statusOf(err) !== 404) throw err;
      const info = await jfrogFetch<{ children?: Array<{ uri?: string; folder?: boolean }> }>(
        this.ctx,
        path,
      );
      return (info?.children ?? []).map((c) => {
        const name = (c.uri ?? "").replace(/^\/+/, "");
        return {
          key: `${base}${name}${c.folder ? "/" : ""}`,
          name,
          size: 0,
          lastModified: "",
          isDirectory: c.folder === true,
        };
      });
    }
  }

  async uploadStorageObject(
    bucket: string,
    key: string,
    file: File,
    onProgress?: (pct: number) => void,
  ): Promise<void> {
    onProgress?.(0);
    const bytes = new Uint8Array(await file.arrayBuffer());
    await jfrogText(this.ctx, `/artifactory/${enc(bucket)}/${encodePath(key)}`, {
      method: "PUT",
      body: bytes,
      contentType: file.type || "application/octet-stream",
    });
    onProgress?.(100);
  }

  async makeStorageFolder(bucket: string, key: string): Promise<void> {
    // A PUT on a path ending in a slash creates the directory.
    await jfrogText(this.ctx, `/artifactory/${enc(bucket)}/${encodePath(key)}/`, { method: "PUT" });
  }

  async deleteStorageObject(bucket: string, key: string): Promise<void> {
    // Deleting a folder path removes everything under it.
    await jfrogText(this.ctx, `/artifactory/${enc(bucket)}/${encodePath(key)}`, {
      method: "DELETE",
    });
  }

  // -------------------------------------------------------------------------
  // Create / update / delete
  // -------------------------------------------------------------------------

  async getCreateConfig(typeId: string): Promise<CreateResourceConfig> {
    switch (typeId) {
      case "jfrog-repository": {
        const repos = await this.repoSummaries().catch(() => [] as JfrogRepoSummary[]);
        const options = repos.map((r) => ({
          id: r.key,
          label: r.key,
          description: [repoClass(r.type), (r.packageType ?? "").toLowerCase()]
            .filter(Boolean)
            .join(" · "),
          category: repoClass(r.type) || "repository",
        }));
        const virtualOnly = { fieldKey: "rclass", fieldValue: "virtual" };
        return {
          fields: [
            {
              key: "key",
              label: "Key",
              kind: "text",
              required: true,
              placeholder: "libs-release-local",
              description:
                "Unique repository key: letters, digits, dashes and dots; it becomes part of the URL.",
            },
            {
              key: "rclass",
              label: "Class",
              kind: "select",
              required: true,
              defaultValue: "local",
              options: [
                { id: "local", label: "Local", description: "Hosts artifacts you deploy" },
                { id: "remote", label: "Remote", description: "Caching proxy of another registry" },
                {
                  id: "virtual",
                  label: "Virtual",
                  description: "Several repositories behind one URL",
                },
                {
                  id: "federated",
                  label: "Federated",
                  description: "Local repository mirrored across platforms (Enterprise X+)",
                },
              ],
            },
            {
              key: "packageType",
              label: "Package type",
              kind: "select",
              required: true,
              defaultValue: "generic",
              options: PACKAGE_TYPES.map((p) => ({ id: p, label: p })),
            },
            {
              key: "remoteUrl",
              label: "Upstream URL",
              kind: "text",
              required: false,
              placeholder: "https://registry.npmjs.org",
              description: "The registry this remote repository proxies.",
              showWhen: { fieldKey: "rclass", fieldValue: "remote" },
            },
            {
              key: "repositories",
              label: "Member repositories",
              kind: "policy-picker",
              required: false,
              description: "Repositories this virtual repository aggregates, in resolution order.",
              policies: options,
              showWhen: virtualOnly,
            },
            {
              key: "defaultDeploymentRepo",
              label: "Default deployment repository",
              kind: "select",
              required: false,
              description: "The local repository deploys to this virtual repository land in.",
              options: [
                { id: "", label: "None" },
                ...repos
                  .filter((r) => repoClass(r.type) === "local")
                  .map((r) => ({ id: r.key, label: r.key })),
              ],
              showWhen: virtualOnly,
            },
            { key: "description", label: "Description", kind: "text", required: false },
            {
              key: "xrayIndex",
              label: "Scan with Xray",
              kind: "select",
              required: false,
              defaultValue: "false",
              options: [
                { id: "false", label: "No" },
                { id: "true", label: "Yes" },
              ],
              showWhen: { fieldKey: "rclass", fieldValuesNot: ["virtual"] },
            },
          ],
        };
      }
      case "jfrog-access-token": {
        const [users, groups] = await Promise.all([
          this.userNames().catch(() => [] as string[]),
          this.groupNames().catch(() => [] as string[]),
        ]);
        return {
          fields: [
            {
              key: "description",
              label: "Description",
              kind: "text",
              required: true,
              placeholder: "CI deploy token",
            },
            {
              key: "username",
              label: "User",
              kind: "select",
              required: false,
              description:
                "Whose permissions the token carries. Leave as yourself unless the connection's token is an admin token.",
              options: [
                { id: "", label: "The user this connection uses" },
                ...users.map((u) => ({ id: u, label: u })),
              ],
            },
            {
              key: "scope",
              label: "Scope",
              kind: "select",
              required: true,
              defaultValue: "applied-permissions/user",
              options: [
                {
                  id: "applied-permissions/user",
                  label: "User",
                  description: "The user's own permissions",
                },
                {
                  id: "applied-permissions/admin",
                  label: "Admin",
                  description: "Full platform admin (admin only)",
                },
                ...groups.map((g) => ({
                  id: `applied-permissions/groups:${g}`,
                  label: `Group: ${g}`,
                  description: "Only what this group is permitted",
                })),
              ],
            },
            {
              key: "expiresIn",
              label: "Expires after",
              kind: "select",
              required: true,
              defaultValue: "2592000",
              options: TOKEN_LIFETIMES,
            },
            {
              key: "refreshable",
              label: "Refreshable",
              kind: "select",
              required: false,
              defaultValue: "false",
              options: [
                { id: "false", label: "No" },
                { id: "true", label: "Yes" },
              ],
            },
          ],
        };
      }
      case "jfrog-user": {
        const groups = await this.groupNames().catch(() => [] as string[]);
        return {
          fields: [
            {
              key: "username",
              label: "Username",
              kind: "text",
              required: true,
              placeholder: "alice",
            },
            {
              key: "email",
              label: "Email",
              kind: "text",
              required: true,
              placeholder: "alice@example.com",
            },
            {
              key: "password",
              label: "Password",
              kind: "password",
              required: true,
              description: "Must satisfy the platform's password policy.",
            },
            {
              key: "groups",
              label: "Groups",
              kind: "policy-picker",
              required: false,
              policies: groups.map((g) => ({ id: g, label: g })),
            },
            {
              key: "admin",
              label: "Admin",
              kind: "select",
              required: false,
              defaultValue: "false",
              options: [
                { id: "false", label: "No" },
                { id: "true", label: "Yes" },
              ],
            },
            {
              key: "disableUiAccess",
              label: "API only (no UI access)",
              kind: "select",
              required: false,
              defaultValue: "false",
              options: [
                { id: "false", label: "No" },
                { id: "true", label: "Yes" },
              ],
            },
          ],
        };
      }
      case "jfrog-group": {
        const users = await this.userNames().catch(() => [] as string[]);
        const yesNo = (key: string, label: string, description: string): CreateFieldConfig => ({
          key,
          label,
          kind: "select",
          required: false,
          defaultValue: "false",
          description,
          options: [
            { id: "false", label: "No" },
            { id: "true", label: "Yes" },
          ],
        });
        return {
          fields: [
            { key: "name", label: "Name", kind: "text", required: true, placeholder: "developers" },
            { key: "description", label: "Description", kind: "text", required: false },
            {
              key: "members",
              label: "Members",
              kind: "policy-picker",
              required: false,
              policies: users.map((u) => ({ id: u, label: u })),
            },
            yesNo(
              "autoJoin",
              "Add new users automatically",
              "Every user created from now on joins this group.",
            ),
            yesNo("adminPrivileges", "Admin privileges", "Members become platform admins."),
          ],
        };
      }
      default:
        throw new Error(`JFrog plugin: cannot create "${typeId}" from Infrawrench`);
    }
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const text = (k: string) => (fields[k] ?? "").trim();
    switch (typeId) {
      case "jfrog-repository": {
        const key = text("key");
        const rclass = text("rclass") || "local";
        if (!key) throw new Error("JFrog plugin: a repository key is required");
        const body: Record<string, unknown> = {
          key,
          rclass,
          packageType: text("packageType") || "generic",
        };
        if (text("description")) body["description"] = text("description");
        if (rclass === "remote") {
          if (!/^https?:\/\//i.test(text("remoteUrl"))) {
            throw new Error(
              "JFrog plugin: a remote repository needs the upstream URL (http:// or https://)",
            );
          }
          body["url"] = text("remoteUrl");
        }
        if (rclass === "virtual") {
          body["repositories"] = pickList(fields["repositories"]);
          if (text("defaultDeploymentRepo"))
            body["defaultDeploymentRepo"] = text("defaultDeploymentRepo");
        } else if (fields["xrayIndex"] !== undefined) {
          body["xrayIndex"] = bool(fields["xrayIndex"]);
        }
        await jfrogText(this.ctx, `/artifactory/api/repositories/${enc(key)}`, {
          method: "PUT",
          body,
        });
        return this.getResource(typeId, `${accountId}:${typeId}:${key}`, accountId);
      }
      case "jfrog-access-token": {
        const expires = Number(text("expiresIn") || "2592000");
        const body: Record<string, unknown> = {
          grant_type: "client_credentials",
          scope: text("scope") || "applied-permissions/user",
          expires_in: Number.isFinite(expires) ? expires : 2592000,
          refreshable: bool(fields["refreshable"]),
          description: text("description"),
        };
        if (text("username")) body["username"] = text("username");
        const res = await jfrogFetch<{ access_token?: string }>(this.ctx, "/access/api/v1/tokens", {
          method: "POST",
          body,
        });
        const token = res?.access_token ?? "";
        if (!token) throw new Error("JFrog plugin: the platform returned no token");
        let id = tokenIdFromJwt(token);
        if (!id) {
          const listed = await jfrogFetch<{ tokens?: AccessToken[] }>(
            this.ctx,
            "/access/api/v1/tokens",
          );
          id = (listed?.tokens ?? [])
            .filter((t) => (t.description ?? "") === text("description"))
            .sort((a, b) => (b.issued_at ?? 0) - (a.issued_at ?? 0))[0]?.token_id;
        }
        const base = id
          ? await this.getResource(typeId, `${accountId}:${typeId}:${id}`, accountId).catch(() =>
              mapToken(accountId, {
                token_id: id!,
                description: text("description"),
                scope: String(body["scope"]),
              }),
            )
          : mapToken(accountId, {
              token_id: `new-${Date.now()}`,
              description: text("description"),
              scope: String(body["scope"]),
            });
        return {
          ...base,
          resolvedOutputs: { ...base.resolvedOutputs, accessToken: token },
          secretStates: [
            { fieldKey: "accessToken", resolution: { kind: "plaintext", value: token } },
          ],
        };
      }
      case "jfrog-user": {
        const username = text("username");
        if (!username || !text("email"))
          throw new Error("JFrog plugin: a username and email are required");
        const body: Record<string, unknown> = {
          username,
          email: text("email"),
          password: fields["password"] ?? "",
          admin: bool(fields["admin"]),
          disable_ui_access: bool(fields["disableUiAccess"]),
          groups: pickList(fields["groups"]),
        };
        const u = await jfrogFetch<AccessUser>(this.ctx, "/access/api/v2/users", {
          method: "POST",
          body,
        });
        return mapUser(accountId, u?.username ? u : await this.user(username));
      }
      case "jfrog-group": {
        const name = text("name");
        if (!name) throw new Error("JFrog plugin: a group name is required");
        const body: Record<string, unknown> = {
          name,
          description: text("description"),
          auto_join: bool(fields["autoJoin"]),
          admin_privileges: bool(fields["adminPrivileges"]),
          members: pickList(fields["members"]),
        };
        const g = await jfrogFetch<AccessGroup>(this.ctx, "/access/api/v2/groups", {
          method: "POST",
          body,
        });
        return mapGroup(accountId, g?.name ? g : await this.group(name));
      }
      default:
        throw new Error(`JFrog plugin: cannot create "${typeId}" from Infrawrench`);
    }
  }

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const id = externalIdOf(resourceId);
    const has = (k: string) => k in fields;
    const text = (k: string) => (fields[k] ?? "").trim();
    switch (typeId) {
      case "jfrog-repository": {
        const current = await this.repoConfig(id);
        const rclass = repoClass(current.rclass);
        const body: Record<string, unknown> = { key: id, rclass };
        if (has("description")) body["description"] = text("description");
        if (has("notes")) body["notes"] = text("notes");
        if (has("includesPattern")) body["includesPattern"] = text("includesPattern") || "**/*";
        if (has("excludesPattern")) body["excludesPattern"] = text("excludesPattern");
        if (has("xrayIndex")) body["xrayIndex"] = bool(fields["xrayIndex"]);
        if (has("blackedOut")) body["blackedOut"] = bool(fields["blackedOut"]);
        if (rclass === "remote") {
          if (has("remoteUrl")) {
            if (!/^https?:\/\//i.test(text("remoteUrl"))) {
              throw new Error("JFrog plugin: the upstream URL must start with http:// or https://");
            }
            body["url"] = text("remoteUrl");
          }
          if (has("offline")) body["offline"] = bool(fields["offline"]);
          if (has("retrievalCachePeriodSecs")) {
            const n = Number(text("retrievalCachePeriodSecs"));
            if (!Number.isFinite(n) || n < 0)
              throw new Error("JFrog plugin: the cache period must be a number of seconds");
            body["retrievalCachePeriodSecs"] = n;
          }
        }
        if (rclass === "virtual") {
          if (has("repositories")) body["repositories"] = list(fields["repositories"]);
          if (has("defaultDeploymentRepo"))
            body["defaultDeploymentRepo"] = text("defaultDeploymentRepo");
        }
        await jfrogText(this.ctx, `/artifactory/api/repositories/${enc(id)}`, {
          method: "POST",
          body,
        });
        break;
      }
      case "jfrog-xray-watch": {
        if (has("description")) {
          const w = await this.watch(id);
          await jfrogFetch(this.ctx, `/xray/api/v2/watches/${enc(id)}`, {
            method: "PUT",
            body: {
              ...w,
              general_data: { ...(w.general_data ?? {}), description: text("description") },
            },
          });
        }
        break;
      }
      case "jfrog-xray-policy": {
        if (has("description")) {
          const p = await this.policy(id);
          await jfrogFetch(this.ctx, `/xray/api/v1/policies/${enc(id)}`, {
            method: "PUT",
            body: { ...p, description: text("description") },
          });
        }
        break;
      }
      case "jfrog-user": {
        const body: Record<string, unknown> = {};
        if (has("email") && text("email")) body["email"] = text("email");
        if (has("admin")) body["admin"] = bool(fields["admin"]);
        if (has("disableUiAccess")) body["disable_ui_access"] = bool(fields["disableUiAccess"]);
        if (has("profileUpdatable")) body["profile_updatable"] = bool(fields["profileUpdatable"]);
        if (has("internalPasswordDisabled")) {
          body["internal_password_disabled"] = bool(fields["internalPasswordDisabled"]);
        }
        if (has("password") && fields["password"]) body["password"] = fields["password"];
        if (Object.keys(body).length > 0) {
          await jfrogFetch(this.ctx, `/access/api/v2/users/${enc(id)}`, { method: "PATCH", body });
        }
        if (has("groups")) {
          const current = new Set((await this.user(id)).groups ?? []);
          const wanted = new Set(list(fields["groups"]));
          const add = [...wanted].filter((g) => !current.has(g));
          const remove = [...current].filter((g) => !wanted.has(g));
          if (add.length || remove.length) {
            await jfrogFetch(this.ctx, `/access/api/v2/users/${enc(id)}/groups`, {
              method: "PATCH",
              body: { add, remove },
            });
          }
        }
        break;
      }
      case "jfrog-group": {
        const body: Record<string, unknown> = {};
        if (has("description")) body["description"] = text("description");
        if (has("autoJoin")) body["auto_join"] = bool(fields["autoJoin"]);
        if (has("adminPrivileges")) body["admin_privileges"] = bool(fields["adminPrivileges"]);
        if (has("externalId")) body["external_id"] = text("externalId");
        if (Object.keys(body).length > 0) {
          await jfrogFetch(this.ctx, `/access/api/v2/groups/${enc(id)}`, { method: "PATCH", body });
        }
        if (has("members")) {
          const current = new Set((await this.group(id)).members ?? []);
          const wanted = new Set(list(fields["members"]));
          const add = [...wanted].filter((m) => !current.has(m));
          const remove = [...current].filter((m) => !wanted.has(m));
          if (add.length || remove.length) {
            await jfrogFetch(this.ctx, `/access/api/v2/groups/${enc(id)}/members`, {
              method: "PATCH",
              body: { add, remove },
            });
          }
        }
        break;
      }
      default:
        throw new Error(`JFrog plugin: "${typeId}" cannot be edited from Infrawrench`);
    }
    return this.getResource(typeId, resourceId, accountId);
  }

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    const id = externalIdOf(resourceId);
    const del = (path: string) => jfrogText(this.ctx, path, { method: "DELETE" });
    switch (typeId) {
      case "jfrog-repository":
        await del(`/artifactory/api/repositories/${enc(id)}`);
        return;
      case "jfrog-build":
        await jfrogText(this.ctx, "/artifactory/api/build/delete", {
          method: "POST",
          body: { buildName: id, deleteAll: true, deleteArtifacts: false },
        });
        return;
      case "jfrog-build-run": {
        const { name, number } = parseBuildRunId(id);
        await jfrogText(this.ctx, "/artifactory/api/build/delete", {
          method: "POST",
          body: { buildName: name, buildNumbers: [number], deleteArtifacts: false },
        });
        return;
      }
      case "jfrog-xray-watch":
        await del(`/xray/api/v2/watches/${enc(id)}`);
        return;
      case "jfrog-xray-policy":
        await del(`/xray/api/v1/policies/${enc(id)}`);
        return;
      case "jfrog-access-token":
        await del(`/access/api/v1/tokens/${enc(id)}`);
        return;
      case "jfrog-user":
        await del(`/access/api/v2/users/${enc(id)}`);
        return;
      case "jfrog-group":
        await del(`/access/api/v2/groups/${enc(id)}`);
        return;
      case "jfrog-permission":
        await del(`/access/api/v2/permissions/${enc(id)}`);
        return;
      default:
        throw new Error(`JFrog plugin: "${typeId}" cannot be deleted from Infrawrench`);
    }
  }

  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    accountId: string,
  ): Promise<void> {
    const id = externalIdOf(resourceId);
    switch (`${typeId}:${actionId}`) {
      case "jfrog-platform:refresh-storage":
        await jfrogText(this.ctx, "/artifactory/api/storageinfo/calculate", { method: "POST" });
        this.storageCache = undefined;
        return;
      case "jfrog-repository:zap-cache":
        await jfrogText(this.ctx, `/artifactory/api/zap/${enc(id)}`, { method: "POST" });
        return;
      case "jfrog-repository:reindex": {
        const r = await this.getResource(typeId, resourceId, accountId);
        const path = reindexPath(String(r.fields["packageType"] ?? ""), id);
        if (!path)
          throw new Error(
            `JFrog plugin: ${String(r.fields["packageType"])} repositories have no index to recalculate`,
          );
        await jfrogText(this.ctx, path, { method: "POST" });
        return;
      }
      case "jfrog-xray-watch:enable":
      case "jfrog-xray-watch:disable": {
        const w = await this.watch(id);
        await jfrogFetch(this.ctx, `/xray/api/v2/watches/${enc(id)}`, {
          method: "PUT",
          body: {
            ...w,
            general_data: { ...(w.general_data ?? {}), active: actionId === "enable" },
          },
        });
        return;
      }
      case "jfrog-access-token:revoke":
        await jfrogText(this.ctx, `/access/api/v1/tokens/${enc(id)}`, { method: "DELETE" });
        return;
      default:
        throw new Error(`JFrog plugin: unknown action "${actionId}" for "${typeId}"`);
    }
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    const schema = renderJfrogDetail(resource, this.ctx.baseUrl);
    // Remote repositories keep their artifacts in the `<key>-cache` repository.
    if (schema.storageBrowser && resource.fields["rclass"] === "remote") {
      return {
        ...schema,
        storageBrowser: { bucketName: `${schema.storageBrowser.bucketName}-cache` },
      };
    }
    return schema;
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderJfrogSidebar(resource);
  }
}
