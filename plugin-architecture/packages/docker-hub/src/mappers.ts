/**
 * Raw Docker Hub shapes (only the fields the plugin reads) and their mapping
 * to `ResourceInstance`s. Field names follow the Docker Hub API OpenAPI
 * document (docs.docker.com/reference/api/hub/latest.yaml, 2026-10) and, for
 * the routes it does not document, Docker's own `docker/terraform-provider-docker`
 * and `docker/hub-tool` clients.
 */
import type { ResourceInstance } from "@infrawrench/plugin-base";

export const PLUGIN_ID = "docker-hub";

export interface HubUser {
  id?: string;
  username?: string;
  full_name?: string;
  company?: string;
  location?: string;
  date_joined?: string;
  profile_url?: string;
}

export interface HubOrg {
  id?: string;
  orgname?: string;
  full_name?: string;
  company?: string;
  location?: string;
  date_joined?: string;
  type?: string;
}

export interface HubRepository {
  name: string;
  namespace: string;
  repository_type?: string | null;
  status?: number;
  status_description?: string;
  description?: string | null;
  full_description?: string | null;
  is_private?: boolean;
  star_count?: number;
  pull_count?: number;
  last_updated?: string | null;
  last_modified?: string | null;
  date_registered?: string;
  media_types?: Array<string | null>;
  content_types?: string[];
  categories?: Array<{ name?: string; slug?: string }>;
  storage_size?: number | null;
  immutable_tags_settings?: { enabled?: boolean; rules?: string[] };
}

export interface HubTagImage {
  architecture?: string;
  variant?: string | null;
  os?: string;
  digest?: string | null;
  size?: number;
  last_pulled?: string | null;
  last_pushed?: string | null;
}

export interface HubTag {
  id?: number;
  name: string;
  full_size?: number;
  last_updated?: string | null;
  last_updater_username?: string;
  tag_status?: string;
  tag_last_pulled?: string | null;
  tag_last_pushed?: string | null;
  digest?: string;
  media_type?: string;
  images?: HubTagImage[];
}

export interface HubTeam {
  id?: number;
  uuid?: string;
  name: string;
  description?: string;
  member_count?: number;
  role?: string | null;
}

export interface HubMember {
  id?: string;
  username: string;
  full_name?: string;
  email?: string;
  role?: string;
  groups?: string[];
  date_joined?: string;
  type?: string;
  last_logged_in_at?: string;
  last_seen_at?: string;
}

export interface HubInvite {
  id: string;
  inviter_username?: string;
  invitee?: string;
  org?: string;
  team?: string;
  created_at?: string;
}

export interface HubPat {
  uuid: string;
  token_label?: string;
  scopes?: string[];
  is_active?: boolean;
  created_at?: string;
  last_used?: string | null;
  expires_at?: string | null;
  generated_by?: string;
  creator_ip?: string;
  client_id?: string;
}

export interface HubOatResource {
  type: string;
  path: string;
  scopes: string[];
}

export interface HubOat {
  id: string;
  label?: string;
  description?: string;
  created_by?: string;
  is_active?: boolean;
  created_at?: string;
  expires_at?: string | null;
  last_used_at?: string | null;
  resources?: HubOatResource[];
}

export interface HubAuditLog {
  account?: string;
  action?: string;
  name?: string;
  actor?: string;
  timestamp?: string;
  action_description?: string;
}

function instance(
  accountId: string,
  typeId: string,
  externalId: string,
  displayName: string,
  fields: Record<string, string | number | boolean | undefined | null>,
  extra: Partial<ResourceInstance> = {},
): ResourceInstance {
  const now = new Date().toISOString();
  const clean: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null) clean[k] = v;
  return {
    id: `${accountId}:${typeId}:${externalId}`,
    pluginId: PLUGIN_ID,
    resourceTypeId: typeId,
    accountId,
    displayName,
    fields: clean,
    resolvedOutputs: {},
    secretStates: [],
    externalId,
    createdAt: now,
    updatedAt: now,
    ...extra,
  };
}

const nsParent = (accountId: string, ns: string) => `${accountId}:dockerhub-namespace:${ns}`;

