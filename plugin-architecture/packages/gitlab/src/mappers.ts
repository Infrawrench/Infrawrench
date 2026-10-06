import type { ResourceInstance } from "@infrawrench/plugin-base";
import type {
  GlDeployKey,
  GlDeployToken,
  GlEnvironment,
  GlGroup,
  GlHook,
  GlMember,
  GlNamespace,
  GlPackage,
  GlPipeline,
  GlProject,
  GlProtectedBranch,
  GlRegistryRepository,
  GlRelease,
  GlRunner,
  GlSchedule,
  GlVariable,
} from "./types.js";

export const PLUGIN_ID = "gitlab";

type FieldValue = string | number | boolean | undefined | null;

export function instance(
  accountId: string,
  typeId: string,
  externalId: string,
  displayName: string,
  fields: Record<string, FieldValue>,
  outputs: Record<string, string | undefined> = {},
  parent?: { typeId: string; externalId: string },
): ResourceInstance {
  const now = new Date().toISOString();
  const clean: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null || v === "") continue;
    if (typeof v === "number" && !Number.isFinite(v)) continue;
    clean[k] = v;
  }
  const resolved: Record<string, string> = {};
  for (const [k, v] of Object.entries(outputs)) if (v) resolved[k] = v;
  return {
    id: `${accountId}:${typeId}:${externalId}`,
    pluginId: PLUGIN_ID,
    resourceTypeId: typeId,
    accountId,
    displayName: displayName || externalId,
    fields: clean,
    resolvedOutputs: resolved,
    secretStates: [],
    externalId,
    ...(parent ? { parentResourceId: `${accountId}:${parent.typeId}:${parent.externalId}` } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

// ---------------------------------------------------------------------------
// Access levels
// ---------------------------------------------------------------------------

/** Member roles (`doc/api/project_members.md`). */
export const MEMBER_LEVELS: Record<number, string> = {
  0: "No access",
  5: "Minimal access",
  10: "Guest",
  15: "Planner",
  20: "Reporter",
  25: "Security Manager",
  30: "Developer",
  40: "Maintainer",
  50: "Owner",
};

export function memberLevelName(level: number | undefined): string | undefined {
  return level === undefined ? undefined : (MEMBER_LEVELS[level] ?? String(level));
}

export function memberLevelValue(name: string): number {
  const trimmed = name.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const hit = Object.entries(MEMBER_LEVELS).find(
    ([, label]) => label.toLowerCase() === trimmed.toLowerCase(),
  );
  if (!hit) {
    throw new Error(
      `GitLab plugin: "${name}" is not a role. Use Guest, Planner, Reporter, Developer, Maintainer or Owner.`,
    );
  }
  return Number(hit[0]);
}

/**
 * Protected-branch push/merge levels. GitLab accepts 0, 30, 40 (and 60 for
 * administrators on self-managed); the labels are the ones its UI shows.
 */
export const BRANCH_LEVELS: Record<number, string> = {
  0: "No one",
  30: "Developers + Maintainers",
  40: "Maintainers",
  60: "Administrators",
};

export function branchLevelValue(name: string | undefined): number | undefined {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return undefined;
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const hit = Object.entries(BRANCH_LEVELS).find(
    ([, label]) => label.toLowerCase() === trimmed.toLowerCase(),
  );
  if (!hit) {
    throw new Error(
      `GitLab plugin: "${name}" is not a branch access level. Use No one, Developers + Maintainers or Maintainers.`,
    );
  }
  return Number(hit[0]);
}

/**
 * The role-based level of a protected branch rule, as one label. A rule can
 * also list users, groups and deploy keys (Premium); those are counted, not
 * flattened into the role.
 */
export function describeLevels(
  entries: GlProtectedBranch["push_access_levels"],
): string | undefined {
  if (!entries || entries.length === 0) return undefined;
  const roles = entries
    .filter(
      (e) =>
        e.access_level !== null &&
        e.access_level !== undefined &&
        !e.user_id &&
        !e.group_id &&
        !e.deploy_key_id,
    )
    .map(
      (e) => BRANCH_LEVELS[e.access_level!] ?? e.access_level_description ?? String(e.access_level),
    );
  const extra = entries.length - roles.length;
  const parts = [...new Set(roles)];
  if (extra > 0) parts.push(`${extra} user/group/key rule${extra === 1 ? "" : "s"}`);
  return parts.join(", ") || undefined;
}

/** The highest role a project grants the token's user, from `permissions`. */
export function accessOf(p: GlProject): number | undefined {
  const a = p.permissions?.project_access?.access_level;
  const b = p.permissions?.group_access?.access_level;
  if (a === undefined && b === undefined) return undefined;
  return Math.max(a ?? 0, b ?? 0);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const list = (items: Array<string | undefined | null> | undefined): string | undefined => {
  const out = (items ?? []).filter((x): x is string => typeof x === "string" && x.length > 0);
  return out.length > 0 ? out.join(", ") : undefined;
};

const round = (n: number, digits = 1) => Math.round(n * 10 ** digits) / 10 ** digits;

const numberOrUndefined = (v: unknown): number | undefined => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
};

/** `refs/heads/main` -> `main`; tags keep their name. */
export function shortRef(ref: string | undefined): string | undefined {
  if (!ref) return undefined;
  return ref.replace(/^refs\/(heads|tags)\//, "");
}

export interface Scope {
  kind: "project" | "group";
  id: number;
  path: string;
  webUrl?: string;
}

const scopeLabel = (s: Scope) => s.path;

// ---------------------------------------------------------------------------
// Groups and projects
// ---------------------------------------------------------------------------

export function mapGroup(accountId: string, g: GlGroup, ns?: GlNamespace): ResourceInstance {
  const extra = ns?.extra_shared_runners_minutes_limit ?? 0;
  const base = ns?.shared_runners_minutes_limit;
  const limit = typeof base === "number" && base > 0 ? base + (extra ?? 0) : undefined;
  return instance(
    accountId,
    "group",
    String(g.id),
    g.full_name ?? g.full_path ?? g.name,
    {
      name: g.name,
      description: g.description ?? undefined,
      visibility: g.visibility,
      fullPath: g.full_path,
      plan: ns?.plan,
      seatsInUse: ns?.seats_in_use,
      billableMembers: ns?.billable_members_count,
      projectsCount: ns?.projects_count,
      computeMinutesUsed: ns?.ci_minutes_usage?.total_minutes_used,
      computeMinutesLimit: limit,
      repositorySizeBytes: ns?.root_repository_size,
      trialEndsOn: ns?.trial ? (ns.trial_ends_on ?? undefined) : undefined,
      subscriptionEnds: ns?.end_date ?? undefined,
      parentId: g.parent_id ? String(g.parent_id) : undefined,
      createdAt: g.created_at,
    },
    { groupId: String(g.id), fullPath: g.full_path, webUrl: g.web_url },
  );
}

export function mapProject(
  accountId: string,
  p: GlProject,
  extra: { openMergeRequests?: number } = {},
): ResourceInstance {
  const nsKind = p.namespace?.kind;
  return instance(
    accountId,
    "project",
    String(p.id),
    p.name_with_namespace ?? p.path_with_namespace,
    {
      name: p.name,
      description: p.description ?? undefined,
      visibility: p.visibility,
      defaultBranch: p.default_branch ?? undefined,
      ciConfigPath: p.ci_config_path ?? undefined,
      pathWithNamespace: p.path_with_namespace,
      namespace: p.namespace?.full_path,
      namespaceId: nsKind === "group" && p.namespace?.id ? String(p.namespace.id) : undefined,
      archived: p.archived,
      openMergeRequests: extra.openMergeRequests,
      openIssues: p.open_issues_count,
      stars: p.star_count,
      forks: p.forks_count,
      storageBytes: p.statistics?.storage_size,
      lastActivityAt: p.last_activity_at,
      createdAt: p.created_at,
      projectId: String(p.id),
    },
    {
      projectId: String(p.id),
      pathWithNamespace: p.path_with_namespace,
      webUrl: p.web_url,
      httpCloneUrl: p.http_url_to_repo,
      sshCloneUrl: p.ssh_url_to_repo,
    },
  );
}

const projectParent = (projectId: number | string) => ({
  typeId: "project",
  externalId: String(projectId),
});

const parentOf = (s: Scope) => ({ typeId: s.kind, externalId: String(s.id) });

// ---------------------------------------------------------------------------
// CI/CD
// ---------------------------------------------------------------------------

export function mapPipeline(accountId: string, project: Scope, p: GlPipeline): ResourceInstance {
  const ref = shortRef(p.ref);
  return instance(
    accountId,
    "pipeline",
    `${project.id}/${p.id}`,
    `${project.path} #${p.iid ?? p.id}${ref ? ` (${ref})` : ""}`,
    {
      iid: p.iid,
      project: project.path,
      status: p.status,
      ref,
      sha: p.sha?.slice(0, 12),
      source: p.source,
      name: p.name ?? undefined,
      user: p.user?.username,
      durationSecs: p.duration ?? undefined,
      queuedSecs:
        p.queued_duration === null || p.queued_duration === undefined
          ? undefined
          : round(p.queued_duration),
      coverage: numberOrUndefined(p.coverage),
      createdAt: p.created_at,
      finishedAt: p.finished_at ?? undefined,
    },
    { pipelineId: String(p.id), webUrl: p.web_url },
    projectParent(project.id),
  );
}

export function mapEnvironment(
  accountId: string,
  project: Scope,
  e: GlEnvironment,
): ResourceInstance {
  const d = e.last_deployment ?? undefined;
  return instance(
    accountId,
    "environment",
    `${project.id}/${e.id}`,
    `${e.name} (${project.path})`,
    {
      name: e.name,
      externalUrl: e.external_url ?? undefined,
      tier: e.tier,
      description: e.description ?? undefined,
      state: e.state,
      project: project.path,
      lastDeploymentStatus: d?.status,
      lastDeploymentRef: d?.ref,
      lastDeployedAt: d?.finished_at ?? d?.created_at,
      lastDeployedBy: d?.user?.username,
      autoStopAt: e.auto_stop_at ?? undefined,
      kubernetesNamespace: e.kubernetes_namespace ?? undefined,
      createdAt: e.created_at,
    },
    { externalUrl: e.external_url ?? undefined, environmentId: String(e.id) },
    projectParent(project.id),
  );
}

export function mapProtectedBranch(
  accountId: string,
  project: Scope,
  b: GlProtectedBranch,
): ResourceInstance {
  return instance(
    accountId,
    "protected-branch",
    `${project.id}/${b.name}`,
    `${b.name} (${project.path})`,
    {
      name: b.name,
      pushAccess: describeLevels(b.push_access_levels),
      mergeAccess: describeLevels(b.merge_access_levels),
      allowForcePush: b.allow_force_push,
      codeOwnerApprovalRequired: b.code_owner_approval_required,
      inherited: b.inherited,
      project: project.path,
    },
    { name: b.name },
    projectParent(project.id),
  );
}

/**
 * Variables are keyed by key *and* environment scope (two variables may share
 * a key with different scopes), so both go into the external id. Keys are
 * `[A-Za-z0-9_]`, so the first slash after the owner id ends the key and
 * everything after it is the scope, which may itself contain slashes
 * (`review/*`). The value is never stored: GitLab returns it, but fields are
 * not a place for secrets.
 */
export function mapVariable(accountId: string, owner: Scope, v: GlVariable): ResourceInstance {
  const scope = v.environment_scope ?? "*";
  const typeId = owner.kind === "project" ? "project-variable" : "group-variable";
  return instance(
    accountId,
    typeId,
    `${owner.id}/${v.key}/${scope}`,
    scope === "*" ? `${v.key} (${owner.path})` : `${v.key} [${scope}] (${owner.path})`,
    {
      key: v.key,
      environmentScope: scope,
      variableType: v.variable_type ?? "env_var",
      protected: v.protected ?? false,
      masked: v.masked ?? false,
      hidden: v.hidden ?? false,
      raw: v.raw,
      description: v.description ?? undefined,
      [owner.kind]: scopeLabel(owner),
    },
    { key: v.key },
    parentOf(owner),
  );
}

export function mapSchedule(accountId: string, project: Scope, s: GlSchedule): ResourceInstance {
  return instance(
    accountId,
    "pipeline-schedule",
    `${project.id}/${s.id}`,
    `${s.description || `Schedule ${s.id}`} (${project.path})`,
    {
      description: s.description,
      cron: s.cron,
      cronTimezone: s.cron_timezone,
      ref: shortRef(s.ref),
      active: s.active,
      nextRunAt: s.active === false ? undefined : (s.next_run_at ?? undefined),
      owner: s.owner?.username,
      lastPipelineStatus: s.last_pipeline?.status,
      variables: list(s.variables?.map((v) => v.key)),
      project: project.path,
    },
    { scheduleId: String(s.id) },
    projectParent(project.id),
  );
}

export function mapContainerRepository(
  accountId: string,
  project: Scope,
  r: GlRegistryRepository,
): ResourceInstance {
  const path = r.path ?? r.name ?? String(r.id);
  return instance(
    accountId,
    "container-repository",
    `${project.id}/${r.id}`,
    path,
    {
      path,
      location: r.location,
      tagsCount: r.tags_count,
      sizeBytes: r.size,
      cleanupPolicyStartedAt: r.cleanup_policy_started_at ?? undefined,
      status: r.status ?? undefined,
      project: project.path,
      createdAt: r.created_at,
    },
    { location: r.location },
    projectParent(project.id),
  );
}

export function mapPackage(accountId: string, project: Scope, p: GlPackage): ResourceInstance {
  return instance(
    accountId,
    "package",
    `${project.id}/${p.id}`,
    p.version ? `${p.name}@${p.version}` : p.name,
    {
      name: p.name,
      version: p.version ?? undefined,
      packageType: p.package_type,
      status: p.status,
      pipelineStatus: p.pipeline?.status,
      lastDownloadedAt: p.last_downloaded_at ?? undefined,
      project: project.path,
      createdAt: p.created_at,
    },
    { name: p.name, version: p.version ?? undefined },
    projectParent(project.id),
  );
}

export function mapDeployKey(accountId: string, project: Scope, k: GlDeployKey): ResourceInstance {
  return instance(
    accountId,
    "deploy-key",
    `${project.id}/${k.id}`,
    `${k.title} (${project.path})`,
    {
      title: k.title,
      canPush: k.can_push ?? false,
      fingerprint: k.fingerprint_sha256 ?? k.fingerprint,
      expiresAt: k.expires_at ?? undefined,
      project: project.path,
      createdAt: k.created_at,
    },
    { fingerprint: k.fingerprint_sha256 ?? k.fingerprint },
    projectParent(project.id),
  );
}

export function mapDeployToken(
  accountId: string,
  owner: Scope,
  t: GlDeployToken,
): ResourceInstance {
  const typeId = owner.kind === "project" ? "deploy-token" : "group-deploy-token";
  return instance(
    accountId,
    typeId,
    `${owner.id}/${t.id}`,
    `${t.name} (${owner.path})`,
    {
      name: t.name,
      username: t.username,
      scopes: list(t.scopes),
      expiresAt: t.expires_at ?? undefined,
      revoked: t.revoked ?? false,
      expired: t.expired ?? false,
      [owner.kind]: scopeLabel(owner),
    },
    { username: t.username },
    parentOf(owner),
  );
}

/** Event flags, in the order GitLab's UI lists them, by their short name. */
export const HOOK_EVENTS = [
  "push",
  "tag_push",
  "merge_requests",
  "issues",
  "confidential_issues",
  "note",
  "confidential_note",
  "job",
  "pipeline",
  "deployment",
  "releases",
  "wiki_page",
  "milestone",
  "feature_flag",
  "subgroup",
  "member",
  "project",
] as const;

export const GROUP_ONLY_HOOK_EVENTS = new Set(["subgroup", "member", "project"]);

export function hookEvents(h: GlHook): string[] {
  const rec = h as unknown as Record<string, unknown>;
  return HOOK_EVENTS.filter((e) => rec[`${e}_events`] === true);
}

export function mapHook(accountId: string, owner: Scope, h: GlHook): ResourceInstance {
  const typeId = owner.kind === "project" ? "project-webhook" : "group-webhook";
  let host = h.url;
  try {
    host = new URL(h.url).host;
  } catch {
    // Keep the raw value.
  }
  return instance(
    accountId,
    typeId,
    `${owner.id}/${h.id}`,
    `${h.name || host} (${owner.path})`,
    {
      url: h.url,
      name: h.name ?? undefined,
      description: h.description ?? undefined,
      events: list(hookEvents(h)),
      pushEventsBranchFilter: h.push_events_branch_filter ?? undefined,
      enableSslVerification: h.enable_ssl_verification,
      tokenSet: h.token_present,
      alertStatus: h.alert_status,
      disabledUntil: h.disabled_until ?? undefined,
      createdAt: h.created_at,
      [owner.kind]: scopeLabel(owner),
    },
    { url: h.url },
    parentOf(owner),
  );
}

export function mapRelease(accountId: string, project: Scope, r: GlRelease): ResourceInstance {
  return instance(
    accountId,
    "release",
    `${project.id}/${r.tag_name}`,
    `${r.name || r.tag_name} (${project.path})`,
    {
      tagName: r.tag_name,
      name: r.name ?? undefined,
      description: r.description ?? undefined,
      releasedAt: r.released_at,
      upcoming: r.upcoming_release,
      author: r.author?.username,
      commit: r.commit?.short_id ?? r.commit?.id?.slice(0, 8),
      milestones: list(r.milestones?.map((m) => m.title)),
      assetCount: r.assets?.count,
      project: project.path,
      createdAt: r.created_at,
    },
    { tagName: r.tag_name, webUrl: r._links?.self },
    projectParent(project.id),
  );
}

export function mapMember(accountId: string, owner: Scope, m: GlMember): ResourceInstance {
  const typeId = owner.kind === "project" ? "project-member" : "group-member";
  return instance(
    accountId,
    typeId,
    `${owner.id}/${m.id}`,
    `${m.username} (${owner.path})`,
    {
      username: m.username,
      name: m.name,
      accessLevel: memberLevelName(m.access_level),
      expiresAt: m.expires_at ?? undefined,
      state: m.membership_state ?? m.state,
      customRole: m.member_role?.name,
      createdAt: m.created_at,
      [owner.kind]: scopeLabel(owner),
    },
    { username: m.username },
    parentOf(owner),
  );
}

export function runnerOwner(r: GlRunner): string | undefined {
  if (r.runner_type === "instance_type") return "Instance";
  if (r.groups && r.groups.length > 0) return list(r.groups.map((g) => g.name));
  if (r.projects && r.projects.length > 0)
    return list(r.projects.map((p) => p.path_with_namespace));
  return undefined;
}

export const RUNNER_TYPE_LABELS: Record<string, string> = {
  instance_type: "Instance",
  group_type: "Group",
  project_type: "Project",
};

export function mapRunner(accountId: string, r: GlRunner): ResourceInstance {
  return instance(
    accountId,
    "runner",
    String(r.id),
    r.description || r.name || `Runner #${r.id}`,
    {
      description: r.description ?? undefined,
      tagList: list(r.tag_list),
      paused: r.paused ?? (r.active === undefined ? undefined : !r.active),
      runUntagged: r.run_untagged,
      locked: r.locked,
      accessLevel: r.access_level,
      maximumTimeout: r.maximum_timeout ?? undefined,
      maintenanceNote: r.maintenance_note ?? undefined,
      runnerType: r.runner_type ? (RUNNER_TYPE_LABELS[r.runner_type] ?? r.runner_type) : undefined,
      status: r.status,
      busy: r.job_execution_status === undefined ? undefined : r.job_execution_status === "active",
      contactedAt: r.contacted_at ?? undefined,
      version: r.version ?? undefined,
      platform: [r.platform, r.architecture].filter(Boolean).join("/") || undefined,
      owner: runnerOwner(r),
      runnerId: String(r.id),
    },
    { runnerId: String(r.id) },
  );
}
