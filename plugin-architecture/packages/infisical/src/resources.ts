import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * Infisical resource types. Docs: https://infisical.com/docs/api-reference
 * (every path below was checked against the live OpenAPI document served at
 * https://app.infisical.com/api/docs/json, 2026-10).
 */

export const ProjectResourceType = rt({
  name: "Project",
  id: "project",
  description:
    "An Infisical project: a secrets manager, certificate manager or KMS workspace with its own environments, folders, secrets, syncs and access.",
  fields: [
    f("name", "Name"),
    f("slug", "Slug", { description: "URL-safe identifier, unique within the organization." }),
    f("description", "Description", { required: false }),
    f("type", "Product", {
      kind: "enum",
      editable: false,
      enumValues: [
        "secret-manager",
        "cert-manager",
        "kms",
        "secret-scanning",
        "pam",
        "agent-vault",
      ],
    }),
    f("projectId", "Project ID", { required: false, editable: false }),
    f("environments", "Environments", { required: false, editable: false }),
    f("hasDeleteProtection", "Delete Protection", { kind: "boolean", required: false }),
    f("autoCapitalization", "Auto-capitalize Secret Keys", { kind: "boolean", required: false }),
    f("secretSharing", "Secret Sharing", { kind: "boolean", required: false }),
    f("pitVersionLimit", "Point-in-time Version Limit", {
      kind: "number",
      required: false,
      description: "How many versions of each secret Infisical keeps for point-in-time recovery.",
    }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [
    o("projectId", "Project ID", {
      description: "The project id machine identities and the CLI use (`--projectId`).",
    }),
    o("slug", "Project Slug"),
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  supportsMetrics: true,
  iconKey: "folder",
});

export const EnvironmentResourceType = rt({
  name: "Environment",
  id: "environment",
  description:
    "A project environment (development, staging, production, ...). Secrets, folders and dynamic secrets live inside one.",
  parentTypeId: "project",
  fields: [
    f("name", "Name"),
    f("slug", "Slug", {
      description:
        "Used by the CLI and SDKs (`--env`). Renaming it breaks callers that use the old slug.",
    }),
    f("position", "Position", { kind: "number", required: false }),
    f("projectId", "Project ID", { required: false, editable: false }),
    f("projectName", "Project", { required: false, editable: false }),
  ],
  outputs: [o("environmentSlug", "Environment Slug"), o("environmentId", "Environment ID")],
  dependsOn: [{ fieldKey: "projectId", targetTypeId: "project", label: "belongs to" }],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "layers",
});

export const FolderResourceType = rt({
  name: "Folder",
  id: "folder",
  description:
    "A secrets folder inside an environment. Folders nest, and syncs and imports point at a folder path.",
  parentTypeId: "environment",
  fields: [
    f("name", "Name"),
    f("path", "Path", { required: false, editable: false }),
    f("description", "Description", { required: false }),
    f("environment", "Environment", { required: false, editable: false }),
    f("projectId", "Project ID", { required: false, editable: false }),
    f("lastSecretModified", "Last Secret Change", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [o("path", "Folder Path", { description: "Pass as `--path` to the Infisical CLI." })],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "folder",
});

export const SecretResourceType = rt({
  name: "Secret",
  id: "secret",
  description:
    "A shared secret in an environment and folder. Values are never synced into the inventory; they are fetched on demand as a sensitive output.",
  parentTypeId: "environment",
  fields: [
    f("key", "Key", { description: "The secret name. Changing it renames the secret." }),
    f("value", "Value", {
      kind: "password",
      required: false,
      description: "Write-only. Leave blank to keep the current value.",
    }),
    f("comment", "Comment", { required: false }),
    f("path", "Folder Path", { required: false, editable: false }),
    f("environment", "Environment", { required: false, editable: false }),
    f("projectId", "Project ID", { required: false, editable: false }),
    f("version", "Version", { kind: "number", required: false, editable: false }),
    f("tags", "Tags", { required: false, editable: false }),
    f("reminderRepeatDays", "Rotation Reminder (days)", {
      kind: "number",
      required: false,
      description: "Email a rotation reminder every N days. Leave empty for none.",
    }),
    f("reminderNote", "Reminder Note", { required: false }),
    f("isRotatedSecret", "Managed by Rotation", {
      kind: "boolean",
      required: false,
      editable: false,
    }),
    f("updatedAt", "Updated", { required: false, editable: false }),
  ],
  outputs: [
    o("value", "Value", { sensitive: true, description: "The secret's current value." }),
    o("key", "Key"),
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "key",
});

export const DynamicSecretResourceType = rt({
  name: "Dynamic Secret",
  id: "dynamic-secret",
  description:
    "A dynamic secret that mints short-lived credentials (database users, cloud IAM keys, ...) on demand as leases.",
  parentTypeId: "environment",
  fields: [
    f("name", "Name"),
    f("type", "Provider", { required: false, editable: false }),
    f("defaultTTL", "Default TTL", {
      required: false,
      description: "Lease lifetime when none is requested, e.g. 1h or 30m.",
    }),
    f("maxTTL", "Max TTL", { required: false, description: "Longest lease allowed, e.g. 24h." }),
    f("status", "Status", { required: false, editable: false }),
    f("statusDetails", "Status Details", { required: false, editable: false }),
    f("path", "Folder Path", { required: false, editable: false }),
    f("environment", "Environment", { required: false, editable: false }),
    f("projectId", "Project ID", { required: false, editable: false }),
    f("projectSlug", "Project Slug", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [],
  credentialFormats: [
    {
      id: "lease",
      label: "New lease (default TTL)",
      description: "Mint a fresh set of short-lived credentials from this dynamic secret.",
      mediaType: "json",
    },
  ],
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "key",
});

export const SecretSyncResourceType = rt({
  name: "Secret Sync",
  id: "secret-sync",
  description:
    "Pushes an environment folder's secrets to a destination (AWS, GCP, Azure, GitHub, Vercel, Kubernetes and dozens more) through an app connection.",
  parentTypeId: "project",
  showInSidebar: true,
  fields: [
    f("name", "Name", { description: "Slug-friendly name of the sync." }),
    f("description", "Description", { required: false }),
    f("destination", "Destination", { required: false, editable: false }),
    f("connectionName", "App Connection", { required: false, editable: false }),
    f("environment", "Source Environment", {
      required: false,
      description: "Environment slug the sync reads from.",
    }),
    f("secretPath", "Source Path", {
      required: false,
      description: "Folder path the sync reads from.",
    }),
    f("isAutoSyncEnabled", "Auto-sync", { kind: "boolean", required: false }),
    f("syncStatus", "Sync Status", { required: false, editable: false }),
    f("lastSyncMessage", "Last Sync Message", { required: false, editable: false }),
    f("lastSyncedAt", "Last Synced", { required: false, editable: false }),
    f("projectId", "Project ID", { required: false, editable: false }),
    f("destinationSummary", "Destination Details", { required: false, editable: false }),
    f("canImport", "Can Import", { kind: "boolean", required: false, editable: false }),
  ],
  outputs: [],
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "sync",
});

export const IntegrationResourceType = rt({
  name: "Native Integration",
  id: "integration",
  description:
    "A legacy native integration (the predecessor of secret syncs). Listed so existing ones can be watched, re-synced and removed.",
  parentTypeId: "project",
  fields: [
    f("integration", "Integration", { editable: false }),
    f("app", "Target", { required: false, editable: false }),
    f("environment", "Environment", { required: false, editable: false }),
    f("secretPath", "Source Path", { required: false, editable: false }),
    f("isActive", "Active", { kind: "boolean", required: false, editable: false }),
    f("isSynced", "Synced", { kind: "boolean", required: false, editable: false }),
    f("syncMessage", "Sync Message", { required: false, editable: false }),
    f("lastUsed", "Last Used", { required: false, editable: false }),
  ],
  outputs: [],
  supportsDelete: true,
  iconKey: "sync",
});

export const MachineIdentityResourceType = rt({
  name: "Machine Identity",
  id: "machine-identity",
  plural: "Machine Identities",
  description:
    "An organization machine identity: a non-human principal for CI, services and agents, with its own auth methods and project access.",
  fields: [
    f("name", "Name"),
    f("role", "Organization Role", {
      description: "admin, member, no-access, or a custom organization role slug.",
    }),
    f("identityId", "Identity ID", { required: false, editable: false }),
    f("authMethods", "Auth Methods", { required: false, editable: false }),
    f("lastLoginTime", "Last Login", { required: false, editable: false }),
    f("lastLoginAuthMethod", "Last Login Method", { required: false, editable: false }),
    f("hasDeleteProtection", "Delete Protection", { kind: "boolean", required: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [
    o("identityId", "Identity ID"),
    o("clientId", "Universal Auth Client ID", {
      description: "Present once Universal Auth is enabled on the identity.",
    }),
  ],
  credentialFormats: [
    {
      id: "universal-auth-client-secret",
      label: "Universal Auth client secret",
      description:
        "Mint a new client secret for this identity's Universal Auth. Enable Universal Auth on the identity first.",
      mediaType: "text",
    },
  ],
  principalRole: { role: "service-account", lastUsedKey: "lastLoginTime", createdKey: "createdAt" },
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "robot",
});

export const CertificateAuthorityResourceType = rt({
  name: "Certificate Authority",
  id: "certificate-authority",
  plural: "Certificate Authorities",
  description: "A private root or intermediate CA in an Infisical certificate management project.",
  parentTypeId: "project",
  showInSidebar: true,
  fields: [
    f("name", "Name", { editable: false }),
    f("friendlyName", "Friendly Name", { required: false, editable: false }),
    f("caType", "Type", { required: false, editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("commonName", "Common Name", { required: false, editable: false }),
    f("keyAlgorithm", "Key Algorithm", { required: false, editable: false }),
    f("serialNumber", "Serial Number", { required: false, editable: false }),
    f("notBefore", "Valid From", { required: false, editable: false }),
    f("notAfter", "Expires", { required: false, editable: false }),
    f("projectId", "Project ID", { required: false, editable: false }),
  ],
  outputs: [o("certificate", "CA Certificate (PEM)", { hidden: true }), o("caId", "CA ID")],
  expiryFields: [
    { fieldKey: "notAfter", from: "expiry", kind: "tls-cert", label: "CA certificate" },
  ],
  credentialFormats: [
    {
      id: "ca-certificate",
      label: "CA certificate and chain (PEM)",
      mediaType: "text",
      filenameTemplate: "{name}-ca.pem",
    },
  ],
  supportsDelete: true,
  iconKey: "certificate",
});

export const CertificateResourceType = rt({
  name: "Certificate",
  id: "certificate",
  description:
    "An X.509 certificate issued or imported in an Infisical certificate management project.",
  parentTypeId: "project",
  showInSidebar: true,
  fields: [
    f("commonName", "Common Name", { editable: false }),
    f("friendlyName", "Friendly Name", { required: false, editable: false }),
    f("altNames", "Subject Alternative Names", { required: false, editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("serialNumber", "Serial Number", { required: false, editable: false }),
    f("notBefore", "Valid From", { required: false, editable: false }),
    f("notAfter", "Expires", { required: false, editable: false }),
    f("revokedAt", "Revoked", { required: false, editable: false }),
    f("caId", "Issuing CA", { required: false, editable: false }),
    f("profileId", "Profile", { required: false, editable: false }),
    f("projectId", "Project ID", { required: false, editable: false }),
  ],
  outputs: [o("certificate", "Certificate (PEM)", { hidden: true })],
  dependsOn: [{ fieldKey: "caId", targetTypeId: "certificate-authority", label: "issued by" }],
  expiryFields: [{ fieldKey: "notAfter", from: "expiry", kind: "tls-cert", label: "Certificate" }],
  credentialFormats: [
    {
      id: "certificate",
      label: "Certificate and chain (PEM)",
      mediaType: "text",
      filenameTemplate: "{name}.pem",
    },
    {
      id: "bundle",
      label: "Certificate, chain and private key (PEM)",
      description: "Only available when Infisical generated and stored the private key.",
      mediaType: "text",
      filenameTemplate: "{name}-bundle.pem",
    },
  ],
  supportsCreate: true,
  supportsDelete: true,
  iconKey: "certificate",
});

export const RESOURCE_TYPES = [
  ProjectResourceType,
  EnvironmentResourceType,
  FolderResourceType,
  SecretResourceType,
  DynamicSecretResourceType,
  SecretSyncResourceType,
  IntegrationResourceType,
  MachineIdentityResourceType,
  CertificateAuthorityResourceType,
  CertificateResourceType,
];
