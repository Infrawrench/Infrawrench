import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * Docker Hub resource types. Everything hangs off a namespace: the user
 * account the credentials belong to and each organization picked in the
 * credentials. (Docker engines are the separate `docker` plugin.)
 */
const ro = { required: false, editable: false } as const;

export const NamespaceResourceType = rt({
  name: "Namespace",
  id: "dockerhub-namespace",
  description:
    "A Docker Hub namespace: your own account or an organization. Shows repositories, pulls and storage; for an organization also members, teams, the image access restriction and the audit log.",
  fields: [
    f("name", "Name", { editable: false }),
    f("kind", "Kind", { ...ro, kind: "enum", enumValues: ["user", "organization"] }),
    f("fullName", "Full Name", ro),
    f("company", "Company", ro),
    f("location", "Location", ro),
    f("dateJoined", "Joined", ro),
    f("repositories", "Repositories", { ...ro, kind: "number" }),
    f("privateRepositories", "Private Repositories", { ...ro, kind: "number" }),
    f("totalPulls", "Total Pulls", { ...ro, kind: "number" }),
    f("storageBytes", "Storage (bytes)", { ...ro, kind: "number" }),
    f("members", "Members", { ...ro, kind: "number" }),
    f("teams", "Teams", { ...ro, kind: "number" }),
    f("restrictedImages", "Restrict Images", {
      kind: "boolean",
      required: false,
      description:
        "Organizations on a Business subscription only: members may only pull the image sources allowed below.",
    }),
    f("allowOfficialImages", "Allow Docker Official Images", { kind: "boolean", required: false }),
    f("allowVerifiedPublishers", "Allow Verified Publisher Images", {
      kind: "boolean",
      required: false,
    }),
  ],
  outputs: [o("namespace", "Namespace"), o("url", "Docker Hub URL")],
  supportsUpdate: true,
  supportsDelete: false,
  supportsMetrics: true,
  iconKey: "users",
});

export const RepositoryResourceType = rt({
  name: "Repository",
  plural: "Repositories",
  id: "dockerhub-repository",
  parentTypeId: "dockerhub-namespace",
  showInSidebar: true,
  description:
    "A Docker Hub image repository: pulls, stars, storage, visibility and its tags. Create, edit the short description, overview (README), visibility and immutable-tag rules, grant a team access, or delete it.",
  fields: [
    f("namespace", "Namespace", ro),
    f("name", "Name", { editable: false }),
    f("description", "Short Description", {
      required: false,
      description: "Up to 100 characters, shown in search results.",
    }),
    f("fullDescription", "Overview", {
      required: false,
      description: "The repository's README, in Markdown.",
    }),
    f("isPrivate", "Private", {
      kind: "boolean",
      required: false,
      description:
        "Only you and the people you grant access can see and pull a private repository.",
    }),
    f("immutableTags", "Immutable Tags", {
      kind: "boolean",
      required: false,
      description: "Stop matching tags from being overwritten once pushed.",
    }),
    f("immutableTagsRules", "Immutable Tag Rules", {
      required: false,
      description:
        "Comma-separated regular expressions of the tags to protect, e.g. ^v\\d+\\.\\d+\\.\\d+$.",
    }),
    f("pullCount", "Pulls", { ...ro, kind: "number" }),
    f("starCount", "Stars", { ...ro, kind: "number" }),
    f("storageSize", "Storage (bytes)", { ...ro, kind: "number" }),
    f("status", "Status", ro),
    f("repositoryType", "Type", ro),
    f("contentTypes", "Content Types", ro),
    f("mediaTypes", "Media Types", ro),
    f("categories", "Categories", ro),
    f("lastUpdated", "Last Pushed", ro),
    f("lastModified", "Last Modified", ro),
    f("dateRegistered", "Created", ro),
  ],
  outputs: [
    o("image", "Image reference", {
      description: "The name to docker pull, e.g. docker.io/acme/api.",
    }),
    o("url", "Docker Hub URL"),
  ],
  dependsOn: [{ fieldKey: "namespace", targetTypeId: "dockerhub-namespace", label: "in" }],
  postureChecks: [
    {
      id: "dockerhub-public-repository",
      title: "Docker Hub repository is public",
      severity: "low",
      category: "public-exposure",
      conditions: [{ fieldKey: "isPrivate", when: "falsy" }],
      reason:
        "Anyone can pull every image in a public repository. Check it holds nothing internal.",
    },
  ],
  orphanRule: {
    conditions: [{ fieldKey: "pullCount", when: "equals", value: "0" }],
    reason: "Repository has never been pulled",
  },
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  supportsMetrics: true,
  iconKey: "box",
  secretExportTemplates: [
    {
      id: "image",
      displayName: "Image reference",
      entries: [{ envKey: "IMAGE", outputKey: "image" }],
    },
  ],
});

