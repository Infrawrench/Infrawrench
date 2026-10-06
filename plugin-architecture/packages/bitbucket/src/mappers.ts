import type { ResourceInstance } from "@infrawrench/plugin-base";
import { WEB_BASE } from "./api.js";
import type {
  BbBranchRestriction,
  BbCache,
  BbDeployKey,
  BbDeployment,
  BbEnvironment,
  BbPipeline,
  BbProject,
  BbRepository,
  BbRunner,
  BbSchedule,
  BbState,
  BbVariable,
  BbWebhook,
  BbWorkspace,
} from "./types.js";

export const PLUGIN_ID = "bitbucket";

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

const list = (items: Array<string | undefined | null> | undefined): string | undefined => {
  const out = (items ?? []).filter((x): x is string => typeof x === "string" && x.length > 0);
  return out.length > 0 ? out.join(", ") : undefined;
};

/** `{abc}` -> `abc`, for display and URLs. */
export const bare = (uuid: string | undefined): string => (uuid ?? "").replace(/^\{|\}$/g, "");

/** The repository slug, from the API object or its full name. */
export function slugOf(r: Pick<BbRepository, "slug" | "full_name">): string {
  return r.slug ?? r.full_name.split("/").slice(1).join("/");
}

/**
 * One word for a pipeline, step or deployment state: the result when it has
 * finished (SUCCESSFUL, FAILED, ERROR, STOPPED, EXPIRED, NOT_RUN), the stage
 * while running (RUNNING, PAUSED), otherwise the state (PENDING).
 */
export function stateWord(s: BbState | undefined): string | undefined {
  return s?.result?.name ?? s?.stage?.name ?? s?.name;
}

const repoParent = (slug: string) => ({ typeId: "repository", externalId: slug });

export function mapWorkspace(
  accountId: string,
  w: BbWorkspace,
  extra: { members?: number; administrator?: boolean } = {},
): ResourceInstance {
  return instance(
    accountId,
    "workspace",
    w.slug,
    w.name ?? w.slug,
    {
      name: w.name,
      slug: w.slug,
      private: w.is_private,
      forkingMode: w.forking_mode,
      members: extra.members,
      administrator: extra.administrator,
      createdAt: w.created_on,
    },
    { slug: w.slug, uuid: w.uuid, webUrl: w.links?.html?.href ?? `${WEB_BASE}/${w.slug}` },
  );
}

export function mapProject(accountId: string, workspace: string, p: BbProject): ResourceInstance {
  return instance(
    accountId,
    "project",
    p.key,
    p.name ?? p.key,
    {
      name: p.name,
      key: p.key,
      description: p.description,
      private: p.is_private,
      publicRepos: p.has_publicly_visible_repos,
      updatedAt: p.updated_on,
      createdAt: p.created_on,
    },
    {
      key: p.key,
      webUrl: p.links?.html?.href ?? `${WEB_BASE}/${workspace}/workspace/projects/${p.key}`,
    },
  );
}

export function mapRepository(
  accountId: string,
  r: BbRepository,
  extra: { pipelinesEnabled?: boolean } = {},
): ResourceInstance {
  const clone = (name: string) => r.links?.clone?.find((c) => c.name === name)?.href;
  const slug = slugOf(r);
  return instance(
    accountId,
    "repository",
    slug,
    r.name,
    {
      name: r.name,
      description: r.description,
      private: r.is_private,
      project: r.project?.key,
      forkPolicy: r.fork_policy,
      mainBranch: r.mainbranch?.name,
      language: r.language,
      sizeBytes: r.size,
      pipelinesEnabled: extra.pipelinesEnabled,
      fullName: r.full_name,
      updatedAt: r.updated_on,
      createdAt: r.created_on,
    },
    {
      fullName: r.full_name,
      webUrl: r.links?.html?.href ?? `${WEB_BASE}/${r.full_name}`,
      // The HTTPS clone link embeds the caller's username; strip it.
      httpsCloneUrl: clone("https")?.replace(/^https:\/\/[^@/]+@/, "https://"),
      sshCloneUrl: clone("ssh"),
    },
  );
}