/** Split `a/b` (or `a/b:c`) on its first slash: namespace names never contain one. */
export function splitScoped(id: string): { ns: string; rest: string } {
  const i = id.indexOf("/");
  if (i <= 0) throw new Error(`Docker Hub plugin: "${id}" is not a namespaced id`);
  return { ns: id.slice(0, i), rest: id.slice(i + 1) };
}

/** `ns/repo:tag` → its three parts (a tag never contains a colon or slash). */
export function splitTagId(id: string): { ns: string; repo: string; tag: string } {
  const { ns, rest } = splitScoped(id);
  const i = rest.lastIndexOf(":");
  if (i <= 0) throw new Error(`Docker Hub plugin: "${id}" is not a tag id`);
  return { ns, repo: rest.slice(0, i), tag: rest.slice(i + 1) };
}

export function mapNamespace(
  accountId: string,
  ns: string,
  kind: "user" | "organization",
  info: HubUser | HubOrg | undefined,
  stats?: {
    repositories: number;
    privateRepositories: number;
    pulls: number;
    storageBytes?: number;
  },
  org?: {
    members?: number;
    teams?: number;
    restricted?: {
      enabled?: boolean;
      allow_official_images?: boolean;
      allow_verified_publishers?: boolean;
    };
  },
): ResourceInstance {
  return instance(
    accountId,
    "dockerhub-namespace",
    ns,
    ns,
    {
      name: ns,
      kind,
      fullName: info?.full_name || undefined,
      company: info?.company || undefined,
      location: info?.location || undefined,
      dateJoined: info?.date_joined,
      repositories: stats?.repositories,
      privateRepositories: stats?.privateRepositories,
      totalPulls: stats?.pulls,
      storageBytes: stats?.storageBytes,
      members: org?.members,
      teams: org?.teams,
      restrictedImages: org?.restricted?.enabled,
      allowOfficialImages: org?.restricted?.allow_official_images,
      allowVerifiedPublishers: org?.restricted?.allow_verified_publishers,
    },
    { resolvedOutputs: { namespace: ns, url: `https://hub.docker.com/u/${ns}` } },
  );
}

export function mapRepository(accountId: string, r: HubRepository): ResourceInstance {
  const id = `${r.namespace}/${r.name}`;
  const image = r.namespace === "library" ? r.name : id;
  return instance(
    accountId,
    "dockerhub-repository",
    id,
    id,
    {
      namespace: r.namespace,
      name: r.name,
      description: r.description ?? "",
      fullDescription: r.full_description ?? undefined,
      isPrivate: r.is_private ?? false,
      immutableTags: r.immutable_tags_settings?.enabled,
      immutableTagsRules: r.immutable_tags_settings?.rules?.join(", "),
      pullCount: r.pull_count,
      starCount: r.star_count,
      storageSize: r.storage_size ?? undefined,
      status: r.status_description,
      repositoryType: r.repository_type ?? undefined,
      lastUpdated: r.last_updated ?? undefined,
      lastModified: r.last_modified ?? undefined,
      dateRegistered: r.date_registered,
      contentTypes: (r.content_types ?? []).join(", ") || undefined,
      mediaTypes: (r.media_types ?? []).filter(Boolean).join(", ") || undefined,
      categories:
        (r.categories ?? [])
          .map((c) => c.name ?? c.slug)
          .filter(Boolean)
          .join(", ") || undefined,
    },
    {
      parentResourceId: nsParent(accountId, r.namespace),
      resolvedOutputs: {
        image: `docker.io/${image}`,
        url: `https://hub.docker.com/r/${id}`,
      },
    },
  );
}

