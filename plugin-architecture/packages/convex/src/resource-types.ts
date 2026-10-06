import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { f, o, rt } from "@infrawrench/plugin-base";

export const DEPLOYMENT_TYPES = ["prod", "dev", "preview", "custom"];
export const DEPLOYMENT_CLASSES = ["s16", "s256", "d1024", "d2048"];
export const REGIONS = ["aws-us-east-1", "aws-eu-west-1", "aws-ca-central-1", "aws-ap-southeast-2"];
export const USAGE_METRICS: Array<[string, string]> = [
  ["functionCalls", "Function calls"],
  ["databaseIoGb", "Database I/O (GB)"],
  ["dataEgressGb", "Data egress (GB)"],
  ["searchQueryGb", "Search queries (Query-GB)"],
  ["queryMutationComputeGbHours", "Query & mutation compute (GB-hours)"],
  ["actionComputeConvexGbHours", "Action compute, Convex runtime (GB-hours)"],
  ["actionComputeNodeJsGbHours", "Action compute, Node.js (GB-hours)"],
  ["actionComputeCpuGbHours", "Action compute, CPU (GB-hours)"],
  ["aiGatewayCostDollars", "AI Gateway spend (USD)"],
];
export const DEPLOY_KEY_ACTIONS = [
  "deployment:deploy",
  "deployment:env:view",
  "deployment:env:write",
  "deployment:pause",
  "deployment:unpause",
  "deployment:logs:view",
  "deployment:metrics:view",
  "deployment:integrations:view",
  "deployment:integrations:write",
  "deployment:data:view",
  "deployment:data:write",
  "deployment:backups:view",
  "deployment:backups:create",
  "deployment:backups:download",
  "deployment:backups:delete",
  "deployment:backups:import",
  "deployment:functions:actAsUser",
  "deployment:functions:runInternalQueries",
  "deployment:functions:runInternalMutations",
  "deployment:functions:runInternalActions",
  "deployment:functions:runTestQuery",
  "deployment:auditLog:view",
  "deployment:usageLimits:view",
  "deployment:usageLimits:write",
  "deployment:usage:view",
  "deployment:aiGateway:use",
];

const ro = { required: false, editable: false } as const;

export const TeamType = rt({
  name: "Team",
  id: "convex-team",
  description: "The Convex team the access token belongs to: members, invitations and roles",
  fields: [
    f("teamId", "Team ID", { kind: "number", editable: false }),
    f("slug", "Slug", ro),
    f("memberCount", "Members", { kind: "number", ...ro }),
    f("adminCount", "Admins", { kind: "number", ...ro }),
    f("pendingInvites", "Pending Invitations", { kind: "number", ...ro }),
    f("projectCount", "Projects", { kind: "number", ...ro }),
  ],
  outputs: [o("teamId", "Team ID"), o("slug", "Team Slug")],
  iconKey: "convex",
});

