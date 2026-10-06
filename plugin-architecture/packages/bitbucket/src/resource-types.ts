import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * Bitbucket Cloud resource types. An account is one workspace (picked in the
 * credentials), so the workspace is the account root. Repository children
 * have external ids `<repo slug>/<child>`; slugs never contain a slash.
 * Field names follow the 2.0 API (https://api.bitbucket.org/swagger.json,
 * 2026-10).
 */

const repoRef = f("repository", "Repository", { required: false, editable: false });

export const WorkspaceResourceType = rt({
  name: "Workspace",
  id: "workspace",
  description:
    "The Bitbucket workspace this account reads: privacy, forking policy, members, projects and repositories, and pipeline build minutes used this month across its busiest repositories.",
  fields: [
    f("name", "Name", { editable: false }),
    f("slug", "Slug", { editable: false }),
    f("private", "Private", { kind: "boolean", required: false, editable: false }),
    f("forkingMode", "Forking", { required: false, editable: false }),
    f("members", "Members", { kind: "number", required: false, editable: false }),
    f("administrator", "You Are an Admin", { kind: "boolean", required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [o("slug", "Workspace slug"), o("uuid", "Workspace UUID"), o("webUrl", "Web URL")],
  accountRoot: true,
  iconKey: "account",
});

export const ProjectResourceType = rt({
  name: "Project",
  id: "project",
  description:
    "A project grouping repositories: key, name, description and privacy, with its deploy keys. Create, rename, edit or delete it (a project must be empty to delete).",
  fields: [
    f("name", "Name"),
    f("key", "Key", { editable: false }),
    f("description", "Description", { required: false }),
    f("private", "Private", { kind: "boolean", required: false }),
    f("publicRepos", "Has Public Repositories", {
      kind: "boolean",
      required: false,
      editable: false,
    }),
    f("updatedAt", "Updated", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [o("key", "Project key"), o("webUrl", "Web URL")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "folder",
});

export const RepositoryResourceType = rt({
  name: "Repository",
  plural: "Repositories",
  id: "repository",
  description:
    "A Git repository: main branch, language, size, privacy, its project and whether Pipelines is on, with recent pipelines. Charts pipelines, failures, success rate, build minutes and duration per day. Create one, edit its description, privacy, project and fork policy, or turn Pipelines on or off.",
  fields: [
    f("name", "Name", { editable: false }),
    f("description", "Description", { required: false }),
    f("private", "Private", { kind: "boolean", required: false }),
    f("project", "Project", {
      required: false,
      description: "Project key to move the repository to.",
    }),
    f("forkPolicy", "Fork Policy", {
      kind: "enum",
      required: false,
      enumValues: ["allow_forks", "no_public_forks", "no_forks"],
    }),
    f("mainBranch", "Main Branch", { required: false, editable: false }),
    f("language", "Language", { required: false, editable: false }),
    f("sizeBytes", "Size (bytes)", { kind: "number", required: false, editable: false }),
    f("pipelinesEnabled", "Pipelines Enabled", {
      kind: "boolean",
      required: false,
      editable: false,
    }),
    f("fullName", "Full Name", { required: false, editable: false }),
    f("updatedAt", "Updated", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [
    o("fullName", "Full name"),
    o("webUrl", "Web URL"),
    o("httpsCloneUrl", "HTTPS clone URL"),
    o("sshCloneUrl", "SSH clone URL"),
  ],
  dependsOn: [
    { fieldKey: "project", targetTypeId: "project", targetKey: "key", label: "in project" },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsMetrics: true,
  supportsDelete: false,
  postureChecks: [
    {
      id: "bitbucket-repository-public",
      title: "Repository is public",
      severity: "low",
      category: "public-exposure",
      conditions: [{ fieldKey: "private", when: "falsy" }],
      reason: "Anyone on the internet can clone this repository.",
    },
  ],
  iconKey: "project",
});

export const PipelineResourceType = rt({
  name: "Pipeline",
  id: "pipeline",
  parentTypeId: "repository",
  showInSidebar: true,
  description:
    "A recent Bitbucket Pipelines run: ref, commit, trigger, state and result, build minutes and duration, with each step and its log. Stop a running pipeline, or create one to run the default, branch or custom pipeline on a branch with variables.",
  fields: [
    f("buildNumber", "Build Number", { kind: "number", required: false, editable: false }),
    repoRef,
    f("state", "State", { required: false, editable: false }),
    f("result", "Result", { required: false, editable: false }),
    f("refType", "Ref Type", { required: false, editable: false }),
    f("refName", "Ref", { required: false, editable: false }),
    f("commit", "Commit", { required: false, editable: false }),
    f("selector", "Pipeline", { required: false, editable: false }),
    f("trigger", "Trigger", { required: false, editable: false }),
    f("creator", "Started By", { required: false, editable: false }),
    f("buildSeconds", "Build Seconds Used", { kind: "number", required: false, editable: false }),
    f("durationSecs", "Duration (seconds)", { kind: "number", required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("completedAt", "Completed", { required: false, editable: false }),
  ],
  outputs: [o("pipelineUuid", "Pipeline UUID"), o("webUrl", "Web URL")],
  supportsCreate: true,
  iconKey: "pipeline",
  pinnable: false,
});

const variableFields = [
  f("key", "Name", { editable: false }),
  f("value", "Value", {
    kind: "password",
    required: false,
    description: "Write-only here. Leave empty to keep the current value.",
  }),
  f("secured", "Secured", {
    kind: "boolean",
    required: false,
    description:
      "Secured values are hidden in Bitbucket and in build logs, and cannot be read back.",
  }),
];

const variablePosture = (id: string) => [
  {
    id,
    title: "Pipeline variable is not secured",
    severity: "low" as const,
    category: "other" as const,
    conditions: [{ fieldKey: "secured", when: "falsy" as const }],
    reason:
      "Anyone with read access can see the value, and it is printed in build logs if a script echoes it. Secure it if it is a secret.",
  },
];

export const RepositoryVariableResourceType = rt({
  name: "Repository Variable",
  id: "repository-variable",
  parentTypeId: "repository",
  description:
    "A repository variable passed to every pipeline in the repository, and whether it is secured. Values are never stored here. Create one, replace its value or secure it under Edit, or delete it.",
  fields: [...variableFields, repoRef],
  outputs: [o("key", "Name")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  postureChecks: variablePosture("bitbucket-repository-variable-unsecured"),
  iconKey: "key",
  pinnable: false,
});

export const WorkspaceVariableResourceType = rt({
  name: "Workspace Variable",
  id: "workspace-variable",
  parentTypeId: "workspace",
  description:
    "A workspace variable passed to pipelines in every repository of the workspace, and whether it is secured. Create one, replace its value or secure it, or delete it.",
  fields: variableFields,
  outputs: [o("key", "Name")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  postureChecks: variablePosture("bitbucket-workspace-variable-unsecured"),
  iconKey: "key",
  pinnable: false,
});

export const EnvironmentResourceType = rt({
  name: "Deployment Environment",
  id: "environment",
  parentTypeId: "repository",
  showInSidebar: true,
  description:
    "A deployment environment (Test, Staging or Production): whether only admins may deploy, whether it is locked by a running deployment, and its recent deployments. Charts deployments per day. Create, rename, restrict to admins or delete it.",
  fields: [
    f("name", "Name"),
    f("environmentType", "Type", { required: false, editable: false }),
    f("adminOnly", "Admins Only", {
      kind: "boolean",
      required: false,
      description: "Only workspace admins can deploy to it.",
    }),
    f("locked", "Locked", { kind: "boolean", required: false, editable: false }),
    f("hidden", "Hidden", { kind: "boolean", required: false, editable: false }),
    f("lastDeploymentStatus", "Last Deployment", { required: false, editable: false }),
    f("lastDeployedAt", "Last Deployed", { required: false, editable: false }),
    f("lastDeployedBy", "Last Deployed By", { required: false, editable: false }),
    f("lastRelease", "Last Release", { required: false, editable: false }),
    repoRef,
  ],
  outputs: [o("environmentUuid", "Environment UUID")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  supportsMetrics: true,
  iconKey: "deployment",
});

export const DeploymentVariableResourceType = rt({
  name: "Deployment Variable",
  id: "deployment-variable",
  parentTypeId: "environment",
  description:
    "A variable passed only to deployment steps targeting one environment, and whether it is secured. Create one, replace its value or secure it, or delete it.",
  fields: [
    ...variableFields,
    f("environment", "Environment", { required: false, editable: false }),
    repoRef,
  ],
  outputs: [o("key", "Name")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  postureChecks: variablePosture("bitbucket-deployment-variable-unsecured"),
  iconKey: "key",
  pinnable: false,
});

export const BranchRestrictionResourceType = rt({
  name: "Branch Restriction",
  id: "branch-restriction",
  parentTypeId: "repository",
  description:
    "A branch permission or merge check on matching branches: who may push or merge, whether force push or deletion is blocked, and how many approvals or passing builds a merge needs. Create, edit or delete it.",
  fields: [
    f("kind", "Rule", { editable: false }),
    f("match", "Applies To", { required: false, editable: false }),
    f("pattern", "Branch Pattern", { required: false }),
    f("value", "Required Count", {
      kind: "number",
      required: false,
      description: "Approvals, passing builds or commits behind, for the rules that take a number.",
    }),
    f("users", "Exempt Users", { required: false, editable: false }),
    f("groups", "Exempt Groups", { required: false, editable: false }),
    repoRef,
  ],
  outputs: [o("restrictionId", "Rule ID")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "shield",
  pinnable: false,
});

const webhookFields = [
  f("url", "URL"),
  f("description", "Description"),
  f("active", "Active", { kind: "boolean", required: false }),
  f("events", "Events", {
    required: false,
    description: "Comma-separated Bitbucket events, e.g. repo:push, pullrequest:created.",
  }),
  f("secret", "Secret", {
    kind: "password",
    required: false,
    description:
      "Signs deliveries (X-Hub-Signature). Write-only; leave empty to keep the current one.",
  }),
  f("secretSet", "Secret Set", { kind: "boolean", required: false, editable: false }),
  f("createdAt", "Created", { required: false, editable: false }),
];

const webhookPosture = (id: string) => [
  {
    id,
    title: "Webhook has no secret",
    severity: "low" as const,
    category: "other" as const,
    conditions: [{ fieldKey: "secretSet", when: "falsy" as const }],
    reason:
      "Deliveries are not signed, so the receiver cannot tell them apart from forged requests.",
  },
];

export const RepositoryWebhookResourceType = rt({
  name: "Repository Webhook",
  id: "repository-webhook",
  parentTypeId: "repository",
  description:
    "A repository webhook: URL, events, whether it is active and whether deliveries are signed. Create, edit, activate or deactivate, or delete it.",
  fields: [...webhookFields, repoRef],
  outputs: [o("url", "URL")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  postureChecks: webhookPosture("bitbucket-repository-webhook-unsigned"),
  iconKey: "webhook",
  pinnable: false,
});

export const WorkspaceWebhookResourceType = rt({
  name: "Workspace Webhook",
  id: "workspace-webhook",
  parentTypeId: "workspace",
  description:
    "A workspace webhook, fired for events in every repository of the workspace. Create, edit, activate or deactivate, or delete it.",
  fields: webhookFields,
  outputs: [o("url", "URL")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  postureChecks: webhookPosture("bitbucket-workspace-webhook-unsigned"),
  iconKey: "webhook",
  pinnable: false,
});

const keyFields = [
  f("label", "Label"),
  f("comment", "Key Comment", { required: false, editable: false }),
  f("keyType", "Key Type", { required: false, editable: false }),
  f("lastUsedAt", "Last Used", { required: false, editable: false }),
  f("createdAt", "Added", { required: false, editable: false }),
];

const keyPrincipal = { role: "key" as const, lastUsedKey: "lastUsedAt" };

export const DeployKeyResourceType = rt({
  name: "Deploy Key",
  id: "deploy-key",
  parentTypeId: "repository",
  description:
    "A read-only SSH access key for one repository, with when it was last used. Add one, relabel it or remove it.",
  fields: [...keyFields, repoRef],
  outputs: [o("label", "Label")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  principalRole: keyPrincipal,
  expiryFields: [
    {
      fieldKey: "createdAt",
      from: "created",
      kind: "ssh-key",
      label: "Deploy key age",
      maxAgeDays: 365,
    },
  ],
  orphanRule: {
    conditions: [{ fieldKey: "lastUsedAt", when: "empty" }],
    reason: "Deploy key that has never been used. If nothing needs it, remove it.",
  },
  iconKey: "key",
  pinnable: false,
});

export const ProjectDeployKeyResourceType = rt({
  name: "Project Deploy Key",
  id: "project-deploy-key",
  parentTypeId: "project",
  description:
    "A read-only SSH access key for every repository in a project, with when it was last used. Add one or remove it.",
  fields: [
    ...keyFields.map((x) => ({ ...x, editable: false })),
    f("project", "Project", { required: false, editable: false }),
  ],
  outputs: [o("label", "Label")],
  supportsCreate: true,
  supportsDelete: true,
  principalRole: keyPrincipal,
  expiryFields: [
    {
      fieldKey: "createdAt",
      from: "created",
      kind: "ssh-key",
      label: "Deploy key age",
      maxAgeDays: 365,
    },
  ],
  iconKey: "key",
  pinnable: false,
});

export const RunnerResourceType = rt({
  name: "Runner",
  id: "runner",
  description:
    "A self-hosted Pipelines runner registered to the workspace or a repository: status, labels, version and whether it is disabled. Create one (its OAuth client credentials are kept as outputs for starting the runner), rename it or change labels, enable or disable it, or delete it.",
  fields: [
    f("name", "Name"),
    f("labels", "Labels", {
      required: false,
      description:
        "Comma-separated. self.hosted and one platform label (linux, linux.arm64, linux.shell, windows, macos) are required.",
    }),
    f("status", "Status", { required: false, editable: false }),
    f("scope", "Registered To", { required: false, editable: false }),
    f("version", "Version", { required: false, editable: false }),
    f("latestVersion", "Latest Version", { required: false, editable: false }),
    f("cordoned", "Cordoned", { kind: "boolean", required: false, editable: false }),
    f("stateUpdatedAt", "Last Seen", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [
    o("runnerUuid", "Runner UUID"),
    o("oauthClientId", "OAuth client ID", {
      sensitive: true,
      description: "Kept for runners created from Infrawrench; Bitbucket shows it once.",
    }),
    o("oauthClientSecret", "OAuth client secret", {
      sensitive: true,
      description: "Kept for runners created from Infrawrench; Bitbucket shows it once.",
    }),
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  orphanRule: {
    conditions: [{ fieldKey: "status", when: "equals", value: "UNREGISTERED" }],
    reason: "Runner created but never started. Nothing is running it.",
  },
  iconKey: "server",
});

export const ScheduleResourceType = rt({
  name: "Pipeline Schedule",
  id: "pipeline-schedule",
  parentTypeId: "repository",
  showInSidebar: true,
  description:
    "A scheduled pipeline: cron (UTC), branch and pipeline, whether it is enabled, and its recent runs. Create one, enable or disable it, or delete it.",
  fields: [
    f("cron", "Cron (UTC)", { editable: false }),
    f("refName", "Branch", { required: false, editable: false }),
    f("selector", "Pipeline", { required: false, editable: false }),
    f("enabled", "Enabled", { kind: "boolean", required: false }),
    repoRef,
    f("updatedAt", "Updated", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [o("scheduleUuid", "Schedule UUID")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "clock",
});

export const CacheResourceType = rt({
  name: "Pipeline Cache",
  id: "pipeline-cache",
  parentTypeId: "repository",
  description:
    "A Pipelines dependency cache: name, path and size. Delete it to force the next build to rebuild it. Bitbucket expires caches after a week.",
  fields: [
    f("name", "Name", { editable: false }),
    f("path", "Path", { required: false, editable: false }),
    f("sizeBytes", "Size (bytes)", { kind: "number", required: false, editable: false }),
    repoRef,
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [o("name", "Cache name")],
  supportsDelete: true,
  iconKey: "cache",
  pinnable: false,
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  WorkspaceResourceType,
  ProjectResourceType,
  RepositoryResourceType,
  PipelineResourceType,
  RepositoryVariableResourceType,
  WorkspaceVariableResourceType,
  EnvironmentResourceType,
  DeploymentVariableResourceType,
  BranchRestrictionResourceType,
  RepositoryWebhookResourceType,
  WorkspaceWebhookResourceType,
  DeployKeyResourceType,
  ProjectDeployKeyResourceType,
  RunnerResourceType,
  ScheduleResourceType,
  CacheResourceType,
];
