import type { ResourceInstance } from "@infrawrench/plugin-base";
import type {
  DevinAutomation,
  DevinNote,
  DevinOrg,
  DevinPlaybook,
  DevinSecret,
  DevinSession,
  DevinUser,
} from "./api.js";
import { APP_BASE } from "./api.js";
import { roundMoney } from "./pricing.js";

export const PLUGIN_ID = "devin";

/** Resolved-output keys the renderer reads; not declared outputs, so never shown as such. */
export const PULL_REQUESTS_KEY = "__pullRequests__";
export const SUMMARY_KEY = "__summary__";

type FieldValue = string | number | boolean | undefined | null;

export function instance(
  accountId: string,
  typeId: string,
  externalId: string,
  displayName: string,
  fields: Record<string, FieldValue>,
  outputs: Record<string, string | undefined> = {},
): ResourceInstance {
  const now = new Date().toISOString();
  const clean: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && v !== null && v !== "") clean[k] = v;
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
    createdAt: now,
    updatedAt: now,
  };
}

/** `<org_id>/<id>` split back apart. Org ids (`org-…`) never contain a slash. */
export function parseScopedId(externalId: string): { orgId: string; id: string } {
  const slash = externalId.indexOf("/");
  if (slash <= 0) throw new Error(`Devin plugin: malformed id "${externalId}"`);
  return { orgId: externalId.slice(0, slash), id: externalId.slice(slash + 1) };
}

export const scopedId = (orgId: string, id: string) => `${orgId}/${id}`;

/** Unix seconds as ISO 8601. */
export function isoTime(seconds: number | null | undefined): string | undefined {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return undefined;
  return new Date(seconds * 1000).toISOString();
}

const round = (n: number, digits = 2) => Math.round(n * 10 ** digits) / 10 ** digits;

export const orgLabel = (org: DevinOrg) => org.name || org.org_id;

function orgFields(org: DevinOrg) {
  return { orgName: orgLabel(org), orgId: org.org_id };
}

/** How a user is named in tags and on screen: name, then email, then id. */
export function userLabel(
  user: Pick<DevinUser, "user_id" | "name" | "email"> | undefined,
  id?: string,
) {
  return user?.name || user?.email || user?.user_id || id || "";
}

export const ACTIVE_STATUSES = new Set(["new", "claimed", "running", "suspended", "resuming"]);

export function mapOrganization(
  accountId: string,
  org: DevinOrg,
  month?: { acus: number; cost: number },
): ResourceInstance {
  return instance(
    accountId,
    "organization",
    org.org_id,
    orgLabel(org),
    {
      name: orgLabel(org),
      orgId: org.org_id,
      sessionAcuLimit: org.max_session_acu_limit ?? undefined,
      cycleAcuLimit: org.max_cycle_acu_limit ?? undefined,
      monthAcus: month ? round(month.acus) : undefined,
      monthCost: month ? round(month.cost) : undefined,
    },
    { orgId: org.org_id },
  );
}

export interface SessionLookups {
  users: Map<string, DevinUser>;
  playbooks: Map<string, DevinPlaybook>;
}

export function mapSession(
  accountId: string,
  org: DevinOrg,
  s: DevinSession,
  acuPrice: number,
  lookups: SessionLookups,
): ResourceInstance {
  const prs = s.pull_requests ?? [];
  const acus = typeof s.acus_consumed === "number" ? s.acus_consumed : undefined;
  const user = s.user_id ? lookups.users.get(s.user_id) : undefined;
  const playbook = s.playbook_id ? lookups.playbooks.get(s.playbook_id) : undefined;
  const startedBy = s.user_id
    ? userLabel(user, s.user_id)
    : s.service_user_id
      ? `Service user ${s.service_user_id}`
      : undefined;
  return instance(
    accountId,
    "session",
    scopedId(org.org_id, s.session_id),
    s.title || s.session_id,
    {
      title: s.title,
      tags: (s.tags ?? []).join(", "),
      status: s.status,
      statusDetail: s.status_detail,
      acus: acus !== undefined ? round(acus) : undefined,
      estimatedCost: acus !== undefined ? round(roundMoney(acus * acuPrice)) : undefined,
      user: startedBy,
      userId: s.user_id,
      serviceUserId: s.service_user_id,
      playbookId: s.playbook_id,
      playbook: playbook?.title ?? s.playbook_id,
      origin: s.origin,
      category: s.category,
      mode: s.devin_mode,
      pullRequests: prs.length,
      pullRequestsMerged: prs.filter((p) => (p.pr_state ?? "").toLowerCase() === "merged").length,
      archived: s.is_archived ?? false,
      createdAt: isoTime(s.created_at),
      updatedAt: isoTime(s.updated_at),
      sessionId: s.session_id,
      ...orgFields(org),
    },
    {
      sessionId: s.session_id,
      url: s.url || `${APP_BASE}/sessions/${s.session_id}`,
      [PULL_REQUESTS_KEY]: prs.length
        ? JSON.stringify(prs.map((p) => ({ url: p.pr_url, state: p.pr_state ?? "" })))
        : undefined,
    },
  );
}

