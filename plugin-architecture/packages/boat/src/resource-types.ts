import { f, o, rt } from "@infrawrench/plugin-base";
import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

/**
 * externalIds are boat's own ids: `bx_…` for sandboxes, the user-chosen name
 * for saved snapshots (their only handle in the API), the environment's uuid,
 * `wh_…` for webhooks and the API key id. boat runs in one place (Europe:
 * Germany, Finland, France) and the API has no region, so nothing here has one.
 */

/** Every `state` the document lists. `archived` is what the CLI calls stopped. */
export const SANDBOX_STATES = [
  "init",
  "provisioning",
  "provisioned",
  "cloning",
  "ready",
  "idle",
  "running",
  "archiving",
  "archived",
  "error",
  "cancelled",
] as const;

/** States in which the machine is up and reachable over SSH. */
export const ONLINE_STATES: readonly string[] = ["ready", "idle", "running"];

export const SANDBOX_SIZES = ["small", "default", "large", "xlarge"] as const;

export const WEBHOOK_EVENTS = [
  "sandbox.ready",
  "sandbox.error",
  "sandbox.archived",
  "sandbox.hydrated",
  "sandbox.degraded",
  "sandbox.recovered",
] as const;

export const SandboxResourceType = rt({
  name: "Sandbox",
  plural: "Sandboxes",
  id: "sandbox",
  description: "A persistent boat Ubuntu VM for agents, automation or people",
  fields: [
    f("name", "Name", { description: "Up to 120 characters" }),
    f("state", "State", {
      showcase: true,
      kind: "enum",
      enumValues: [...SANDBOX_STATES],
      editable: false,
    }),
    f("online", "Online", { kind: "boolean", required: false, editable: false }),
    f("size", "Size", {
      showcase: true,
      kind: "enum",
      enumValues: [...SANDBOX_SIZES],
      editable: false,
      description: "Change it by stopping the sandbox and resuming it on another size",
    }),
    f("vcpus", "vCPUs", { kind: "number", required: false, editable: false }),
    f("memoryGb", "Memory (GB)", { kind: "number", required: false, editable: false }),
    f("billingMultiplier", "Billing Multiplier", {
      kind: "number",
      required: false,
      editable: false,
      description: "Price relative to a default sandbox",
    }),
    f("health", "Health", {
      kind: "enum",
      enumValues: ["ok", "degraded"],
      required: false,
      editable: false,
    }),
    f("healthReason", "Degraded Because", { required: false, editable: false }),
    f("error", "Error", { required: false, editable: false }),
    f("environment", "Environment", { required: false, editable: false }),
    f("environmentVersion", "Environment Version", { required: false, editable: false }),
    f("ttlSeconds", "Auto-stop After (seconds)", {
      kind: "number",
      required: false,
      description:
        "Stops the sandbox this long after the last activity, 1 to 2592000 (30 days). Empty disables auto-stop",
    }),
    f("autoStopAt", "Stops At", { required: false, editable: false }),
    f("autoStopDisabled", "Auto-stop Disabled", {
      kind: "boolean",
      required: false,
      editable: false,
    }),
    f("subdomain", "Subdomain", {
      required: false,
      description:
        "Hosted ports are served at https://<subdomain>-<port>.on.boat.dev. 3 to 40 lowercase letters, digits and dashes",
    }),
    f("labels", "Labels", { required: false, editable: false }),
    f("organization", "Organization", { required: false, editable: false }),
    f("access", "Your Access", {
      kind: "enum",
      enumValues: ["owner", "use", "view"],
      required: false,
      editable: false,
    }),
    f("visibility", "Visibility", {
      kind: "enum",
      enumValues: ["shared", "private"],
      required: false,
      editable: false,
    }),
    f("createdBy", "Created By", { required: false, editable: false }),
    f("snapshots", "Snapshots on Stop", { kind: "boolean", required: false, editable: false }),
    f("monitoring", "Monitoring", { kind: "boolean", required: false, editable: false }),
    f("lastSnapshotAt", "Last Snapshot", { required: false, editable: false }),
    f("setupStatus", "Setup Script", { required: false, editable: false }),
    f("setupError", "Setup Error", { required: false, editable: false }),
    f("monthCost", "Cost This Month ($)", {
      showcase: true,
      kind: "number",
      required: false,
      editable: false,
      description: "Machine time since the 1st (UTC) at list price, before plan-included hours",
    }),
    f("stoppedAt", "Stopped", { required: false, editable: false }),
    f("dataExpiredAt", "Data Deleted", {
      required: false,
      editable: false,
      description: "Set when data retention deleted the stopped sandbox's files",
    }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [
    o("ip", "Machine IP", { dnsValue: "ipv4" }),
    o("sshEndpoint", "SSH Endpoint", {
      description: "host:port to SSH to when boat routes SSH through a relay",
    }),
    o("sshCommand", "SSH Command"),
    o("url", "Machine URL"),
    o("hostedUrls", "Hosted Port URLs", {
      sensitive: true,
      description:
        "Ports hosted from Infrawrench, one URL per line. A private port's URL carries its access token",
    }),
    o("desktopUrl", "Desktop URL", {
      sensitive: true,
      hidden: true,
      description: "Opens the sandbox's desktop stream; the link carries its access token",
    }),
  ],
  showInSidebar: true,
  iconKey: "server",
  supportsCreate: true,
  // Edit = rename, auto-stop and subdomain, the fields boat's PATCH accepts.
  supportsUpdate: true,
  sshEndpoint: {
    hostOutputKey: "ip",
    runningWhen: { fieldKey: "online", value: "true" },
    defaultUsername: "user",
  },
  postureChecks: [
    {
      id: "boat-autostop-disabled",
      title: "Auto-stop disabled",
      severity: "low",
      category: "other",
      conditions: [{ fieldKey: "autoStopDisabled", when: "truthy" }],
      reason:
        "This sandbox never stops by itself, so it bills machine time until someone stops it. Set an auto-stop length unless it serves something long-running.",
    },
  ],
});

export const SavedSnapshotResourceType = rt({
  name: "Saved Snapshot",
  id: "saved-snapshot",
  description: "A named, frozen copy of a sandbox that new sandboxes can start from",
  fields: [
    f("name", "Name", { editable: false }),
    f("status", "Status", {
      showcase: true,
      kind: "enum",
      enumValues: ["saving", "ready", "failed"],
      editable: false,
    }),
    f("error", "Error", { required: false, editable: false }),
    f("sourceSandboxId", "Saved From", { required: false, editable: false }),
    f("size", "Size", { required: false, editable: false }),
    f("sizeGb", "Content (GB)", {
      showcase: true,
      kind: "number",
      required: false,
      editable: false,
    }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  dependsOn: [{ fieldKey: "sourceSandboxId", targetTypeId: "sandbox", label: "saved from" }],
  showInSidebar: true,
  iconKey: "snapshot",
  supportsCreate: true,
});

export const EnvironmentResourceType = rt({
  name: "Environment",
  id: "environment",
  description:
    "What a new sandbox carries: env vars, secret files, repositories and which of your logins pass in",
  fields: [
    f("name", "Name", { description: "Letters, numbers, dot, dash and underscore; up to 64" }),
    f("isDefault", "Default", {
      kind: "boolean",
      required: false,
      description: "Sandboxes created without an environment use the default one",
    }),
    f("latestVersion", "Version", {
      showcase: true,
      kind: "number",
      required: false,
      editable: false,
    }),
    f("safeForThirdParties", "Safe for Third Parties", {
      kind: "boolean",
      required: false,
      description: "When on, none of your own credentials enter sandboxes on this environment",
    }),
    f("passGithub", "Pass GitHub Login", { kind: "boolean", required: false }),
    f("passSecrets", "Pass Secrets", { kind: "boolean", required: false }),
    f("passSandboxCredentials", "Pass Sandbox Credentials", { kind: "boolean", required: false }),
    f("passAgentsCredentials", "Pass Agent Logins", { kind: "boolean", required: false }),
    f("proxyAiCredentials", "Proxy AI Credentials", {
      kind: "boolean",
      required: false,
      description: "Agents reach model providers through boat's AI proxy instead of holding keys",
    }),
    f("envVarNames", "Env Vars", {
      required: false,
      editable: false,
      description: "Names only; values are never synced",
    }),
    f("envVarCount", "Env Var Count", {
      showcase: true,
      kind: "number",
      required: false,
      editable: false,
    }),
    f("secretFiles", "Secret Files", { required: false, editable: false }),
    f("repositories", "Repositories", { required: false, editable: false }),
  ],
  showInSidebar: true,
  iconKey: "settings",
  supportsCreate: true,
  supportsUpdate: true,
});

export const WebhookResourceType = rt({
  name: "Webhook",
  id: "webhook",
  description: "An HTTPS endpoint boat posts sandbox lifecycle events to",
  fields: [
    f("name", "Name", { required: false }),
    f("url", "URL", { showcase: true, description: "Public HTTPS on port 443" }),
    f("events", "Events", { description: "Comma-separated sandbox events" }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("updatedAt", "Updated", { required: false, editable: false }),
  ],
  outputs: [
    o("signingSecret", "Signing Secret", {
      sensitive: true,
      description:
        "Only for webhooks created or rotated from Infrawrench: boat shows the whsec_ secret once.",
    }),
  ],
  iconKey: "webhook",
  supportsCreate: true,
  supportsUpdate: true,
});

export const ApiKeyResourceType = rt({
  name: "API Key",
  id: "api-key",
  description: "A boat API key on the account",
  fields: [
    f("name", "Name", { editable: false }),
    f("keyHint", "Key", { required: false, editable: false }),
    f("actions", "Allowed Actions", { required: false, editable: false }),
    f("admin", "Full Access", { kind: "boolean", required: false, editable: false }),
    f("sandboxScope", "Sandboxes", { required: false, editable: false }),
    f("expiresAt", "Expires", { showcase: true, required: false, editable: false }),
    f("neverExpires", "Never Expires", { kind: "boolean", required: false, editable: false }),
    f("expired", "Expired", { kind: "boolean", required: false, editable: false }),
    f("lastUsedAt", "Last Used", { showcase: true, required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  iconKey: "key",
  expiryFields: [
    { fieldKey: "expiresAt", from: "expiry", kind: "api-token", label: "API key expires" },
  ],
  postureChecks: [
    {
      id: "boat-admin-key-never-expires",
      title: "Full-access API key never expires",
      severity: "medium",
      category: "credential-age",
      conditions: [
        { fieldKey: "admin", when: "truthy" },
        { fieldKey: "neverExpires", when: "truthy" },
      ],
      reason:
        "This key can do anything on the account, including creating more keys, and stays valid until someone revokes it. Replace it with a scoped key that expires.",
    },
  ],
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  SandboxResourceType,
  SavedSnapshotResourceType,
  EnvironmentResourceType,
  WebhookResourceType,
  ApiKeyResourceType,
];