export function mapTag(accountId: string, ns: string, repo: string, t: HubTag): ResourceInstance {
  const images = t.images ?? [];
  const platforms = images
    .map((i) => [i.os, i.architecture, i.variant].filter(Boolean).join("/"))
    .filter(Boolean);
  const digest = t.digest ?? images[0]?.digest ?? undefined;
  const ref = `${ns === "library" ? repo : `${ns}/${repo}`}:${t.name}`;
  return instance(
    accountId,
    "dockerhub-tag",
    `${ns}/${repo}:${t.name}`,
    `${repo}:${t.name}`,
    {
      repository: `${ns}/${repo}`,
      tag: t.name,
      digest: digest ?? undefined,
      sizeBytes: t.full_size,
      platforms: platforms.join(", ") || undefined,
      status: t.tag_status,
      lastPushed: t.tag_last_pushed ?? undefined,
      lastPulled: t.tag_last_pulled ?? undefined,
      lastUpdated: t.last_updated ?? undefined,
      lastUpdater: t.last_updater_username,
      mediaType: t.media_type,
    },
    {
      parentResourceId: `${accountId}:dockerhub-repository:${ns}/${repo}`,
      resolvedOutputs: {
        image: `docker.io/${ref}`,
        ...(digest
          ? { pinned: `docker.io/${ns === "library" ? repo : `${ns}/${repo}`}@${digest}` }
          : {}),
      },
    },
  );
}

export function mapTeam(
  accountId: string,
  org: string,
  t: HubTeam,
  members?: string[],
): ResourceInstance {
  return instance(
    accountId,
    "dockerhub-team",
    `${org}/${t.name}`,
    t.name,
    {
      organization: org,
      name: t.name,
      description: t.description ?? "",
      memberCount: t.member_count,
      role: t.role ?? undefined,
      teamId: t.id,
      members: members?.join(", "),
    },
    { parentResourceId: nsParent(accountId, org) },
  );
}

export function mapMember(accountId: string, org: string, m: HubMember): ResourceInstance {
  return instance(
    accountId,
    "dockerhub-member",
    `${org}/${m.username}`,
    m.username,
    {
      organization: org,
      username: m.username,
      fullName: m.full_name || undefined,
      email: m.email || undefined,
      role: (m.role ?? "").toLowerCase() || undefined,
      teams: (m.groups ?? []).join(", ") || undefined,
      dateJoined: m.date_joined,
      lastLoggedIn: m.last_logged_in_at,
      lastSeenAt: m.last_seen_at,
    },
    { parentResourceId: nsParent(accountId, org) },
  );
}

export function mapInvite(accountId: string, org: string, i: HubInvite): ResourceInstance {
  return instance(
    accountId,
    "dockerhub-invite",
    i.id,
    i.invitee ?? i.id,
    {
      organization: i.org ?? org,
      invitee: i.invitee,
      team: i.team,
      inviter: i.inviter_username,
      createdAt: i.created_at,
    },
    { parentResourceId: nsParent(accountId, org) },
  );
}

export function mapPat(accountId: string, t: HubPat): ResourceInstance {
  return instance(accountId, "dockerhub-access-token", t.uuid, t.token_label || t.uuid, {
    label: t.token_label ?? "",
    scopes: (t.scopes ?? []).join(", "),
    active: t.is_active ?? true,
    createdAt: t.created_at,
    lastUsedAt: t.last_used ?? undefined,
    expiresAt: t.expires_at ?? undefined,
    neverExpires: !t.expires_at,
    generatedBy: t.generated_by,
    creatorIp: t.creator_ip,
    admin: (t.scopes ?? []).includes("repo:admin"),
  });
}

export function describeOatResources(resources: HubOatResource[] | undefined): string {
  return (resources ?? [])
    .map((r) => `${r.path} (${r.scopes.map((s) => s.replace(/^scope-/, "")).join(", ")})`)
    .join("; ");
}

export function mapOat(accountId: string, org: string, t: HubOat): ResourceInstance {
  return instance(
    accountId,
    "dockerhub-org-access-token",
    `${org}/${t.id}`,
    t.label || t.id,
    {
      organization: org,
      label: t.label ?? "",
      description: t.description ?? "",
      active: t.is_active ?? true,
      createdBy: t.created_by,
      createdAt: t.created_at,
      expiresAt: t.expires_at ?? undefined,
      neverExpires: !t.expires_at,
      lastUsedAt: t.last_used_at ?? undefined,
      resources: t.resources ? describeOatResources(t.resources) : undefined,
    },
    { parentResourceId: nsParent(accountId, org) },
  );
}
