/**
 * Raw JFrog Platform shapes (only the fields the plugin reads) and their
 * mapping to `ResourceInstance`s. Field names follow the OpenAPI documents
 * published at docs.jfrog.com (2026-10).
 */
import type { ResourceInstance } from "@infrawrench/plugin-base";

export const PLUGIN_ID = "jfrog";

// ---------------------------------------------------------------------------
// Artifactory
// ---------------------------------------------------------------------------

/** One row of `GET /artifactory/api/repositories`. */
export interface JfrogRepoSummary {
  key: string;
  type?: string;
  description?: string;
  url?: string;
  packageType?: string;
}

/** `GET /artifactory/api/repositories/{key}` (fields vary by `rclass`). */
export interface JfrogRepoConfig {
  key: string;
  rclass?: string;
  packageType?: string;
  description?: string;
  notes?: string;
  includesPattern?: string;
  excludesPattern?: string;
  repoLayoutRef?: string;
  projectKey?: string;
  environments?: string[];
  xrayIndex?: boolean;
  blackedOut?: boolean;
  // remote
  url?: string;
  username?: string;
  offline?: boolean;
  retrievalCachePeriodSecs?: number;
  // virtual
  repositories?: string[];
  defaultDeploymentRepo?: string;
  // local
  maxUniqueSnapshots?: number;
  handleReleases?: boolean;
  handleSnapshots?: boolean;
}

/** One row of `repositoriesSummaryList` in `GET /artifactory/api/storageinfo`. */
export interface JfrogRepoStorage {
  repoKey: string;
  repoType?: string;
  foldersCount?: number;
  filesCount?: number;
  usedSpace?: string;
  usedSpaceInBytes?: number;
  itemsCount?: number;
  packageType?: string;
  percentage?: string;
}

export interface JfrogStorageInfo {
  binariesSummary?: {
    binariesCount?: string;
    binariesSize?: string;
    artifactsSize?: string;
    optimization?: string;
    itemsCount?: string;
    artifactsCount?: string;
  };
  fileStoreSummary?: {
    storageType?: string;
    storageDirectory?: string;
    totalSpace?: string;
    usedSpace?: string;
    freeSpace?: string;
  };
  repositoriesSummaryList?: JfrogRepoStorage[];
}

export interface JfrogVersion {
  version?: string;
  revision?: string;
  addons?: string[];
  license?: string;
}

export interface JfrogBuildsList {
  builds?: Array<{ uri?: string; lastStarted?: string }>;
}

export interface JfrogBuildRuns {
  buildsNumbers?: Array<{ uri?: string; started?: string }>;
}

export interface JfrogBuildInfo {
  buildInfo?: {
    name?: string;
    number?: string;
    started?: string;
    durationMillis?: number;
    url?: string;
    artifactoryPrincipal?: string;
    agent?: { name?: string; version?: string };
    buildAgent?: { name?: string; version?: string };
    vcs?: Array<{ revision?: string; branch?: string; url?: string; message?: string }>;
    modules?: Array<{
      id?: string;
      type?: string;
      artifacts?: Array<{ name?: string; path?: string; sha256?: string; type?: string }>;
      dependencies?: Array<{ id?: string }>;
    }>;
  };
}

// ---------------------------------------------------------------------------
// Xray
// ---------------------------------------------------------------------------

export interface XrayWatch {
  general_data?: { id?: string; name?: string; description?: string; active?: boolean };
  project_resources?: {
    resources?: Array<{ type?: string; name?: string; bin_mgr_id?: string; filters?: unknown[] }>;
  };
  assigned_policies?: Array<{ name?: string; type?: string }>;
  watch_recipients?: string[];
  [key: string]: unknown;
}

