import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * Pulumi Cloud resource types, scoped to the organization picked in the
 * credentials. Field names follow the REST API's OpenAPI spec (2026-10).
 */

const ro = { required: false, editable: false } as const;
const num = { kind: "number", required: false, editable: false } as const;
const bool = { kind: "boolean", required: false, editable: false } as const;

export const OrganizationResourceType = rt({
  name: "Organization",
  id: "organization",
  accountRoot: true,
  description:
    "The Pulumi Cloud organization: members, projects, stacks, ESC environments, resources under management and the last 30 days of resource-hours, deployment minutes and ESC secret-hours, plus the most common resource types across every stack. Charts resources under management and daily usage.",
  fields: [
    f("name", "Name", ro),
    f("role", "Your Role", ro),
    f("memberCount", "Members", num),
    f("projectCount", "Projects", num),
    f("stackCount", "Stacks", num),
    f("environmentCount", "ESC Environments", num),
    f("resourcesUnderManagement", "Resources Under Management", num),
    f("resourceHours30d", "Resource-Hours (30 days)", num),
    f("deploymentMinutes30d", "Deployment Minutes (30 days)", num),
    f("secretHours30d", "ESC Secret-Hours (30 days)", num),
  ],
  outputs: [o("name", "Organization name"), o("url", "Pulumi Cloud URL")],
  supportsDelete: false,
  supportsMetrics: true,
  iconKey: "account",
});

export const ProjectResourceType = rt({
  name: "Project",
  id: "project",
  description: "A Pulumi project: its stacks, total resources and last update.",
  fields: [
    f("name", "Name", ro),
    f("stackCount", "Stacks", num),
    f("resourceCount", "Resources", num),
    f("lastUpdate", "Last Update", ro),
    f("organization", "Organization", ro),
  ],
  outputs: [o("name", "Project name"), o("url", "Pulumi Cloud URL")],
  supportsDelete: false,
  iconKey: "folder",
});

export const StackResourceType = rt({
  name: "Stack",
  id: "stack",
  parentTypeId: "project",
  showInSidebar: true,
  description:
    "A stack: resources, last update, what is running now, drift, update history, deployment settings (edit them in the Settings tab) and deployment schedules. Run a Pulumi Deployment (update, preview, refresh, destroy, drift detection or remediation), schedule one, rename or delete the stack. Its outputs are separate resources other resources can reference. Charts updates and resource changes.",
  fields: [
    f("name", "Name", ro),
    f("project", "Project", ro),
    f("fullyQualifiedName", "Full Name", ro),
    f("resourceCount", "Resources", num),
    f("lastUpdate", "Last Update", ro),
    f("version", "Version", num),
    f("currentOperation", "Running Now", ro),
    f("operationAuthor", "Started By", ro),
    f("description", "Description", ro),
    f("runtime", "Runtime", ro),
    f("repository", "Repository", ro),
    f("tags", "Tags", ro),
    f("secretsProvider", "Secrets Provider", ro),
    f("environment", "ESC Environment", ro),
    f("driftDetected", "Drift Detected", bool),
    f("outputCount", "Outputs", num),
    f("organization", "Organization", ro),
    f("stackId", "Stack ID", ro),
  ],
  outputs: [
    o("name", "Stack name"),
    o("fullyQualifiedName", "org/project/stack"),
    o("url", "Pulumi Cloud URL"),
  ],
  orphanRule: {
    conditions: [{ fieldKey: "resourceCount", when: "equals", value: "0" }],
    reason: "Stack manages no resources.",
  },
  supportsCreate: true,
  supportsDelete: true,
  supportsMetrics: true,
  iconKey: "stack",
});

