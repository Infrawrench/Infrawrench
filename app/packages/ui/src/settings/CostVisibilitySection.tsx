import { useCallback, useEffect, useMemo, useState } from "react";
import { useGT } from "gt-react";
import {
  COST_VISIBILITY_LIMITS,
  costCentrePaths,
  costVisibilityScopeIsEmpty,
  type CostCentre,
  type CostVisibilityPrincipalKind,
  type CostVisibilityScope,
  type CostVisibilityScopeInput,
  type SavedCostFilter,
  type TeamMember,
} from "@infrawrench/client-core";
import { useSettingsHost } from "./host.js";
import { CARD, LABEL, PRIMARY_BUTTON, SECONDARY_BUTTON } from "./styles.js";

interface RoleOption {
  id: string;
  name: string;
  systemKey: string | null;
}
interface KeyOption {
  id: string;
  name: string;
  prefix: string;
  revokedAt: string | null;
}
interface AccountOption {
  id: string;
  displayName: string;
}

const SELECT =
  "bg-surface-overlay border border-border-strong rounded-lg px-2 py-1.5 text-sm text-on-surface-secondary focus:outline-none";

/**
 * Cost visibility: which cost rows a role, member or API key can see.
 *
 * A scope names cost centres and/or connected accounts, optionally ANDed with
 * a saved filter. Every scope that applies to someone is intersected, so a
 * member scope can only narrow their role's. Owners are never scoped. Every
 * picker reads the org's own objects, so nobody types an id.
 */