export const ProjectType = rt({
  name: "Project",
  id: "convex-project",
  description: "A Convex project: one app with its production, development and preview deployments",
  fields: [
    f("name", "Name"),
    f("slug", "Slug", { description: "Used in dashboard URLs and preview deploy keys." }),
    f("projectId", "Project ID", { kind: "number", editable: false }),
    f("teamSlug", "Team", ro),
    f("prodDeploymentName", "Production Deployment", ro),
    f("createdAt", "Created At", ro),
  ],
  outputs: [o("projectId", "Project ID"), o("slug", "Project Slug")],
  dependsOn: [
    {
      fieldKey: "prodDeploymentName",
      targetTypeId: "convex-deployment",
      targetKey: "name",
      label: "production deployment",
    },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "convex",
});

export const DeploymentType = rt({
  name: "Deployment",
  id: "convex-deployment",
  description:
    "A Convex deployment: a backend with its own database, functions, files and environment",
  fields: [
    f("name", "Name", { editable: false }),
    f("projectId", "Project", { kind: "number", editable: false }),
    f("projectSlug", "Project Slug", ro),
    f("deploymentType", "Type", {
      kind: "enum",
      enumValues: DEPLOYMENT_TYPES,
      required: false,
      description: "Changing the type moves the deployment between prod, dev, preview and custom.",
    }),
    f("region", "Region", ro),
    f("class", "Class", {
      kind: "enum",
      enumValues: DEPLOYMENT_CLASSES,
      required: false,
      description: "Deployment class (capacity tier). Needs class selection on the team's plan.",
    }),
    f("reference", "Reference", {
      required: false,
      description: "Identifier unique within the project, e.g. staging.",
    }),
    f("isDefault", "Default Deployment", {
      kind: "boolean",
      required: false,
      description: "For prod: whether this is the project's default production deployment.",
    }),
    f("dashboardEditConfirmation", "Confirm Dashboard Edits", { kind: "boolean", required: false }),
    f("sendLogsToClient", "Send Function Logs to Clients", { kind: "boolean", required: false }),
    f("expiresAt", "Expires At", {
      required: false,
      description: "ISO timestamp when Convex deletes the deployment. Empty means never.",
    }),
    f("deploymentUrl", "Deployment URL", ro),
    f("siteUrl", "HTTP Actions URL", ro),
    f("previewIdentifier", "Preview Identifier", ro),
    f("lastDeployAt", "Last Deploy", ro),
    f("createdAt", "Created At", ro),
  ],
  outputs: [
    o("deploymentUrl", "Deployment URL", { description: "CONVEX_URL for clients." }),
    o("siteUrl", "HTTP Actions URL", {
      description: "The .convex.site URL HTTP actions are served from.",
    }),
    o("deploymentName", "Deployment Name"),
  ],
  dependsOn: [{ fieldKey: "projectId", targetTypeId: "convex-project", label: "in project" }],
  expiryFields: [
    { fieldKey: "expiresAt", from: "expiry", kind: "other", label: "Deployment is deleted" },
  ],
  lifecycle: { startActionId: "unpause", stopActionId: "pause" },
  secretExportTemplates: [
    {
      id: "convex-client",
      displayName: "Convex client",
      description: "CONVEX_URL and CONVEX_SITE_URL for an app",
      entries: [
        { envKey: "CONVEX_URL", outputKey: "deploymentUrl" },
        { envKey: "CONVEX_SITE_URL", outputKey: "siteUrl" },
      ],
    },
  ],
  parentTypeId: "convex-project",
  showInSidebar: true,
  supportsCreate: true,
  supportsUpdate: true,
  supportsMetrics: true,
  iconKey: "convex",
});

export const EnvVarType = rt({
  name: "Environment Variable",
  pinnable: false,
  id: "convex-env-var",
  description:
    "An environment variable of one deployment, readable by its functions as process.env",
  fields: [
    f("name", "Name", { editable: false }),
    f("deploymentName", "Deployment", { editable: false }),
    f("value", "Value", {
      kind: "password",
      required: false,
      description: "Leave blank to keep the current value.",
    }),
  ],
  outputs: [o("value", "Value", { sensitive: true })],
  dependsOn: [
    {
      fieldKey: "deploymentName",
      targetTypeId: "convex-deployment",
      targetKey: "name",
      label: "in deployment",
    },
  ],
  parentTypeId: "convex-deployment",
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "convex",
});

export const DefaultEnvVarType = rt({
  name: "Default Environment Variable",
  pinnable: false,
  id: "convex-default-env-var",
  description:
    "A project-level default copied into every new deployment of the chosen types (dev, preview…)",
  fields: [
    f("name", "Name", { editable: false }),
    f("projectId", "Project", { kind: "number", editable: false }),
    f("deploymentType", "Applies To", {
      kind: "enum",
      enumValues: DEPLOYMENT_TYPES,
      editable: false,
    }),
    f("value", "Value", {
      kind: "password",
      required: false,
      description: "Leave blank to keep it.",
    }),
  ],
  outputs: [o("value", "Value", { sensitive: true })],
  dependsOn: [{ fieldKey: "projectId", targetTypeId: "convex-project", label: "in project" }],
  parentTypeId: "convex-project",
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "convex",
});

export const DeployKeyType = rt({
  name: "Deploy Key",
  pinnable: false,
  id: "convex-deploy-key",
  description:
    "A deploy key for one deployment, used by the Convex CLI and CI. The key is shown once.",
  fields: [
    f("name", "Name"),
    f("deploymentName", "Deployment"),
    f("allowedActions", "Allowed Actions", { required: false }),
    f("managed", "Managed By Integration", { kind: "boolean", required: false }),
    f("createdAt", "Created At", { required: false }),
    f("lastUsedAt", "Last Used At", { required: false }),
    f("expiresAt", "Expires At", { required: false }),
  ],
  outputs: [o("deployKey", "Deploy Key", { sensitive: true })],
  dependsOn: [
    {
      fieldKey: "deploymentName",
      targetTypeId: "convex-deployment",
      targetKey: "name",
      label: "for deployment",
    },
  ],
  expiryFields: [
    { fieldKey: "expiresAt", from: "expiry", kind: "api-token", label: "Deploy key expires" },
  ],
  principalRole: { role: "key", lastUsedKey: "lastUsedAt", createdKey: "createdAt" },
  parentTypeId: "convex-deployment",
  supportsCreate: true,
  iconKey: "convex",
});

export const PreviewDeployKeyType = rt({
  name: "Preview Deploy Key",
  pinnable: false,
  id: "convex-preview-deploy-key",
  description: "A key that lets CI create and manage preview deployments in one project",
  fields: [
    f("name", "Name"),
    f("projectId", "Project", { kind: "number" }),
    f("managed", "Managed By Integration", { kind: "boolean", required: false }),
    f("createdAt", "Created At", { required: false }),
    f("lastUsedAt", "Last Used At", { required: false }),
    f("expiresAt", "Expires At", { required: false }),
  ],
  outputs: [o("previewDeployKey", "Preview Deploy Key", { sensitive: true })],
  dependsOn: [{ fieldKey: "projectId", targetTypeId: "convex-project", label: "for project" }],
  expiryFields: [
    {
      fieldKey: "expiresAt",
      from: "expiry",
      kind: "api-token",
      label: "Preview deploy key expires",
    },
  ],
  principalRole: { role: "key", lastUsedKey: "lastUsedAt", createdKey: "createdAt" },
  parentTypeId: "convex-project",
  supportsCreate: true,
  iconKey: "convex",
});

export const CustomDomainType = rt({
  name: "Custom Domain",
  id: "convex-custom-domain",
  description:
    "A custom domain serving a deployment's API (convex.cloud) or HTTP actions (convex.site)",
  fields: [
    f("domain", "Domain"),
    f("deploymentName", "Deployment"),
    f("requestDestination", "Serves", { kind: "enum", enumValues: ["convexCloud", "convexSite"] }),
    f("verified", "Verified", { kind: "boolean", required: false }),
    f("verifiedAt", "Verified At", { required: false }),
    f("createdAt", "Created At", { required: false }),
  ],
  outputs: [o("url", "URL")],
  dependsOn: [
    {
      fieldKey: "deploymentName",
      targetTypeId: "convex-deployment",
      targetKey: "name",
      label: "for deployment",
    },
  ],
  parentTypeId: "convex-deployment",
  supportsCreate: true,
  iconKey: "convex",
});

export const LogStreamType = rt({
  name: "Log Stream",
  id: "convex-log-stream",
  description:
    "A deployment log stream (Datadog, Axiom, Sentry, PostHog, a webhook) or an S3 table export",
  fields: [
    f("streamType", "Destination", { editable: false }),
    f("deploymentName", "Deployment", { editable: false }),
    f("status", "Status", ro),
    f("failureReason", "Failure", ro),
    f("target", "Target", {
      ...ro,
      description: "URL, dataset, site or bucket the stream writes to.",
    }),
    f("url", "Webhook URL", { required: false, description: "Webhook streams only." }),
    f("format", "Webhook Format", {
      kind: "enum",
      enumValues: ["json", "jsonl"],
      required: false,
      description: "Webhook streams only.",
    }),
    f("service", "Datadog Service", { required: false, description: "Datadog streams only." }),
    f("datasetName", "Axiom Dataset", { required: false, description: "Axiom streams only." }),
    f("topics", "Topics", {
      ...ro,
      description: "Empty means every topic, including future ones.",
    }),
  ],
  outputs: [o("hmacSecret", "Webhook Signing Secret", { sensitive: true })],
  dependsOn: [
    {
      fieldKey: "deploymentName",
      targetTypeId: "convex-deployment",
      targetKey: "name",
      label: "streams from",
    },
  ],
  parentTypeId: "convex-deployment",
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "convex",
});

export const UsageLimitType = rt({
  name: "Usage Limit",
  id: "convex-usage-limit",
  description: "A per-deployment usage limit that warns or disables the deployment when crossed",
  fields: [
    f("metric", "Metric", { kind: "enum", enumValues: USAGE_METRICS.map(([id]) => id) }),
    f("deploymentName", "Deployment", { editable: false }),
    f("window", "Window", { kind: "enum", enumValues: ["day", "month"] }),
    f("limitType", "When Crossed", {
      kind: "enum",
      enumValues: ["warning", "disable"],
      description: "warning sends a notification; disable pauses the deployment.",
    }),
    f("limit", "Limit", { kind: "number" }),
    f("enabled", "Enabled", { kind: "boolean" }),
    f("currentUsage", "Current Usage", { kind: "number", ...ro }),
  ],
  outputs: [],
  dependsOn: [
    {
      fieldKey: "deploymentName",
      targetTypeId: "convex-deployment",
      targetKey: "name",
      label: "limits",
    },
  ],
  parentTypeId: "convex-deployment",
  pinnable: false,
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "convex",
});

export const MemberType = rt({
  name: "Team Member",
  id: "convex-member",
  description: "A member of the team and their role",
  fields: [
    f("email", "Email", { editable: false }),
    f("name", "Name", ro),
    f("role", "Role", {
      kind: "enum",
      enumValues: ["admin", "developer"],
      description: "Built-in role. Custom roles are assigned in the Convex dashboard.",
    }),
    f("customRoles", "Custom Roles", ro),
  ],
  outputs: [],
  principalRole: { role: "user", adminIndicatorKey: "role", adminValues: ["admin"] },
  parentTypeId: "convex-team",
  pinnable: false,
  supportsUpdate: true,
  supportsDelete: false,
  iconKey: "convex",
});

export const InviteType = rt({
  name: "Invitation",
  id: "convex-invite",
  description: "A pending invitation to join the team",
  fields: [
    f("email", "Email"),
    f("role", "Role", { kind: "enum", enumValues: ["admin", "developer", "custom"] }),
    f("expired", "Expired", { kind: "boolean", required: false }),
  ],
  outputs: [],
  parentTypeId: "convex-team",
  pinnable: false,
  supportsCreate: true,
  iconKey: "convex",
});

export const CustomRoleType = rt({
  name: "Custom Role",
  id: "convex-custom-role",
  description: "A team custom role: allow/deny statements over actions and resource paths",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("statementCount", "Statements", { kind: "number", ...ro }),
    f("statements", "Statements (JSON)", { ...ro }),
    f("createdAt", "Created At", ro),
  ],
  outputs: [],
  parentTypeId: "convex-team",
  pinnable: false,
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "convex",
});

export const AccessTokenType = rt({
  name: "Team Access Token",
  id: "convex-access-token",
  description: "A team access token created by the member who owns this account's token",
  fields: [
    f("name", "Name"),
    f("createdAt", "Created At", { required: false }),
    f("lastUsedAt", "Last Used At", { required: false }),
    f("expiresAt", "Expires At", { required: false }),
  ],
  outputs: [],
  expiryFields: [
    { fieldKey: "expiresAt", from: "expiry", kind: "api-token", label: "Access token expires" },
    {
      fieldKey: "createdAt",
      from: "created",
      kind: "api-token",
      label: "Access token due for rotation",
    },
  ],
  principalRole: { role: "key", lastUsedKey: "lastUsedAt", createdKey: "createdAt" },
  parentTypeId: "convex-team",
  pinnable: false,
  iconKey: "convex",
});

export const resourceTypes: ResourceTypeDefinition[] = [
  TeamType,
  ProjectType,
  DeploymentType,
  EnvVarType,
  DefaultEnvVarType,
  DeployKeyType,
  PreviewDeployKeyType,
  CustomDomainType,
  LogStreamType,
  UsageLimitType,
  MemberType,
  InviteType,
  CustomRoleType,
  AccessTokenType,
];