export const StackOutputResourceType = rt({
  name: "Stack Output",
  id: "stack-output",
  parentTypeId: "stack",
  showInSidebar: true,
  description:
    "An output of a stack's latest update. Its value is an output other resources can reference, so a DNS record or an exported secret follows what Pulumi last deployed. Secret outputs are decrypted on demand when the stack uses Pulumi Cloud's own secrets provider.",
  fields: [
    f("name", "Name", ro),
    f("type", "Type", ro),
    f("secret", "Secret", bool),
    f("preview", "Value", ro),
    f("project", "Project", ro),
    f("stack", "Stack", ro),
  ],
  outputs: [
    o("value", "Value", { sensitive: true, description: "JSON for lists and objects." }),
    o("name", "Name"),
  ],
  supportsDelete: false,
  iconKey: "output",
  pinnable: false,
});

export const DeploymentResourceType = rt({
  name: "Deployment",
  id: "deployment",
  parentTypeId: "stack",
  showInSidebar: true,
  description:
    "A Pulumi Deployments run: operation, status, who started it, its steps and the update it produced, with the full log in the Logs tab. Cancel a running deployment. The 50 most recent in the organization are listed; create one to run a stack.",
  fields: [
    f("status", "Status", ro),
    f("operation", "Operation", ro),
    f("version", "Number", num),
    f("project", "Project", ro),
    f("stack", "Stack", ro),
    f("initiator", "Initiator", ro),
    f("requestedBy", "Requested By", ro),
    f("updateResult", "Update Result", ro),
    f("updateVersion", "Stack Version", num),
    f("steps", "Steps", ro),
    f("durationSecs", "Duration (seconds)", num),
    f("paused", "Paused", bool),
    f("created", "Created", ro),
    f("deploymentId", "Deployment ID", ro),
  ],
  outputs: [o("deploymentId", "Deployment ID"), o("url", "Pulumi Cloud URL")],
  supportsCreate: true,
  supportsDelete: false,
  iconKey: "play",
  pinnable: false,
});

export const EnvironmentResourceType = rt({
  name: "ESC Environment",
  id: "environment",
  description:
    "A Pulumi ESC environment: its definition (edit the YAML in the Definition tab), revisions and revision tags, and which stacks and environments use it. Create, delete, tag a revision or roll back to one. Its opened values are an output other resources can reference.",
  fields: [
    f("name", "Name", ro),
    f("project", "Project", ro),
    f("owner", "Owner", ro),
    f("stackReferrers", "Stacks Using It", num),
    f("environmentReferrers", "Environments Importing It", num),
    f("deletionProtected", "Deletion Protected", bool),
    f("tags", "Tags", ro),
    f("modified", "Modified", ro),
    f("organization", "Organization", ro),
    f("environmentId", "Environment ID", ro),
  ],
  outputs: [
    o("values", "Opened values", {
      sensitive: true,
      description:
        "The environment's resolved values as JSON, secrets decrypted. Opening is audited in Pulumi Cloud.",
    }),
    o("environmentVariables", "Environment variables", {
      sensitive: true,
      description: "The environmentVariables section, one KEY=value per line.",
    }),
    o("name", "project/environment"),
  ],
  supportsCreate: true,
  supportsDelete: true,
  iconKey: "key",
});

export const AccessTokenResourceType = rt({
  name: "Organization Token",
  id: "access-token",
  description:
    "An organization access token: name, description, whether it is an admin token, when it was last used and when it expires. Create one (its value is kept as an output) or revoke it.",
  fields: [
    f("name", "Name", ro),
    f("description", "Description", ro),
    f("type", "Type", ro),
    f("admin", "Admin", bool),
    f("createdBy", "Created By", ro),
    f("created", "Created", ro),
    f("lastUsed", "Last Used", ro),
    f("expires", "Expires", ro),
    f("organization", "Organization", ro),
    f("tokenId", "Token ID", ro),
  ],
  outputs: [
    o("token", "Token", {
      sensitive: true,
      description:
        "PULUMI_ACCESS_TOKEN. Only available for tokens created from Infrawrench: Pulumi shows it once.",
    }),
    o("tokenId", "Token ID"),
  ],
  secretExportTemplates: [
    {
      id: "pulumi-env",
      displayName: "Pulumi CLI",
      entries: [{ envKey: "PULUMI_ACCESS_TOKEN", outputKey: "token" }],
    },
  ],
  expiryFields: [
    { fieldKey: "expires", from: "expiry", kind: "api-token", label: "Pulumi token expires" },
  ],
  postureChecks: [
    {
      id: "pulumi-admin-token-never-expires",
      title: "Admin token never expires",
      severity: "medium",
      category: "credential-age",
      conditions: [
        { fieldKey: "admin", when: "truthy" },
        { fieldKey: "expires", when: "empty" },
      ],
      reason:
        "An organization admin token without an expiry stays valid until someone revokes it. Give it an expiry.",
    },
  ],
  orphanRule: {
    conditions: [{ fieldKey: "lastUsed", when: "empty" }],
    reason: "This token has never been used.",
  },
  supportsCreate: true,
  supportsDelete: true,
  iconKey: "key",
  pinnable: false,
});

