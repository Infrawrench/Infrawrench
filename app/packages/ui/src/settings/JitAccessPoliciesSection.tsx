import { useCallback, useEffect, useMemo, useState } from "react";
import { T, Var, useGT } from "gt-react";
import {
  JIT_LIMITS,
  formatGrantDuration,
  type JitAccessAccount,
  type JitPickerOption,
  type JitPolicy,
  type JitPolicyInput,
  type JitPolicyTarget,
  type OnCallSchedule,
} from "@infrawrench/client-core";

import type { TeamMember } from "../api-types.js";
import { useSettingsHost } from "./host.js";
import { useDataString } from "../i18n/data-strings.js";
import { CARD, INPUT, LABEL, PRIMARY_BUTTON, SECONDARY_BUTTON } from "./styles.js";

interface RoleOption {
  id: string;
  name: string;
}

const DURATION_CHOICES = [15, 30, 60, 120, 240, 480, 720];
const TIMEOUT_CHOICES = [15, 30, 60, 120, 240, 480, 1440];

/**
 * Just-in-time access policies: which provider roles people may ask for, on
 * which account, for how long, who may ask and who must approve.
 *
 * Every id in a policy comes from a picker: scopes and roles are read from the
 * provider through the account's plugin, approvers from the team, roles and
 * on-call rotations. Nobody types an ARN.
 */
