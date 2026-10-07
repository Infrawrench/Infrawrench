/**
 * Raw Doppler shapes (only the fields the plugin reads) and their mapping to
 * `ResourceInstance`s. Field names follow the OpenAPI definitions embedded in
 * docs.doppler.com/reference (read 2026-10).
 */
import type { ResourceInstance } from "@infrawrench/plugin-base";

export const PLUGIN_ID = "doppler";

export interface DopplerWorkplace {
  id: string;
  name?: string;
  billing_email?: string;
  security_email?: string;
}

export interface DopplerProject {
  id: string;
  slug?: string;
  name: string;
  description?: string;
  created_at?: string;
}

export interface DopplerEnvironment {
  id: string;
  slug?: string;
  name?: string;
  initial_fetch_at?: string | null;
  created_at?: string;
  project?: string;
  personal_configs?: boolean;
}

export interface DopplerConfig {
  name: string;
  root?: boolean;
  locked?: boolean;
  inheritable?: boolean;
  inheriting?: boolean;
  inherits?: Array<{ project?: string; config?: string }>;
  inheritedBy?: Array<{ project?: string; config?: string }>;
  initial_fetch_at?: string | null;
  last_fetch_at?: string | null;
  created_at?: string;
  environment?: string;
  project?: string;
  slug?: string;
}

export interface DopplerSecretValue {
  raw?: string | null;
  computed?: string | null;
  note?: string;
  rawVisibility?: { type?: string };
  computedVisibility?: { type?: string };
}

export interface DopplerServiceToken {
  name?: string;
  slug: string;
  created_at?: string;
  config?: string;
  environment?: string;
  project?: string;
  expires_at?: string | null;
  access?: string;
  key?: string;
}

export interface DopplerSync {
  slug: string;
  integration?: string;
  project?: string;
  config?: string;
  enabled?: boolean;
  lastSyncedAt?: string | null;
}

export interface DopplerIntegration {
  slug: string;
  name?: string;
  type?: string;
  kind?: string;
  enabled?: boolean;
  syncs?: DopplerSync[];
}

export interface DopplerWebhook {
  id: string;
  name?: string;
  url?: string;
  enabled?: boolean;
  hasSecret?: boolean;
  authentication?: { type?: string };
  enabledConfigs?: string[];
  canManage?: boolean;
}

export interface DopplerWorkplaceUser {
  id: string;
  access?: string;
  created_at?: string;
  user?: { email?: string; name?: string; username?: string };
}

export interface DopplerGroup {
  slug: string;
  name: string;
  created_at?: string;
  default_project_role?: { identifier?: string } | null;
  projects?: Array<{ name?: string; slug?: string; role?: { identifier?: string } }>;
  members?: Array<{ type?: string; slug?: string }>;
}

export interface DopplerServiceAccount {
  slug: string;
  name: string;
  created_at?: string;
  workplace_role?: { name?: string; identifier?: string } | null;
}

export interface DopplerApiToken {
  slug: string;
  name?: string;
  created_at?: string;
  last_seen_at?: string | null;
  expires_at?: string | null;
}

export interface DopplerLog {
  id: string;
  text?: string;
  created_at?: string;
  config?: string | null;
  environment?: string | null;
  project?: string | null;
  user?: { email?: string; name?: string } | null;
}

/** Ids nest with dots: `project.config`, `project.config.SECRET`. Project and config names never contain one. */
export function joinId(...parts: string[]): string {
  return parts.join(".");
}