function selectorLabel(sel: { type?: string; pattern?: string } | undefined): string | undefined {
  if (!sel?.type) return undefined;
  if (sel.type === "default") return "default";
  return sel.pattern ? `${sel.type}: ${sel.pattern}` : sel.type;
}

export function pipelineDuration(p: BbPipeline): number | undefined {
  if (typeof p.duration_in_seconds === "number") return p.duration_in_seconds;
  const a = p.created_on ? Date.parse(p.created_on) : NaN;
  const b = p.completed_on ? Date.parse(p.completed_on) : NaN;
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / 1000) : undefined;
}

export function mapPipeline(
  accountId: string,
  workspace: string,
  slug: string,
  p: BbPipeline,
): ResourceInstance {
  const t = p.target;
  const ref = t?.ref_name ?? (t?.source ? `${t.source} → ${t.destination ?? ""}` : undefined);
  return instance(
    accountId,
    "pipeline",
    `${slug}/${p.uuid}`,
    `${slug} #${p.build_number ?? bare(p.uuid).slice(0, 8)}${t?.ref_name ? ` (${t.ref_name})` : ""}`,
    {
      buildNumber: p.build_number,
      repository: slug,
      state: p.state?.name,
      result: stateWord(p.state),
      refType: t?.ref_type ?? (t?.source ? "pullrequest" : undefined),
      refName: ref,
      commit: t?.commit?.hash?.slice(0, 12),
      selector: selectorLabel(t?.selector),
      trigger: p.trigger?.name,
      creator: p.creator?.display_name,
      buildSeconds: p.build_seconds_used,
      durationSecs: pipelineDuration(p),
      createdAt: p.created_on,
      completedAt: p.completed_on ?? undefined,
    },
    {
      pipelineUuid: p.uuid,
      webUrl: p.build_number
        ? `${WEB_BASE}/${workspace}/${slug}/pipelines/results/${p.build_number}`
        : undefined,
    },
    repoParent(slug),
  );
}

export type VariableOwner =
  | { kind: "repository"; slug: string }
  | { kind: "workspace" }
  | { kind: "deployment"; slug: string; envUuid: string; envName?: string };

export function mapVariable(
  accountId: string,
  owner: VariableOwner,
  v: BbVariable,
): ResourceInstance {
  switch (owner.kind) {
    case "repository":
      return instance(
        accountId,
        "repository-variable",
        `${owner.slug}/${v.uuid}`,
        `${v.key} (${owner.slug})`,
        { key: v.key, secured: v.secured ?? false, repository: owner.slug },
        { key: v.key },
        repoParent(owner.slug),
      );
    case "workspace":
      return instance(
        accountId,
        "workspace-variable",
        v.uuid,
        v.key,
        { key: v.key, secured: v.secured ?? false },
        { key: v.key },
      );
    case "deployment":
      return instance(
        accountId,
        "deployment-variable",
        `${owner.slug}/${owner.envUuid}/${v.uuid}`,
        `${v.key} (${owner.envName ?? "environment"}, ${owner.slug})`,
        {
          key: v.key,
          secured: v.secured ?? false,
          environment: owner.envName,
          repository: owner.slug,
        },
        { key: v.key },
        { typeId: "environment", externalId: `${owner.slug}/${owner.envUuid}` },
      );
  }
}

export function deploymentStatus(d: BbDeployment | undefined): string | undefined {
  if (!d?.state) return undefined;
  return d.state.status?.name ?? d.state.name;
}