export const TagResourceType = rt({
  name: "Tag",
  id: "dockerhub-tag",
  parentTypeId: "dockerhub-repository",
  pinnable: false,
  description:
    "An image tag: digest, size, platforms and when it was last pushed and pulled. The 25 most recently pushed tags of each repository are listed (the Tags tab on a repository browses them all). Delete a tag.",
  fields: [
    f("repository", "Repository", ro),
    f("tag", "Tag", ro),
    f("digest", "Digest", ro),
    f("sizeBytes", "Size (bytes)", { ...ro, kind: "number" }),
    f("platforms", "Platforms", ro),
    f("status", "Status", ro),
    f("lastPushed", "Last Pushed", ro),
    f("lastPulled", "Last Pulled", ro),
    f("lastUpdated", "Last Updated", ro),
    f("lastUpdater", "Pushed By", ro),
    f("mediaType", "Media Type", ro),
  ],
  outputs: [
    o("image", "Image reference", { description: "docker.io/<namespace>/<repo>:<tag>" }),
    o("pinned", "Pinned reference", { description: "The same image pinned by digest." }),
  ],
  dependsOn: [{ fieldKey: "repository", targetTypeId: "dockerhub-repository", label: "tag of" }],
  orphanRule: {
    conditions: [{ fieldKey: "status", when: "equals", value: "inactive" }],
    reason: "Tag has not been pushed or pulled for over a month (Docker Hub marks it inactive)",
  },
  supportsDelete: true,
  iconKey: "tag",
});

export const TeamResourceType = rt({
  name: "Team",
  id: "dockerhub-team",
  parentTypeId: "dockerhub-namespace",
  showInSidebar: true,
  description:
    "An organization team (Docker Hub calls them groups): description and members. Create, rename, change the description or members, or delete it.",
  fields: [
    f("organization", "Organization", ro),
    f("name", "Name", { required: true }),
    f("description", "Description", { required: false }),
    f("members", "Members", {
      required: false,
      description: "Comma-separated Docker IDs; changing it adds and removes members.",
    }),
    f("memberCount", "Member Count", { ...ro, kind: "number" }),
    f("role", "Role", ro),
    f("teamId", "Team ID", { ...ro, kind: "number" }),
  ],
  outputs: [o("name", "Team name")],
  dependsOn: [
    { fieldKey: "organization", targetTypeId: "dockerhub-namespace", label: "in" },
    {
      fieldKey: "members",
      targetTypeId: "dockerhub-member",
      matchTemplate: "{organization}/{members}",
      label: "has member",
    },
  ],
  principalRole: { role: "group" },
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "users",
});

export const MemberResourceType = rt({
  name: "Member",
  id: "dockerhub-member",
  parentTypeId: "dockerhub-namespace",
  description:
    "A member of an organization: role, teams and (with insights enabled) last sign-in. Change the role (owner, editor or member) or remove the member.",
  fields: [
    f("organization", "Organization", ro),
    f("username", "Docker ID", ro),
    f("fullName", "Full Name", ro),
    f("email", "Email", ro),
    f("role", "Role", {
      kind: "enum",
      enumValues: ["member", "editor", "owner"],
      required: false,
      description:
        "Owners administer the organization; editors manage repositories; members only use them.",
    }),
    f("teams", "Teams", ro),
    f("dateJoined", "Joined", ro),
    f("lastLoggedIn", "Last Sign-in", ro),
    f("lastSeenAt", "Last Seen", ro),
  ],
  outputs: [o("username", "Docker ID")],
  dependsOn: [
    { fieldKey: "organization", targetTypeId: "dockerhub-namespace", label: "member of" },
  ],
  principalRole: {
    role: "user",
    lastUsedKey: "lastSeenAt",
    createdKey: "dateJoined",
    adminIndicatorKey: "role",
    adminValues: ["owner"],
    parentKey: "organization",
  },
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "user",
});

