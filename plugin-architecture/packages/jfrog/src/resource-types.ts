import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * JFrog Platform resource types. Everything lives on the one platform origin
 * in the credentials: Artifactory (repositories, builds, storage), Xray
 * (watches, policies, violations) and Access (users, groups, permissions,
 * tokens).
 */

const ro = { required: false, editable: false } as const;

export const PlatformResourceType = rt({
  name: "Platform",
  id: "jfrog-platform",
  accountRoot: true,
  description:
    "The JFrog Platform this connection points at: Artifactory version and license, and the storage summary (binaries, artifacts, file store usage) charted on the Metrics tab.",
  fields: [
    f("baseUrl", "Platform URL", ro),
    f("version", "Artifactory Version", ro),
    f("revision", "Revision", ro),
    f("license", "License", ro),
    f("addons", "Add-ons", ro),
    f("repositories", "Repositories", { ...ro, kind: "number" }),
    f("binariesCount", "Binaries", { ...ro, kind: "number" }),
    f("binariesSize", "Binaries Size", ro),
    f("artifactsCount", "Artifacts", { ...ro, kind: "number" }),
    f("artifactsSize", "Artifacts Size", ro),
    f("itemsCount", "Items", { ...ro, kind: "number" }),
    f("optimization", "Deduplication Savings", ro),
    f("storageType", "File Store Type", ro),
    f("totalSpace", "File Store Capacity", ro),
    f("usedSpace", "File Store Used", ro),
    f("freeSpace", "File Store Free", ro),
  ],
  outputs: [o("baseUrl", "Platform URL"), o("artifactoryUrl", "Artifactory URL")],
  supportsMetrics: true,
  supportsDelete: false,
  iconKey: "server",
});

export const RepositoryResourceType = rt({
  name: "Repository",
  plural: "Repositories",
  id: "jfrog-repository",
  description:
    "An Artifactory repository: local (hosted), remote (a caching proxy of another registry), virtual (several repositories behind one URL) or federated. Browse, upload and delete artifacts, edit its settings, and chart its file count and storage.",
  fields: [
    f("key", "Key", { editable: false }),
    f("rclass", "Class", {
      ...ro,
      kind: "enum",
      enumValues: ["local", "remote", "virtual", "federated"],
    }),
    f("packageType", "Package Type", ro),
    f("description", "Description", { required: false }),
    f("notes", "Notes", { required: false, description: "Internal notes, not shown to users." }),
    f("includesPattern", "Includes Pattern", {
      required: false,
      description: "Comma-separated Ant patterns of paths the repository accepts, e.g. **/*.",
    }),
    f("excludesPattern", "Excludes Pattern", {
      required: false,
      description: "Comma-separated Ant patterns of paths the repository rejects.",
    }),
    f("remoteUrl", "Remote URL", {
      required: false,
      description: "Remote repositories only: the upstream registry this repository proxies.",
    }),
    f("offline", "Offline", {
      kind: "boolean",
      required: false,
      description:
        "Remote repositories only: serve from the cache without contacting the upstream.",
    }),
    f("retrievalCachePeriodSecs", "Metadata Cache Period (seconds)", {
      kind: "number",
      required: false,
      description: "Remote repositories only: how long upstream metadata is cached.",
    }),
    f("repositories", "Member Repositories", {
      required: false,
      description:
        "Virtual repositories only: comma-separated keys of the repositories it aggregates, in resolution order.",
    }),
    f("defaultDeploymentRepo", "Default Deployment Repository", {
      required: false,
      description: "Virtual repositories only: the local repository that receives deploys.",
    }),
    f("xrayIndex", "Xray Indexing", {
      kind: "boolean",
      required: false,
      description: "Scan this repository's artifacts with Xray.",
    }),
    f("blackedOut", "Blacked Out", {
      kind: "boolean",
      required: false,
      description: "Block all downloads and uploads.",
    }),
    f("repoLayoutRef", "Layout", ro),
    f("projectKey", "Project", ro),
    f("environments", "Environments", ro),
    f("filesCount", "Files", { ...ro, kind: "number" }),
    f("foldersCount", "Folders", { ...ro, kind: "number" }),
    f("itemsCount", "Items", { ...ro, kind: "number" }),
    f("usedSpace", "Used Space", ro),
    f("usedSpaceBytes", "Used Space (bytes)", { ...ro, kind: "number" }),
    f("storagePercentage", "Share of Storage", ro),
  ],
  outputs: [
    o("key", "Repository key"),
    o("url", "Repository URL", {
      description: "The URL clients resolve from and deploy to.",
    }),
  ],
  dependsOn: [
    {
      fieldKey: "repositories",
      targetTypeId: "jfrog-repository",
      label: "aggregates",
    },
    {
      fieldKey: "defaultDeploymentRepo",
      targetTypeId: "jfrog-repository",
      label: "deploys to",
    },
  ],
  orphanRule: {
    conditions: [
      { fieldKey: "rclass", when: "equals", value: "local" },
      { fieldKey: "itemsCount", when: "equals", value: "0" },
    ],
    reason: "Local repository holds no artifacts",
  },
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  supportsStorageBrowser: true,
  supportsMetrics: true,
  iconKey: "database",
  secretExportTemplates: [
    {
      id: "repository-url",
      displayName: "Repository URL",
      description: "The URL package managers resolve from",
      entries: [{ envKey: "ARTIFACTORY_REPOSITORY_URL", outputKey: "url" }],
    },
  ],
});