export interface XrayPolicy {
  name: string;
  type?: string;
  description?: string;
  author?: string;
  created?: string;
  modified?: string;
  project_key?: string;
  watches?: string[];
  rules?: Array<{
    name?: string;
    priority?: number;
    criteria?: { min_severity?: string; cvss_range?: { from?: string; to?: string } } & Record<
      string,
      unknown
    >;
    actions?: {
      fail_build?: boolean;
      block_download?: { active?: boolean; unscanned?: boolean };
      notify_deployer?: boolean;
      notify_watch_recipients?: boolean;
    };
  }>;
  [key: string]: unknown;
}

export interface XrayViolation {
  description?: string;
  severity?: string;
  type?: string;
  infected_components?: string[];
  created?: string;
  watch_name?: string;
  issue_id?: string;
  violation_details_url?: string;
  impacted_artifacts?: string[];
}

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

export interface AccessToken {
  token_id: string;
  subject?: string;
  expiry?: number;
  issued_at?: number;
  issuer?: string;
  description?: string;
  refreshable?: boolean;
  scope?: string;
  last_used?: number;
}

export interface AccessUser {
  username: string;
  email?: string;
  admin?: boolean;
  effective_admin?: boolean;
  profile_updatable?: boolean;
  disable_ui_access?: boolean;
  internal_password_disabled?: boolean;
  last_logged_in?: string;
  realm?: string;
  groups?: string[];
  status?: string;
}

export interface AccessGroup {
  name: string;
  description?: string;
  auto_join?: boolean;
  admin_privileges?: boolean;
  realm?: string;
  external_id?: string;
  members?: string[];
}

export interface AccessPermissionResource {
  actions?: { users?: Record<string, string[]>; groups?: Record<string, string[]> };
  targets?: Record<string, { include_patterns?: string[]; exclude_patterns?: string[] }>;
}

export interface AccessPermission {
  name: string;
  resources?: Record<string, AccessPermissionResource | undefined>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const UNITS: Record<string, number> = {
  B: 1,
  BYTES: 1,
  KB: 1024,
  MB: 1024 ** 2,
  GB: 1024 ** 3,
  TB: 1024 ** 4,
  PB: 1024 ** 5,
};

/**
 * Storage info reports sizes as display strings ("3.48 GB", "32.22 GB
 * (15.77%)", "125,726"). Turn one into a number of bytes (or a plain count
 * when there is no unit). `undefined` for anything unreadable, never 0: an
 * unparseable size is missing data, not an empty repository.
 */
export function parseSize(raw: string | number | undefined): number | undefined {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : undefined;
  if (!raw) return undefined;
  const m = /^\s*([\d.,]+)\s*([a-z]+)?/i.exec(raw);
  if (!m) return undefined;
  const n = Number(m[1]!.replace(/,/g, ""));
  if (!Number.isFinite(n)) return undefined;
  const unit = (m[2] ?? "").toUpperCase();
  if (!unit) return n;
  const mult = UNITS[unit];
  return mult === undefined ? undefined : Math.round(n * mult);
}

/** The "(15.77%)" a filestore summary appends, as a number. */
export function parsePercent(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const m = /([\d.]+)\s*%/.exec(raw);
  return m ? Number(m[1]) : undefined;
}

/** Last path segment of an Artifactory `uri` ("/my-build" → "my-build"). */
export function lastSegment(uri: string | undefined): string {
  if (!uri) return "";
  const parts = uri.split("/").filter(Boolean);
  return decodeURIComponent(parts[parts.length - 1] ?? "");
}

export function epochToIso(seconds: number | undefined): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return "";
  return new Date(seconds * 1000).toISOString();
}

/** Lowercase rclass from either the config (`rclass`) or the list (`type: "LOCAL"`). */
export function repoClass(raw: string | undefined): string {
  return (raw ?? "").toLowerCase();
}