export const InviteResourceType = rt({
  name: "Invite",
  id: "dockerhub-invite",
  parentTypeId: "dockerhub-namespace",
  pinnable: false,
  description:
    "A pending invitation to join an organization. Invite people by Docker ID or email (with a role and an optional team), resend an invite, or cancel it.",
  fields: [
    f("organization", "Organization", ro),
    f("invitee", "Invitee", ro),
    f("team", "Team", ro),
    f("inviter", "Invited By", ro),
    f("createdAt", "Sent", ro),
  ],
  outputs: [],
  supportsCreate: true,
  supportsDelete: true,
  iconKey: "mail",
});

export const AccessTokenResourceType = rt({
  name: "Personal Access Token",
  id: "dockerhub-access-token",
  description:
    "A personal access token of the connected Docker ID: label, scope, last use and expiry. Create one (the value is shown once), rename it, deactivate or reactivate it, or delete it. Docker Hub only manages tokens when the connection signs in with a password.",
  fields: [
    f("label", "Label", { required: true }),
    f("scopes", "Scopes", ro),
    f("active", "Active", { ...ro, kind: "boolean" }),
    f("admin", "Admin Scope", { ...ro, kind: "boolean" }),
    f("neverExpires", "Never Expires", { ...ro, kind: "boolean" }),
    f("createdAt", "Created", ro),
    f("lastUsedAt", "Last Used", ro),
    f("expiresAt", "Expires", ro),
    f("generatedBy", "Generated By", ro),
    f("creatorIp", "Created From", ro),
  ],
  outputs: [
    o("token", "Token", {
      sensitive: true,
      description: "Only available for tokens created from Infrawrench.",
    }),
  ],
  expiryFields: [
    { fieldKey: "expiresAt", from: "expiry", kind: "api-token", label: "Docker Hub token expires" },
  ],
  principalRole: {
    role: "key",
    lastUsedKey: "lastUsedAt",
    createdKey: "createdAt",
    adminIndicatorKey: "admin",
    revokeActionId: "deactivate",
  },
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "key",
});

export const OrgAccessTokenResourceType = rt({
  name: "Organization Access Token",
  id: "dockerhub-org-access-token",
  parentTypeId: "dockerhub-namespace",
  showInSidebar: true,
  description:
    "An organization access token: the repositories it reaches and what it may do there. Create one (the value is shown once), edit its label and description, deactivate or reactivate it, or delete it. Needs an organization owner.",
  fields: [
    f("organization", "Organization", ro),
    f("label", "Label", { required: true }),
    f("description", "Description", { required: false }),
    f("active", "Active", { ...ro, kind: "boolean" }),
    f("resources", "Access", ro),
    f("neverExpires", "Never Expires", { ...ro, kind: "boolean" }),
    f("createdBy", "Created By", ro),
    f("createdAt", "Created", ro),
    f("lastUsedAt", "Last Used", ro),
    f("expiresAt", "Expires", ro),
  ],
  outputs: [
    o("token", "Token", {
      sensitive: true,
      description: "Only available for tokens created from Infrawrench.",
    }),
  ],
  dependsOn: [{ fieldKey: "organization", targetTypeId: "dockerhub-namespace", label: "for" }],
  expiryFields: [
    {
      fieldKey: "expiresAt",
      from: "expiry",
      kind: "api-token",
      label: "Organization access token expires",
    },
  ],
  principalRole: {
    role: "key",
    lastUsedKey: "lastUsedAt",
    createdKey: "createdAt",
    parentKey: "organization",
    revokeActionId: "deactivate",
  },
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "key",
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  NamespaceResourceType,
  RepositoryResourceType,
  TagResourceType,
  TeamResourceType,
  MemberResourceType,
  InviteResourceType,
  AccessTokenResourceType,
  OrgAccessTokenResourceType,
];