export const BuildResourceType = rt({
  name: "Build",
  id: "jfrog-build",
  description:
    "Build info published to Artifactory by a CI system (the JFrog CLI or a CI plugin). Shows its runs; delete a build and all its runs.",
  fields: [
    f("name", "Name", { editable: false }),
    f("lastStarted", "Last Started", ro),
    f("runs", "Runs", { ...ro, kind: "number" }),
    f("latestNumber", "Latest Run", ro),
  ],
  outputs: [o("name", "Build name")],
  supportsDelete: true,
  iconKey: "build",
});

export const BuildRunResourceType = rt({
  name: "Build Run",
  id: "jfrog-build-run",
  parentTypeId: "jfrog-build",
  pinnable: false,
  description:
    "One run of a build: when it started, how long it took, the commit it built, its modules and the artifacts and dependencies it recorded. The 25 most recent runs of each build are listed.",
  fields: [
    f("buildName", "Build", ro),
    f("number", "Number", ro),
    f("started", "Started", ro),
    f("durationSeconds", "Duration (seconds)", { ...ro, kind: "number" }),
    f("agent", "Agent", ro),
    f("principal", "Published By", ro),
    f("ciUrl", "CI URL", ro),
    f("vcsRevision", "Revision", ro),
    f("vcsBranch", "Branch", ro),
    f("vcsUrl", "Repository", ro),
    f("vcsMessage", "Commit Message", ro),
    f("modules", "Modules", { ...ro, kind: "number" }),
    f("artifacts", "Artifacts", { ...ro, kind: "number" }),
    f("dependencies", "Dependencies", { ...ro, kind: "number" }),
  ],
  outputs: [o("number", "Build number")],
  dependsOn: [{ fieldKey: "buildName", targetTypeId: "jfrog-build", label: "run of" }],
  supportsDelete: true,
  iconKey: "build",
});

export const WatchResourceType = rt({
  name: "Xray Watch",
  id: "jfrog-xray-watch",
  description:
    "An Xray watch: the repositories and builds Xray scans, and the policies it applies to them. Enable or disable it, edit its description, or delete it.",
  fields: [
    f("name", "Name", { editable: false }),
    f("description", "Description", { required: false }),
    f("active", "Active", { ...ro, kind: "boolean" }),
    f("resources", "Watched Resources", ro),
    f("watchedRepositories", "Watched Repositories", ro),
    f("policies", "Policies", ro),
    f("recipients", "Email Recipients", ro),
  ],
  outputs: [o("name", "Watch name")],
  dependsOn: [
    { fieldKey: "policies", targetTypeId: "jfrog-xray-policy", label: "applies" },
    { fieldKey: "watchedRepositories", targetTypeId: "jfrog-repository", label: "watches" },
  ],
  postureChecks: [
    {
      id: "jfrog-watch-inactive",
      title: "Xray watch is disabled",
      severity: "medium",
      category: "other",
      conditions: [{ fieldKey: "active", when: "falsy" }],
      reason: "A disabled watch scans nothing, so its policies raise no violations.",
    },
  ],
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "shield",
});

