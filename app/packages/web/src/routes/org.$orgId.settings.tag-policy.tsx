import { createFileRoute, useParams } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import type {
  AccountTagCompliance,
  AllocationRule,
  CostCentre,
  CostDimensionOption,
  RequiredTag,
  TagPolicy,
} from "@infrawrench/client-core";
import { apiDelete, apiGet, apiPost, apiPut } from "@/lib/api";
import { usePermissions } from "@/auth/permissions-context";

export const Route = createFileRoute("/org/$orgId/settings/tag-policy")({
  component: TagPolicyPage,
});

/** One editable policy row: the key plus allowed values as a comma list. */
interface PolicyRow {
  key: string;
  allowedValues: string;
}

function toRows(policy: TagPolicy): PolicyRow[] {
  return policy.requiredTags.map((t) => ({
    key: t.key,
    allowedValues: (t.allowedValues ?? []).join(", "),
  }));
}

function fromRows(rows: PolicyRow[], enforceOnCreate: boolean): TagPolicy {
  const requiredTags: RequiredTag[] = [];
  for (const row of rows) {
    const key = row.key.trim();
    if (!key) continue;
    const allowedValues = row.allowedValues
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
    requiredTags.push(allowedValues.length > 0 ? { key, allowedValues } : { key });
  }
  return { requiredTags, enforceOnCreate };
}

