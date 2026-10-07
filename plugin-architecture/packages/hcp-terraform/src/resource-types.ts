import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * HCP Terraform / Terraform Enterprise resource types, scoped to the
 * organization picked in the credentials. Attribute names follow the API v2
 * reference (2026-10).
 */

const ro = { required: false, editable: false } as const;
const num = { kind: "number", required: false, editable: false } as const;
const bool = { kind: "boolean", required: false, editable: false } as const;
const editBool = (description?: string) => ({
  kind: "boolean" as const,
  required: false,
  ...(description ? { description } : {}),
});

export const OrganizationResourceType = rt({
  name: "Organization",
  id: "organization",
  accountRoot: true,
  description:
    "The HCP Terraform or Terraform Enterprise organization: plan, workspaces, projects, resources under management, drifted workspaces and failing checks, users against the plan's limit, and the next invoice. Edit its notification email and defaults. Charts runs, errors and run duration across the organization.",
  fields: [
    f("name", "Name", ro),
    f("email", "Notification Email", { required: false }),
    f("defaultExecutionMode", "Default Execution Mode", {
      kind: "enum",
      enumValues: ["remote", "local"],
      required: false,
    }),
    f("costEstimationEnabled", "Cost Estimation", editBool()),
    f(
      "assessmentsEnforced",
      "Enforce Health Assessments",
      editBool(
        "Run drift detection and checks on every workspace, whatever the workspace setting.",
      ),
    ),
    f(
      "allowForceDeleteWorkspaces",
      "Allow Force-Deleting Workspaces",
      editBool("Let workspace admins delete workspaces that still manage resources."),
    ),
    f("sessionTimeoutMinutes", "Session Timeout (minutes)", num),
    f("plan", "Plan", ro),
    f("planExpiresAt", "Plan Expires", ro),
    f("planExpired", "Plan Expired", bool),
    f("workspaceCount", "Workspaces", num),
    f("projectCount", "Projects", num),
    f("rumCount", "Resources Under Management", num),
    f("driftedWorkspaces", "Drifted Workspaces", num),
    f("checksFailing", "Workspaces Failing Checks", num),
    f("userCount", "Users", num),
    f("userLimit", "User Limit", num),
    f("nextInvoiceTotal", "Next Invoice (USD)", num),
    f("runningRuns", "Active Runs", num),
    f("externalId", "Organization ID", ro),
    f("createdAt", "Created", ro),
  ],
  outputs: [
    o("name", "Organization name"),
    o("organizationId", "Organization ID"),
    o("url", "URL"),
  ],
  expiryFields: [
    { fieldKey: "planExpiresAt", from: "expiry", kind: "other", label: "Plan expires" },
  ],
  supportsUpdate: true,
  supportsDelete: false,
  supportsMetrics: true,
  iconKey: "account",
});

export const ProjectResourceType = rt({
  name: "Project",
  id: "project",
  description:
    "A project: a group of workspaces with shared settings and team access. Create, edit or delete it.",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("defaultExecutionMode", "Default Execution Mode", {
      kind: "enum",
      enumValues: ["remote", "local"],
      required: false,
      description:
        "Where new workspaces in this project run by default. Agent mode is set from the workspace.",
    }),
    f("autoDestroyActivityDuration", "Auto-Destroy After Inactivity", {
      required: false,
      description:
        "Destroy a workspace's infrastructure after this long without activity, e.g. 14d or 48h. Empty turns it off.",
    }),
    f("workspaceCount", "Workspaces", num),
    f("organization", "Organization", ro),
    f("projectId", "Project ID", ro),
  ],
  outputs: [o("projectId", "Project ID"), o("url", "URL")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "folder",
});

