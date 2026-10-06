import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { f, o, rt } from "@infrawrench/plugin-base";

/** Compute sizes a project or branch can run on (`desired_instance_size`). */
export const COMPUTE_SIZES = [
  "nano",
  "micro",
  "small",
  "medium",
  "large",
  "xlarge",
  "2xlarge",
  "4xlarge",
  "8xlarge",
  "12xlarge",
  "16xlarge",
  "24xlarge",
  "24xlarge_optimized_memory",
  "24xlarge_optimized_cpu",
  "24xlarge_high_memory",
  "48xlarge",
  "48xlarge_optimized_memory",
  "48xlarge_optimized_cpu",
  "48xlarge_high_memory",
];

export const OrganizationType = rt({
  name: "Organization",
  id: "supabase-organization",
  description: "A Supabase organization: the billing and membership boundary projects live in",
  fields: [
    f("name", "Name", { editable: false }),
    f("slug", "Slug", { editable: false }),
    f("plan", "Plan", { required: false, editable: false }),
    f("memberCount", "Members", { kind: "number", required: false, editable: false }),
    f("membersWithoutMfa", "Members without MFA", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("projectCount", "Projects", { kind: "number", required: false, editable: false }),
  ],
  outputs: [o("slug", "Organization Slug")],
  postureChecks: [
    {
      id: "supabase-org-members-without-mfa",
      title: "Organization members without MFA",
      severity: "medium",
      category: "other",
      conditions: [
        { fieldKey: "membersWithoutMfa", when: "notEquals", value: "0" },
        { fieldKey: "membersWithoutMfa", when: "truthy" },
      ],
      reason:
        "At least one member of this Supabase organization has not enrolled a second factor, so a stolen password is enough to reach every project in it.",
    },
  ],
  iconKey: "supabase",
});

export const ProjectType = rt({
  name: "Project",
  id: "supabase-project",
  description:
    "A Supabase project: a dedicated Postgres database plus Auth, Storage, Realtime, the Data API and Edge Functions",
  fields: [
    f("name", "Name", { description: "Display name of the project." }),
    f("ref", "Project Ref", { editable: false }),
    f("organizationSlug", "Organization", { editable: false }),
    f("region", "Region", { editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("dbHost", "Database Host", { required: false, editable: false }),
    f("postgresVersion", "Postgres Version", { required: false, editable: false }),
    f("postgresEngine", "Postgres Engine", { required: false, editable: false }),
    f("releaseChannel", "Release Channel", { required: false, editable: false }),
    f("apiUrl", "API URL", { required: false, editable: false }),
    f("computeSize", "Compute Size", {
      kind: "enum",
      enumValues: COMPUTE_SIZES,
      required: false,
      description:
        "Dedicated compute add-on. Changing it restarts the database for a few minutes and changes the bill.",
    }),
    f("diskSizeGb", "Disk Size (GB)", {
      kind: "number",
      required: false,
      description: "Provisioned disk. Disks can only grow, and only once every six hours.",
    }),
    f("diskType", "Disk Type", {
      kind: "enum",
      enumValues: ["gp3", "io2"],
      required: false,
    }),
    f("diskIops", "Disk IOPS", { kind: "number", required: false }),
    f("diskThroughputMbps", "Disk Throughput (MiB/s)", {
      kind: "number",
      required: false,
      description: "gp3 disks only.",
    }),
    f("pitrDays", "Point-in-Time Recovery", {
      kind: "enum",
      enumValues: ["0", "7", "14", "28"],
      required: false,
      description: "Days of point-in-time recovery (an add-on; 0 turns it off).",
    }),
    f("ipv4", "Dedicated IPv4 Address", {
      kind: "boolean",
      required: false,
      description: "IPv4 add-on for direct database connections from IPv4-only networks.",
    }),
    f("sslEnforced", "Enforce SSL", {
      kind: "boolean",
      required: false,
      description: "Reject database connections that do not use SSL.",
    }),
    f("allowedCidrs", "Allowed IPv4 CIDRs", {
      required: false,
      description:
        "Comma-separated IPv4 ranges allowed to reach the database. 0.0.0.0/0 allows everything.",
    }),
    f("allowedCidrsV6", "Allowed IPv6 CIDRs", {
      required: false,
      description:
        "Comma-separated IPv6 ranges allowed to reach the database. ::/0 allows everything.",
    }),
    f("networkOpen", "Open to All Addresses", {
      kind: "boolean",
      required: false,
      editable: false,
    }),
    f("poolMode", "Dedicated Pooler Mode", {
      kind: "enum",
      enumValues: ["transaction", "session"],
      required: false,
    }),
    f("poolSize", "Pooler Pool Size", {
      kind: "number",
      required: false,
      description: "Connections the pooler keeps open to Postgres (0-3000).",
    }),
    f("legacyApiKeysEnabled", "Legacy anon / service_role Keys", {
      kind: "boolean",
      required: false,
      description: "Whether the JWT-based anon and service_role keys still work.",
    }),
    f("pitrEnabled", "PITR Enabled", { kind: "boolean", required: false, editable: false }),
    f("automatedBackups", "Daily Backups", { kind: "boolean", required: false, editable: false }),
    f("readReplicaCount", "Read Replicas", { kind: "number", required: false, editable: false }),
    f("createdAt", "Created At", { required: false, editable: false }),
  ],
  outputs: [
    o("ref", "Project Ref"),
    o("apiUrl", "API URL"),
    o("dbHost", "Database Host"),
    o("connectionString", "Direct Connection String", { sensitive: true }),
    o("poolerConnectionString", "Pooler Connection String", {
      sensitive: true,
      description: "Supavisor transaction-mode pooler, reachable over IPv4.",
    }),
    o("sessionPoolerConnectionString", "Session Pooler Connection String", {
      sensitive: true,
      description: "Supavisor in session mode on port 5432, reachable over IPv4.",
    }),
    o("publishableKey", "Publishable Key", {
      description: "Safe to ship in browsers and apps (sb_publishable_…).",
    }),
    o("secretKey", "Secret Key", { sensitive: true }),
    o("anonKey", "Legacy anon Key"),
    o("serviceRoleKey", "Legacy service_role Key", { sensitive: true }),
  ],
  dependsOn: [
    {
      fieldKey: "organizationSlug",
      targetTypeId: "supabase-organization",
      label: "in organization",
    },
  ],
  postureChecks: [
    {
      id: "supabase-ssl-not-enforced",
      title: "Database accepts connections without SSL",
      severity: "high",
      category: "encryption",
      conditions: [{ fieldKey: "sslEnforced", when: "falsy" }],
      reason:
        "SSL enforcement is off, so a client can connect to this project's Postgres in plaintext and send credentials and data unencrypted.",
    },
    {
      id: "supabase-network-unrestricted",
      title: "Database reachable from any address",
      severity: "medium",
      category: "public-exposure",
      conditions: [{ fieldKey: "networkOpen", when: "truthy" }],
      reason:
        "No network restrictions are set, so the database port answers the whole internet and only the password stands between it and an attacker.",
    },
    {
      id: "supabase-legacy-keys-enabled",
      title: "Legacy JWT API keys still enabled",
      severity: "low",
      category: "credential-age",
      conditions: [{ fieldKey: "legacyApiKeysEnabled", when: "truthy" }],
      reason:
        "The anon and service_role JWT keys cannot be rotated without rotating the JWT secret. Move clients to publishable and secret keys and turn the legacy keys off.",
    },
  ],
  backupPolicy: {
    protectedBy: ["supabase-backup"],
    automatedBackupFieldKey: "automatedBackups",
  },
  lifecycle: {
    startActionId: "restore",
    stopActionId: "pause",
    statusFieldKey: "status",
    runningValues: ["ACTIVE_HEALTHY", "ACTIVE_UNHEALTHY"],
    stoppedValues: ["INACTIVE"],
  },
  peerIntegrations: [
    {
      pluginId: "postgres",
      credentialMappings: [
        { outputKey: "poolerConnectionString", credentialKey: "connectionString" },
      ],
      tabLabel: "PostgreSQL",
      credentialSetupAction: {
        label: "Reset database password",
        command: "reset-db-password",
        title: "Reset the database password",
        description:
          "Supabase never returns the postgres password after the project is created. Set a new one so Infrawrench can connect; anything else using the old password stops working.",
        submitLabel: "Reset password",
        fields: [
          {
            key: "password",
            label: "New password",
            kind: "password",
            required: false,
            description: "Leave blank to generate a strong random password.",
          },
        ],
      },
    },
  ],
  secretExportTemplates: [
    {
      id: "supabase-js",
      displayName: "supabase-js client",
      description: "URL and keys for a Supabase client",
      entries: [
        { envKey: "SUPABASE_URL", outputKey: "apiUrl" },
        { envKey: "SUPABASE_PUBLISHABLE_KEY", outputKey: "publishableKey" },
        { envKey: "SUPABASE_SECRET_KEY", outputKey: "secretKey" },
      ],
    },
    {
      id: "database-url",
      displayName: "Database URL",
      description: "DATABASE_URL through the pooler, plus the direct URL for migrations",
      entries: [
        { envKey: "DATABASE_URL", outputKey: "poolerConnectionString" },
        { envKey: "DIRECT_URL", outputKey: "connectionString" },
      ],
    },
  ],
  supportsRestQuery: true,
  supportsCreate: true,
  supportsUpdate: true,
  supportsMetrics: true,
  iconKey: "supabase",
});

export const BranchType = rt({
  name: "Branch",
  plural: "Branches",
  id: "supabase-branch",
  description:
    "A Supabase branch: a separate project that runs a copy of the parent's schema, for previews and staging",
  fields: [
    f("name", "Name"),
    f("branchRef", "Branch Project Ref", { editable: false }),
    f("parentRef", "Parent Project", { editable: false }),
    f("gitBranch", "Git Branch", { required: false }),
    f("persistent", "Persistent", {
      kind: "boolean",
      required: false,
      description: "Persistent branches are not deleted when their pull request closes.",
    }),
    f("isDefault", "Default (Production) Branch", {
      kind: "boolean",
      required: false,
      editable: false,
    }),
    f("withData", "Seeded With Data", { kind: "boolean", required: false, editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("projectStatus", "Project Status", { required: false, editable: false }),
    f("prNumber", "Pull Request", { kind: "number", required: false, editable: false }),
    f("notifyUrl", "Status Webhook URL", {
      required: false,
      description: "HTTP endpoint Supabase calls with branch status updates.",
    }),
    f("deletionScheduledAt", "Deletion Scheduled At", { required: false, editable: false }),
    f("createdAt", "Created At", { required: false, editable: false }),
    f("updatedAt", "Updated At", { required: false, editable: false }),
  ],
  outputs: [
    o("branchRef", "Branch Project Ref"),
    o("apiUrl", "API URL"),
    o("connectionString", "Connection String", { sensitive: true }),
  ],
  dependsOn: [{ fieldKey: "parentRef", targetTypeId: "supabase-project", label: "branch of" }],
  peerIntegrations: [
    {
      pluginId: "postgres",
      credentialMappings: [{ outputKey: "connectionString", credentialKey: "connectionString" }],
      tabLabel: "PostgreSQL",
    },
  ],
  secretExportTemplates: [
    {
      id: "connection-url",
      displayName: "Connection URL",
      description: "DATABASE_URL for this branch",
      entries: [{ envKey: "DATABASE_URL", outputKey: "connectionString" }],
    },
  ],
  parentTypeId: "supabase-project",
  showInSidebar: true,
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "supabase",
});

export const FunctionType = rt({
  name: "Edge Function",
  id: "supabase-function",
  description: "A Supabase Edge Function: a Deno function served at /functions/v1/{slug}",
  fields: [
    f("name", "Name"),
    f("slug", "Slug", { editable: false }),
    f("projectRef", "Project", { editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("version", "Version", { kind: "number", required: false, editable: false }),
    f("verifyJwt", "Verify JWT", {
      kind: "boolean",
      required: false,
      description: "Require a valid Supabase JWT in the Authorization header.",
    }),
    f("entrypointPath", "Entrypoint", { required: false, editable: false }),
    f("importMap", "Uses Import Map", { kind: "boolean", required: false, editable: false }),
    f("url", "URL", { required: false, editable: false }),
    f("createdAt", "Created At", { required: false, editable: false }),
    f("updatedAt", "Updated At", { required: false, editable: false }),
  ],
  outputs: [o("url", "Invocation URL"), o("slug", "Slug")],
  dependsOn: [{ fieldKey: "projectRef", targetTypeId: "supabase-project", label: "in project" }],
  parentTypeId: "supabase-project",
  showInSidebar: true,
  supportsCreate: true,
  supportsUpdate: true,
  supportsMetrics: true,
  iconKey: "supabase",
});

export const SecretType = rt({
  name: "Edge Function Secret",
  pinnable: false,
  id: "supabase-secret",
  description:
    "An environment secret available to every Edge Function in the project. The API only returns a digest of the value.",
  fields: [
    f("name", "Name", { editable: false }),
    f("projectRef", "Project", { editable: false }),
    f("value", "Value", {
      kind: "password",
      required: false,
      description: "Write-only. Leave blank to keep the current value.",
    }),
    f("digest", "Value Digest (SHA-256)", { required: false, editable: false }),
    f("updatedAt", "Updated At", { required: false, editable: false }),
  ],
  outputs: [],
  dependsOn: [{ fieldKey: "projectRef", targetTypeId: "supabase-project", label: "in project" }],
  parentTypeId: "supabase-project",
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "supabase",
});

export const ApiKeyType = rt({
  name: "API Key",
  pinnable: false,
  id: "supabase-api-key",
  description: "A project API key: publishable (client-side) or secret (server-side)",
  fields: [
    f("name", "Name", { editable: false }),
    f("projectRef", "Project", { editable: false }),
    f("type", "Type", {
      kind: "enum",
      enumValues: ["publishable", "secret", "legacy"],
      editable: false,
    }),
    f("description", "Description", { required: false }),
    f("prefix", "Prefix", { required: false, editable: false }),
    f("role", "Postgres Role", { required: false, editable: false }),
    f("createdAt", "Created At", { required: false, editable: false }),
    f("updatedAt", "Updated At", { required: false, editable: false }),
  ],
  outputs: [o("apiKey", "API Key", { sensitive: true })],
  dependsOn: [{ fieldKey: "projectRef", targetTypeId: "supabase-project", label: "in project" }],
  expiryFields: [
    { fieldKey: "createdAt", from: "created", kind: "api-token", label: "Key due for rotation" },
  ],
  principalRole: {
    role: "key",
    createdKey: "createdAt",
    adminIndicatorKey: "type",
    adminValues: ["secret"],
  },
  parentTypeId: "supabase-project",
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "supabase",
});

export const BucketType = rt({
  name: "Storage Bucket",
  id: "supabase-bucket",
  description: "A Supabase Storage bucket",
  fields: [
    f("name", "Name", { editable: false }),
    f("projectRef", "Project", { editable: false }),
    f("public", "Public", {
      kind: "boolean",
      required: false,
      description: "Public buckets serve every object without authentication.",
    }),
    f("fileSizeLimit", "File Size Limit (bytes)", {
      kind: "number",
      required: false,
      description: "Largest object the bucket accepts. Leave empty for the project default.",
    }),
    f("allowedMimeTypes", "Allowed MIME Types", {
      required: false,
      description: "Comma-separated, e.g. image/png, image/*. Empty allows everything.",
    }),
    f("owner", "Owner", { required: false, editable: false }),
    f("createdAt", "Created At", { required: false, editable: false }),
    f("updatedAt", "Updated At", { required: false, editable: false }),
  ],
  outputs: [o("bucketName", "Bucket Name"), o("publicUrl", "Public URL Prefix")],
  dependsOn: [{ fieldKey: "projectRef", targetTypeId: "supabase-project", label: "in project" }],
  postureChecks: [
    {
      id: "supabase-bucket-public",
      title: "Storage bucket is public",
      severity: "medium",
      category: "public-exposure",
      conditions: [{ fieldKey: "public", when: "truthy" }],
      reason:
        "Anyone who knows or guesses an object path can download it without a token. Make the bucket private unless it only holds assets meant for the public.",
    },
  ],
  parentTypeId: "supabase-project",
  showInSidebar: true,
  supportsStorageBrowser: true,
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "supabase",
});

export const BackupType = rt({
  name: "Backup",
  pinnable: false,
  id: "supabase-backup",
  description: "A daily physical or logical backup of a project's database",
  fields: [
    f("projectRef", "Project"),
    f("backupId", "Backup ID", { kind: "number" }),
    f("status", "Status", { required: false }),
    f("physical", "Physical Backup", { kind: "boolean", required: false }),
    f("createdAt", "Taken At", { required: false }),
  ],
  outputs: [],
  backupRole: { role: "snapshot", sourceKey: "projectRef", createdKey: "createdAt" },
  dependsOn: [{ fieldKey: "projectRef", targetTypeId: "supabase-project", label: "backup of" }],
  parentTypeId: "supabase-project",
  supportsDelete: false,
  iconKey: "supabase",
});

export const ReadReplicaType = rt({
  name: "Read Replica",
  id: "supabase-read-replica",
  description: "A read-only replica of a project's database in another region",
  fields: [
    f("identifier", "Identifier", { editable: false }),
    f("projectRef", "Project", { editable: false }),
    f("region", "Region", { editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("computeSize", "Compute Size", { required: false, editable: false }),
    f("diskSizeGb", "Disk Size (GB)", { kind: "number", required: false, editable: false }),
  ],
  outputs: [o("connectionString", "Pooler Connection String", { sensitive: true })],
  dependsOn: [{ fieldKey: "projectRef", targetTypeId: "supabase-project", label: "replica of" }],
  parentTypeId: "supabase-project",
  supportsCreate: true,
  iconKey: "supabase",
});

export const AuthType = rt({
  name: "Auth",
  plural: "Auth",
  id: "supabase-auth",
  description:
    "A project's Supabase Auth configuration: sign-in providers, sessions, passwords, MFA, email and rate limits",
  fields: [
    f("projectRef", "Project", { editable: false }),
    f("siteUrl", "Site URL", { required: false, editable: false }),
    f("disableSignup", "Sign-ups Disabled", { kind: "boolean", required: false, editable: false }),
    f("enabledProviders", "Enabled Providers", { required: false, editable: false }),
    f("passwordMinLength", "Minimum Password Length", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("leakedPasswordProtection", "Leaked Password Protection", {
      kind: "boolean",
      required: false,
      editable: false,
    }),
    f("mfaTotp", "TOTP MFA", { kind: "boolean", required: false, editable: false }),
    f("customSmtp", "Custom SMTP", { kind: "boolean", required: false, editable: false }),
    f("jwtExpirySeconds", "JWT Expiry (s)", { kind: "number", required: false, editable: false }),
  ],
  outputs: [o("siteUrl", "Site URL")],
  dependsOn: [{ fieldKey: "projectRef", targetTypeId: "supabase-project", label: "auth for" }],
  postureChecks: [
    {
      id: "supabase-auth-leaked-passwords",
      title: "Leaked password protection is off",
      severity: "low",
      category: "other",
      conditions: [{ fieldKey: "leakedPasswordProtection", when: "falsy" }],
      reason:
        "Supabase Auth accepts passwords that appear in known breach corpora (HaveIBeenPwned). Turn on leaked password protection in the Auth settings.",
    },
  ],
  parentTypeId: "supabase-project",
  supportsDelete: false,
  pinnable: false,
  iconKey: "supabase",
});

export const SsoProviderType = rt({
  name: "SSO Provider",
  id: "supabase-sso-provider",
  description: "A SAML 2.0 identity provider for Supabase Auth single sign-on",
  fields: [
    f("entityId", "Entity ID", { editable: false }),
    f("projectRef", "Project", { editable: false }),
    f("metadataUrl", "Metadata URL", { required: false }),
    f("domains", "Domains", {
      required: false,
      description: "Comma-separated email domains that sign in through this provider.",
    }),
    f("nameIdFormat", "NameID Format", {
      kind: "enum",
      enumValues: [
        "urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified",
        "urn:oasis:names:tc:SAML:2.0:nameid-format:transient",
        "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
        "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
      ],
      required: false,
    }),
    f("createdAt", "Created At", { required: false, editable: false }),
  ],
  outputs: [],
  dependsOn: [{ fieldKey: "projectRef", targetTypeId: "supabase-project", label: "in project" }],
  parentTypeId: "supabase-project",
  pinnable: false,
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "supabase",
});

export const ThirdPartyAuthType = rt({
  name: "Third-Party Auth",
  plural: "Third-Party Auth Integrations",
  id: "supabase-third-party-auth",
  description:
    "A third-party auth integration: Supabase accepts JWTs issued by another provider (Clerk, Auth0, Firebase, Cognito, WorkOS…)",
  fields: [
    f("type", "Type", { required: false }),
    f("projectRef", "Project"),
    f("oidcIssuerUrl", "OIDC Issuer URL", { required: false }),
    f("jwksUrl", "JWKS URL", { required: false }),
    f("resolvedAt", "Keys Resolved At", { required: false }),
    f("createdAt", "Created At", { required: false }),
  ],
  outputs: [],
  dependsOn: [{ fieldKey: "projectRef", targetTypeId: "supabase-project", label: "in project" }],
  parentTypeId: "supabase-project",
  pinnable: false,
  supportsCreate: true,
  iconKey: "supabase",
});

export const SigningKeyType = rt({
  name: "JWT Signing Key",
  id: "supabase-signing-key",
  description:
    "A key Supabase Auth signs access tokens with (asymmetric or the legacy HS256 secret)",
  fields: [
    f("algorithm", "Algorithm", { editable: false }),
    f("projectRef", "Project", { editable: false }),
    f("status", "Status", {
      kind: "enum",
      enumValues: ["in_use", "standby", "previously_used", "revoked"],
      description:
        "standby → in_use rotates signing to this key; previously_used keys still verify; revoked keys do not.",
    }),
    f("createdAt", "Created At", { required: false, editable: false }),
    f("updatedAt", "Updated At", { required: false, editable: false }),
  ],
  outputs: [o("publicJwk", "Public JWK")],
  dependsOn: [{ fieldKey: "projectRef", targetTypeId: "supabase-project", label: "in project" }],
  expiryFields: [
    {
      fieldKey: "createdAt",
      from: "created",
      kind: "access-key",
      label: "Signing key due for rotation",
      maxAgeDays: 365,
    },
  ],
  parentTypeId: "supabase-project",
  pinnable: false,
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "supabase",
});

export const resourceTypes: ResourceTypeDefinition[] = [
  OrganizationType,
  ProjectType,
  BranchType,
  FunctionType,
  SecretType,
  ApiKeyType,
  BucketType,
  BackupType,
  ReadReplicaType,
  AuthType,
  SsoProviderType,
  ThirdPartyAuthType,
  SigningKeyType,
];