function TagPolicyPage() {
  const { orgId } = useParams({ from: "/org/$orgId/settings/tag-policy" });
  const { has } = usePermissions();
  const canEditPolicy = has("org:settings:write");
  const canReadAllocation = has("costs:read");
  const canEditAllocation = has("costs:write");

  const [rows, setRows] = useState<PolicyRow[]>([]);
  const [enforceOnCreate, setEnforceOnCreate] = useState(false);
  const [compliance, setCompliance] = useState<AccountTagCompliance[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const report = await apiGet<{ policy: TagPolicy; accounts: AccountTagCompliance[] }>(
        `/api/org/${orgId}/tag-policy/compliance`,
      );
      setRows(toRows(report.policy));
      setEnforceOnCreate(report.policy.enforceOnCreate);
      setCompliance(report.accounts);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load tag policy");
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const saved = await apiPut<TagPolicy>(
        `/api/org/${orgId}/tag-policy`,
        fromRows(rows, enforceOnCreate),
      );
      setRows(toRows(saved));
      setEnforceOnCreate(saved.enforceOnCreate);
      setSavedAt(Date.now());
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save tag policy");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold">Tag Policy</h1>
        <p className="text-sm text-on-surface-muted mt-1">
          Require every resource to carry tags like <code>owner</code> and <code>env</code>.
          Compliance is scored per account, untagged spend shows up on the Costs page, and — when
          enforcement is on — creating a resource without the required tags is rejected. Holders of{" "}
          <code>tag-policy:override</code> can override; blocks and overrides are recorded in the
          audit log.
        </p>
      </div>

      {error && (
        <div className="mb-4 px-3 py-2 text-sm text-red-400 border border-red-900/50 bg-red-950/20 rounded-lg">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-on-surface-faint">Loading…</p>
      ) : (
        <div className="space-y-8">
          <section className="border border-border rounded-xl p-4 space-y-3 bg-surface-raised/50">
            <h2 className="text-sm font-semibold">Required tags</h2>
            {rows.length === 0 && (
              <p className="text-sm text-on-surface-muted">
                No required tags yet. Add keys every resource should carry.
              </p>
            )}
            {rows.map((row, i) => (
              <div key={i} className="grid grid-cols-1 sm:grid-cols-[1fr_2fr_auto] gap-3">
                <input
                  type="text"
                  value={row.key}
                  disabled={!canEditPolicy}
                  onChange={(e) =>
                    setRows((prev) =>
                      prev.map((r, j) => (j === i ? { ...r, key: e.target.value } : r)),
                    )
                  }
                  placeholder="owner"
                  aria-label="Tag key"
                  className="px-3 py-1.5 text-sm bg-surface border border-border rounded-lg focus:outline-none focus:border-border-strong disabled:opacity-60"
                />
                <input
                  type="text"
                  value={row.allowedValues}
                  disabled={!canEditPolicy}
                  onChange={(e) =>
                    setRows((prev) =>
                      prev.map((r, j) => (j === i ? { ...r, allowedValues: e.target.value } : r)),
                    )
                  }
                  placeholder="Allowed values, comma-separated (optional — e.g. prod, staging, dev)"
                  aria-label="Allowed values"
                  className="px-3 py-1.5 text-sm bg-surface border border-border rounded-lg focus:outline-none focus:border-border-strong disabled:opacity-60"
                />
                {canEditPolicy && (
                  <button
                    type="button"
                    onClick={() => setRows((prev) => prev.filter((_, j) => j !== i))}
                    className="text-xs text-red-400 hover:text-red-500 dark:text-red-300"
                  >
                    Remove
                  </button>
                )}
              </div>
            ))}
            {canEditPolicy && (
              <div className="flex items-center justify-between gap-4 pt-1">
                <button
                  type="button"
                  onClick={() => setRows((prev) => [...prev, { key: "", allowedValues: "" }])}
                  className="text-sm text-blue-500 hover:text-blue-400"
                >
                  + Add required tag
                </button>
                <div className="flex items-center gap-4">
                  <label className="flex items-center gap-2 text-sm text-on-surface-secondary">
                    <input
                      type="checkbox"
                      checked={enforceOnCreate}
                      onChange={(e) => setEnforceOnCreate(e.target.checked)}
                    />
                    Enforce at create time
                  </label>
                  <button
                    type="button"
                    onClick={() => void save()}
                    disabled={saving}
                    className="px-3 py-1.5 text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg transition-colors"
                  >
                    {saving ? "Saving…" : savedAt ? "Saved — save again" : "Save policy"}
                  </button>
                </div>
              </div>
            )}
          </section>

          <section className="space-y-3">
            <h2 className="text-sm font-semibold">Compliance by account</h2>
            <p className="text-xs text-on-surface-muted">
              Share of each account&rsquo;s resources exposing a <code>tags</code>/
              <code>labels</code> field that carry every required tag. Resources whose types
              don&rsquo;t surface tags are excluded from the score.
            </p>
            {compliance.length === 0 ? (
              <p className="text-sm text-on-surface-muted">No accounts connected.</p>
            ) : (
              <div className="border border-border rounded-xl overflow-hidden">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-border text-xs text-on-surface-muted">
                      <th scope="col" className="text-left px-4 py-2 font-medium">
                        Account
                      </th>
                      <th scope="col" className="text-right px-4 py-2 font-medium">
                        Resources
                      </th>
                      <th scope="col" className="text-right px-4 py-2 font-medium">
                        Compliant
                      </th>
                      <th scope="col" className="text-right px-4 py-2 font-medium">
                        Score
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {compliance.map((account) => (
                      <tr
                        key={account.accountId}
                        className="border-b border-border/50 hover:bg-surface-raised/50"
                      >
                        <td className="px-4 py-2 text-sm text-on-surface-secondary">
                          {account.displayName}
                          <span className="ml-2 text-xs text-on-surface-muted">
                            {account.pluginId}
                          </span>
                        </td>
                        <td className="px-4 py-2 text-right text-xs text-on-surface-tertiary">
                          {account.evaluated}
                          {account.totalResources > account.evaluated && (
                            <span className="text-on-surface-muted">
                              {" "}
                              of {account.totalResources}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2 text-right text-xs text-on-surface-tertiary">
                          {account.compliant}
                        </td>
                        <td className="px-4 py-2 text-right text-xs">
                          {account.score === null ? (
                            <span className="text-on-surface-muted">—</span>
                          ) : (
                            <span
                              className={
                                account.score >= 90
                                  ? "text-emerald-500"
                                  : account.score >= 50
                                    ? "text-amber-500"
                                    : "text-red-400"
                              }
                            >
                              {account.score}%
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {canReadAllocation && <AllocationSection orgId={orgId} canEdit={canEditAllocation} />}
        </div>
      )}
    </div>
  );
}

/**
 * Cost centres + the ordered rules mapping spend onto them. Rules evaluate
 * first-match-wins by ascending priority; unmatched spend reports as
 * "Unallocated" in the showback view on the Costs page.
 */
function AllocationSection({ orgId, canEdit }: { orgId: string; canEdit: boolean }) {
  const [centres, setCentres] = useState<CostCentre[]>([]);
  const [rules, setRules] = useState<AllocationRule[]>([]);
  const [accounts, setAccounts] = useState<CostDimensionOption[]>([]);
  const [providers, setProviders] = useState<CostDimensionOption[]>([]);
  const [services, setServices] = useState<CostDimensionOption[]>([]);
  const [tagKeys, setTagKeys] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [newCentreName, setNewCentreName] = useState("");

  const load = useCallback(async () => {
    setError(null);
    try {
      const [centreRows, ruleRows] = await Promise.all([
        apiGet<CostCentre[]>(`/api/org/${orgId}/cost-centres`),
        apiGet<AllocationRule[]>(`/api/org/${orgId}/cost-centres/rules`),
      ]);
      setCentres(centreRows);
      setRules(ruleRows);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load cost centres");
    }
  }, [orgId]);

  useEffect(() => {
    void load();
    // Pickers, so nobody has to paste ids: values seen in the org's cost data.
    const dimension = (name: string) =>
      apiGet<{ values: Array<string | CostDimensionOption> }>(
        `/api/org/${orgId}/costs/dimensions?dimension=${name}`,
      ).then((res) => res.values.map((v) => (typeof v === "string" ? { value: v, label: v } : v)));
    dimension("account").then(setAccounts, () => {});
    dimension("provider").then(setProviders, () => {});
    dimension("service").then(setServices, () => {});
    dimension("tag-keys").then(
      (options) => setTagKeys(options.map((o) => o.value)),
      () => {},
    );
  }, [orgId, load]);

  async function addCentre() {
    const name = newCentreName.trim();
    if (!name) return;
    try {
      await apiPost(`/api/org/${orgId}/cost-centres`, { name });
      setNewCentreName("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create cost centre");
    }
  }

  async function removeCentre(centre: CostCentre) {
    const ruleCount = rules.filter((r) => r.costCentreId === centre.id).length;
    const suffix = ruleCount > 0 ? ` Its ${ruleCount} allocation rule(s) go with it.` : "";
    if (!window.confirm(`Delete cost centre "${centre.name}"?${suffix}`)) return;
    try {
      await apiDelete(`/api/org/${orgId}/cost-centres/${centre.id}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete cost centre");
    }
  }

  async function removeRule(rule: AllocationRule) {
    try {
      await apiDelete(`/api/org/${orgId}/cost-centres/rules/${rule.id}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete rule");
    }
  }

  /** Swap priorities with the neighbour so first-match-wins order is editable. */
  async function moveRule(rule: AllocationRule, direction: -1 | 1) {
    const index = rules.findIndex((r) => r.id === rule.id);
    const neighbour = rules[index + direction];
    if (!neighbour || index < 0) return;
    try {
      // Single transactional swap on the server — two independent PUTs could
      // leave both rules on the same priority if one failed mid-flight.
      const next = await apiPost<AllocationRule[]>(`/api/org/${orgId}/cost-centres/rules/swap`, {
        aId: rule.id,
        bId: neighbour.id,
      });
      setRules(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to reorder rule");
    }
  }

  const labelFor = (options: CostDimensionOption[], value: string | undefined) =>
    value === undefined ? null : (options.find((o) => o.value === value)?.label ?? value);

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold">Cost centres &amp; showback</h2>
      <p className="text-xs text-on-surface-muted">
        Map spend to named cost centres for showback. Rules match on tag, account, provider, or
        service and evaluate top-down — the first match wins; unmatched spend reports as
        &ldquo;Unallocated&rdquo; on the Costs page.
      </p>

      {error && (
        <div className="px-3 py-2 text-sm text-red-400 border border-red-900/50 bg-red-950/20 rounded-lg">
          {error}
        </div>
      )}

      <div className="border border-border rounded-xl p-4 space-y-2 bg-surface-raised/50">
        <h3 className="text-xs font-semibold text-on-surface-secondary">Centres</h3>
        {centres.length === 0 && (
          <p className="text-sm text-on-surface-muted">No cost centres yet.</p>
        )}
        <ul className="flex flex-wrap gap-2">
          {centres.map((centre) => (
            <li
              key={centre.id}
              className="flex items-center gap-2 px-2.5 py-1 rounded-full border border-border text-sm text-on-surface-secondary"
            >
              {centre.name}
              {canEdit && (
                <button
                  type="button"
                  onClick={() => void removeCentre(centre)}
                  aria-label={`Delete ${centre.name}`}
                  className="text-on-surface-muted hover:text-red-500"
                >
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
        {canEdit && (
          <div className="flex gap-2 pt-1">
            <input
              type="text"
              value={newCentreName}
              onChange={(e) => setNewCentreName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void addCentre();
              }}
              placeholder="New cost centre, e.g. Platform"
              className="px-3 py-1.5 text-sm bg-surface border border-border rounded-lg focus:outline-none focus:border-border-strong"
            />
            <button
              type="button"
              onClick={() => void addCentre()}
              className="px-3 py-1.5 text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors"
            >
              Add
            </button>
          </div>
        )}
      </div>

      <div className="border border-border rounded-xl p-4 space-y-3 bg-surface-raised/50">
        <h3 className="text-xs font-semibold text-on-surface-secondary">Allocation rules</h3>
        {rules.length === 0 && (
          <p className="text-sm text-on-surface-muted">
            No rules yet. Spend stays &ldquo;Unallocated&rdquo; until a rule claims it.
          </p>
        )}
        <ul className="space-y-1.5">
          {rules.map((rule) => {
            const centre = centres.find((c) => c.id === rule.costCentreId);
            const parts: string[] = [];
            if (rule.match.tagKey) {
              parts.push(
                rule.match.tagValue !== undefined
                  ? `tag ${rule.match.tagKey}=${rule.match.tagValue}`
                  : `has tag ${rule.match.tagKey}`,
              );
            }
            if (rule.match.accountId)
              parts.push(`account ${labelFor(accounts, rule.match.accountId)}`);
            if (rule.match.pluginId)
              parts.push(`provider ${labelFor(providers, rule.match.pluginId)}`);
            if (rule.match.service) parts.push(`service ${rule.match.service}`);
            const ruleIndex = rules.findIndex((r) => r.id === rule.id);
            return (
              <li key={rule.id} className="flex items-center gap-3 text-sm">
                <span className="text-xs text-on-surface-muted w-10">#{rule.priority}</span>
                <span className="flex-1 truncate text-on-surface-secondary">
                  {parts.length > 0 ? parts.join(" and ") : "everything"}
                  <span className="text-on-surface-muted"> → </span>
                  {centre?.name ?? "?"}
                </span>
                {canEdit && (
                  <span className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => void moveRule(rule, -1)}
                      disabled={ruleIndex <= 0}
                      aria-label="Move rule up"
                      className="text-xs text-on-surface-muted hover:text-on-surface-secondary disabled:opacity-30 disabled:hover:text-on-surface-muted px-1"
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      onClick={() => void moveRule(rule, 1)}
                      disabled={ruleIndex < 0 || ruleIndex >= rules.length - 1}
                      aria-label="Move rule down"
                      className="text-xs text-on-surface-muted hover:text-on-surface-secondary disabled:opacity-30 disabled:hover:text-on-surface-muted px-1"
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      onClick={() => void removeRule(rule)}
                      className="text-xs text-red-400 hover:text-red-500 dark:text-red-300"
                    >
                      Remove
                    </button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
        {canEdit && centres.length > 0 && (
          <NewRuleForm
            orgId={orgId}
            centres={centres}
            accounts={accounts}
            providers={providers}
            services={services}
            tagKeys={tagKeys}
            nextPriority={rules.reduce((max, r) => Math.max(max, r.priority), -1) + 1}
            onCreated={load}
            onError={setError}
          />
        )}
      </div>
    </section>
  );
}

function NewRuleForm({
  orgId,
  centres,
  accounts,
  providers,
  services,
  tagKeys,
  nextPriority,
  onCreated,
  onError,
}: {
  orgId: string;
  centres: CostCentre[];
  accounts: CostDimensionOption[];
  providers: CostDimensionOption[];
  services: CostDimensionOption[];
  tagKeys: string[];
  nextPriority: number;
  onCreated: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [costCentreId, setCostCentreId] = useState(centres[0]?.id ?? "");
  const [tagKey, setTagKey] = useState("");
  const [tagValue, setTagValue] = useState("");
  const [accountId, setAccountId] = useState("");
  const [pluginId, setPluginId] = useState("");
  const [service, setService] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!centres.some((c) => c.id === costCentreId)) setCostCentreId(centres[0]?.id ?? "");
  }, [centres, costCentreId]);

  async function submit() {
    if (!costCentreId) return;
    setSubmitting(true);
    try {
      await apiPost(`/api/org/${orgId}/cost-centres/rules`, {
        costCentreId,
        priority: nextPriority,
        match: {
          ...(tagKey ? { tagKey } : {}),
          ...(tagKey && tagValue ? { tagValue } : {}),
          ...(accountId ? { accountId } : {}),
          ...(pluginId ? { pluginId } : {}),
          ...(service ? { service } : {}),
        },
      });
      setTagKey("");
      setTagValue("");
      setAccountId("");
      setPluginId("");
      setService("");
      await onCreated();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to create rule");
    } finally {
      setSubmitting(false);
    }
  }

  const selectClass =
    "px-2.5 py-1.5 text-sm bg-surface border border-border rounded-lg focus:outline-none focus:border-border-strong";

  return (
    <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-border/50">
      <select
        value={tagKey}
        onChange={(e) => setTagKey(e.target.value)}
        aria-label="Tag key"
        className={selectClass}
      >
        <option value="">Any tag</option>
        {tagKeys.map((key) => (
          <option key={key} value={key}>
            tag: {key}
          </option>
        ))}
      </select>
      {tagKey && (
        <input
          type="text"
          value={tagValue}
          onChange={(e) => setTagValue(e.target.value)}
          placeholder="value (blank = any)"
          aria-label="Tag value"
          className={selectClass}
        />
      )}
      <select
        value={accountId}
        onChange={(e) => setAccountId(e.target.value)}
        aria-label="Account"
        className={selectClass}
      >
        <option value="">Any account</option>
        {accounts.map((a) => (
          <option key={a.value} value={a.value}>
            {a.label}
          </option>
        ))}
      </select>
      <select
        value={pluginId}
        onChange={(e) => setPluginId(e.target.value)}
        aria-label="Provider"
        className={selectClass}
      >
        <option value="">Any provider</option>
        {providers.map((p) => (
          <option key={p.value} value={p.value}>
            {p.label}
          </option>
        ))}
      </select>
      <select
        value={service}
        onChange={(e) => setService(e.target.value)}
        aria-label="Service"
        className={selectClass}
      >
        <option value="">Any service</option>
        {services.map((s) => (
          <option key={s.value} value={s.value}>
            {s.label}
          </option>
        ))}
      </select>
      <span className="text-on-surface-muted text-sm">→</span>
      <select
        value={costCentreId}
        onChange={(e) => setCostCentreId(e.target.value)}
        aria-label="Cost centre"
        className={selectClass}
      >
        {centres.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={() => void submit()}
        disabled={submitting || !costCentreId}
        className="px-3 py-1.5 text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg transition-colors"
      >
        {submitting ? "Adding…" : "Add rule"}
      </button>
    </div>
  );
}