export const PolicyResourceType = rt({
  name: "Xray Policy",
  plural: "Xray Policies",
  id: "jfrog-xray-policy",
  description:
    "An Xray security, license or operational-risk policy: its rules, the severity they trigger on and what they do (block downloads, fail builds). Edit its description or delete it.",
  fields: [
    f("name", "Name", { editable: false }),
    f("type", "Type", ro),
    f("description", "Description", { required: false }),
    f("author", "Author", ro),
    f("rules", "Rules", { ...ro, kind: "number" }),
    f("minSeverity", "Minimum Severity", ro),
    f("blocksDownload", "Blocks Downloads", { ...ro, kind: "boolean" }),
    f("failsBuild", "Fails Builds", { ...ro, kind: "boolean" }),
    f("watches", "Watches", ro),
    f("projectKey", "Project", ro),
    f("created", "Created", ro),
    f("modified", "Modified", ro),
  ],
  outputs: [o("name", "Policy name")],
  orphanRule: {
    conditions: [{ fieldKey: "watches", when: "empty" }],
    reason: "Policy is not assigned to any watch, so it is never enforced",
  },
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "shield",
});

export const ViolationResourceType = rt({
  name: "Xray Violation",
  id: "jfrog-xray-violation",
  pinnable: false,
  description:
    "A policy violation Xray raised against a watched artifact or build: the issue, its severity, the vulnerable components and the artifacts they reach. The 100 most recent are listed.",
  fields: [
    f("issueId", "Issue", ro),
    f("severity", "Severity", ro),
    f("type", "Type", ro),
    f("description", "Description", ro),
    f("watchName", "Watch", ro),
    f("created", "Created", ro),
    f("infectedComponents", "Infected Components", ro),
    f("impactedArtifacts", "Impacted Artifacts", ro),
    f("detailsUrl", "Details URL", ro),
  ],
  outputs: [],
  dependsOn: [{ fieldKey: "watchName", targetTypeId: "jfrog-xray-watch", label: "raised by" }],
  supportsDelete: false,
  iconKey: "alert",
});

export const AccessTokenResourceType = rt({
  name: "Access Token",
  id: "jfrog-access-token",
  description:
    "A JFrog access token: who it belongs to, its scope, when it was last used and when it expires. Create a token (the value is shown once) or revoke one. Admin tokens see every token; others see only their own.",
  fields: [
    f("tokenId", "Token ID", ro),
    f("description", "Description", ro),
    f("subject", "Subject", ro),
    f("username", "User", ro),
    f("scope", "Scope", ro),
    f("issuer", "Issuer", ro),
    f("refreshable", "Refreshable", { ...ro, kind: "boolean" }),
    f("admin", "Admin Scope", { ...ro, kind: "boolean" }),
    f("neverExpires", "Never Expires", { ...ro, kind: "boolean" }),
    f("createdAt", "Issued", ro),
    f("expiresAt", "Expires", ro),
    f("lastUsedAt", "Last Used", ro),
  ],
  outputs: [
    o("accessToken", "Access token", {
      sensitive: true,
      description: "Only available for tokens created from Infrawrench.",
    }),
  ],
  dependsOn: [{ fieldKey: "username", targetTypeId: "jfrog-user", label: "acts as" }],
  expiryFields: [
    { fieldKey: "expiresAt", from: "expiry", kind: "api-token", label: "Access token expires" },
  ],
  postureChecks: [
    {
      id: "jfrog-admin-token-never-expires",
      title: "Admin access token never expires",
      severity: "high",
      category: "credential-age",
      conditions: [
        { fieldKey: "admin", when: "truthy" },
        { fieldKey: "neverExpires", when: "truthy" },
      ],
      reason:
        "An admin-scoped token with no expiry grants full control of the platform until someone remembers to revoke it.",
    },
  ],
  principalRole: {
    role: "key",
    lastUsedKey: "lastUsedAt",
    createdKey: "createdAt",
    adminIndicatorKey: "admin",
    parentKey: "username",
    revokeActionId: "revoke",
  },
  supportsCreate: true,
  supportsDelete: true,
  iconKey: "key",
});

