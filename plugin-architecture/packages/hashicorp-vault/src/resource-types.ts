import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { f, o, rt } from "@infrawrench/plugin-base";

/** HashiCorp Vault resource types, all within the namespace in the credentials. */
const ro = { required: false, editable: false } as const;
const ttlField = (key: string, label: string) =>
  f(key, label, {
    kind: "number",
    required: false,
    description: "Seconds; 0 uses the system default.",
  });

export const ClusterResourceType = rt({
  name: "Cluster",
  id: "vault-cluster",
  accountRoot: true,
  description:
    "The Vault cluster this connection reaches: version, seal state and type, HA leader and replication modes. The Metrics tab charts seal and standby state, leases, tokens and monthly clients.",
  fields: [
    f("address", "Address", ro),
    f("namespace", "Namespace", ro),
    f("version", "Version", ro),
    f("enterprise", "Enterprise", { ...ro, kind: "boolean" }),
    f("clusterName", "Cluster Name", ro),
    f("clusterId", "Cluster ID", ro),
    f("initialized", "Initialized", { ...ro, kind: "boolean" }),
    f("sealed", "Sealed", { ...ro, kind: "boolean" }),
    f("sealType", "Seal Type", ro),
    f("storageType", "Storage", ro),
    f("threshold", "Unseal Threshold", { ...ro, kind: "number" }),
    f("shares", "Key Shares", { ...ro, kind: "number" }),
    f("standby", "Standby", { ...ro, kind: "boolean" }),
    f("performanceStandby", "Performance Standby", { ...ro, kind: "boolean" }),
    f("haEnabled", "HA Enabled", { ...ro, kind: "boolean" }),
    f("leaderAddress", "Leader", ro),
    f("isLeader", "This Node Leads", { ...ro, kind: "boolean" }),
    f("replicationPerformance", "Performance Replication", ro),
    f("replicationDr", "DR Replication", ro),
    f("raftCommittedIndex", "Raft Committed Index", { ...ro, kind: "number" }),
    f("raftAppliedIndex", "Raft Applied Index", { ...ro, kind: "number" }),
    f("buildDate", "Build Date", ro),
  ],
  outputs: [o("address", "Vault address"), o("namespace", "Namespace")],
  supportsMetrics: true,
  supportsDelete: false,
  iconKey: "server",
  secretExportTemplates: [
    {
      id: "vault-addr",
      displayName: "Vault address",
      entries: [
        { envKey: "VAULT_ADDR", outputKey: "address" },
        { envKey: "VAULT_NAMESPACE", outputKey: "namespace" },
      ],
    },
  ],
});

