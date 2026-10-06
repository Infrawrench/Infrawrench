import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * GitLab resource types. An account sees either one group (and its
 * subgroups) or, with no group picked, every project the token's user is a
 * member of. Field names follow the REST v4 reference (`doc/api/*.md`,
 * 2026-10); each type names the endpoint it lists from.
 *
 * Child types hang off a project or a group, and their external ids are
 * `<projectId|groupId>/<child>` so one id is enough to reach them again.
 */

export const ACCESS_LEVEL_OPTIONS = [
  "Guest",
  "Planner",
  "Reporter",
  "Developer",
  "Maintainer",
  "Owner",
];

const projectRef = f("project", "Project", { required: false, editable: false });
const groupRef = f("group", "Group", { required: false, editable: false });

/** `GET /groups/:id` plus `GET /namespaces/:id` and the descendant groups. */
export const GroupResourceType = rt({
  name: "Group",
  id: "group",
  description:
    "A GitLab group or subgroup: plan, seats, projects, compute minutes used this month and storage. Charts compute minutes per month. Rename it or change its description and visibility.",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("visibility", "Visibility", {
      kind: "enum",
      required: false,
      enumValues: ["private", "internal", "public"],
    }),
    f("fullPath", "Full Path", { required: false, editable: false }),
    f("plan", "Plan", { required: false, editable: false }),
    f("seatsInUse", "Seats in Use", { kind: "number", required: false, editable: false }),
    f("billableMembers", "Billable Members", { kind: "number", required: false, editable: false }),
    f("projectsCount", "Projects", { kind: "number", required: false, editable: false }),
    f("computeMinutesUsed", "Compute Minutes Used (this period)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("computeMinutesLimit", "Compute Minutes Quota", {
      kind: "number",
      required: false,
      editable: false,
      description: "Only visible to instance administrators; GitLab hides it from everyone else.",
    }),
    f("repositorySizeBytes", "Repository Storage (bytes)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("trialEndsOn", "Trial Ends", { required: false, editable: false }),
    f("subscriptionEnds", "Subscription Ends", { required: false, editable: false }),
    f("parentId", "Parent Group ID", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [o("groupId", "Group ID"), o("fullPath", "Full path"), o("webUrl", "Web URL")],
  expiryFields: [
    { fieldKey: "subscriptionEnds", from: "expiry", kind: "other", label: "Subscription ends" },
    { fieldKey: "trialEndsOn", from: "expiry", kind: "other", label: "Trial ends" },
  ],
  supportsUpdate: true,
  supportsMetrics: true,
  supportsDelete: false,
  iconKey: "folder",
});

/** `GET /groups/:id/projects?include_subgroups=true` or `GET /projects?membership=true`. */
export const ProjectResourceType = rt({
  name: "Project",
  id: "project",
  description:
    "A GitLab project: repository URLs, default branch, open merge requests and issues, storage, and the latest pipeline. Charts pipelines and jobs per day, success rate, job duration and queue time. Edit its name, description, visibility and default branch, archive it, or run a pipeline.",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("visibility", "Visibility", {
      kind: "enum",
      required: false,
      enumValues: ["private", "internal", "public"],
    }),
    f("defaultBranch", "Default Branch", { required: false }),
    f("ciConfigPath", "CI/CD Config Path", {
      required: false,
      description: "Leave empty for .gitlab-ci.yml in the repository root.",
    }),
    f("pathWithNamespace", "Path", { required: false, editable: false }),
    f("namespace", "Namespace", { required: false, editable: false }),
    f("archived", "Archived", { kind: "boolean", required: false, editable: false }),
    f("openMergeRequests", "Open Merge Requests", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("openIssues", "Open Issues", { kind: "number", required: false, editable: false }),
    f("stars", "Stars", { kind: "number", required: false, editable: false }),
    f("forks", "Forks", { kind: "number", required: false, editable: false }),
    f("storageBytes", "Storage (bytes)", { kind: "number", required: false, editable: false }),
    f("lastActivityAt", "Last Activity", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("projectId", "Project ID", { required: false, editable: false }),
    f("namespaceId", "Namespace ID", { required: false, editable: false }),
  ],
  outputs: [
    o("projectId", "Project ID"),
    o("pathWithNamespace", "Path"),
    o("webUrl", "Web URL"),
    o("httpCloneUrl", "HTTPS clone URL"),
    o("sshCloneUrl", "SSH clone URL"),
  ],
  dependsOn: [{ fieldKey: "namespaceId", targetTypeId: "group", label: "in group" }],
  supportsUpdate: true,
  supportsDelete: false,
  supportsMetrics: true,
  postureChecks: [
    {
      id: "gitlab-project-public",
      title: "Project is public",
      severity: "low",
      category: "public-exposure",
      conditions: [{ fieldKey: "visibility", when: "equals", value: "public" }],
      reason:
        "Anyone on the internet can read this project's code, and its issues and pipelines unless they are restricted separately.",
    },
  ],
  orphanRule: {
    conditions: [{ fieldKey: "archived", when: "equals", value: "true" }],
    reason:
      "Archived project. It still counts towards the namespace's storage, including job artifacts, packages and container images.",
  },
  iconKey: "project",
});

/** `GET /projects/:id/pipelines`: the most recent per project. */
export const PipelineResourceType = rt({
  name: "Pipeline",
  id: "pipeline",
  parentTypeId: "project",
  showInSidebar: true,
  description:
    "A recent CI/CD pipeline: ref, commit, source, status, duration and queue time, with every job and its log. Retry failed jobs, cancel, run manual jobs or delete the pipeline. Create one to run a pipeline on a branch or tag with variables.",
  fields: [
    f("iid", "Number", { kind: "number", required: false, editable: false }),
    projectRef,
    f("status", "Status", { required: false, editable: false }),
    f("ref", "Ref", { required: false, editable: false }),
    f("sha", "Commit", { required: false, editable: false }),
    f("source", "Source", { required: false, editable: false }),
    f("name", "Name", { required: false, editable: false }),
    f("user", "Triggered By", { required: false, editable: false }),
    f("durationSecs", "Duration (seconds)", { kind: "number", required: false, editable: false }),
    f("queuedSecs", "Queued (seconds)", { kind: "number", required: false, editable: false }),
    f("coverage", "Coverage (%)", { kind: "number", required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("finishedAt", "Finished", { required: false, editable: false }),
  ],
  outputs: [o("pipelineId", "Pipeline ID"), o("webUrl", "Web URL")],
  supportsCreate: true,
  supportsDelete: true,
  iconKey: "pipeline",
  pinnable: false,
});

/** `GET /projects/:id/environments`. */
export const EnvironmentResourceType = rt({
  name: "Environment",
  id: "environment",
  parentTypeId: "project",
  showInSidebar: true,
  description:
    "A deployment environment: tier, external URL, state, auto-stop time and the last deployment, with recent deployments (approve or reject ones waiting for approval). Charts deployments per day. Create, edit, stop or delete it.",
  fields: [
    f("name", "Name", { editable: false }),
    f("externalUrl", "External URL", { required: false }),
    f("tier", "Tier", {
      kind: "enum",
      required: false,
      enumValues: ["production", "staging", "testing", "development", "other"],
    }),
    f("description", "Description", { required: false }),
    f("state", "State", { required: false, editable: false }),
    projectRef,
    f("lastDeploymentStatus", "Last Deployment", { required: false, editable: false }),
    f("lastDeploymentRef", "Last Deployed Ref", { required: false, editable: false }),
    f("lastDeployedAt", "Last Deployed", { required: false, editable: false }),
    f("lastDeployedBy", "Last Deployed By", { required: false, editable: false }),
    f("autoStopAt", "Auto-Stops", { required: false, editable: false }),
    f("kubernetesNamespace", "Kubernetes Namespace", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [o("externalUrl", "External URL"), o("environmentId", "Environment ID")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  supportsMetrics: true,
  orphanRule: {
    conditions: [{ fieldKey: "state", when: "equals", value: "stopped" }],
    reason:
      "Stopped environment. It keeps its deployment history but serves nothing; delete it once it is no longer needed.",
  },
  iconKey: "deployment",
});

/** `GET /projects/:id/protected_branches`. */
export const ProtectedBranchResourceType = rt({
  name: "Protected Branch",
  plural: "Protected Branches",
  id: "protected-branch",
  parentTypeId: "project",
  description:
    "A protected branch or wildcard: who may push and merge, and whether force push is allowed. Protect a branch, change its rules, or unprotect it.",
  fields: [
    f("name", "Branch", { editable: false }),
    f("pushAccess", "Allowed to Push", {
      kind: "enum",
      required: false,
      enumValues: ["No one", "Developers + Maintainers", "Maintainers"],
    }),
    f("mergeAccess", "Allowed to Merge", {
      kind: "enum",
      required: false,
      enumValues: ["No one", "Developers + Maintainers", "Maintainers"],
    }),
    f("allowForcePush", "Allow Force Push", { kind: "boolean", required: false }),
    f("codeOwnerApprovalRequired", "Require Code Owner Approval", {
      kind: "boolean",
      required: false,
      description: "Premium and Ultimate only.",
    }),
    f("inherited", "Inherited from Group", { kind: "boolean", required: false, editable: false }),
    projectRef,
  ],
  outputs: [o("name", "Branch")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  postureChecks: [
    {
      id: "gitlab-protected-branch-force-push",
      title: "Force push allowed on a protected branch",
      severity: "medium",
      category: "data-protection",
      conditions: [{ fieldKey: "allowForcePush", when: "truthy" }],
      reason:
        "Anyone who can push to this branch can rewrite its history, including removing commits others rely on.",
    },
  ],
  iconKey: "shield",
});

const variableFields = [
  f("key", "Key", { editable: false }),
  f("value", "Value", {
    kind: "password",
    required: false,
    description: "Write-only here. Leave empty to keep the current value.",
  }),
  f("environmentScope", "Environment Scope", {
    required: false,
    description: "Which environments receive it, e.g. * or production or review/*.",
  }),
  f("variableType", "Type", { kind: "enum", required: false, enumValues: ["env_var", "file"] }),
  f("protected", "Protected", {
    kind: "boolean",
    required: false,
    description: "Only passed to pipelines on protected branches and tags.",
  }),
  f("masked", "Masked", { kind: "boolean", required: false, description: "Hidden in job logs." }),
  f("hidden", "Hidden", { kind: "boolean", required: false, editable: false }),
  f("raw", "Raw (no expansion)", { kind: "boolean", required: false }),
  f("description", "Description", { required: false }),
];

const variablePosture = (prefix: string) => [
  {
    id: `${prefix}-unprotected-unmasked`,
    title: "CI/CD variable neither protected nor masked",
    severity: "low" as const,
    category: "other" as const,
    conditions: [
      { fieldKey: "protected", when: "falsy" as const },
      { fieldKey: "masked", when: "falsy" as const },
    ],
    reason:
      "Any pipeline on any branch receives this variable and its value is printed in job logs if a script echoes it. Mask it, and protect it if it is a secret only deployments need.",
  },
];

/** `GET /projects/:id/variables`. */
export const ProjectVariableResourceType = rt({
  name: "Project Variable",
  id: "project-variable",
  parentTypeId: "project",
  description:
    "A project CI/CD variable: type, environment scope and whether it is protected, masked, hidden or raw. Values are never stored here. Create one, replace its value or change its settings under Edit, or delete it.",
  fields: [...variableFields, projectRef],
  outputs: [o("key", "Key")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  postureChecks: variablePosture("gitlab-project-variable"),
  iconKey: "key",
  pinnable: false,
});

/** `GET /groups/:id/variables`. */
export const GroupVariableResourceType = rt({
  name: "Group Variable",
  id: "group-variable",
  parentTypeId: "group",
  description:
    "A group CI/CD variable, inherited by every project in the group: type, environment scope and whether it is protected, masked, hidden or raw. Create one, replace its value or settings, or delete it.",
  fields: [...variableFields, groupRef],
  outputs: [o("key", "Key")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  postureChecks: variablePosture("gitlab-group-variable"),
  iconKey: "key",
  pinnable: false,
});

/** `GET /projects/:id/pipeline_schedules`. */
export const PipelineScheduleResourceType = rt({
  name: "Pipeline Schedule",
  id: "pipeline-schedule",
  parentTypeId: "project",
  showInSidebar: true,
  description:
    "A scheduled pipeline: cron, time zone, ref, whether it is active, its owner, next run and last pipeline status. Create, edit, activate or deactivate it, run it now, take ownership or delete it.",
  fields: [
    f("description", "Description"),
    f("cron", "Cron Schedule", { description: "Five fields, e.g. 0 3 * * 1-5." }),
    f("cronTimezone", "Time Zone", {
      required: false,
      description: "An IANA zone such as Europe/Berlin, or UTC.",
    }),
    f("ref", "Branch or Tag", { required: false }),
    f("active", "Active", { kind: "boolean", required: false }),
    f("nextRunAt", "Next Run", { required: false, editable: false }),
    f("owner", "Owner", { required: false, editable: false }),
    f("lastPipelineStatus", "Last Pipeline", { required: false, editable: false }),
    f("variables", "Variables", { required: false, editable: false }),
    projectRef,
  ],
  outputs: [o("scheduleId", "Schedule ID")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "clock",
});

/** `GET /projects/:id/registry/repositories` (or the group listing). */
export const ContainerRepositoryResourceType = rt({
  name: "Container Repository",
  plural: "Container Repositories",
  id: "container-repository",
  parentTypeId: "project",
  showInSidebar: true,
  description:
    "A container registry repository: image location, tag count and size, with every tag's digest and size under Artifacts. Clean up old tags or delete the repository.",
  fields: [
    f("path", "Path", { editable: false }),
    f("location", "Location", { required: false, editable: false }),
    f("tagsCount", "Tags", { kind: "number", required: false, editable: false }),
    f("sizeBytes", "Size (bytes)", { kind: "number", required: false, editable: false }),
    f("cleanupPolicyStartedAt", "Last Cleanup", { required: false, editable: false }),
    f("status", "Status", { required: false, editable: false }),
    projectRef,
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [o("location", "Image location")],
  supportsDelete: true,
  orphanRule: {
    conditions: [{ fieldKey: "tagsCount", when: "equals", value: "0" }],
    reason: "Container repository with no tags. Nothing can be pulled from it.",
  },
  iconKey: "container-registry",
});

/** `GET /projects/:id/packages` (or the group listing). */
export const PackageResourceType = rt({
  name: "Package",
  id: "package",
  parentTypeId: "project",
  showInSidebar: true,
  description:
    "A package in the package registry (npm, Maven, PyPI, NuGet, Helm, Go, Conan, Composer, generic, Terraform module): version, status, the pipeline that built it, and its files under Artifacts. Delete it.",
  fields: [
    f("name", "Name", { editable: false }),
    f("version", "Version", { required: false, editable: false }),
    f("packageType", "Type", { required: false, editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("pipelineStatus", "Built By Pipeline", { required: false, editable: false }),
    f("lastDownloadedAt", "Last Downloaded", { required: false, editable: false }),
    projectRef,
    f("createdAt", "Published", { required: false, editable: false }),
  ],
  outputs: [o("name", "Package name"), o("version", "Version")],
  supportsDelete: true,
  iconKey: "file",
  pinnable: false,
});

/** `GET /projects/:id/deploy_keys`. */
export const DeployKeyResourceType = rt({
  name: "Deploy Key",
  id: "deploy-key",
  parentTypeId: "project",
  description:
    "An SSH deploy key with read or read-write access to the project's repository: fingerprint, push access and expiry. Add one, rename it or change push access, or remove it.",
  fields: [
    f("title", "Title"),
    f("canPush", "Write Access", { kind: "boolean", required: false }),
    f("fingerprint", "Fingerprint (SHA256)", { required: false, editable: false }),
    f("expiresAt", "Expires", { required: false, editable: false }),
    projectRef,
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [o("fingerprint", "Fingerprint")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  expiryFields: [
    { fieldKey: "expiresAt", from: "expiry", kind: "ssh-key", label: "Deploy key expires" },
    {
      fieldKey: "createdAt",
      from: "created",
      kind: "ssh-key",
      label: "Deploy key age",
      maxAgeDays: 365,
    },
  ],
  principalRole: { role: "key", adminIndicatorKey: "canPush" },
  postureChecks: [
    {
      id: "gitlab-deploy-key-write",
      title: "Deploy key can push",
      severity: "medium",
      category: "credential-age",
      conditions: [
        { fieldKey: "canPush", when: "truthy" },
        { fieldKey: "expiresAt", when: "empty" },
      ],
      reason:
        "This key can write to the repository and never expires. Whoever holds the private key can push code without a user account.",
    },
  ],
  iconKey: "key",
  pinnable: false,
});

const deployTokenFields = [
  f("name", "Name", { editable: false }),
  f("username", "Username", { required: false, editable: false }),
  f("scopes", "Scopes", { required: false, editable: false }),
  f("expiresAt", "Expires", { required: false, editable: false }),
  f("revoked", "Revoked", { kind: "boolean", required: false, editable: false }),
  f("expired", "Expired", { kind: "boolean", required: false, editable: false }),
];

const deployTokenOrphan = {
  conditions: [{ fieldKey: "expired", when: "equals" as const, value: "true" }],
  reason: "Expired deploy token. It no longer works and can be removed.",
};

/** `GET /projects/:id/deploy_tokens`. */
export const DeployTokenResourceType = rt({
  name: "Deploy Token",
  id: "deploy-token",
  parentTypeId: "project",
  description:
    "A project deploy token for cloning, pulling images or packages from CI, Kubernetes or a build server: scopes, username and expiry. Create one (its token is kept as a sensitive output) or revoke it.",
  fields: [...deployTokenFields, projectRef],
  outputs: [
    o("username", "Username"),
    o("token", "Token", {
      sensitive: true,
      description: "Only available for tokens created from Infrawrench; GitLab shows a token once.",
    }),
  ],
  supportsCreate: true,
  supportsDelete: true,
  expiryFields: [
    { fieldKey: "expiresAt", from: "expiry", kind: "api-token", label: "Deploy token expires" },
  ],
  principalRole: { role: "key" },
  orphanRule: deployTokenOrphan,
  secretExportTemplates: [
    {
      id: "registry-login",
      displayName: "Registry login",
      entries: [
        { envKey: "GITLAB_DEPLOY_USER", outputKey: "username" },
        { envKey: "GITLAB_DEPLOY_TOKEN", outputKey: "token" },
      ],
    },
  ],
  iconKey: "key",
  pinnable: false,
});

/** `GET /groups/:id/deploy_tokens`. */
export const GroupDeployTokenResourceType = rt({
  name: "Group Deploy Token",
  id: "group-deploy-token",
  parentTypeId: "group",
  description:
    "A group deploy token that works for every project in the group: scopes, username and expiry. Create one (its token is kept as a sensitive output) or revoke it.",
  fields: [...deployTokenFields, groupRef],
  outputs: [
    o("username", "Username"),
    o("token", "Token", {
      sensitive: true,
      description: "Only available for tokens created from Infrawrench; GitLab shows a token once.",
    }),
  ],
  supportsCreate: true,
  supportsDelete: true,
  expiryFields: [
    { fieldKey: "expiresAt", from: "expiry", kind: "api-token", label: "Deploy token expires" },
  ],
  principalRole: { role: "key" },
  orphanRule: deployTokenOrphan,
  secretExportTemplates: [
    {
      id: "registry-login",
      displayName: "Registry login",
      entries: [
        { envKey: "GITLAB_DEPLOY_USER", outputKey: "username" },
        { envKey: "GITLAB_DEPLOY_TOKEN", outputKey: "token" },
      ],
    },
  ],
  iconKey: "key",
  pinnable: false,
});

const hookFields = [
  f("url", "URL"),
  f("name", "Name", { required: false }),
  f("description", "Description", { required: false }),
  f("events", "Events", {
    required: false,
    description:
      "Comma-separated: push, tag_push, merge_requests, issues, confidential_issues, note, confidential_note, job, pipeline, deployment, releases, wiki_page, milestone, feature_flag (plus subgroup, member, project on group hooks).",
  }),
  f("pushEventsBranchFilter", "Push Branch Filter", { required: false }),
  f("enableSslVerification", "Verify TLS", { kind: "boolean", required: false }),
  f("secretToken", "Secret Token", {
    kind: "password",
    required: false,
    description: "Sent in X-Gitlab-Token. Write-only; leave empty to keep the current one.",
  }),
  f("tokenSet", "Secret Token Set", { kind: "boolean", required: false, editable: false }),
  f("alertStatus", "Delivery Status", { required: false, editable: false }),
  f("disabledUntil", "Disabled Until", { required: false, editable: false }),
  f("createdAt", "Created", { required: false, editable: false }),
];

const hookPosture = (prefix: string) => [
  {
    id: `${prefix}-no-tls-verify`,
    title: "Webhook skips TLS verification",
    severity: "medium" as const,
    category: "encryption" as const,
    conditions: [{ fieldKey: "enableSslVerification", when: "falsy" as const }],
    reason:
      "GitLab sends events (and the secret token) without checking the receiver's certificate, so anyone who can intercept the connection can read or forge them.",
  },
];

/** `GET /projects/:id/hooks`. */
export const ProjectWebhookResourceType = rt({
  name: "Project Webhook",
  id: "project-webhook",
  parentTypeId: "project",
  description:
    "A project webhook: URL, the events it sends, branch filter, TLS verification and whether GitLab has disabled it after failures. Create, edit, send a test push event or delete it.",
  fields: [...hookFields, projectRef],
  outputs: [o("url", "URL")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  postureChecks: hookPosture("gitlab-project-hook"),
  iconKey: "webhook",
  pinnable: false,
});

/** `GET /groups/:id/hooks` (Premium and Ultimate). */
export const GroupWebhookResourceType = rt({
  name: "Group Webhook",
  id: "group-webhook",
  parentTypeId: "group",
  description:
    "A group webhook (Premium and Ultimate) that fires for every project in the group. Create, edit, send a test push event or delete it.",
  fields: [...hookFields, groupRef],
  outputs: [o("url", "URL")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  postureChecks: hookPosture("gitlab-group-hook"),
  iconKey: "webhook",
  pinnable: false,
});

/** `GET /projects/:id/releases`. */
export const ReleaseResourceType = rt({
  name: "Release",
  id: "release",
  parentTypeId: "project",
  description:
    "A release: tag, name, release date, author, commit, milestones and asset links. Create a release (tagging a branch or commit if the tag is new), edit its name, notes and date, or delete it (the tag stays).",
  fields: [
    f("tagName", "Tag", { editable: false }),
    f("name", "Name", { required: false }),
    f("description", "Release Notes", { required: false }),
    f("releasedAt", "Released", { required: false }),
    f("upcoming", "Upcoming", { kind: "boolean", required: false, editable: false }),
    f("author", "Author", { required: false, editable: false }),
    f("commit", "Commit", { required: false, editable: false }),
    f("milestones", "Milestones", { required: false, editable: false }),
    f("assetCount", "Assets", { kind: "number", required: false, editable: false }),
    projectRef,
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [o("tagName", "Tag"), o("webUrl", "Web URL")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "tag",
  pinnable: false,
});

const memberFields = [
  f("username", "Username", { editable: false }),
  f("name", "Name", { required: false, editable: false }),
  f("accessLevel", "Role", { kind: "enum", required: false, enumValues: ACCESS_LEVEL_OPTIONS }),
  f("expiresAt", "Access Expires", {
    required: false,
    description: "YYYY-MM-DD. Leave empty for no expiry.",
  }),
  f("state", "State", { required: false, editable: false }),
  f("customRole", "Custom Role", { required: false, editable: false }),
  f("createdAt", "Added", { required: false, editable: false }),
];

const memberPrincipal = {
  role: "binding" as const,
  adminIndicatorKey: "accessLevel",
  adminValues: ["Owner", "Maintainer"],
};

/** `GET /projects/:id/members` (direct members). */
export const ProjectMemberResourceType = rt({
  name: "Project Member",
  id: "project-member",
  parentTypeId: "project",
  description:
    "A user added directly to the project, with their role and access expiry. Add someone by username, change their role or expiry, or remove them. Members inherited from groups are listed on the group.",
  fields: [...memberFields, projectRef],
  outputs: [o("username", "Username")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  expiryFields: [
    { fieldKey: "expiresAt", from: "expiry", kind: "other", label: "Project access expires" },
  ],
  principalRole: memberPrincipal,
  iconKey: "user",
  pinnable: false,
});

/** `GET /groups/:id/members` (direct members). */
export const GroupMemberResourceType = rt({
  name: "Group Member",
  id: "group-member",
  parentTypeId: "group",
  description:
    "A user added directly to the group (and so to all its projects), with their role and access expiry. Add someone by username, change their role or expiry, or remove them.",
  fields: [...memberFields, groupRef],
  outputs: [o("username", "Username")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  expiryFields: [
    { fieldKey: "expiresAt", from: "expiry", kind: "other", label: "Group access expires" },
  ],
  principalRole: memberPrincipal,
  iconKey: "user",
  pinnable: false,
});

/** `GET /groups/:id/runners`, the projects' runners, or `GET /runners`. */
export const RunnerResourceType = rt({
  name: "Runner",
  id: "runner",
  description:
    "A GitLab Runner registered to the group, a project or the instance: status, whether it is busy, tags, version and last contact, with its recent jobs. Charts jobs, failures and job duration per day. Create one, pause or resume it, edit its tags and settings, reset its token with Get credentials, or delete it.",
  fields: [
    f("description", "Description", { required: false }),
    f("tagList", "Tags", { required: false, description: "Comma-separated." }),
    f("paused", "Paused", { kind: "boolean", required: false }),
    f("runUntagged", "Run Untagged Jobs", { kind: "boolean", required: false }),
    f("locked", "Locked to Current Projects", { kind: "boolean", required: false }),
    f("accessLevel", "Protected Refs Only", {
      kind: "enum",
      required: false,
      enumValues: ["not_protected", "ref_protected"],
    }),
    f("maximumTimeout", "Maximum Job Timeout (seconds)", { kind: "number", required: false }),
    f("maintenanceNote", "Maintenance Note", { required: false }),
    f("runnerType", "Scope", { required: false, editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("busy", "Running Jobs", { kind: "boolean", required: false, editable: false }),
    f("contactedAt", "Last Contact", { required: false, editable: false }),
    f("version", "Version", { required: false, editable: false }),
    f("platform", "Platform", { required: false, editable: false }),
    f("owner", "Registered To", { required: false, editable: false }),
    f("runnerId", "Runner ID", { required: false, editable: false }),
  ],
  outputs: [
    o("runnerId", "Runner ID"),
    o("token", "Authentication token", {
      sensitive: true,
      description:
        "Kept when the runner is created or its token reset from Infrawrench; GitLab shows a token once. Use it with gitlab-runner register --token.",
    }),
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  supportsMetrics: true,
  credentialFormats: [
    {
      id: "runner-token",
      label: "New runner authentication token",
      description:
        "Resets the runner's authentication token and returns the new one. Runners using the old token stop picking up jobs until reconfigured.",
      mediaType: "text",
      filenameTemplate: "gitlab-runner-token.txt",
    },
  ],
  orphanRule: {
    conditions: [{ fieldKey: "status", when: "equals", value: "stale" }],
    reason:
      "Runner that has not contacted GitLab for over a week. If the machine behind it is gone the registration can be deleted; if not, it may be idle capacity you pay for elsewhere.",
  },
  iconKey: "server",
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  GroupResourceType,
  ProjectResourceType,
  PipelineResourceType,
  EnvironmentResourceType,
  ProtectedBranchResourceType,
  ProjectVariableResourceType,
  GroupVariableResourceType,
  PipelineScheduleResourceType,
  ContainerRepositoryResourceType,
  PackageResourceType,
  DeployKeyResourceType,
  DeployTokenResourceType,
  GroupDeployTokenResourceType,
  ProjectWebhookResourceType,
  GroupWebhookResourceType,
  ReleaseResourceType,
  ProjectMemberResourceType,
  GroupMemberResourceType,
  RunnerResourceType,
];
