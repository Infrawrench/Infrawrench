import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { f, o, rt } from "@infrawrench/plugin-base";

/** Heroku regions (devcenter.heroku.com/articles/regions, 2026-10). */
export const REGIONS = [
  { id: "us", label: "United States", location: "Common Runtime", flag: "\u{1F1FA}\u{1F1F8}" },
  { id: "eu", label: "Europe", location: "Common Runtime", flag: "\u{1F1EA}\u{1F1FA}" },
  { id: "virginia", label: "Virginia", location: "Private Spaces", flag: "\u{1F1FA}\u{1F1F8}" },
  { id: "oregon", label: "Oregon", location: "Private Spaces", flag: "\u{1F1FA}\u{1F1F8}" },
  { id: "montreal", label: "Montreal", location: "Private Spaces", flag: "\u{1F1E8}\u{1F1E6}" },
  { id: "dublin", label: "Dublin", location: "Private Spaces", flag: "\u{1F1EE}\u{1F1EA}" },
  { id: "frankfurt", label: "Frankfurt", location: "Private Spaces", flag: "\u{1F1E9}\u{1F1EA}" },
  { id: "london", label: "London", location: "Private Spaces", flag: "\u{1F1EC}\u{1F1E7}" },
  { id: "mumbai", label: "Mumbai", location: "Private Spaces", flag: "\u{1F1EE}\u{1F1F3}" },
  { id: "singapore", label: "Singapore", location: "Private Spaces", flag: "\u{1F1F8}\u{1F1EC}" },
  { id: "sydney", label: "Sydney", location: "Private Spaces", flag: "\u{1F1E6}\u{1F1FA}" },
  { id: "tokyo", label: "Tokyo", location: "Private Spaces", flag: "\u{1F1EF}\u{1F1F5}" },
];

const ro = { required: false, editable: false } as const;
const inApp = { fieldKey: "appId", targetTypeId: "app", label: "in app" };

export const TeamResourceType = rt({
  name: "Team",
  id: "team",
  description: "A Heroku team (or enterprise team) the API key belongs to",
  fields: [
    f("name", "Name"),
    f("role", "Your Role", ro),
    f("type", "Type", ro),
    f("default", "Default Team", { kind: "boolean", required: false }),
    f("enterpriseAccount", "Enterprise Account", ro),
  ],
  outputs: [o("teamId", "Team ID")],
  supportsUpdate: true,
  iconKey: "team",
});