export const MountResourceType = rt({
  name: "Secrets Engine",
  id: "vault-mount",
  description:
    "A mounted secrets engine (KV, PKI, Transit, database, cloud credentials…): type, version, lease TTLs and visibility. Enable a new engine, tune it, or disable it (which deletes its data).",
  fields: [
    f("path", "Path", { editable: false }),
    f("type", "Type", ro),
    f("description", "Description", { required: false }),
    ttlField("defaultLeaseTtl", "Default Lease TTL"),
    ttlField("maxLeaseTtl", "Max Lease TTL"),
    f("listingVisibility", "Listed in the UI", {
      kind: "enum",
      enumValues: ["hidden", "unauth"],
      required: false,
      description: "unauth lists the mount on the sign-in page.",
    }),
    f("accessor", "Accessor", ro),
    f("local", "Local (not replicated)", { ...ro, kind: "boolean" }),
    f("sealWrap", "Seal Wrap", { ...ro, kind: "boolean" }),
    f("pluginVersion", "Plugin Version", ro),
    f("deprecationStatus", "Deprecation Status", ro),
  ],
  outputs: [o("path", "Mount path")],
  postureChecks: [
    {
      id: "vault-mount-deprecated",
      title: "Secrets engine plugin is deprecated",
      severity: "medium",
      category: "other",
      conditions: [{ fieldKey: "deprecationStatus", when: "equals", value: "deprecated" }],
      reason: "Vault marks this engine deprecated; it will be removed in a future release.",
    },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "database",
});

export const KvSecretResourceType = rt({
  name: "KV Secret",
  id: "vault-kv-secret",
  parentTypeId: "vault-mount",
  showInSidebar: true,
  pinnable: false,
  description:
    "A secret in a KV version 2 engine. The Versions tab lists every version, reveals one, adds a new version, and soft-deletes, restores or destroys versions. Edit its version limits and custom metadata, or delete it with all its versions.",
  fields: [
    f("mount", "Engine", ro),
    f("path", "Path", ro),
    f("currentVersion", "Current Version", { ...ro, kind: "number" }),
    f("versions", "Versions Kept", { ...ro, kind: "number" }),
    f("currentDeleted", "Current Version Deleted", { ...ro, kind: "boolean" }),
    f("createdAt", "Created", ro),
    f("updatedAt", "Updated", ro),
    f("maxVersions", "Max Versions", {
      kind: "number",
      required: false,
      description: "Versions to keep; 0 uses the engine's setting.",
    }),
    f("casRequired", "Require Check-and-Set", { kind: "boolean", required: false }),
    f("deleteVersionAfter", "Delete Versions After", {
      required: false,
      description: "A duration such as 720h; 0s keeps them forever.",
    }),
    f("customMetadata", "Custom Metadata", {
      required: false,
      description: "Comma-separated key=value pairs.",
    }),
  ],
  outputs: [
    o("path", "Secret path"),
    o("value", "Current value (JSON)", { sensitive: true, hidden: true }),
  ],
  dependsOn: [{ fieldKey: "mount", targetTypeId: "vault-mount", label: "in" }],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "key",
});

export const AuthMethodResourceType = rt({
  name: "Auth Method",
  id: "vault-auth-method",
  description:
    "An enabled auth method (AppRole, OIDC, Kubernetes, userpass, LDAP, cloud IAM…): its path, type, token TTLs and token type. Enable one, tune it, or disable it (which revokes every token it issued).",
  fields: [
    f("path", "Path", { editable: false }),
    f("type", "Type", ro),
    f("description", "Description", { required: false }),
    ttlField("defaultLeaseTtl", "Default Token TTL"),
    ttlField("maxLeaseTtl", "Max Token TTL"),
    f("listingVisibility", "Listed in the UI", {
      kind: "enum",
      enumValues: ["hidden", "unauth"],
      required: false,
    }),
    f("tokenType", "Token Type", {
      kind: "enum",
      enumValues: ["default-service", "default-batch", "service", "batch"],
      required: false,
    }),
    f("accessor", "Accessor", ro),
    f("local", "Local (not replicated)", { ...ro, kind: "boolean" }),
    f("pluginVersion", "Plugin Version", ro),
  ],
  outputs: [o("path", "Auth path"), o("accessor", "Accessor")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "lock",
});

export const PolicyResourceType = rt({
  name: "Policy",
  plural: "Policies",
  id: "vault-policy",
  description:
    "An ACL policy. Read and edit its HCL in an editor, create policies, or delete them (root and default are built in).",
  fields: [
    f("name", "Name", { editable: false }),
    f("paths", "Path Rules", { ...ro, kind: "number" }),
    f("grantsSudo", "Grants sudo", { ...ro, kind: "boolean" }),
    f("builtIn", "Built In", { ...ro, kind: "boolean" }),
  ],
  outputs: [o("name", "Policy name"), o("policy", "Policy HCL", { hidden: true })],
  supportsCreate: true,
  supportsDelete: true,
  iconKey: "shield",
});

export const PkiRoleResourceType = rt({
  name: "PKI Role",
  id: "vault-pki-role",
  parentTypeId: "vault-mount",
  showInSidebar: true,
  description:
    "A PKI role: which names it may issue certificates for, key type and TTLs. Create, edit or delete it.",
  fields: [
    f("mount", "Engine", ro),
    f("name", "Name", { editable: false }),
    f("allowedDomains", "Allowed Domains", { required: false, description: "Comma-separated." }),
    f("allowSubdomains", "Allow Subdomains", { kind: "boolean", required: false }),
    f("allowBareDomains", "Allow Bare Domains", { kind: "boolean", required: false }),
    f("allowGlobDomains", "Allow Glob Domains", { kind: "boolean", required: false }),
    f("allowAnyName", "Allow Any Name", { kind: "boolean", required: false }),
    f("allowIpSans", "Allow IP SANs", { kind: "boolean", required: false }),
    f("allowLocalhost", "Allow localhost", { kind: "boolean", required: false }),
    f("enforceHostnames", "Enforce Hostnames", { kind: "boolean", required: false }),
    f("serverFlag", "Server Certificates", { kind: "boolean", required: false }),
    f("clientFlag", "Client Certificates", { kind: "boolean", required: false }),
    f("ttl", "TTL (seconds)", { kind: "number", required: false }),
    f("maxTtl", "Max TTL (seconds)", { kind: "number", required: false }),
    f("keyType", "Key Type", ro),
    f("keyBits", "Key Bits", { ...ro, kind: "number" }),
    f("issuerRef", "Issuer", ro),
    f("noStore", "Certificates Not Stored", { ...ro, kind: "boolean" }),
  ],
  outputs: [o("name", "Role name")],
  dependsOn: [{ fieldKey: "mount", targetTypeId: "vault-mount", label: "in" }],
  postureChecks: [
    {
      id: "vault-pki-role-any-name",
      title: "PKI role may issue certificates for any name",
      severity: "high",
      category: "other",
      conditions: [{ fieldKey: "allowAnyName", when: "truthy" }],
      reason:
        "Anyone allowed to use this role can mint a certificate for any hostname the CA is trusted for.",
    },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "shield",
});

export const PkiCertResourceType = rt({
  name: "PKI Certificate",
  id: "vault-pki-cert",
  parentTypeId: "vault-mount",
  showInSidebar: true,
  pinnable: false,
  description:
    "A certificate a PKI engine issued and stored: common name, issuer and validity. Expiring certificates show on the expiry radar. Revoke a certificate.",
  fields: [
    f("mount", "Engine", ro),
    f("serial", "Serial", ro),
    f("commonName", "Common Name", ro),
    f("issuer", "Issuer", ro),
    f("notBefore", "Valid From", ro),
    f("notAfter", "Expires", ro),
    f("expires", "Validity Ends", ro),
    f("revoked", "Revoked", { ...ro, kind: "boolean" }),
    f("revokedAt", "Revoked At", ro),
  ],
  outputs: [o("certificate", "Certificate (PEM)", { hidden: true })],
  dependsOn: [{ fieldKey: "mount", targetTypeId: "vault-mount", label: "issued by" }],
  expiryFields: [
    { fieldKey: "notAfter", from: "expiry", kind: "tls-cert", label: "Certificate expires" },
  ],
  supportsDelete: false,
  iconKey: "certificate",
});

export const LeaseResourceType = rt({
  name: "Lease",
  id: "vault-lease",
  pinnable: false,
  description:
    "A lease on a dynamic secret (database or cloud credentials and similar): when it was issued and when it expires. Renew or revoke it. Listing leases needs a sudo-capable token; the first 300 are shown.",
  fields: [
    f("leaseId", "Lease ID", ro),
    f("prefix", "Issued By", ro),
    f("issueTime", "Issued", ro),
    f("expireTime", "Expires", ro),
    f("lastRenewal", "Last Renewed", ro),
    f("renewable", "Renewable", { ...ro, kind: "boolean" }),
    f("ttl", "TTL (seconds)", { ...ro, kind: "number" }),
  ],
  outputs: [],
  expiryFields: [
    { fieldKey: "expireTime", from: "expiry", kind: "other", label: "Vault lease expires" },
  ],
  supportsDelete: true,
  iconKey: "clock",
});

export const TokenResourceType = rt({
  name: "Token",
  id: "vault-token",
  pinnable: false,
  description:
    "A Vault token, identified by its accessor: policies, the auth path that issued it, TTL and expiry. Renew or revoke it. Listing tokens needs a sudo-capable token; the first 200 are shown.",
  fields: [
    f("accessor", "Accessor", ro),
    f("displayName", "Display Name", ro),
    f("policies", "Policies", ro),
    f("root", "Root", { ...ro, kind: "boolean" }),
    f("path", "Issued Via", ro),
    f("type", "Type", ro),
    f("createdAt", "Created", ro),
    f("expireTime", "Expires", ro),
    f("neverExpires", "Never Expires", { ...ro, kind: "boolean" }),
    f("ttl", "TTL (seconds)", { ...ro, kind: "number" }),
    f("renewable", "Renewable", { ...ro, kind: "boolean" }),
    f("orphan", "Orphan", { ...ro, kind: "boolean" }),
    f("numUses", "Uses Left", { ...ro, kind: "number" }),
    f("entityId", "Entity", ro),
    f("meta", "Metadata", ro),
  ],
  outputs: [],
  dependsOn: [{ fieldKey: "policies", targetTypeId: "vault-policy", label: "has policy" }],
  expiryFields: [
    { fieldKey: "expireTime", from: "expiry", kind: "api-token", label: "Vault token expires" },
  ],
  postureChecks: [
    {
      id: "vault-root-token",
      title: "Root token exists",
      severity: "critical",
      category: "credential-age",
      conditions: [{ fieldKey: "root", when: "truthy" }],
      reason:
        "HashiCorp recommends revoking root tokens once setup is done and generating one only when needed.",
    },
  ],
  principalRole: {
    role: "key",
    createdKey: "createdAt",
    adminIndicatorKey: "root",
  },
  supportsDelete: true,
  iconKey: "key",
});

export const AuditDeviceResourceType = rt({
  name: "Audit Device",
  id: "vault-audit-device",
  description:
    "An audit device (file, syslog or socket) Vault writes every request and response to. Enable one or disable it.",
  fields: [
    f("path", "Path", ro),
    f("type", "Type", ro),
    f("description", "Description", ro),
    f("filePath", "File Path", ro),
    f("options", "Options", ro),
    f("local", "Local (not replicated)", { ...ro, kind: "boolean" }),
  ],
  outputs: [],
  supportsCreate: true,
  supportsDelete: true,
  iconKey: "log",
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  ClusterResourceType,
  MountResourceType,
  KvSecretResourceType,
  AuthMethodResourceType,
  PolicyResourceType,
  PkiRoleResourceType,
  PkiCertResourceType,
  LeaseResourceType,
  TokenResourceType,
  AuditDeviceResourceType,
];