export function splitId(id: string, n: number): string[] {
  const parts = id.split(".");
  if (parts.length < n) throw new Error(`Doppler plugin: "${id}" is not a valid id`);
  // The last part keeps any remaining dots (service token slugs, secret names never have them).
  return [...parts.slice(0, n - 1), parts.slice(n - 1).join(".")];
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

const parent = (accountId: string, typeId: string, id: string) => `${accountId}:${typeId}:${id}`;

export function mapWorkplace(accountId: string, w: DopplerWorkplace): ResourceInstance {
  return instance(accountId, "doppler-workplace", w.id, w.name || w.id, {
    workplaceId: w.id,
    name: w.name ?? "",
    billingEmail: w.billing_email ?? "",
    securityEmail: w.security_email ?? "",
  });
}

/** The project's API identifier: its slug where Doppler returns one, else its name. */
export const projectKey = (p: DopplerProject) => p.slug || p.name;

export function mapProject(
  accountId: string,
  p: DopplerProject,
  counts?: { configs?: number; environments?: number },
): ResourceInstance {
  const key = projectKey(p);
  return instance(
    accountId,
    "doppler-project",
    key,
    p.name,
    {
      name: p.name,
      slug: key,
      projectId: p.id,
      description: p.description ?? "",
      createdAt: p.created_at,
      environments: counts?.environments,
      configs: counts?.configs,
    },
    { resolvedOutputs: { project: key } },
  );
}

export function mapEnvironment(
  accountId: string,
  project: string,
  e: DopplerEnvironment,
): ResourceInstance {
  const slug = e.slug || e.id;
  return instance(
    accountId,
    "doppler-environment",
    joinId(project, slug),
    e.name || slug,
    {
      project,
      slug,
      name: e.name ?? slug,
      personalConfigs: e.personal_configs,
      initialFetchAt: e.initial_fetch_at ?? undefined,
      createdAt: e.created_at,
    },
    { parentResourceId: parent(accountId, "doppler-project", project) },
  );
}

export function mapConfig(
  accountId: string,
  project: string,
  c: DopplerConfig,
  secrets?: number,
): ResourceInstance {
  return instance(
    accountId,
    "doppler-config",
    joinId(project, c.name),
    c.name,
    {
      project,
      name: c.name,
      environment: c.environment,
      root: c.root,
      locked: c.locked,
      inheritable: c.inheritable,
      inherits: (c.inherits ?? []).map((i) => `${i.project}.${i.config}`).join(", ") || undefined,
      inheritedBy:
        (c.inheritedBy ?? []).map((i) => `${i.project}.${i.config}`).join(", ") || undefined,
      secrets,
      initialFetchAt: c.initial_fetch_at ?? undefined,
      lastFetchAt: c.last_fetch_at ?? undefined,
      neverFetched: !c.last_fetch_at,
      createdAt: c.created_at,
    },
    {
      parentResourceId: parent(accountId, "doppler-project", project),
      resolvedOutputs: { project, config: c.name },
    },
  );
}

export function mapSecret(
  accountId: string,
  project: string,
  config: string,
  name: string,
  v: DopplerSecretValue,
): ResourceInstance {
  const visibility = v.rawVisibility?.type ?? v.computedVisibility?.type;
  const referencesOthers = /\$\{[^}]+\}/.test(v.raw ?? "");
  return instance(
    accountId,
    "doppler-secret",
    joinId(project, config, name),
    name,
    {
      project,
      config,
      name,
      visibility,
      note: v.note ?? "",
      referencesOthers: v.raw === undefined || v.raw === null ? undefined : referencesOthers,
      empty: v.raw === undefined || v.raw === null ? undefined : v.raw === "",
    },
    { parentResourceId: parent(accountId, "doppler-config", joinId(project, config)) },
  );
}

export function mapServiceToken(
  accountId: string,
  project: string,
  config: string,
  t: DopplerServiceToken,
): ResourceInstance {
  return instance(
    accountId,
    "doppler-service-token",
    joinId(project, config, t.slug),
    t.name || t.slug,
    {
      project,
      config,
      name: t.name ?? "",
      access: t.access ?? "read",
      environment: t.environment,
      createdAt: t.created_at,
      expiresAt: t.expires_at ?? undefined,
      neverExpires: !t.expires_at,
    },
    { parentResourceId: parent(accountId, "doppler-config", joinId(project, config)) },
  );
}