export const UserResourceType = rt({
  name: "User",
  id: "jfrog-user",
  description:
    "A JFrog Platform user: email, admin rights, realm (internal, LDAP, SAML…), groups and last login. Create, edit (email, admin, groups, password, UI access) or delete.",
  fields: [
    f("username", "Username", { editable: false }),
    f("email", "Email", { required: false }),
    f("admin", "Admin", { kind: "boolean", required: false }),
    f("groups", "Groups", {
      required: false,
      description: "Comma-separated group names; changing it adds and removes memberships.",
    }),
    f("password", "New Password", {
      kind: "password",
      required: false,
      description: "Internal users only. Leave blank to keep the current password.",
    }),
    f("disableUiAccess", "API Only (no UI access)", { kind: "boolean", required: false }),
    f("profileUpdatable", "Can Update Profile", { kind: "boolean", required: false }),
    f("internalPasswordDisabled", "Internal Password Disabled", {
      kind: "boolean",
      required: false,
    }),
    f("effectiveAdmin", "Effective Admin", { ...ro, kind: "boolean" }),
    f("realm", "Realm", ro),
    f("status", "Status", ro),
    f("lastLoggedIn", "Last Login", ro),
  ],
  outputs: [o("username", "Username"), o("email", "Email")],
  dependsOn: [{ fieldKey: "groups", targetTypeId: "jfrog-group", label: "member of" }],
  principalRole: {
    role: "user",
    lastUsedKey: "lastLoggedIn",
    adminIndicatorKey: "admin",
  },
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "user",
});

export const GroupResourceType = rt({
  name: "Group",
  id: "jfrog-group",
  description:
    "A JFrog Platform group: its members, whether new users join it automatically, and whether it grants admin rights. Create, edit (description, members, auto-join, admin) or delete.",
  fields: [
    f("name", "Name", { editable: false }),
    f("description", "Description", { required: false }),
    f("members", "Members", {
      required: false,
      description: "Comma-separated usernames; changing it adds and removes members.",
    }),
    f("autoJoin", "Add New Users Automatically", { kind: "boolean", required: false }),
    f("adminPrivileges", "Admin Privileges", { kind: "boolean", required: false }),
    f("externalId", "External ID", { required: false }),
    f("realm", "Realm", ro),
    f("memberCount", "Member Count", { ...ro, kind: "number" }),
  ],
  outputs: [o("name", "Group name")],
  dependsOn: [{ fieldKey: "members", targetTypeId: "jfrog-user", label: "has member" }],
  principalRole: {
    role: "group",
    adminIndicatorKey: "adminPrivileges",
  },
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "users",
});

export const PermissionResourceType = rt({
  name: "Permission",
  id: "jfrog-permission",
  description:
    "A permission target: which users and groups may read, deploy, delete or manage which repositories, builds and release bundles. Shows every grant; delete a permission.",
  fields: [
    f("name", "Name", { editable: false }),
    f("resourceTypes", "Applies To", ro),
    f("targets", "Targets", ro),
    f("users", "Users", ro),
    f("groups", "Groups", ro),
  ],
  outputs: [o("name", "Permission name")],
  dependsOn: [
    { fieldKey: "users", targetTypeId: "jfrog-user", label: "grants" },
    { fieldKey: "groups", targetTypeId: "jfrog-group", label: "grants" },
  ],
  principalRole: { role: "binding" },
  supportsDelete: true,
  iconKey: "lock",
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  PlatformResourceType,
  RepositoryResourceType,
  BuildResourceType,
  BuildRunResourceType,
  WatchResourceType,
  PolicyResourceType,
  ViolationResourceType,
  AccessTokenResourceType,
  UserResourceType,
  GroupResourceType,
  PermissionResourceType,
];