export function mapEnvironment(
  accountId: string,
  slug: string,
  e: BbEnvironment,
  last?: BbDeployment,
): ResourceInstance {
  return instance(
    accountId,
    "environment",
    `${slug}/${e.uuid}`,
    `${e.name} (${slug})`,
    {
      name: e.name,
      environmentType: e.environment_type?.name,
      adminOnly: e.restrictions?.admin_only,
      locked: e.lock
        ? e.lock.name === "LOCKED" || e.lock.type === "deployment_environment_lock_locked"
        : undefined,
      hidden: e.hidden,
      lastDeploymentStatus: deploymentStatus(last),
      lastDeployedAt:
        last?.state?.completion_date ?? last?.state?.start_date ?? last?.last_update_time,
      lastDeployedBy: last?.state?.deployer?.display_name,
      lastRelease: last?.release?.name,
      repository: slug,
    },
    { environmentUuid: e.uuid },
    repoParent(slug),
  );
}

/** Branch restriction kinds, in Bitbucket's own words. */
export const RESTRICTION_KINDS: Record<
  string,
  { label: string; takesValue?: boolean; takesExemptions?: boolean }
> = {
  push: { label: "Restrict pushes", takesExemptions: true },
  restrict_merges: { label: "Restrict merges via pull request", takesExemptions: true },
  force: { label: "Block force push" },
  delete: { label: "Block branch deletion" },
  require_approvals_to_merge: { label: "Minimum approvals", takesValue: true },
  require_default_reviewer_approvals_to_merge: {
    label: "Minimum default reviewer approvals",
    takesValue: true,
  },
  require_review_group_approvals_to_merge: { label: "Review group approvals", takesValue: true },
  require_passing_builds_to_merge: { label: "Minimum successful builds", takesValue: true },
  require_commits_behind: { label: "Maximum commits behind", takesValue: true },
  require_tasks_to_be_completed: { label: "No open tasks" },
  require_no_changes_requested: { label: "No changes requested" },
  require_all_dependencies_merged: { label: "All dependencies merged" },
  require_all_comments_resolved: { label: "All comments resolved" },
  reset_pullrequest_approvals_on_change: { label: "Reset approvals on change" },
  smart_reset_pullrequest_approvals: { label: "Reset approvals on source change" },
  reset_pullrequest_changes_requested_on_change: { label: "Reset requested changes on change" },
  enforce_merge_checks: { label: "Prevent merge with unresolved checks (Premium)" },
  allow_auto_merge_when_builds_pass: { label: "Allow auto-merge when builds pass" },
};

export function restrictionMatch(b: BbBranchRestriction): string | undefined {
  if (b.branch_match_kind === "branching_model")
    return b.branch_type ? `${b.branch_type} branches` : undefined;
  return b.pattern;
}

export function mapBranchRestriction(
  accountId: string,
  slug: string,
  b: BbBranchRestriction,
): ResourceInstance {
  const label = RESTRICTION_KINDS[b.kind]?.label ?? b.kind;
  const match = restrictionMatch(b);
  return instance(
    accountId,
    "branch-restriction",
    `${slug}/${b.id}`,
    `${label}: ${match ?? "?"} (${slug})`,
    {
      kind: b.kind,
      match: b.branch_match_kind,
      pattern: match,
      value: b.value ?? undefined,
      users: list(b.users?.map((u) => u.display_name)),
      groups: list(b.groups?.map((g) => g.name ?? g.slug)),
      repository: slug,
    },
    { restrictionId: String(b.id) },
    repoParent(slug),
  );
}

export function mapWebhook(
  accountId: string,
  slug: string | undefined,
  h: WebhookLike,
): ResourceInstance {
  let host = h.url;
  try {
    host = new URL(h.url).host;
  } catch {
    // keep raw
  }
  const fields = {
    url: h.url,
    description: h.description,
    active: h.active,
    events: list(h.events),
    secretSet: h.secret_set,
    createdAt: h.created_at,
  };
  if (!slug) {
    return instance(accountId, "workspace-webhook", h.uuid, h.description || host, fields, {
      url: h.url,
    });
  }
  return instance(
    accountId,
    "repository-webhook",
    `${slug}/${h.uuid}`,
    `${h.description || host} (${slug})`,
    { ...fields, repository: slug },
    { url: h.url },
    repoParent(slug),
  );
}
type WebhookLike = BbWebhook;