export const TeamResourceType = rt({
  name: "Team",
  id: "team",
  description:
    "A team: members, and the stacks and environments it can reach. Create a Pulumi team, edit its display name and description, or delete it.",
  fields: [
    f("name", "Name", { editable: false }),
    f("displayName", "Display Name"),
    f("description", "Description", { required: false }),
    f("kind", "Kind", ro),
    f("memberCount", "Members", num),
    f("stackCount", "Stacks", num),
    f("environmentCount", "Environments", num),
    f("organization", "Organization", ro),
  ],
  outputs: [o("name", "Team name")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "users",
});

export const WebhookResourceType = rt({
  name: "Webhook",
  id: "webhook",
  description:
    "An organization webhook: where it posts, in which format (raw JSON, Slack or Microsoft Teams), and which events. Create, edit, enable, disable, send a test ping, or delete it.",
  fields: [
    f("name", "Name", { editable: false }),
    f("displayName", "Display Name"),
    f("payloadUrl", "Payload URL"),
    f("active", "Active", { kind: "boolean", required: false }),
    f("format", "Format", {
      kind: "enum",
      enumValues: ["raw", "slack", "ms_teams"],
      required: false,
    }),
    f("groups", "Event Groups", {
      required: false,
      description:
        "Comma-separated, e.g. stacks, deployments, environments. Empty sends every event.",
    }),
    f("filters", "Event Filters", { required: false, description: "Comma-separated event types." }),
    f("secret", "Signing Secret", {
      kind: "password",
      required: false,
      description: "Write-only. Leave empty to keep the current secret.",
    }),
    f("hasSecret", "Signed", bool),
    f("organization", "Organization", ro),
  ],
  outputs: [o("name", "Webhook name")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "webhook",
  pinnable: false,
});

export const PolicyPackResourceType = rt({
  name: "Policy Pack",
  id: "policy-pack",
  description:
    "A CrossGuard policy pack published to the organization, with its versions. Delete it.",
  fields: [
    f("name", "Name", ro),
    f("displayName", "Display Name", ro),
    f("latestVersion", "Latest Version", num),
    f("versionCount", "Versions", num),
    f("versionTags", "Version Tags", ro),
    f("organization", "Organization", ro),
  ],
  outputs: [o("name", "Policy pack name")],
  supportsDelete: true,
  iconKey: "shield",
});

export const PolicyGroupResourceType = rt({
  name: "Policy Group",
  id: "policy-group",
  description:
    "A policy group: the stacks it governs, its enabled policy packs and its mode. Create, rename or delete it, and add or remove stacks.",
  fields: [
    f("name", "Name"),
    f("mode", "Mode", ro),
    f("entityType", "Applies To", ro),
    f("isOrgDefault", "Organization Default", bool),
    f("stackCount", "Stacks", num),
    f("accountCount", "Insights Accounts", num),
    f("policyPackCount", "Policy Packs", num),
    f("organization", "Organization", ro),
  ],
  outputs: [o("name", "Policy group name")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "shield",
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  OrganizationResourceType,
  ProjectResourceType,
  StackResourceType,
  StackOutputResourceType,
  DeploymentResourceType,
  EnvironmentResourceType,
  AccessTokenResourceType,
  TeamResourceType,
  WebhookResourceType,
  PolicyPackResourceType,
  PolicyGroupResourceType,
];