export function mapPlaybook(accountId: string, org: DevinOrg, p: DevinPlaybook): ResourceInstance {
  return instance(
    accountId,
    "playbook",
    scopedId(org.org_id, p.playbook_id),
    p.title || p.playbook_id,
    {
      title: p.title,
      macro: p.macro,
      body: p.body,
      structuredOutputSchema: p.structured_output_schema
        ? JSON.stringify(p.structured_output_schema)
        : undefined,
      accessType: p.access_type,
      updatedAt: isoTime(p.updated_at),
      playbookId: p.playbook_id,
      ...orgFields(org),
    },
    { playbookId: p.playbook_id },
  );
}

export function mapNote(accountId: string, org: DevinOrg, n: DevinNote): ResourceInstance {
  return instance(
    accountId,
    "knowledge-note",
    scopedId(org.org_id, n.note_id),
    n.name || n.note_id,
    {
      name: n.name,
      trigger: n.trigger,
      body: n.body,
      enabled: n.is_enabled ?? true,
      pinnedRepo: n.pinned_repo,
      folder: n.folder_path,
      accessType: n.access_type,
      updatedAt: isoTime(n.updated_at),
      noteId: n.note_id,
      ...orgFields(org),
    },
    { noteId: n.note_id },
  );
}

export function mapSecret(accountId: string, org: DevinOrg, s: DevinSecret): ResourceInstance {
  return instance(
    accountId,
    "secret",
    scopedId(org.org_id, s.secret_id),
    s.key || s.secret_id,
    {
      key: s.key ?? s.secret_id,
      secretType: s.secret_type,
      note: s.note,
      sensitive: s.is_sensitive ?? false,
      accessType: s.access_type,
      createdBy: s.created_by,
      createdAt: isoTime(s.created_at),
      updatedAt: isoTime(s.updated_at),
      secretId: s.secret_id,
      ...orgFields(org),
    },
    { secretId: s.secret_id },
  );
}

export function mapMember(
  accountId: string,
  org: DevinOrg,
  u: DevinUser,
  usage?: { acus: number; cost: number },
): ResourceInstance {
  const roles = [
    ...new Set(
      (u.role_assignments ?? [])
        .filter((r) => !r.org_id || r.org_id === org.org_id)
        .map((r) => r.role?.role_name)
        .filter((r): r is string => !!r),
    ),
  ];
  return instance(
    accountId,
    "member",
    scopedId(org.org_id, u.user_id),
    userLabel(u),
    {
      name: u.name,
      email: u.email,
      roles: roles.join(", "),
      acus30d: usage ? round(usage.acus) : undefined,
      cost30d: usage ? round(usage.cost) : undefined,
      userId: u.user_id,
      ...orgFields(org),
    },
    { userId: u.user_id, email: u.email ?? undefined },
  );
}

export function mapAutomation(
  accountId: string,
  org: DevinOrg,
  a: DevinAutomation,
): ResourceInstance {
  const triggers = [
    ...new Set((a.triggers ?? []).map((t) => t.event_type).filter((t): t is string => !!t)),
  ];
  return instance(
    accountId,
    "automation",
    scopedId(org.org_id, a.automation_id),
    a.name || a.automation_id,
    {
      name: a.name,
      enabled: a.enabled ?? false,
      triggers: triggers.join(", "),
      lastRunAt: isoTime(a.last_invocation?.fired_at),
      lastRunStatus: a.last_invocation?.status,
      nextRunAt: isoTime(a.next_run_at),
      createdBy: a.created_by?.name ?? a.created_by?.id,
      automationId: a.automation_id,
      ...orgFields(org),
    },
    { automationId: a.automation_id },
  );
}