export function CostVisibilitySection() {
  const gt = useGT();
  const { orgId, api, has } = useSettingsHost();
  const canEdit = has("team:role:write");

  const [scopes, setScopes] = useState<CostVisibilityScope[]>([]);
  const [roles, setRoles] = useState<RoleOption[]>([]);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [keys, setKeys] = useState<KeyOption[]>([]);
  const [centres, setCentres] = useState<CostCentre[]>([]);
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [filters, setFilters] = useState<SavedCostFilter[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<CostVisibilityScopeInput | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [scopeRes, roleRows, memberRows, keyRows, centreRows, accountRows, filterRows] =
        await Promise.all([
          api.get<{ scopes: CostVisibilityScope[] }>(`/api/org/${orgId}/cost-visibility`),
          api.get<RoleOption[]>(`/api/org/${orgId}/team/roles`).catch(() => [] as RoleOption[]),
          api.get<TeamMember[]>(`/api/org/${orgId}/team/members`).catch(() => [] as TeamMember[]),
          api.get<KeyOption[]>(`/api/org/${orgId}/api-keys`).catch(() => [] as KeyOption[]),
          api.get<CostCentre[]>(`/api/org/${orgId}/cost-centres`).catch(() => [] as CostCentre[]),
          api.get<AccountOption[]>(`/api/org/${orgId}/accounts`).catch(() => [] as AccountOption[]),
          api
            .get<SavedCostFilter[]>(`/api/org/${orgId}/saved-cost-filters`)
            .catch(() => [] as SavedCostFilter[]),
        ]);
      setScopes(scopeRes.scopes);
      setRoles(roleRows);
      setMembers(memberRows);
      setKeys(keyRows.filter((k) => !k.revokedAt));
      setCentres(centreRows);
      setAccounts(accountRows);
      setFilters(filterRows);
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to load cost visibility"));
    } finally {
      setLoading(false);
    }
  }, [api, orgId, gt]);

  useEffect(() => {
    void load();
  }, [load]);

  const centrePaths = useMemo(() => costCentrePaths(centres), [centres]);
  const centreName = useMemo(() => new Map(centrePaths.map((p) => [p.id, p.path])), [centrePaths]);
  const accountName = useMemo(
    () => new Map(accounts.map((a) => [a.id, a.displayName])),
    [accounts],
  );
  const filterName = useMemo(() => new Map(filters.map((f) => [f.id, f.name])), [filters]);

  const principalOptions = (kind: CostVisibilityPrincipalKind) => {
    const taken = new Set(scopes.filter((s) => s.principalKind === kind).map((s) => s.principalId));
    if (kind === "role") {
      return roles
        .filter((r) => r.systemKey !== "owner" && !taken.has(r.id))
        .map((r) => ({ id: r.id, label: r.name }));
    }
    if (kind === "member") {
      return members
        .filter((m) => (m.roleSystemKey ?? m.role) !== "owner" && !taken.has(m.id))
        .map((m) => ({
          id: m.id,
          label: m.displayName ? `${m.displayName} (${m.email})` : m.email,
        }));
    }
    return keys
      .filter((k) => !taken.has(k.id))
      .map((k) => ({ id: k.id, label: `${k.name} (${k.prefix}…)` }));
  };

  const kindLabel = (kind: CostVisibilityPrincipalKind) =>
    kind === "role" ? gt("Role") : kind === "member" ? gt("Member") : gt("API key");

  async function save() {
    if (!editing) return;
    setSaving(true);
    setError(null);
    try {
      await api.put(`/api/org/${orgId}/cost-visibility`, editing);
      setEditing(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to save the scope"));
    } finally {
      setSaving(false);
    }
  }

  async function remove(scope: CostVisibilityScope) {
    setError(null);
    try {
      await api.delete(
        `/api/org/${orgId}/cost-visibility/${scope.principalKind}/${encodeURIComponent(scope.principalId)}`,
      );
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to remove the scope"));
    }
  }

  function describe(
    scope: Pick<CostVisibilityScope, "costCentreIds" | "accountIds" | "savedFilterId">,
  ) {
    const parts: string[] = [];
    if (scope.costCentreIds.length > 0) {
      parts.push(
        scope.costCentreIds.map((id) => centreName.get(id) ?? gt("Deleted centre")).join(", "),
      );
    }
    if (scope.accountIds.length > 0) {
      parts.push(
        scope.accountIds.map((id) => accountName.get(id) ?? gt("Removed account")).join(", "),
      );
    }
    const base = parts.length > 0 ? parts.join(gt(" or ")) : null;
    const filter = scope.savedFilterId
      ? (filterName.get(scope.savedFilterId) ?? gt("Deleted saved filter"))
      : null;
    if (base && filter) return gt("{base}, filtered by {filter}", { base, filter });
    if (base) return base;
    if (filter) return gt("Filtered by {filter}", { filter });
    return gt("Nothing (sees no costs)");
  }

  return (
    <div className="max-w-3xl">
      <div className="mb-6">
        <h1 className="text-xl font-semibold">{gt("Cost Visibility")}</h1>
        <p className="text-sm text-on-surface-muted mt-1">
          {gt(
            "Restrict which costs a role, member or API key can see, everywhere spend appears. Combined scopes only narrow access. Owners always see everything.",
          )}
        </p>
      </div>

      {error && (
        <div className="mb-4 px-3 py-2 text-sm text-danger border border-red-900/50 bg-red-950/20 rounded-lg">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-on-surface-faint">{gt("Loading…")}</p>
      ) : (
        <div className="space-y-6">
          <div className="border border-border rounded-xl overflow-hidden">
            {scopes.length === 0 ? (
              <p className="px-4 py-3 text-sm text-on-surface-muted">
                {gt(
                  "No scopes yet. Everyone with cost access sees all of the organization's spend.",
                )}
              </p>
            ) : (
              scopes.map((scope) => (
                <div
                  key={scope.id}
                  className="flex items-center gap-3 px-4 py-3 border-b border-border/50 last:border-b-0"
                >
                  <span className="text-xs text-on-surface-muted w-16 shrink-0">
                    {kindLabel(scope.principalKind)}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-on-surface-secondary truncate">
                      {scope.principalLabel ?? gt("Deleted principal")}
                    </div>
                    <div className="text-xs text-on-surface-muted truncate">{describe(scope)}</div>
                  </div>
                  {canEdit && (
                    <span className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        className="text-xs text-on-surface-muted hover:text-on-surface-secondary"
                        onClick={() =>
                          setEditing({
                            principalKind: scope.principalKind,
                            principalId: scope.principalId,
                            costCentreIds: scope.costCentreIds,
                            accountIds: scope.accountIds,
                            savedFilterId: scope.savedFilterId,
                          })
                        }
                      >
                        {gt("Edit")}
                      </button>
                      <button
                        type="button"
                        className="text-xs text-danger hover:text-danger-strong"
                        onClick={() => void remove(scope)}
                      >
                        {gt("Remove")}
                      </button>
                    </span>
                  )}
                </div>
              ))
            )}
          </div>

          {canEdit && !editing && (
            <button
              type="button"
              className={PRIMARY_BUTTON}
              onClick={() =>
                setEditing({
                  principalKind: "role",
                  principalId: "",
                  costCentreIds: [],
                  accountIds: [],
                  savedFilterId: null,
                })
              }
            >
              {gt("Add a scope")}
            </button>
          )}

          {editing && (
            <div className={`${CARD} space-y-4`}>
              <h2 className="text-sm font-semibold">{gt("Scope")}</h2>
              <div className="flex flex-wrap gap-3">
                <label className="flex flex-col">
                  <span className={LABEL}>{gt("Applies to")}</span>
                  <select
                    className={SELECT}
                    value={editing.principalKind}
                    disabled={scopes.some(
                      (s) =>
                        s.principalKind === editing.principalKind &&
                        s.principalId === editing.principalId,
                    )}
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        principalKind: e.target.value as CostVisibilityPrincipalKind,
                        principalId: "",
                      })
                    }
                  >
                    <option value="role">{gt("Role")}</option>
                    <option value="member">{gt("Member")}</option>
                    <option value="api_key">{gt("API key")}</option>
                  </select>
                </label>
                <label className="flex flex-col flex-1 min-w-48">
                  <span className={LABEL}>{kindLabel(editing.principalKind)}</span>
                  {scopes.some(
                    (s) =>
                      s.principalKind === editing.principalKind &&
                      s.principalId === editing.principalId,
                  ) ? (
                    <span className="text-sm text-on-surface-secondary py-1.5">
                      {scopes.find(
                        (s) =>
                          s.principalKind === editing.principalKind &&
                          s.principalId === editing.principalId,
                      )?.principalLabel ?? editing.principalId}
                    </span>
                  ) : (
                    <select
                      className={SELECT}
                      value={editing.principalId}
                      onChange={(e) => setEditing({ ...editing, principalId: e.target.value })}
                    >
                      <option value="">{gt("Choose…")}</option>
                      {principalOptions(editing.principalKind).map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  )}
                </label>
              </div>

              <PickList
                title={gt("Cost centres")}
                hint={gt(
                  "Spend the allocation rules assign to these centres, including their sub-centres.",
                )}
                options={centrePaths.map((p) => ({ id: p.id, label: p.path }))}
                selected={editing.costCentreIds}
                max={COST_VISIBILITY_LIMITS.maxCostCentres}
                onChange={(costCentreIds) => setEditing({ ...editing, costCentreIds })}
                empty={gt("No cost centres yet. Create them under Cost Centres.")}
              />
              <PickList
                title={gt("Accounts")}
                hint={gt("All spend on these connected accounts.")}
                options={accounts.map((a) => ({ id: a.id, label: a.displayName }))}
                selected={editing.accountIds}
                max={COST_VISIBILITY_LIMITS.maxAccounts}
                onChange={(accountIds) => setEditing({ ...editing, accountIds })}
                empty={gt("No connected accounts.")}
              />
              <label className="flex flex-col">
                <span className={LABEL}>{gt("Saved filter (optional)")}</span>
                <select
                  className={SELECT}
                  value={editing.savedFilterId ?? ""}
                  onChange={(e) =>
                    setEditing({ ...editing, savedFilterId: e.target.value || null })
                  }
                >
                  <option value="">{gt("None")}</option>
                  {filters.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </select>
                <span className="text-xs text-on-surface-muted mt-1">
                  {gt(
                    "Applied on top of the centres and accounts. On its own, it decides what is visible.",
                  )}
                </span>
              </label>

              <p className="text-xs text-on-surface-muted">
                {gt("Will see: {what}", { what: describe(editing) })}
              </p>
              {costVisibilityScopeIsEmpty(editing) && (
                <p className="text-xs text-warning">
                  {gt("A scope with nothing picked hides all costs from this principal.")}
                </p>
              )}

              <div className="flex gap-2">
                <button
                  type="button"
                  className={PRIMARY_BUTTON}
                  disabled={saving || !editing.principalId}
                  onClick={() => void save()}
                >
                  {saving ? gt("Saving…") : gt("Save scope")}
                </button>
                <button type="button" className={SECONDARY_BUTTON} onClick={() => setEditing(null)}>
                  {gt("Cancel")}
                </button>
              </div>
            </div>
          )}

          <div className="text-xs text-on-surface-muted space-y-1">
            <p>
              {gt(
                "Scoped people cannot use cost exports, invoices, the weekly digest or config as code, or change roles, invitations or scopes.",
              )}
            </p>
            <p>
              {gt(
                "Budgets, change alerts and report schedules a scoped person creates only ever measure what they can see. Anomaly findings are detected org-wide and are hidden from them.",
              )}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function PickList({
  title,
  hint,
  options,
  selected,
  max,
  onChange,
  empty,
}: {
  title: string;
  hint: string;
  options: Array<{ id: string; label: string }>;
  selected: string[];
  max: number;
  onChange: (next: string[]) => void;
  empty: string;
}) {
  const set = new Set(selected);
  return (
    <fieldset>
      <legend className={LABEL}>{title}</legend>
      <p className="text-xs text-on-surface-muted mb-2">{hint}</p>
      {options.length === 0 ? (
        <p className="text-xs text-on-surface-faint">{empty}</p>
      ) : (
        <div className="max-h-44 overflow-auto border border-border rounded-lg divide-y divide-border/50">
          {options.map((o) => (
            <label key={o.id} className="flex items-center gap-2 px-3 py-1.5 text-sm">
              <input
                type="checkbox"
                checked={set.has(o.id)}
                disabled={!set.has(o.id) && selected.length >= max}
                onChange={(e) =>
                  onChange(
                    e.target.checked ? [...selected, o.id] : selected.filter((id) => id !== o.id),
                  )
                }
              />
              <span className="truncate text-on-surface-secondary">{o.label}</span>
            </label>
          ))}
        </div>
      )}
    </fieldset>
  );
}