export const AppResourceType = rt({
  name: "App",
  id: "app",
  description: "A Heroku app: code, config, dynos and add-ons deployed together",
  fields: [
    f("name", "Name", { description: "Also the <name>.herokuapp.com hostname, renamed with it." }),
    f("region", "Region", ro),
    f("stack", "Stack", ro),
    f("buildStack", "Next Build Stack", {
      required: false,
      description: "Stack the next build uses (heroku-24, heroku-22, …).",
    }),
    f("generation", "Generation", ro),
    f("maintenance", "Maintenance Mode", {
      kind: "boolean",
      required: false,
      description: "Serve a maintenance page instead of the app.",
    }),
    f("acm", "Automated Certificates", {
      kind: "boolean",
      required: false,
      description: "Let Heroku issue and renew TLS certificates for custom domains.",
    }),
    f("team", "Team", ro),
    f("teamId", "Team ID", ro),
    f("owner", "Owner", ro),
    f("space", "Private Space", ro),
    f("spaceId", "Space ID", ro),
    f("internalRouting", "Internal Routing", { kind: "boolean", ...ro }),
    f("webUrl", "URL", ro),
    f("gitUrl", "Git URL", ro),
    f("buildpack", "Buildpack", ro),
    f("slugSizeMb", "Slug Size (MB)", { kind: "number", ...ro }),
    f("repoSizeMb", "Repo Size (MB)", { kind: "number", ...ro }),
    f("releasedAt", "Last Release", ro),
    f("createdAt", "Created", ro),
  ],
  outputs: [
    o("appName", "App Name"),
    o("appId", "App ID"),
    o("webUrl", "URL"),
    o("hostname", "Hostname"),
  ],
  dependsOn: [
    { fieldKey: "teamId", targetTypeId: "team", label: "owned by" },
    { fieldKey: "spaceId", targetTypeId: "space", label: "in space" },
  ],
  dnsServiceHosts: [
    {
      id: "herokuapp",
      label: "Heroku app hostname",
      hostPattern: String.raw`([a-z][a-z0-9-]*?)(?:-[0-9a-f]{12})?\.herokuapp\.com`,
      reason:
        "A deleted app's name is free for anyone to take, and a CNAME still pointing at its herokuapp.com hostname would then serve their app.",
    },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "app",
  secretExportTemplates: [
    {
      id: "app-url",
      displayName: "App URL",
      description: "The app's web URL",
      entries: [{ envKey: "APP_URL", outputKey: "webUrl" }],
    },
  ],
});

export const FormationResourceType = rt({
  name: "Process Type",
  id: "formation",
  description: "A process type in an app's formation (web, worker, …) with its dyno size and count",
  parentTypeId: "app",
  fields: [
    f("type", "Process Type", { editable: false }),
    f("quantity", "Dynos", {
      kind: "number",
      description: "How many dynos to run. 0 stops the process type.",
    }),
    f("size", "Dyno Size", {
      required: false,
      description: "Eco, Basic, Standard-1X, Standard-2X, Performance-M, Performance-L, …",
    }),
    f("command", "Command", ro),
    f("running", "Running", { kind: "boolean", ...ro }),
    f("appId", "App", ro),
    f("appName", "App Name", ro),
    f("updatedAt", "Updated", ro),
  ],
  dependsOn: [inApp],
  supportsUpdate: true,
  iconKey: "server",
  lifecycle: {
    startActionId: "start",
    stopActionId: "stop",
    statusFieldKey: "running",
    runningValues: ["true"],
    stoppedValues: ["false"],
  },
});

export const DynoResourceType = rt({
  name: "Dyno",
  pinnable: false,
  id: "dyno",
  description: "A running Heroku dyno",
  parentTypeId: "app",
  fields: [
    f("name", "Name"),
    f("state", "State", {
      kind: "enum",
      enumValues: ["crashed", "down", "idle", "starting", "up"],
      required: false,
    }),
    f("type", "Process Type", { required: false }),
    f("size", "Size", { required: false }),
    f("command", "Command", { required: false }),
    f("releaseVersion", "Release", { kind: "number", required: false }),
    f("appId", "App", { required: false }),
    f("appName", "App Name", { required: false }),
    f("createdAt", "Started", { required: false }),
  ],
  dependsOn: [inApp],
  iconKey: "server",
});

export const ReleaseResourceType = rt({
  name: "Release",
  pinnable: false,
  id: "release",
  description: "A Heroku release: a build plus config at a version",
  parentTypeId: "app",
  fields: [
    f("version", "Version", { kind: "number" }),
    f("status", "Status", {
      kind: "enum",
      enumValues: ["failed", "pending", "succeeded", "expired"],
      required: false,
    }),
    f("description", "Description", { required: false }),
    f("current", "Current", { kind: "boolean", required: false }),
    f("eligibleForRollback", "Can Roll Back", { kind: "boolean", required: false }),
    f("user", "By", { required: false }),
    f("addonPlans", "Add-on Plans", { required: false }),
    f("appId", "App", { required: false }),
    f("appName", "App Name", { required: false }),
    f("createdAt", "Created", { required: false }),
  ],
  outputs: [o("releaseId", "Release ID")],
  dependsOn: [inApp],
  iconKey: "deployment",
});

export const ConfigVarResourceType = rt({
  name: "Config Var",
  pinnable: false,
  id: "config-var",
  description: "An app config var, exposed to its dynos as an environment variable",
  parentTypeId: "app",
  fields: [
    f("key", "Key", { editable: false }),
    f("value", "Value", {
      kind: "password",
      required: false,
      description:
        "New value. Leave blank to keep the current one. Saving restarts the app's dynos.",
    }),
    f("fromAddon", "Set by Add-on", ro),
    f("appId", "App", ro),
    f("appName", "App Name", ro),
  ],
  outputs: [o("key", "Key"), o("value", "Value", { sensitive: true })],
  dependsOn: [inApp],
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "secret",
});

export const AddonResourceType = rt({
  name: "Add-on",
  id: "add-on",
  description:
    "A Heroku add-on (Postgres, Key-Value Store, Kafka, partner services) attached to an app",
  fields: [
    f("name", "Name"),
    f("service", "Service", ro),
    f("plan", "Plan", ro),
    f("state", "State", {
      kind: "enum",
      enumValues: ["provisioning", "provisioned", "deprovisioned"],
      ...ro,
    }),
    f("priceMonthly", "Price (USD / month)", { kind: "number", ...ro }),
    f("contract", "Contract Pricing", { kind: "boolean", ...ro }),
    f("billedTo", "Billed To", ro),
    f("configVars", "Config Vars", ro),
    f("appId", "App", ro),
    f("appName", "App Name", ro),
    f("webUrl", "Dashboard", ro),
    f("createdAt", "Created", ro),
  ],
  outputs: [o("addonId", "Add-on ID"), o("configVarNames", "Config Var Names")],
  dependsOn: [{ fieldKey: "appId", targetTypeId: "app", label: "attached to" }],
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "database",
  orphanRule: {
    conditions: [{ fieldKey: "appId", when: "empty" }],
    reason: "Not attached to any app, but still billed every month.",
  },
});

export const DomainResourceType = rt({
  name: "Domain",
  id: "domain",
  description: "A hostname routed to a Heroku app",
  parentTypeId: "app",
  fields: [
    f("hostname", "Hostname", { editable: false }),
    f("kind", "Kind", { kind: "enum", enumValues: ["heroku", "custom"], ...ro }),
    f("cname", "DNS Target", {
      ...ro,
      description: "Point a CNAME (or ALIAS for an apex) for the hostname at this.",
    }),
    f("status", "Status", ro),
    f("acmStatus", "Certificate", ro),
    f("acmStatusReason", "Certificate Detail", ro),
    f("sniEndpointId", "SNI Endpoint", {
      required: false,
      description:
        "Uploaded certificate serving this hostname. Blank uses Automated Certificate Management.",
    }),
    f("appId", "App", ro),
    f("appName", "App Name", ro),
    f("createdAt", "Created", ro),
  ],
  outputs: [o("hostname", "Hostname"), o("cname", "DNS Target")],
  dependsOn: [
    inApp,
    {
      fieldKey: "sniEndpointId",
      targetTypeId: "sni-endpoint",
      matchTemplate: "{appId}/{sniEndpointId}",
      label: "served by",
    },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "globe",
});

export const SniEndpointResourceType = rt({
  name: "SSL Certificate",
  id: "sni-endpoint",
  description: "An uploaded TLS certificate (SNI endpoint) on a Heroku app",
  parentTypeId: "app",
  fields: [
    f("name", "Name", { editable: false }),
    f("subject", "Subject", ro),
    f("issuer", "Issuer", ro),
    f("certDomains", "Covers", ro),
    f("domains", "Serving Domains", ro),
    f("expiresAt", "Expires", ro),
    f("startsAt", "Valid From", ro),
    f("selfSigned", "Self-Signed", { kind: "boolean", ...ro }),
    f("certificateChain", "Certificate Chain", {
      kind: "password",
      required: false,
      description: "PEM chain to replace the certificate with (with the private key below).",
    }),
    f("privateKey", "Private Key", {
      kind: "password",
      required: false,
      description: "PEM private key for the new chain.",
    }),
    f("appId", "App", ro),
    f("appName", "App Name", ro),
  ],
  dependsOn: [inApp],
  expiryFields: [
    { fieldKey: "expiresAt", from: "expiry", kind: "tls-cert", label: "Certificate expires" },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "lock",
});

export const LogDrainResourceType = rt({
  name: "Log Drain",
  id: "log-drain",
  description: "A syslog or HTTPS endpoint receiving an app's logs",
  parentTypeId: "app",
  fields: [
    f("url", "URL"),
    f("token", "Drain Token", { required: false }),
    f("addon", "Provided by Add-on", { required: false }),
    f("appId", "App", { required: false }),
    f("appName", "App Name", { required: false }),
    f("createdAt", "Created", { required: false }),
  ],
  dependsOn: [inApp],
  supportsCreate: true,
  iconKey: "log",
});

export const PipelineResourceType = rt({
  name: "Pipeline",
  id: "pipeline",
  description: "A Heroku pipeline promoting releases from review to staging to production",
  fields: [
    f("name", "Name"),
    f("ownerType", "Owner Type", ro),
    f("ownerId", "Owner", ro),
    f("appCount", "Apps", { kind: "number", ...ro }),
    f("reviewApps", "Automatic Review Apps", { kind: "boolean", ...ro }),
    f("generation", "Generation", ro),
    f("createdAt", "Created", ro),
  ],
  outputs: [o("pipelineId", "Pipeline ID")],
  dependsOn: [{ fieldKey: "ownerId", targetTypeId: "team", label: "owned by" }],
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "workflow",
});

export const CouplingResourceType = rt({
  name: "Pipeline App",
  id: "pipeline-coupling",
  description: "An app's place (stage) in a Heroku pipeline",
  parentTypeId: "pipeline",
  fields: [
    f("appName", "App", { editable: false }),
    f("stage", "Stage", {
      kind: "enum",
      enumValues: ["review", "development", "staging", "production"],
    }),
    f("appId", "App ID", ro),
    f("pipelineId", "Pipeline", ro),
    f("pipelineName", "Pipeline Name", ro),
    f("createdAt", "Added", ro),
  ],
  dependsOn: [
    { fieldKey: "appId", targetTypeId: "app", label: "app" },
    { fieldKey: "pipelineId", targetTypeId: "pipeline", label: "in pipeline" },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "link",
});

export const ReviewAppResourceType = rt({
  name: "Review App",
  pinnable: false,
  id: "review-app",
  description: "A temporary app built for a pull request in a Heroku pipeline",
  parentTypeId: "pipeline",
  fields: [
    f("branch", "Branch"),
    f("prNumber", "Pull Request", { kind: "number", required: false }),
    f("status", "Status", {
      kind: "enum",
      enumValues: ["pending", "creating", "created", "deleting", "deleted", "errored"],
      required: false,
    }),
    f("error", "Error", { required: false }),
    f("appId", "App", { required: false }),
    f("pipelineId", "Pipeline", { required: false }),
    f("createdAt", "Created", { required: false }),
  ],
  dependsOn: [
    { fieldKey: "appId", targetTypeId: "app", label: "app" },
    { fieldKey: "pipelineId", targetTypeId: "pipeline", label: "in pipeline" },
  ],
  iconKey: "branch",
});

export const SpaceResourceType = rt({
  name: "Private Space",
  id: "space",
  description: "A Heroku Private Space: an isolated network for a team's apps",
  fields: [
    f("name", "Name"),
    f("region", "Region", ro),
    f("team", "Team", ro),
    f("teamId", "Team ID", ro),
    f("shield", "Shield", { kind: "boolean", ...ro }),
    f("state", "State", {
      kind: "enum",
      enumValues: ["allocating", "allocated", "deleting"],
      ...ro,
    }),
    f("cidr", "CIDR", ro),
    f("dataCidr", "Data CIDR", ro),
    f("generation", "Generation", ro),
    f("createdAt", "Created", ro),
  ],
  outputs: [o("spaceId", "Space ID")],
  dependsOn: [{ fieldKey: "teamId", targetTypeId: "team", label: "owned by" }],
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "network",
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  TeamResourceType,
  AppResourceType,
  FormationResourceType,
  DynoResourceType,
  ReleaseResourceType,
  ConfigVarResourceType,
  AddonResourceType,
  DomainResourceType,
  SniEndpointResourceType,
  LogDrainResourceType,
  PipelineResourceType,
  CouplingResourceType,
  ReviewAppResourceType,
  SpaceResourceType,
];