function keyType(key: string | undefined): string | undefined {
  return key?.trim().split(/\s+/)[0];
}

export function mapDeployKey(accountId: string, slug: string, k: BbDeployKey): ResourceInstance {
  return instance(
    accountId,
    "deploy-key",
    `${slug}/${k.id}`,
    `${k.label ?? k.id} (${slug})`,
    {
      label: k.label,
      comment: k.comment,
      keyType: keyType(k.key),
      lastUsedAt: k.last_used ?? undefined,
      createdAt: k.added_on,
      repository: slug,
    },
    { label: k.label },
    repoParent(slug),
  );
}

export function mapProjectDeployKey(
  accountId: string,
  projectKey: string,
  k: BbDeployKey,
): ResourceInstance {
  return instance(
    accountId,
    "project-deploy-key",
    `${projectKey}/${k.id}`,
    `${k.label ?? k.id} (${projectKey})`,
    {
      label: k.label,
      comment: k.comment,
      keyType: keyType(k.key),
      lastUsedAt: k.last_used ?? undefined,
      createdAt: k.added_on,
      project: projectKey,
    },
    { label: k.label },
    { typeId: "project", externalId: projectKey },
  );
}

/** Runner external ids: `workspace/<uuid>` or `repo:<slug>/<uuid>`. */
export function runnerExternalId(slug: string | undefined, uuid: string): string {
  return slug ? `repo:${slug}/${uuid}` : `workspace/${uuid}`;
}

export function parseRunnerId(id: string): { slug?: string; uuid: string } {
  if (id.startsWith("repo:")) {
    const rest = id.slice(5);
    const i = rest.indexOf("/");
    return { slug: rest.slice(0, i), uuid: rest.slice(i + 1) };
  }
  return { uuid: id.replace(/^workspace\//, "") };
}

export function mapRunner(
  accountId: string,
  slug: string | undefined,
  r: BbRunner,
): ResourceInstance {
  return instance(
    accountId,
    "runner",
    runnerExternalId(slug, r.uuid),
    r.name,
    {
      name: r.name,
      labels: list(r.labels),
      status: r.state?.status,
      scope: slug ? `Repository ${slug}` : "Workspace",
      version: r.state?.version?.version,
      latestVersion: r.state?.version?.current,
      cordoned: r.state?.cordoned,
      stateUpdatedAt: r.state?.updated_on,
      createdAt: r.created_on,
    },
    { runnerUuid: r.uuid },
  );
}

export function mapSchedule(accountId: string, slug: string, s: BbSchedule): ResourceInstance {
  const sel = selectorLabel(s.target?.selector);
  return instance(
    accountId,
    "pipeline-schedule",
    `${slug}/${s.uuid}`,
    `${s.cron_pattern ?? "Schedule"} on ${s.target?.ref_name ?? "?"} (${slug})`,
    {
      cron: s.cron_pattern,
      refName: s.target?.ref_name,
      selector: sel,
      enabled: s.enabled,
      repository: slug,
      updatedAt: s.updated_on,
      createdAt: s.created_on,
    },
    { scheduleUuid: s.uuid },
    repoParent(slug),
  );
}

export function mapCache(accountId: string, slug: string, c: BbCache): ResourceInstance {
  return instance(
    accountId,
    "pipeline-cache",
    `${slug}/${c.uuid}`,
    `${c.name ?? "cache"} (${slug})`,
    {
      name: c.name,
      path: c.path,
      sizeBytes: c.file_size_bytes,
      repository: slug,
      createdAt: c.created_on,
    },
    { name: c.name },
    repoParent(slug),
  );
}
