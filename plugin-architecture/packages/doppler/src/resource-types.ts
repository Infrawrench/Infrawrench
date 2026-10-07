import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { f, o, rt } from "@infrawrench/plugin-base";

/** Doppler resource types, all inside the workplace the token belongs to. */
const ro = { required: false, editable: false } as const;

export const WorkplaceResourceType = rt({
  name: "Workplace",
  id: "doppler-workplace",
  accountRoot: true,
  description:
    "The Doppler workplace the token belongs to: its name and billing and security contacts (editable). The Logs tab shows the workplace activity log.",
  fields: [
    f("name", "Name", { required: false }),
    f("billingEmail", "Billing Email", { required: false }),
    f("securityEmail", "Security Email", { required: false }),
    f("workplaceId", "Workplace ID", ro),
  ],
  outputs: [o("workplaceId", "Workplace ID")],
  supportsUpdate: true,
  supportsDelete: false,
  iconKey: "building",
});

export const ProjectResourceType = rt({
  name: "Project",
  id: "doppler-project",
  description:
    "A Doppler project: its environments, configs and webhooks. Create, rename, describe or delete it.",
  fields: [
    f("name", "Name", { required: true }),
    f("description", "Description", { required: false }),
    f("slug", "Slug", ro),
    f("projectId", "Project ID", ro),
    f("environments", "Environments", { ...ro, kind: "number" }),
    f("configs", "Configs", { ...ro, kind: "number" }),
    f("createdAt", "Created", ro),
  ],
  outputs: [o("project", "Project slug")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "folder",
});

export const EnvironmentResourceType = rt({
  name: "Environment",
  id: "doppler-environment",
  parentTypeId: "doppler-project",
  pinnable: false,
  description:
    "An environment in a project (development, staging, production…). Create one, rename it or change its slug, or delete it with its configs.",
  fields: [
    f("project", "Project", ro),
    f("name", "Name", { required: true }),
    f("slug", "Slug", {
      required: true,
      description: "Changing the slug changes the root config's name.",
    }),
    f("personalConfigs", "Personal Configs", { ...ro, kind: "boolean" }),
    f("initialFetchAt", "First Fetched", ro),
    f("createdAt", "Created", ro),
  ],
  outputs: [o("slug", "Environment slug")],
  dependsOn: [{ fieldKey: "project", targetTypeId: "doppler-project", label: "in" }],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "layers",
});

export const ConfigResourceType = rt({
  name: "Config",
  id: "doppler-config",
  parentTypeId: "doppler-project",
  showInSidebar: true,
  description:
    "A config: an environment's root config or a branch of it. The Keys tab reads and edits its secrets. Create a branch config, rename it, clone it, lock or unlock it, make it inheritable, read its change log, or delete it.",
  fields: [
    f("project", "Project", ro),
    f("name", "Name", {
      required: true,
      description: "Branch configs are named <environment>_<branch>.",
    }),
    f("environment", "Environment", ro),
    f("root", "Root Config", { ...ro, kind: "boolean" }),
    f("locked", "Locked", { ...ro, kind: "boolean" }),
    f("inheritable", "Inheritable", {
      kind: "boolean",
      required: false,
      description: "Other configs may inherit this config's secrets.",
    }),
    f("inherits", "Inherits From", ro),
    f("inheritedBy", "Inherited By", ro),
    f("secrets", "Secrets", { ...ro, kind: "number" }),
    f("initialFetchAt", "First Fetched", ro),
    f("lastFetchAt", "Last Fetched", ro),
    f("neverFetched", "Never Fetched", { ...ro, kind: "boolean" }),
    f("createdAt", "Created", ro),
  ],
  outputs: [o("project", "Project"), o("config", "Config name")],
  dependsOn: [
    { fieldKey: "project", targetTypeId: "doppler-project", label: "in" },
    {
      fieldKey: "environment",
      targetTypeId: "doppler-environment",
      matchTemplate: "{project}.{environment}",
      label: "of",
    },
    { fieldKey: "inherits", targetTypeId: "doppler-config", label: "inherits" },
  ],
  orphanRule: {
    conditions: [
      { fieldKey: "root", when: "equals", value: "false" },
      { fieldKey: "neverFetched", when: "equals", value: "true" },
    ],
    reason: "Branch config has never been fetched by any application",
  },
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "settings",
});

export const SecretResourceType = rt({
  name: "Secret",
  id: "doppler-secret",
  parentTypeId: "doppler-config",
  pinnable: false,
  description:
    "A secret in a config. Values never sync into Infrawrench: set a new value, change its visibility (masked, unmasked or restricted) or note, or delete it. Its value is an output other resources can reference.",
  fields: [
    f("project", "Project", ro),
    f("config", "Config", ro),
    f("name", "Name", ro),
    f("newValue", "New Value", {
      kind: "password",
      required: false,
      description:
        "Leave blank to keep the current value. ${OTHER_SECRET} references are expanded by Doppler.",
    }),
    f("visibility", "Visibility", {
      kind: "enum",
      enumValues: ["masked", "unmasked", "restricted"],
      required: false,
      description: "Restricted values can't be read back in the dashboard or the API.",
    }),
    f("note", "Note", { required: false }),
    f("referencesOthers", "References Other Secrets", { ...ro, kind: "boolean" }),
    f("empty", "Empty", { ...ro, kind: "boolean" }),
  ],
  outputs: [
    o("value", "Secret value", {
      sensitive: true,
      description: "The computed value, with references expanded.",
    }),
  ],
  dependsOn: [
    {
      fieldKey: "config",
      targetTypeId: "doppler-config",
      matchTemplate: "{project}.{config}",
      label: "in",
    },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "key",
});

export const ServiceTokenResourceType = rt({
  name: "Service Token",
  id: "doppler-service-token",
  parentTypeId: "doppler-config",
  pinnable: false,
  description:
    "A service token scoped to one config, read-only or read/write, used by applications and CI to fetch secrets. Create one (the token is shown once) or revoke it.",
  fields: [
    f("project", "Project", ro),
    f("config", "Config", ro),
    f("name", "Name", ro),
    f("access", "Access", ro),
    f("environment", "Environment", ro),
    f("createdAt", "Created", ro),
    f("expiresAt", "Expires", ro),
    f("neverExpires", "Never Expires", { ...ro, kind: "boolean" }),
  ],
  outputs: [
    o("token", "Service token", {
      sensitive: true,
      description: "Only available for tokens created from Infrawrench.",
    }),
  ],
  dependsOn: [
    {
      fieldKey: "config",
      targetTypeId: "doppler-config",
      matchTemplate: "{project}.{config}",
      label: "reads",
    },
  ],
  expiryFields: [
    {
      fieldKey: "expiresAt",
      from: "expiry",
      kind: "api-token",
      label: "Doppler service token expires",
    },
  ],
  principalRole: { role: "key", createdKey: "createdAt" },
  supportsCreate: true,
  supportsDelete: true,
  iconKey: "key",
  secretExportTemplates: [
    {
      id: "doppler-token",
      displayName: "DOPPLER_TOKEN",
      entries: [{ envKey: "DOPPLER_TOKEN", outputKey: "token" }],
    },
  ],
});

export const IntegrationResourceType = rt({
  name: "Integration",
  id: "doppler-integration",
  description:
    "A connection to an external service that Doppler syncs secrets to or rotates secrets in (AWS, GCP, Azure, GitHub, Vercel, Kubernetes…), with its syncs. Delete it.",
  fields: [
    f("name", "Name", ro),
    f("type", "Type", ro),
    f("kind", "Kind", ro),
    f("enabled", "Enabled", { ...ro, kind: "boolean" }),
    f("syncs", "Syncs", { ...ro, kind: "number" }),
  ],
  outputs: [],
  supportsDelete: true,
  iconKey: "plug",
});

export const SyncResourceType = rt({
  name: "Secrets Sync",
  id: "doppler-sync",
  parentTypeId: "doppler-integration",
  showInSidebar: true,
  pinnable: false,
  description:
    "A secrets sync pushing one config to an integration, with when it last synced. Delete it (optionally removing the synced secrets from the target).",
  fields: [
    f("project", "Project", ro),
    f("config", "Config", ro),
    f("integrationName", "Integration", ro),
    f("integrationType", "Integration Type", ro),
    f("enabled", "Enabled", { ...ro, kind: "boolean" }),
    f("lastSyncedAt", "Last Synced", ro),
  ],
  outputs: [],
  dependsOn: [
    {
      fieldKey: "config",
      targetTypeId: "doppler-config",
      matchTemplate: "{project}.{config}",
      label: "syncs",
    },
  ],
  supportsDelete: true,
  iconKey: "refresh",
});

export const WebhookResourceType = rt({
  name: "Webhook",
  id: "doppler-webhook",
  parentTypeId: "doppler-project",
  pinnable: false,
  description:
    "A project webhook Doppler calls when secrets change in the configs it is enabled for. Create, edit (name, URL, configs), enable, disable or delete.",
  fields: [
    f("project", "Project", ro),
    f("name", "Name", { required: false }),
    f("url", "URL", { required: true, description: "Must be https." }),
    f("enabledConfigs", "Configs", {
      required: false,
      description: "Comma-separated config names it fires for.",
    }),
    f("enabled", "Enabled", { ...ro, kind: "boolean" }),
    f("hasSecret", "Signed", { ...ro, kind: "boolean" }),
    f("authentication", "Authentication", ro),
  ],
  outputs: [],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "webhook",
});

export const UserResourceType = rt({
  name: "User",
  id: "doppler-user",
  description:
    "A member of the workplace and their workplace role. Change the role from the list of the workplace's roles.",
  fields: [
    f("email", "Email", ro),
    f("name", "Name", ro),
    f("username", "Username", ro),
    f("access", "Workplace Role", ro),
    f("createdAt", "Joined", ro),
  ],
  outputs: [o("email", "Email")],
  principalRole: { role: "user", adminIndicatorKey: "access", adminValues: ["owner", "admin"] },
  supportsDelete: false,
  iconKey: "user",
});

export const GroupResourceType = rt({
  name: "Group",
  id: "doppler-group",
  description:
    "A workplace group: its members, the projects it reaches and its default project role. Create, rename, change the default role or members, or delete it.",
  fields: [
    f("name", "Name", { required: true }),
    f("defaultProjectRole", "Default Project Role", {
      required: false,
      description: "admin, collaborator, viewer, no_access or a custom role's identifier.",
    }),
    f("members", "Members", { required: false, description: "Comma-separated member emails." }),
    f("memberCount", "Member Count", { ...ro, kind: "number" }),
    f("projects", "Projects", ro),
    f("createdAt", "Created", ro),
  ],
  outputs: [],
  principalRole: { role: "group" },
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "users",
});

export const ServiceAccountResourceType = rt({
  name: "Service Account",
  id: "doppler-service-account",
  description:
    "A workplace service account (a machine identity with its own role) and its API tokens. Delete it.",
  fields: [
    f("name", "Name", ro),
    f("workplaceRole", "Workplace Role", ro),
    f("createdAt", "Created", ro),
  ],
  outputs: [],
  principalRole: {
    role: "service-account",
    adminIndicatorKey: "workplaceRole",
    adminValues: ["owner", "admin"],
  },
  supportsDelete: true,
  iconKey: "bot",
});

export const ServiceAccountTokenResourceType = rt({
  name: "Service Account Token",
  id: "doppler-service-account-token",
  parentTypeId: "doppler-service-account",
  pinnable: false,
  description:
    "An API token of a service account: when it was last used and when it expires. Revoke it.",
  fields: [
    f("serviceAccountName", "Service Account", ro),
    f("name", "Name", ro),
    f("createdAt", "Created", ro),
    f("lastUsedAt", "Last Used", ro),
    f("expiresAt", "Expires", ro),
    f("neverExpires", "Never Expires", { ...ro, kind: "boolean" }),
  ],
  outputs: [],
  expiryFields: [
    {
      fieldKey: "expiresAt",
      from: "expiry",
      kind: "api-token",
      label: "Doppler service account token expires",
    },
  ],
  principalRole: { role: "key", parentKey: "serviceAccountName" },
  supportsDelete: true,
  iconKey: "key",
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  WorkplaceResourceType,
  ProjectResourceType,
  EnvironmentResourceType,
  ConfigResourceType,
  SecretResourceType,
  ServiceTokenResourceType,
  IntegrationResourceType,
  SyncResourceType,
  WebhookResourceType,
  UserResourceType,
  GroupResourceType,
  ServiceAccountResourceType,
  ServiceAccountTokenResourceType,
];