export function JitAccessPoliciesSection() {
  const gt = useGT();
  const { orgId, api, has, permissionsLoading } = useSettingsHost();
  const canRead = has("access:read");
  const canWrite = has("org:settings:write");
  const base = `/api/org/${orgId}/jit-access`;

  const [policies, setPolicies] = useState<JitPolicy[] | null>(null);
  const [accounts, setAccounts] = useState<JitAccessAccount[]>([]);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [roles, setRoles] = useState<RoleOption[]>([]);
  const [schedules, setSchedules] = useState<OnCallSchedule[]>([]);
  const [editing, setEditing] = useState<JitPolicy | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [p, a] = await Promise.all([
        api.get<JitPolicy[]>(`${base}/policies`),
        api.get<JitAccessAccount[]>(`${base}/accounts`),
      ]);
      setPolicies(p);
      setAccounts(a);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Could not load policies"));
    }
  }, [api, base, gt]);

  useEffect(() => {
    if (!canRead) return;
    void load();
  }, [canRead, load]);

  useEffect(() => {
    if (!canWrite) return;
    // Pickers for the editor; each failing alone only empties its own list.
    api
      .get<TeamMember[]>(`/api/org/${orgId}/team/members`)
      .then(setMembers)
      .catch(() => setMembers([]));
    api
      .get<RoleOption[]>(`/api/org/${orgId}/team/roles`)
      .then(setRoles)
      .catch(() => setRoles([]));
    api
      .get<{ schedules: OnCallSchedule[] }>(`/api/org/${orgId}/on-call/schedules`)
      .then((r) => setSchedules(r.schedules))
      .catch(() => setSchedules([]));
  }, [api, orgId, canWrite]);

  if (permissionsLoading) return <p className="text-sm text-on-surface-faint">{gt("Loading…")}</p>;

  if (!canRead) {
    return (
      <T>
        <p className="text-sm text-on-surface-muted">
          Your role does not include{" "}
          <Var>
            <code>access:read</code>
          </Var>
          , so you cannot see just-in-time access policies.
        </p>
      </T>
    );
  }

  const nameOf = (id: string) => {
    const m = members.find((x) => x.id === id);
    return m ? (m.displayName ?? m.email) : id;
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-on-surface">{gt("Just-in-time access")}</h1>
        <p className="text-sm text-on-surface-muted max-w-2xl">
          {gt(
            "Policies decide which cloud roles members may request, for how long, and who approves. Grants are made and removed by the account's provider when a request is approved and when its time is up.",
          )}
        </p>
      </div>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}

      {editing ? (
        <PolicyEditor
          key={editing === "new" ? "new" : editing.id}
          initial={editing === "new" ? null : editing}
          accounts={accounts}
          members={members}
          roles={roles}
          schedules={schedules}
          onCancel={() => setEditing(null)}
          onSave={async (input) => {
            if (editing === "new") await api.post(`${base}/policies`, input);
            else await api.put(`${base}/policies/${encodeURIComponent(editing.id)}`, input);
            setEditing(null);
            await load();
          }}
        />
      ) : (
        canWrite && (
          <div>
            <button
              type="button"
              className={PRIMARY_BUTTON}
              disabled={accounts.length === 0}
              onClick={() => setEditing("new")}
            >
              {gt("New policy")}
            </button>
            {policies !== null && accounts.length === 0 && (
              <p className="text-sm text-on-surface-muted mt-2">
                {gt(
                  "None of your connected accounts support just-in-time access yet. AWS (IAM Identity Center), Google Cloud and Kubernetes accounts do.",
                )}
              </p>
            )}
          </div>
        )
      )}

      {policies === null ? (
        <p className="text-sm text-on-surface-faint">{gt("Loading…")}</p>
      ) : policies.length === 0 ? (
        <p className="text-sm text-on-surface-muted">{gt("No policies yet.")}</p>
      ) : (
        <ul className="border border-border rounded-xl divide-y divide-border overflow-hidden">
          {policies.map((p) => (
            <li key={p.id} className="p-4 space-y-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-on-surface">{p.name}</span>
                  {!p.enabled && (
                    <span className="px-2 py-0.5 rounded-full text-xs bg-surface-overlay text-on-surface-tertiary">
                      {gt("Off")}
                    </span>
                  )}
                </div>
                {canWrite && (
                  <div className="flex gap-2">
                    <button
                      type="button"
                      className={SECONDARY_BUTTON}
                      onClick={() => setEditing(p)}
                    >
                      {gt("Edit")}
                    </button>
                    <button
                      type="button"
                      className={SECONDARY_BUTTON}
                      onClick={async () => {
                        if (
                          !window.confirm(
                            gt(
                              "Delete this policy? Grants it already made still end on time; its pending requests will time out.",
                            ),
                          )
                        ) {
                          return;
                        }
                        try {
                          await api.delete(`${base}/policies/${encodeURIComponent(p.id)}`);
                          await load();
                        } catch (e) {
                          setError(e instanceof Error ? e.message : gt("Could not delete"));
                        }
                      }}
                    >
                      {gt("Delete")}
                    </button>
                  </div>
                )}
              </div>
              <p className="text-sm text-on-surface-secondary">
                {p.accountName ?? p.accountId}
                {" · "}
                {p.targets.map((t) => `${t.roleName} · ${t.scopeName}`).join(", ")}
              </p>
              <p className="text-xs text-on-surface-tertiary">
                {gt("Up to {duration} · approvers: {approvers}", {
                  duration: formatGrantDuration(p.maxDurationMinutes),
                  approvers:
                    [
                      ...p.approverUserIds.map(nameOf),
                      ...p.approverRoleIds.map((id) => roles.find((r) => r.id === id)?.name ?? id),
                      ...p.approverOnCallScheduleIds.map(
                        (id) =>
                          `${schedules.find((s) => s.id === id)?.name ?? id} (${gt("on call")})`,
                      ),
                    ].join(", ") || "—",
                })}
                {p.allowSelfApprovalDuringIncident
                  ? ` · ${gt("self-approval during an incident")}`
                  : ""}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function toggle(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}

function CheckList({
  legend,
  options,
  selected,
  onChange,
}: {
  legend: string;
  options: Array<{ id: string; label: string }>;
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const gt = useGT();
  return (
    <fieldset>
      <legend className={LABEL}>{legend}</legend>
      {options.length === 0 ? (
        <p className="text-xs text-on-surface-faint">{gt("Nothing to pick from.")}</p>
      ) : (
        <div className="max-h-40 overflow-y-auto border border-border rounded-lg p-2 space-y-1">
          {options.map((o) => (
            <label key={o.id} className="flex items-center gap-2 text-sm text-on-surface-secondary">
              <input
                type="checkbox"
                checked={selected.includes(o.id)}
                onChange={() => onChange(toggle(selected, o.id))}
              />
              {o.label}
            </label>
          ))}
        </div>
      )}
    </fieldset>
  );
}

function PolicyEditor({
  initial,
  accounts,
  members,
  roles,
  schedules,
  onCancel,
  onSave,
}: {
  initial: JitPolicy | null;
  accounts: JitAccessAccount[];
  members: TeamMember[];
  roles: RoleOption[];
  schedules: OnCallSchedule[];
  onCancel: () => void;
  onSave: (input: JitPolicyInput) => Promise<void>;
}) {
  const gt = useGT();
  const ds = useDataString();
  const { orgId, api } = useSettingsHost();
  const base = `/api/org/${orgId}/jit-access`;
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [accountId, setAccountId] = useState(initial?.accountId ?? accounts[0]?.id ?? "");
  const [targets, setTargets] = useState<JitPolicyTarget[]>(initial?.targets ?? []);
  const [maxDuration, setMaxDuration] = useState(initial?.maxDurationMinutes ?? 240);
  const [defaultDuration, setDefaultDuration] = useState(initial?.defaultDurationMinutes ?? 60);
  const [timeout, setTimeoutMinutes] = useState(initial?.requestTimeoutMinutes ?? 60);
  const [requesterUserIds, setRequesterUserIds] = useState(initial?.requesterUserIds ?? []);
  const [requesterRoleIds, setRequesterRoleIds] = useState(initial?.requesterRoleIds ?? []);
  const [approverUserIds, setApproverUserIds] = useState(initial?.approverUserIds ?? []);
  const [approverRoleIds, setApproverRoleIds] = useState(initial?.approverRoleIds ?? []);
  const [approverSchedules, setApproverSchedules] = useState(
    initial?.approverOnCallScheduleIds ?? [],
  );
  const [selfApproval, setSelfApproval] = useState(
    initial?.allowSelfApprovalDuringIncident ?? false,
  );
  const [requireReason, setRequireReason] = useState(initial?.requireReason ?? true);
  const [requireTicket, setRequireTicket] = useState(initial?.requireTicket ?? false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Target pickers, read from the provider through the plugin.
  const [scopes, setScopes] = useState<JitPickerOption[] | null>(null);
  const [scopeId, setScopeId] = useState("");
  const [roleOptions, setRoleOptions] = useState<JitPickerOption[] | null>(null);
  const [roleId, setRoleId] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [pickerError, setPickerError] = useState<string | null>(null);
  const account = accounts.find((a) => a.id === accountId) ?? null;

  useEffect(() => {
    if (!accountId) return;
    setScopes(null);
    setScopeId("");
    setPickerError(null);
    let cancelled = false;
    api
      .get<JitPickerOption[]>(`${base}/accounts/${encodeURIComponent(accountId)}/scopes`)
      .then((s) => {
        if (!cancelled) setScopes(s);
      })
      .catch((e: unknown) => {
        if (!cancelled) setPickerError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [api, base, accountId]);

  useEffect(() => {
    if (!accountId || !scopeId) return;
    setRoleOptions(null);
    setRoleId("");
    let cancelled = false;
    api
      .get<JitPickerOption[]>(
        `${base}/accounts/${encodeURIComponent(accountId)}/roles?scopeId=${encodeURIComponent(scopeId)}`,
      )
      .then((r) => {
        if (!cancelled) setRoleOptions(r);
      })
      .catch((e: unknown) => {
        if (!cancelled) setPickerError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [api, base, accountId, scopeId]);

  const filteredRoles = useMemo(() => {
    const needle = roleFilter.trim().toLowerCase();
    const all = roleOptions ?? [];
    return (
      needle
        ? all.filter((r) => `${r.name} ${r.description ?? ""}`.toLowerCase().includes(needle))
        : all
    ).slice(0, 300);
  }, [roleOptions, roleFilter]);

  function addTarget() {
    const scope = scopes?.find((s) => s.id === scopeId);
    const role = roleOptions?.find((r) => r.id === roleId);
    if (!scope || !role) return;
    if (targets.some((t) => t.scopeId === scope.id && t.roleId === role.id)) return;
    setTargets([
      ...targets,
      { scopeId: scope.id, scopeName: scope.name, roleId: role.id, roleName: role.name },
    ]);
    setRoleId("");
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await onSave({
        name: name.trim(),
        description: description.trim() || null,
        enabled,
        accountId,
        targets,
        maxDurationMinutes: maxDuration,
        defaultDurationMinutes: Math.min(defaultDuration, maxDuration),
        requestTimeoutMinutes: timeout,
        requesterUserIds,
        requesterRoleIds,
        approverUserIds,
        approverRoleIds,
        approverOnCallScheduleIds: approverSchedules,
        allowSelfApprovalDuringIncident: selfApproval,
        requireReason,
        requireTicket,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Could not save the policy"));
    } finally {
      setSaving(false);
    }
  }

  const memberOptions = members.map((m) => ({ id: m.id, label: m.displayName ?? m.email }));
  const roleChoices = roles.map((r) => ({ id: r.id, label: r.name }));
  const approverCount = approverUserIds.length + approverRoleIds.length + approverSchedules.length;

  return (
    <form
      className={`${CARD} space-y-5`}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className={LABEL}>{gt("Name")}</span>
          <input
            className={INPUT}
            value={name}
            maxLength={JIT_LIMITS.maxNameLength}
            onChange={(e) => setName(e.target.value)}
            placeholder={gt("Production admin for on-call")}
          />
        </label>
        <label className="block">
          <span className={LABEL}>{gt("Account")}</span>
          <select
            className={INPUT}
            value={accountId}
            onChange={(e) => {
              setAccountId(e.target.value);
              setTargets([]);
            }}
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.displayName}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="block">
        <span className={LABEL}>{gt("Description")}</span>
        <input
          className={INPUT}
          value={description}
          maxLength={JIT_LIMITS.maxDescriptionLength}
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>
      {account?.labels.description && (
        <p className="text-xs text-on-surface-tertiary">{ds(account.labels.description)}</p>
      )}

      <fieldset className="space-y-2">
        <legend className={LABEL}>{gt("What may be requested")}</legend>
        {targets.length > 0 && (
          <ul className="space-y-1">
            {targets.map((t) => (
              <li
                key={`${t.scopeId}:${t.roleId}`}
                className="flex items-center justify-between text-sm text-on-surface-secondary"
              >
                <span>{`${t.roleName} · ${t.scopeName}`}</span>
                <button
                  type="button"
                  className="text-xs text-danger"
                  onClick={() => setTargets(targets.filter((x) => x !== t))}
                >
                  {gt("Remove")}
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="grid gap-2 sm:grid-cols-3">
          <select
            className={INPUT}
            value={scopeId}
            onChange={(e) => setScopeId(e.target.value)}
            aria-label={account ? ds(account.labels.scopeLabel) : gt("Scope")}
          >
            <option value="">
              {scopes === null
                ? gt("Loading…")
                : gt("Pick a {label}", {
                    label: account ? ds(account.labels.scopeLabel) : gt("scope"),
                  })}
            </option>
            {(scopes ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.description && s.description !== s.name
                  ? `${s.name} (${s.description})`
                  : s.name}
              </option>
            ))}
          </select>
          <div className="space-y-1">
            <input
              className={INPUT}
              value={roleFilter}
              onChange={(e) => setRoleFilter(e.target.value)}
              placeholder={gt("Filter roles")}
              aria-label={gt("Filter roles")}
              disabled={!scopeId}
            />
            <select
              className={INPUT}
              value={roleId}
              onChange={(e) => setRoleId(e.target.value)}
              aria-label={account ? ds(account.labels.roleLabel) : gt("Role")}
              disabled={!scopeId}
            >
              <option value="">
                {scopeId && roleOptions === null
                  ? gt("Loading…")
                  : gt("Pick a {label}", {
                      label: account ? ds(account.labels.roleLabel) : gt("role"),
                    })}
              </option>
              {filteredRoles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.privileged ? `${r.name} ⚠` : r.name}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            className={SECONDARY_BUTTON}
            disabled={!scopeId || !roleId || targets.length >= JIT_LIMITS.maxTargets}
            onClick={addTarget}
          >
            {gt("Add")}
          </button>
        </div>
        {pickerError && <p className="text-xs text-danger break-words">{pickerError}</p>}
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-3">
        <label className="block">
          <span className={LABEL}>{gt("Longest window")}</span>
          <select
            className={INPUT}
            value={maxDuration}
            onChange={(e) => setMaxDuration(Number(e.target.value))}
          >
            {DURATION_CHOICES.map((m) => (
              <option key={m} value={m}>
                {formatGrantDuration(m)}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className={LABEL}>{gt("Default window")}</span>
          <select
            className={INPUT}
            value={defaultDuration}
            onChange={(e) => setDefaultDuration(Number(e.target.value))}
          >
            {DURATION_CHOICES.filter((m) => m <= maxDuration).map((m) => (
              <option key={m} value={m}>
                {formatGrantDuration(m)}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className={LABEL}>{gt("Undecided requests time out after")}</span>
          <select
            className={INPUT}
            value={timeout}
            onChange={(e) => setTimeoutMinutes(Number(e.target.value))}
          >
            {TIMEOUT_CHOICES.map((m) => (
              <option key={m} value={m}>
                {formatGrantDuration(m)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <CheckList
          legend={gt("Who may request: members (none picked means everyone)")}
          options={memberOptions}
          selected={requesterUserIds}
          onChange={setRequesterUserIds}
        />
        <CheckList
          legend={gt("Who may request: roles")}
          options={roleChoices}
          selected={requesterRoleIds}
          onChange={setRequesterRoleIds}
        />
        <CheckList
          legend={gt("Approvers: members")}
          options={memberOptions}
          selected={approverUserIds}
          onChange={setApproverUserIds}
        />
        <CheckList
          legend={gt("Approvers: roles")}
          options={roleChoices}
          selected={approverRoleIds}
          onChange={setApproverRoleIds}
        />
        <CheckList
          legend={gt("Approvers: whoever is on call")}
          options={schedules.map((s) => ({ id: s.id, label: s.name }))}
          selected={approverSchedules}
          onChange={setApproverSchedules}
        />
      </div>

      <div className="space-y-2">
        <label className="flex items-start gap-2 text-sm text-on-surface-secondary">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          {gt("Policy is on")}
        </label>
        <label className="flex items-start gap-2 text-sm text-on-surface-secondary">
          <input
            type="checkbox"
            checked={requireReason}
            onChange={(e) => setRequireReason(e.target.checked)}
          />
          {gt("Require a reason")}
        </label>
        <label className="flex items-start gap-2 text-sm text-on-surface-secondary">
          <input
            type="checkbox"
            checked={requireTicket}
            onChange={(e) => setRequireTicket(e.target.checked)}
          />
          {gt("Require a ticket reference")}
        </label>
        <label className="flex items-start gap-2 text-sm text-on-surface-secondary">
          <input
            type="checkbox"
            checked={selfApproval}
            onChange={(e) => setSelfApproval(e.target.checked)}
          />
          <span>
            {gt("Let an approver approve their own request while a declared incident is open")}
            <span className="block text-xs text-on-surface-tertiary">
              {gt(
                "Recorded as self-approved, with the incident. Only covers the approver's own principal.",
              )}
            </span>
          </span>
        </label>
      </div>

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="submit"
          className={PRIMARY_BUTTON}
          disabled={
            saving || !name.trim() || !accountId || targets.length === 0 || approverCount === 0
          }
        >
          {saving ? gt("Saving…") : gt("Save policy")}
        </button>
        <button type="button" className={SECONDARY_BUTTON} onClick={onCancel}>
          {gt("Cancel")}
        </button>
      </div>
    </form>
  );
}