function instance(
  accountId: string,
  typeId: string,
  externalId: string,
  displayName: string,
  fields: Record<string, string | number | boolean | undefined>,
  extra: Partial<ResourceInstance> = {},
): ResourceInstance {
  const now = new Date().toISOString();
  const clean: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) clean[k] = v;
  return {
    id: `${accountId}:${typeId}:${externalId}`,
    pluginId: PLUGIN_ID,
    resourceTypeId: typeId,
    accountId,
    displayName,
    fields: clean,
    resolvedOutputs: {},
    secretStates: [],
    externalId,
    createdAt: now,
    updatedAt: now,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

export function mapPlatform(
  accountId: string,
  baseUrl: string,
  version: JfrogVersion | undefined,
  storage: JfrogStorageInfo | undefined,
): ResourceInstance {
  const host = baseUrl.replace(/^https?:\/\//, "");
  const b = storage?.binariesSummary;
  const fs = storage?.fileStoreSummary;
  return instance(
    accountId,
    "jfrog-platform",
    host,
    host,
    {
      baseUrl,
      version: version?.version,
      revision: version?.revision,
      license: version?.license,
      addons: (version?.addons ?? []).join(", ") || undefined,
      repositories: storage?.repositoriesSummaryList?.filter((r) => r.repoKey !== "TOTAL").length,
      binariesCount: parseSize(b?.binariesCount),
      binariesSize: b?.binariesSize,
      artifactsSize: b?.artifactsSize,
      artifactsCount: parseSize(b?.artifactsCount),
      itemsCount: parseSize(b?.itemsCount),
      optimization: b?.optimization,
      storageType: fs?.storageType,
      totalSpace: fs?.totalSpace,
      usedSpace: fs?.usedSpace,
      freeSpace: fs?.freeSpace,
    },
    { resolvedOutputs: { baseUrl, artifactoryUrl: `${baseUrl}/artifactory` } },
  );
}

export function mapRepository(
  accountId: string,
  baseUrl: string,
  summary: JfrogRepoSummary,
  config: JfrogRepoConfig | undefined,
  storage: JfrogRepoStorage | undefined,
): ResourceInstance {
  const key = summary.key;
  const rclass = repoClass(config?.rclass ?? summary.type);
  const url = `${baseUrl}/artifactory/${encodeURIComponent(key)}`;
  const usedBytes = storage?.usedSpaceInBytes ?? parseSize(storage?.usedSpace);
  return instance(
    accountId,
    "jfrog-repository",
    key,
    key,
    {
      key,
      rclass,
      packageType: (config?.packageType ?? summary.packageType ?? "").toLowerCase() || undefined,
      description: config?.description ?? summary.description ?? "",
      notes: config?.notes,
      includesPattern: config?.includesPattern,
      excludesPattern: config?.excludesPattern,
      repoLayoutRef: config?.repoLayoutRef,
      projectKey: config?.projectKey || undefined,
      environments: config?.environments?.join(", ") || undefined,
      xrayIndex: config?.xrayIndex,
      blackedOut: config?.blackedOut,
      remoteUrl: rclass === "remote" ? (config?.url ?? summary.url) : undefined,
      offline: rclass === "remote" ? config?.offline : undefined,
      retrievalCachePeriodSecs: rclass === "remote" ? config?.retrievalCachePeriodSecs : undefined,
      repositories: rclass === "virtual" ? (config?.repositories ?? []).join(", ") : undefined,
      defaultDeploymentRepo: rclass === "virtual" ? config?.defaultDeploymentRepo : undefined,
      filesCount: storage?.filesCount,
      foldersCount: storage?.foldersCount,
      itemsCount: storage?.itemsCount,
      usedSpace: storage?.usedSpace,
      usedSpaceBytes: usedBytes,
      storagePercentage: storage?.percentage,
    },
    { resolvedOutputs: { key, url } },
  );
}

export function mapBuild(
  accountId: string,
  name: string,
  lastStarted: string | undefined,
  runs?: number,
  latestNumber?: string,
): ResourceInstance {
  return instance(accountId, "jfrog-build", name, name, {
    name,
    lastStarted,
    runs,
    latestNumber,
  });
}

export function buildRunExternalId(name: string, number: string): string {
  return `${name}/${number}`;
}

/** Split a build run id; the build name may itself contain slashes. */
export function parseBuildRunId(id: string): { name: string; number: string } {
  const i = id.lastIndexOf("/");
  if (i <= 0) throw new Error(`JFrog plugin: "${id}" is not a build run id`);
  return { name: id.slice(0, i), number: id.slice(i + 1) };
}

export function mapBuildRun(
  accountId: string,
  name: string,
  number: string,
  started: string | undefined,
  info?: JfrogBuildInfo["buildInfo"],
): ResourceInstance {
  const vcs = info?.vcs?.[0];
  const modules = info?.modules ?? [];
  const artifacts = modules.reduce((n, m) => n + (m.artifacts?.length ?? 0), 0);
  const dependencies = modules.reduce((n, m) => n + (m.dependencies?.length ?? 0), 0);
  const agent = info?.agent ?? info?.buildAgent;
  return instance(
    accountId,
    "jfrog-build-run",
    buildRunExternalId(name, number),
    `${name} #${number}`,
    {
      buildName: name,
      number,
      started: info?.started ?? started,
      durationSeconds:
        typeof info?.durationMillis === "number"
          ? Math.round(info.durationMillis / 100) / 10
          : undefined,
      agent: agent?.name ? `${agent.name}${agent.version ? ` ${agent.version}` : ""}` : undefined,
      principal: info?.artifactoryPrincipal,
      ciUrl: info?.url,
      vcsRevision: vcs?.revision,
      vcsBranch: vcs?.branch,
      vcsUrl: vcs?.url,
      vcsMessage: vcs?.message,
      modules: info ? modules.length : undefined,
      artifacts: info ? artifacts : undefined,
      dependencies: info ? dependencies : undefined,
    },
    { parentResourceId: `${accountId}:jfrog-build:${name}` },
  );
}

export function mapWatch(accountId: string, w: XrayWatch): ResourceInstance {
  const name = w.general_data?.name ?? "";
  const resources = w.project_resources?.resources ?? [];
  return instance(accountId, "jfrog-xray-watch", name, name, {
    name,
    description: w.general_data?.description ?? "",
    active: w.general_data?.active ?? false,
    resources: resources
      .map((r) => (r.name ? `${r.type ?? "resource"}: ${r.name}` : (r.type ?? "")))
      .filter(Boolean)
      .join(", "),
    watchedRepositories: resources
      .filter((r) => r.type === "repository" && r.name)
      .map((r) => r.name)
      .join(", "),
    policies: (w.assigned_policies ?? [])
      .map((p) => p.name)
      .filter(Boolean)
      .join(", "),
    recipients: (w.watch_recipients ?? []).join(", "),
  });
}

export function mapPolicy(accountId: string, p: XrayPolicy): ResourceInstance {
  const rules = p.rules ?? [];
  const blocks = rules.some((r) => r.actions?.block_download?.active);
  const fails = rules.some((r) => r.actions?.fail_build);
  return instance(accountId, "jfrog-xray-policy", p.name, p.name, {
    name: p.name,
    type: p.type ?? "",
    description: p.description ?? "",
    author: p.author,
    created: p.created,
    modified: p.modified,
    projectKey: p.project_key || undefined,
    rules: rules.length,
    minSeverity: rules
      .map((r) => r.criteria?.min_severity)
      .filter(Boolean)
      .join(", "),
    blocksDownload: blocks,
    failsBuild: fails,
    watches: (p.watches ?? []).join(", "),
  });
}

/**
 * A violation has no id field of its own. Its details URL ends in one
 * (`…/violations/security/<id>`), so that is the stable key; without a URL
 * the issue, watch and first artifact together identify it.
 */
export function violationId(v: XrayViolation): string {
  const fromUrl = lastSegment(v.violation_details_url);
  if (fromUrl) return fromUrl;
  return [v.issue_id ?? "", v.watch_name ?? "", v.impacted_artifacts?.[0] ?? ""].join("|");
}

export function mapViolation(accountId: string, v: XrayViolation): ResourceInstance {
  const id = violationId(v);
  return instance(
    accountId,
    "jfrog-xray-violation",
    id,
    v.issue_id ? `${v.issue_id} (${v.watch_name ?? "watch"})` : id,
    {
      issueId: v.issue_id,
      severity: v.severity ?? "",
      type: v.type ?? "",
      description: v.description ?? "",
      watchName: v.watch_name ?? "",
      created: v.created,
      infectedComponents: (v.infected_components ?? []).join(", "),
      impactedArtifacts: (v.impacted_artifacts ?? []).join(", "),
      detailsUrl: v.violation_details_url,
    },
  );
}

export function mapToken(accountId: string, t: AccessToken): ResourceInstance {
  const subject = t.subject ?? "";
  // Subjects look like `jfac@01h…/users/alice`; the tail is the username.
  const user = subject.includes("/users/") ? subject.split("/users/").pop() : undefined;
  return instance(
    accountId,
    "jfrog-access-token",
    t.token_id,
    t.description ? t.description : `${user ?? subject} (${t.token_id.slice(0, 8)})`,
    {
      tokenId: t.token_id,
      subject,
      username: user,
      description: t.description ?? "",
      scope: t.scope ?? "",
      issuer: t.issuer,
      refreshable: t.refreshable ?? false,
      createdAt: epochToIso(t.issued_at),
      expiresAt: epochToIso(t.expiry),
      lastUsedAt: epochToIso(t.last_used),
      neverExpires: !t.expiry,
      admin: /applied-permissions\/admin/.test(t.scope ?? ""),
    },
  );
}

export function mapUser(accountId: string, u: AccessUser): ResourceInstance {
  return instance(accountId, "jfrog-user", u.username, u.username, {
    username: u.username,
    email: u.email ?? "",
    admin: u.admin ?? false,
    effectiveAdmin: u.effective_admin,
    realm: u.realm ?? "",
    status: u.status ?? "",
    groups: (u.groups ?? []).join(", "),
    lastLoggedIn: u.last_logged_in,
    lastUsedAt: u.last_logged_in,
    profileUpdatable: u.profile_updatable,
    disableUiAccess: u.disable_ui_access,
    internalPasswordDisabled: u.internal_password_disabled,
  });
}

export function mapGroup(accountId: string, g: AccessGroup): ResourceInstance {
  return instance(accountId, "jfrog-group", g.name, g.name, {
    name: g.name,
    description: g.description ?? "",
    autoJoin: g.auto_join ?? false,
    adminPrivileges: g.admin_privileges ?? false,
    realm: g.realm ?? "",
    externalId: g.external_id,
    members: (g.members ?? []).join(", "),
    memberCount: g.members?.length,
  });
}

export function mapPermission(accountId: string, p: AccessPermission): ResourceInstance {
  const resources = Object.entries(p.resources ?? {}).filter(([, r]) => r);
  const users = new Set<string>();
  const groups = new Set<string>();
  const targets: string[] = [];
  for (const [type, r] of resources) {
    for (const u of Object.keys(r?.actions?.users ?? {})) users.add(u);
    for (const g of Object.keys(r?.actions?.groups ?? {})) groups.add(g);
    for (const t of Object.keys(r?.targets ?? {})) targets.push(`${type}: ${t}`);
  }
  return instance(accountId, "jfrog-permission", p.name, p.name, {
    name: p.name,
    resourceTypes: resources.map(([t]) => t).join(", "),
    targets: targets.join(", "),
    users: [...users].join(", "),
    groups: [...groups].join(", "),
  });
}