export function mapIntegration(accountId: string, i: DopplerIntegration): ResourceInstance {
  return instance(accountId, "doppler-integration", i.slug, i.name || i.slug, {
    name: i.name ?? "",
    type: i.type ?? "",
    kind: i.kind ?? "",
    enabled: i.enabled,
    syncs: i.syncs?.length,
  });
}

export function mapSync(
  accountId: string,
  s: DopplerSync,
  integration?: DopplerIntegration,
): ResourceInstance {
  const project = s.project ?? "";
  const config = s.config ?? "";
  return instance(
    accountId,
    "doppler-sync",
    joinId(project, config, s.slug),
    `${project}/${config} → ${integration?.name ?? s.integration ?? "integration"}`,
    {
      project,
      config,
      integration: s.integration,
      integrationName: integration?.name,
      integrationType: integration?.type,
      enabled: s.enabled,
      lastSyncedAt: s.lastSyncedAt ?? undefined,
    },
    s.integration
      ? { parentResourceId: parent(accountId, "doppler-integration", s.integration) }
      : {},
  );
}

export function mapWebhook(
  accountId: string,
  project: string,
  w: DopplerWebhook,
): ResourceInstance {
  return instance(
    accountId,
    "doppler-webhook",
    joinId(project, w.id),
    w.name || w.url || w.id,
    {
      project,
      name: w.name ?? "",
      url: w.url ?? "",
      enabled: w.enabled,
      hasSecret: w.hasSecret,
      authentication: w.authentication?.type,
      enabledConfigs: (w.enabledConfigs ?? []).join(", "),
    },
    { parentResourceId: parent(accountId, "doppler-project", project) },
  );
}

export function mapUser(accountId: string, u: DopplerWorkplaceUser): ResourceInstance {
  return instance(accountId, "doppler-user", u.id, u.user?.name || u.user?.email || u.id, {
    email: u.user?.email ?? "",
    name: u.user?.name,
    username: u.user?.username,
    access: u.access ?? "",
    createdAt: u.created_at,
  });
}

export function mapGroup(
  accountId: string,
  g: DopplerGroup,
  users?: Map<string, string>,
): ResourceInstance {
  const members = (g.members ?? []).filter((m) => m.slug);
  return instance(accountId, "doppler-group", g.slug, g.name, {
    name: g.name,
    defaultProjectRole: g.default_project_role?.identifier,
    memberCount: g.members ? members.length : undefined,
    members: g.members ? members.map((m) => users?.get(m.slug!) ?? m.slug).join(", ") : undefined,
    projects: g.projects
      ? g.projects.map((p) => `${p.name ?? p.slug} (${p.role?.identifier ?? "?"})`).join(", ")
      : undefined,
    createdAt: g.created_at,
  });
}

export function mapServiceAccount(accountId: string, s: DopplerServiceAccount): ResourceInstance {
  return instance(accountId, "doppler-service-account", s.slug, s.name, {
    name: s.name,
    workplaceRole: s.workplace_role?.identifier ?? s.workplace_role?.name,
    createdAt: s.created_at,
  });
}

export function mapApiToken(
  accountId: string,
  sa: DopplerServiceAccount,
  t: DopplerApiToken,
): ResourceInstance {
  return instance(
    accountId,
    "doppler-service-account-token",
    joinId(sa.slug, t.slug),
    t.name || t.slug,
    {
      serviceAccount: sa.slug,
      serviceAccountName: sa.name,
      name: t.name ?? "",
      createdAt: t.created_at,
      lastUsedAt: t.last_seen_at ?? undefined,
      expiresAt: t.expires_at ?? undefined,
      neverExpires: !t.expires_at,
    },
    { parentResourceId: parent(accountId, "doppler-service-account", sa.slug) },
  );
}