export const WorkspaceResourceType = rt({
  name: "Workspace",
  id: "workspace",
  parentTypeId: "project",
  showInSidebar: true,
  description:
    "A workspace: its Terraform version, execution mode, VCS repository, resource count, current run, drift and check results, recent state versions, and its variables and outputs. Queue a plan, apply or destroy, lock or unlock it, edit its settings, download its current state, or delete it safely. Charts runs, failures, duration and resource changes.",
  fields: [
    f("name", "Name", {
      description: "Renaming changes the workspace's URL and its remote backend name.",
    }),
    f("description", "Description", { required: false }),
    f("terraformVersion", "Terraform Version", {
      required: false,
      description: "An exact version (1.9.8) or a constraint (~> 1.9).",
    }),
    f("executionMode", "Execution Mode", {
      kind: "enum",
      enumValues: ["remote", "local", "agent"],
      required: false,
      description: "Agent mode also needs an agent pool: use Change agent pool.",
    }),
    f("workingDirectory", "Working Directory", { required: false }),
    f("autoApply", "Auto Apply", editBool()),
    f("autoApplyRunTrigger", "Auto Apply Run-Triggered Runs", editBool()),
    f(
      "assessmentsEnabled",
      "Health Assessments",
      editBool("Drift detection and continuous validation."),
    ),
    f("allowDestroyPlan", "Allow Destroy Plans", editBool()),
    f("speculativeEnabled", "Speculative Plans on Pull Requests", editBool()),
    f("fileTriggersEnabled", "Only Run on Changes in the Working Directory", editBool()),
    f("queueAllRuns", "Queue All Runs", editBool()),
    f("globalRemoteState", "Share State with All Workspaces", editBool()),
    f("autoDestroyAt", "Scheduled Destroy", {
      required: false,
      description: "ISO 8601 time at which a destroy run is queued. Empty clears it.",
    }),
    f("autoDestroyActivityDuration", "Auto-Destroy After Inactivity", {
      required: false,
      description: "e.g. 14d or 48h. Empty turns it off.",
    }),
    f("projectName", "Project", ro),
    f("projectId", "Project ID", ro),
    f("agentPoolId", "Agent Pool ID", ro),
    f("vcsRepo", "VCS Repository", ro),
    f("vcsBranch", "VCS Branch", ro),
    f("locked", "Locked", bool),
    f("resourceCount", "Resources", num),
    f("rumCount", "Resources Under Management", num),
    f("currentRunStatus", "Current Run", ro),
    f("currentRunId", "Current Run ID", ro),
    f("drifted", "Drifted", bool),
    f("resourcesDrifted", "Drifted Resources", num),
    f("checksFailed", "Failing Checks", num),
    f("checksPassed", "Passing Checks", num),
    f("runFailures", "Run Failures", num),
    f("applyDurationAverageMs", "Average Apply (ms)", num),
    f("planDurationAverageMs", "Average Plan (ms)", num),
    f("providers", "Providers", ro),
    f("stateTerraformVersion", "State Terraform Version", ro),
    f("tags", "Tags", ro),
    f("latestChangeAt", "Last Change", ro),
    f("organization", "Organization", ro),
    f("workspaceId", "Workspace ID", ro),
    f("createdAt", "Created", ro),
  ],
  outputs: [o("workspaceId", "Workspace ID"), o("name", "Workspace name"), o("url", "URL")],
  dependsOn: [
    { fieldKey: "projectId", targetTypeId: "project", label: "in" },
    { fieldKey: "agentPoolId", targetTypeId: "agent-pool", label: "runs on" },
  ],
  orphanRule: {
    conditions: [
      { fieldKey: "resourceCount", when: "equals", value: "0" },
      { fieldKey: "currentRunStatus", when: "empty" },
    ],
    reason: "Workspace manages no resources and has never run.",
  },
  postureChecks: [
    {
      id: "workspace-global-remote-state",
      title: "Workspace state is readable by every workspace",
      severity: "low",
      category: "data-protection",
      conditions: [{ fieldKey: "globalRemoteState", when: "truthy" }],
      reason:
        "Every workspace in the organization can read this workspace's state, including any secrets in it. Share it with specific workspaces instead.",
    },
  ],
  credentialFormats: [
    {
      id: "state",
      label: "Current state (.tfstate)",
      description:
        "The workspace's current Terraform state file. Upload it under IaC to see which of your synced resources it manages.",
      mediaType: "json",
      filenameTemplate: "{resource}.tfstate",
    },
    {
      id: "state-json",
      label: "Current state (terraform show -json)",
      description: "The same state in the machine-readable JSON format.",
      mediaType: "json",
      filenameTemplate: "{resource}.state.json",
    },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  supportsMetrics: true,
  iconKey: "workspace",
});

export const RunResourceType = rt({
  name: "Run",
  id: "run",
  parentTypeId: "workspace",
  showInSidebar: true,
  description:
    "A run: its status, trigger, message and planned resource changes, with plan and apply logs in the Logs tab. Apply, discard, cancel or force-cancel it. The 50 most recent runs in the organization are listed; create one to queue a plan.",
  fields: [
    f("status", "Status", ro),
    f("message", "Message", ro),
    f("workspaceName", "Workspace", ro),
    f("workspaceId", "Workspace ID", ro),
    f("source", "Source", ro),
    f("triggerReason", "Trigger", ro),
    f("isDestroy", "Destroy", bool),
    f("planOnly", "Plan Only", bool),
    f("refreshOnly", "Refresh Only", bool),
    f("autoApply", "Auto Apply", bool),
    f("hasChanges", "Has Changes", bool),
    f("terraformVersion", "Terraform Version", ro),
    f("targetAddrs", "Targets", ro),
    f("resourceAdditions", "To Add", num),
    f("resourceChanges", "To Change", num),
    f("resourceDestructions", "To Destroy", num),
    f("resourceImports", "To Import", num),
    f("canApply", "Can Apply", bool),
    f("canDiscard", "Can Discard", bool),
    f("canCancel", "Can Cancel", bool),
    f("durationSecs", "Duration (seconds)", num),
    f("planId", "Plan ID", ro),
    f("applyId", "Apply ID", ro),
    f("createdAt", "Created", ro),
    f("runId", "Run ID", ro),
  ],
  outputs: [o("runId", "Run ID"), o("url", "URL")],
  supportsCreate: true,
  supportsDelete: false,
  iconKey: "play",
  pinnable: false,
});

export const VariableResourceType = rt({
  name: "Variable",
  id: "variable",
  parentTypeId: "workspace",
  description:
    "A workspace variable, Terraform or environment. Non-sensitive values are shown and can be referenced by other resources; sensitive ones are write-only. Create, edit or delete it.",
  fields: [
    f("key", "Key"),
    f("value", "Value", {
      required: false,
      description:
        "For a sensitive variable, type a new value to replace it; leave empty to keep it.",
    }),
    f("category", "Category", { kind: "enum", enumValues: ["terraform", "env"], required: false }),
    f("hcl", "HCL", {
      kind: "boolean",
      required: false,
      description: "Parse the value as HCL (lists, maps).",
    }),
    f("sensitive", "Sensitive", {
      kind: "boolean",
      required: false,
      description: "Once sensitive, a variable cannot be made non-sensitive again.",
    }),
    f("description", "Description", { required: false }),
    f("workspaceName", "Workspace", ro),
    f("workspaceId", "Workspace ID", ro),
    f("variableId", "Variable ID", ro),
  ],
  outputs: [
    o("key", "Key"),
    o("value", "Value", { description: "Only for non-sensitive variables." }),
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "key",
  pinnable: false,
});

export const StateOutputResourceType = rt({
  name: "State Output",
  id: "state-output",
  parentTypeId: "workspace",
  showInSidebar: true,
  description:
    "An output of a workspace's current state. Its value (including sensitive outputs, with permission to read state outputs) is an output other resources can reference, so a DNS record or a secret export follows what Terraform last applied.",
  fields: [
    f("name", "Name", ro),
    f("type", "Type", ro),
    f("sensitive", "Sensitive", bool),
    f("preview", "Value", ro),
    f("workspaceName", "Workspace", ro),
    f("workspaceId", "Workspace ID", ro),
    f("outputId", "Output ID", ro),
  ],
  outputs: [
    o("value", "Value", {
      sensitive: true,
      description: "The output's value; JSON for lists, maps and objects.",
    }),
    o("name", "Name"),
  ],
  supportsDelete: false,
  iconKey: "output",
  pinnable: false,
});

export const VariableSetResourceType = rt({
  name: "Variable Set",
  id: "variable-set",
  description:
    "A variable set shared across workspaces and projects, or applied globally. Create, edit or delete it, apply it to or remove it from a workspace or project, and manage its variables.",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("global", "Global", editBool("Apply to every current and future workspace.")),
    f(
      "priority",
      "Priority",
      editBool("Its values override workspace variables and cannot be overridden."),
    ),
    f("varCount", "Variables", num),
    f("workspaceCount", "Workspaces", num),
    f("projectCount", "Projects", num),
    f("workspaceIds", "Workspace IDs", ro),
    f("projectIds", "Project IDs", ro),
    f("updatedAt", "Updated", ro),
    f("organization", "Organization", ro),
    f("varsetId", "Variable Set ID", ro),
  ],
  outputs: [o("varsetId", "Variable set ID")],
  dependsOn: [
    { fieldKey: "workspaceIds", targetTypeId: "workspace", label: "applied to" },
    { fieldKey: "projectIds", targetTypeId: "project", label: "applied to" },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "key",
});

export const VarsetVariableResourceType = rt({
  name: "Variable Set Variable",
  id: "varset-variable",
  parentTypeId: "variable-set",
  description: "A variable in a variable set. Create, edit or delete it.",
  fields: [
    f("key", "Key"),
    f("value", "Value", {
      required: false,
      description:
        "For a sensitive variable, type a new value to replace it; leave empty to keep it.",
    }),
    f("category", "Category", { kind: "enum", enumValues: ["terraform", "env"], required: false }),
    f("hcl", "HCL", { kind: "boolean", required: false }),
    f("sensitive", "Sensitive", { kind: "boolean", required: false }),
    f("description", "Description", { required: false }),
    f("varsetName", "Variable Set", ro),
    f("varsetId", "Variable Set ID", ro),
    f("variableId", "Variable ID", ro),
  ],
  outputs: [
    o("key", "Key"),
    o("value", "Value", { description: "Only for non-sensitive variables." }),
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "key",
  pinnable: false,
});

export const AgentPoolResourceType = rt({
  name: "Agent Pool",
  id: "agent-pool",
  description:
    "An agent pool for running Terraform on your own infrastructure: its agents, tokens and which workspaces may use it. Create, rename, scope or delete it, and mint an agent token with Get credentials.",
  fields: [
    f("name", "Name"),
    f("organizationScoped", "Available to All Workspaces", editBool()),
    f("agentCount", "Agents", num),
    f("workspaceCount", "Workspaces Using It", num),
    f("allowedWorkspaces", "Allowed Workspaces", num),
    f("allowedProjects", "Allowed Projects", num),
    f("organization", "Organization", ro),
    f("agentPoolId", "Agent Pool ID", ro),
    f("createdAt", "Created", ro),
  ],
  outputs: [o("agentPoolId", "Agent pool ID")],
  credentialFormats: [
    {
      id: "agent-token",
      label: "Agent token",
      description: "A new token for an HCP Terraform agent in this pool (TFC_AGENT_TOKEN).",
      mediaType: "text",
      filenameTemplate: "tfc-agent-token.txt",
    },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "server",
});

export const AgentResourceType = rt({
  name: "Agent",
  id: "agent",
  parentTypeId: "agent-pool",
  showInSidebar: true,
  description:
    "An agent in a pool: its status, IP address and last check-in. Remove an exited or errored agent.",
  fields: [
    f("name", "Name", ro),
    f("status", "Status", ro),
    f("ipAddress", "IP Address", ro),
    f("lastPingAt", "Last Check-In", ro),
    f("poolName", "Agent Pool", ro),
    f("agentPoolId", "Agent Pool ID", ro),
    f("agentId", "Agent ID", ro),
  ],
  outputs: [o("agentId", "Agent ID")],
  orphanRule: {
    conditions: [{ fieldKey: "status", when: "equals", value: "exited" }],
    reason: "The agent has exited and only lingers in the pool's list.",
  },
  supportsDelete: true,
  iconKey: "server",
  pinnable: false,
});

export const AgentTokenResourceType = rt({
  name: "Agent Token",
  id: "agent-token",
  parentTypeId: "agent-pool",
  description:
    "An agent pool token: description, when it was created and last used. Create one (its value is kept as the token output, exportable as TFC_AGENT_TOKEN) or revoke it.",
  fields: [
    f("description", "Description", { editable: false }),
    f("lastUsedAt", "Last Used", ro),
    f("createdAt", "Created", ro),
    f("poolName", "Agent Pool", ro),
    f("agentPoolId", "Agent Pool ID", ro),
    f("tokenId", "Token ID", ro),
  ],
  outputs: [
    o("token", "Agent token", {
      sensitive: true,
      description: "Only available for tokens created from Infrawrench: the value is shown once.",
    }),
    o("tokenId", "Token ID"),
  ],
  secretExportTemplates: [
    {
      id: "agent-env",
      displayName: "Agent environment",
      entries: [{ envKey: "TFC_AGENT_TOKEN", outputKey: "token" }],
    },
  ],
  expiryFields: [
    {
      fieldKey: "createdAt",
      from: "created",
      kind: "api-token",
      label: "Agent token is old",
      maxAgeDays: 365,
    },
  ],
  orphanRule: {
    conditions: [{ fieldKey: "lastUsedAt", when: "empty" }],
    reason: "This agent token has never been used.",
  },
  supportsCreate: true,
  supportsDelete: true,
  iconKey: "key",
  pinnable: false,
});

export const PolicySetResourceType = rt({
  name: "Policy Set",
  id: "policy-set",
  description:
    "A Sentinel or OPA policy set: where its policies come from, whether it is global or overridable, and how many workspaces and projects it covers. Create one (optionally from a VCS repository), edit, delete, or attach it to a workspace or project.",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("global", "Global", editBool("Enforce on every workspace.")),
    f("overridable", "Overridable", editBool("Let users override failed mandatory policies.")),
    f("agentEnabled", "Evaluate on Agents", editBool("Sentinel only.")),
    f("policyToolVersion", "Policy Tool Version", { required: false }),
    f("policiesPath", "Policies Path", { required: false }),
    f("kind", "Framework", ro),
    f("policyCount", "Policies", num),
    f("workspaceCount", "Workspaces", num),
    f("projectCount", "Projects", num),
    f("vcsRepo", "VCS Repository", ro),
    f("versioned", "Versioned", bool),
    f("updatedAt", "Updated", ro),
    f("organization", "Organization", ro),
    f("policySetId", "Policy Set ID", ro),
  ],
  outputs: [o("policySetId", "Policy set ID")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "shield",
});

export const TeamResourceType = rt({
  name: "Team",
  id: "team",
  description:
    "A team and its organization-level permissions. Create, edit (name, visibility, permissions) or delete it.",
  fields: [
    f("name", "Name"),
    f("visibility", "Visibility", {
      kind: "enum",
      enumValues: ["secret", "organization"],
      required: false,
    }),
    f("usersCount", "Members", num),
    f("ssoTeamId", "SSO Team ID", { required: false }),
    f("allowMemberTokenManagement", "Members Manage Team Tokens", editBool()),
    f("manageWorkspaces", "Manage All Workspaces", editBool()),
    f("manageProjects", "Manage All Projects", editBool()),
    f("readWorkspaces", "Read All Workspaces", editBool()),
    f("readProjects", "Read All Projects", editBool()),
    f("managePolicies", "Manage Policies", editBool()),
    f("managePolicyOverrides", "Override Policies", editBool()),
    f("manageRunTasks", "Manage Run Tasks", editBool()),
    f("manageVcsSettings", "Manage VCS Settings", editBool()),
    f("manageAgentPools", "Manage Agent Pools", editBool()),
    f("manageModules", "Manage Private Modules", editBool()),
    f("manageProviders", "Manage Private Providers", editBool()),
    f("manageTeams", "Manage Teams", editBool()),
    f("manageMembership", "Manage Membership", editBool()),
    f("manageOrganizationAccess", "Manage Organization Access", editBool()),
    f("organization", "Organization", ro),
    f("teamId", "Team ID", ro),
  ],
  outputs: [o("teamId", "Team ID"), o("name", "Team name")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "users",
});

export const RunTaskResourceType = rt({
  name: "Run Task",
  id: "run-task",
  description:
    "A run task: an external service HCP Terraform calls during runs. Create, edit (URL, description, HMAC key, enabled) or delete it.",
  fields: [
    f("name", "Name"),
    f("url", "Endpoint URL"),
    f("description", "Description", { required: false }),
    f("enabled", "Enabled", editBool()),
    f("hmacKey", "HMAC Key", {
      kind: "password",
      required: false,
      description: "Write-only. Leave empty to keep the current key.",
    }),
    f("category", "Category", ro),
    f("workspaceCount", "Workspaces", num),
    f("organization", "Organization", ro),
    f("taskId", "Task ID", ro),
  ],
  outputs: [o("taskId", "Task ID")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "plug",
});

export const RegistryModuleResourceType = rt({
  name: "Registry Module",
  id: "registry-module",
  description:
    "A module in the organization's private registry (or a public module added to it): its versions, VCS source, no-code status and tests. Delete it from the registry.",
  fields: [
    f("name", "Name", ro),
    f("namespace", "Namespace", ro),
    f("provider", "Provider", ro),
    f("registryName", "Registry", ro),
    f("status", "Status", ro),
    f("latestVersion", "Latest Version", ro),
    f("versionCount", "Versions", num),
    f("noCode", "No-Code Ready", bool),
    f("testsEnabled", "Tests Enabled", bool),
    f("vcsRepo", "VCS Repository", ro),
    f("source", "Source", ro),
    f("updatedAt", "Updated", ro),
    f("organization", "Organization", ro),
    f("moduleId", "Module ID", ro),
  ],
  outputs: [o("moduleId", "Module ID")],
  supportsDelete: true,
  iconKey: "package",
});

export const RegistryProviderResourceType = rt({
  name: "Registry Provider",
  id: "registry-provider",
  description: "A provider in the organization's private registry. Delete it from the registry.",
  fields: [
    f("name", "Name", ro),
    f("namespace", "Namespace", ro),
    f("registryName", "Registry", ro),
    f("updatedAt", "Updated", ro),
    f("organization", "Organization", ro),
    f("providerId", "Provider ID", ro),
  ],
  outputs: [o("providerId", "Provider ID")],
  supportsDelete: true,
  iconKey: "package",
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  OrganizationResourceType,
  ProjectResourceType,
  WorkspaceResourceType,
  RunResourceType,
  VariableResourceType,
  StateOutputResourceType,
  VariableSetResourceType,
  VarsetVariableResourceType,
  AgentPoolResourceType,
  AgentResourceType,
  AgentTokenResourceType,
  PolicySetResourceType,
  TeamResourceType,
  RunTaskResourceType,
  RegistryModuleResourceType,
  RegistryProviderResourceType,
];
