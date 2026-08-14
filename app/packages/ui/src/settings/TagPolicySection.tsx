import { useCallback, useEffect, useMemo, useState } from "react";
import { T, Var, useGT } from "gt-react";
import { costCentrePaths } from "@infrawrench/client-core";
import type {
  AccountTagCompliance,
  AllocationRule,
  CostCentre,
  CostCentrePathRow,
  CostDimensionOption,
  RequiredTag,
  TagPolicy,
} from "@infrawrench/client-core";
import { useSettingsHost, type SettingsApi } from "./host.js";

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

/** A dimension value as its picker label, falling back to the raw id. */
function labelFor(options: CostDimensionOption[], value: string | undefined): string | null {
  return value === undefined ? null : (options.find((o) => o.value === value)?.label ?? value);
}

export function TagPolicySection() {
  const gt = useGT();
  const { orgId, api, has, openSection } = useSettingsHost();
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
      const report = await api.get<{ policy: TagPolicy; accounts: AccountTagCompliance[] }>(
        `/api/org/${orgId}/tag-policy/compliance`,
      );
      setRows(toRows(report.policy));
      setEnforceOnCreate(report.policy.enforceOnCreate);
      setCompliance(report.accounts);
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to load tag policy"));
    } finally {
      setLoading(false);
    }
  }, [api, orgId, gt]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const saved = await api.put<TagPolicy>(
        `/api/org/${orgId}/tag-policy`,
        fromRows(rows, enforceOnCreate),
      );
      setRows(toRows(saved));
      setEnforceOnCreate(saved.enforceOnCreate);
      setSavedAt(Date.now());
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to save tag policy"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold">{gt("Tag Policy")}</h1>
        <T>
          <p className="text-sm text-on-surface-muted mt-1">
            Require every resource to carry tags like <code>owner</code> and <code>env</code>.
            Compliance is scored per account, untagged spend shows up on the Costs page, and — when
            enforcement is on — creating a resource without the required tags is rejected. Holders
            of <code>tag-policy:override</code> can override; blocks and overrides are recorded in
            the audit log.
          </p>
        </T>
      </div>

      {error && (
        <div className="mb-4 px-3 py-2 text-sm text-danger border border-red-900/50 bg-red-950/20 rounded-lg">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-on-surface-faint">{gt("Loading…")}</p>
      ) : (
        <div className="space-y-8">
          <section className="border border-border rounded-xl p-4 space-y-3 bg-surface-raised/50">
            <h2 className="text-sm font-semibold">{gt("Required tags")}</h2>
            {rows.length === 0 && (
              <p className="text-sm text-on-surface-muted">
                {gt("No required tags yet. Add keys every resource should carry.")}
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
                  placeholder={gt("owner")}
                  aria-label={gt("Tag key")}
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
                  placeholder={gt(
                    "Allowed values, comma-separated (optional — e.g. prod, staging, dev)",
                  )}
                  aria-label={gt("Allowed values")}
                  className="px-3 py-1.5 text-sm bg-surface border border-border rounded-lg focus:outline-none focus:border-border-strong disabled:opacity-60"
                />
                {canEditPolicy && (
                  <button
                    type="button"
                    onClick={() => setRows((prev) => prev.filter((_, j) => j !== i))}
                    className="text-xs text-danger hover:text-danger-strong"
                  >
                    {gt("Remove")}
                  </button>
                )}
              </div>
            ))}
            {canEditPolicy && (
              <div className="flex items-center justify-between gap-4 pt-1">
                <button
                  type="button"
                  onClick={() => setRows((prev) => [...prev, { key: "", allowedValues: "" }])}
                  className="text-sm text-info hover:text-info-strong"
                >
                  {gt("+ Add required tag")}
                </button>
                <div className="flex items-center gap-4">
                  <label className="flex items-center gap-2 text-sm text-on-surface-secondary">
                    <input
                      type="checkbox"
                      checked={enforceOnCreate}
                      onChange={(e) => setEnforceOnCreate(e.target.checked)}
                    />
                    {gt("Enforce at create time")}
                  </label>
                  <button
                    type="button"
                    onClick={() => void save()}
                    disabled={saving}
                    className="px-3 py-1.5 text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg transition-colors"
                  >
                    {saving
                      ? gt("Saving…")
                      : savedAt
                        ? gt("Saved — save again")
                        : gt("Save policy")}
                  </button>
                </div>
              </div>
            )}
          </section>

          <section className="space-y-3">
            <h2 className="text-sm font-semibold">{gt("Compliance by account")}</h2>
            <T>
              <p className="text-xs text-on-surface-muted">
                Share of each account&rsquo;s resources exposing a <code>tags</code>/
                <code>labels</code> field that carry every required tag. Resources whose types
                don&rsquo;t surface tags are excluded from the score.
              </p>
            </T>
            {compliance.length === 0 ? (
              <p className="text-sm text-on-surface-muted">{gt("No accounts connected.")}</p>
            ) : (
              <div className="border border-border rounded-xl overflow-hidden">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-border text-xs text-on-surface-muted">
                      <th scope="col" className="text-left px-4 py-2 font-medium">
                        {gt("Account")}
                      </th>
                      <th scope="col" className="text-right px-4 py-2 font-medium">
                        {gt("Resources")}
                      </th>
                      <th scope="col" className="text-right px-4 py-2 font-medium">
                        {gt("Compliant")}
                      </th>
                      <th scope="col" className="text-right px-4 py-2 font-medium">
                        {gt("Score")}
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
                            <T>
                              <span className="text-on-surface-muted">
                                {" "}
                                of <Var>{account.totalResources}</Var>
                              </span>
                            </T>
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
                                  ? "text-success"
                                  : account.score >= 50
                                    ? "text-warning"
                                    : "text-danger"
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

          {canReadAllocation && (
            <AllocationSection
              api={api}
              orgId={orgId}
              canEdit={canEditAllocation}
              openSection={openSection}
            />
          )}
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
function AllocationSection({
  api,
  orgId,
  canEdit,
  openSection,
}: {
  api: SettingsApi;
  orgId: string;
  canEdit: boolean;
  openSection: (section: string) => void;
}) {
  const gt = useGT();
  const [centres, setCentres] = useState<CostCentre[]>([]);
  const [rules, setRules] = useState<AllocationRule[]>([]);
  const [accounts, setAccounts] = useState<CostDimensionOption[]>([]);
  const [providers, setProviders] = useState<CostDimensionOption[]>([]);
  const [services, setServices] = useState<CostDimensionOption[]>([]);
  const [tagKeys, setTagKeys] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [centreRows, ruleRows] = await Promise.all([
        api.get<CostCentre[]>(`/api/org/${orgId}/cost-centres`),
        api.get<AllocationRule[]>(`/api/org/${orgId}/cost-centres/rules`),
      ]);
      setCentres(centreRows);
      setRules(ruleRows);
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to load cost centres"));
    }
  }, [api, orgId, gt]);

  useEffect(() => {
    void load();
    // Pickers, so nobody has to paste ids: values seen in the org's cost data.
    const dimension = (name: string) =>
      api
        .get<{
          values: Array<string | CostDimensionOption>;
        }>(`/api/org/${orgId}/costs/dimensions?dimension=${name}`)
        .then((res) => res.values.map((v) => (typeof v === "string" ? { value: v, label: v } : v)));
    dimension("account").then(setAccounts, () => {});
    dimension("provider").then(setProviders, () => {});
    dimension("service").then(setServices, () => {});
    dimension("tag-keys").then(
      (options) => setTagKeys(options.map((o) => o.value)),
      () => {},
    );
  }, [api, orgId, load]);

  async function removeRule(rule: AllocationRule) {
    try {
      await api.delete(`/api/org/${orgId}/cost-centres/rules/${rule.id}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to delete rule"));
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
      const next = await api.post<AllocationRule[]>(`/api/org/${orgId}/cost-centres/rules/swap`, {
        aId: rule.id,
        bId: neighbour.id,
      });
      setRules(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to reorder rule"));
    }
  }

  // Centre labels carry the full path so "Platform" under Engineering never
  // reads as the same bucket as "Platform" under Data.
  const centrePaths = useMemo(() => costCentrePaths(centres), [centres]);
  const pathFor = (id: string) => centrePaths.find((row) => row.id === id)?.path;

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold">{gt("Cost centres & showback")}</h2>
      <T>
        <p className="text-xs text-on-surface-muted">
          Map spend to cost centres for showback. Rules match on tag, account, provider, or service
          and evaluate top-down — the first match wins, so every cost row is allocated exactly once;
          unmatched spend reports as &ldquo;Unallocated&rdquo; on the Costs page. Centres nest, and
          a rule may target a parent or a child freely: at the same priority the more deeply nested
          centre claims the row, and the parent still counts it in its subtree total.
        </p>
      </T>

      {error && (
        <div className="px-3 py-2 text-sm text-danger border border-red-900/50 bg-red-950/20 rounded-lg">
          {error}
        </div>
      )}

      <div className="border border-border rounded-xl p-4 space-y-2 bg-surface-raised/50">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="text-xs font-semibold text-on-surface-secondary">{gt("Centres")}</h3>
          <button
            type="button"
            onClick={() => openSection("cost-centres")}
            className="text-xs text-info hover:text-info-strong"
          >
            {gt("Manage cost centres →")}
          </button>
        </div>
        {centres.length === 0 ? (
          <p className="text-sm text-on-surface-muted">
            {gt(
              "No cost centres yet. Create them under Settings → Cost Centres, then point rules at them here.",
            )}
          </p>
        ) : (
          // Read-only here on purpose: centres are a tree with move and depth
          // rules of their own, and two editors for one thing is how the two
          // disagree. This is the picker's vocabulary, spelled out.
          <ul className="flex flex-wrap gap-2">
            {centrePaths.map(({ id, path }) => (
              <li
                key={id}
                className="px-2.5 py-1 rounded-full border border-border text-sm text-on-surface-secondary"
              >
                {path}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="border border-border rounded-xl p-4 space-y-3 bg-surface-raised/50">
        <h3 className="text-xs font-semibold text-on-surface-secondary">
          {gt("Allocation rules")}
        </h3>
        {rules.length === 0 && (
          <p className="text-sm text-on-surface-muted">
            {gt("No rules yet. Spend stays “Unallocated” until a rule claims it.")}
          </p>
        )}
        <ul className="space-y-1.5">
          {rules.map((rule) => {
            const parts: string[] = [];
            if (rule.match.tagKey) {
              parts.push(
                rule.match.tagValue !== undefined
                  ? gt("tag {key}={value}", { key: rule.match.tagKey, value: rule.match.tagValue })
                  : gt("has tag {key}", { key: rule.match.tagKey }),
              );
            }
            if (rule.match.accountId)
              parts.push(gt("account {name}", { name: labelFor(accounts, rule.match.accountId) }));
            if (rule.match.pluginId)
              parts.push(gt("provider {name}", { name: labelFor(providers, rule.match.pluginId) }));
            if (rule.match.service) parts.push(gt("service {name}", { name: rule.match.service }));
            const ruleIndex = rules.findIndex((r) => r.id === rule.id);
            return (
              <li key={rule.id} className="flex items-center gap-3 text-sm">
                <span className="text-xs text-on-surface-muted w-10">#{rule.priority}</span>
                <span className="flex-1 truncate text-on-surface-secondary">
                  {parts.length > 0 ? parts.join(gt(" and ")) : gt("everything")}
                  <span className="text-on-surface-muted"> → </span>
                  {pathFor(rule.costCentreId) ?? "?"}
                </span>
                {canEdit && (
                  <span className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => void moveRule(rule, -1)}
                      disabled={ruleIndex <= 0}
                      aria-label={gt("Move rule up")}
                      className="text-xs text-on-surface-muted hover:text-on-surface-secondary disabled:opacity-30 disabled:hover:text-on-surface-muted px-1"
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      onClick={() => void moveRule(rule, 1)}
                      disabled={ruleIndex < 0 || ruleIndex >= rules.length - 1}
                      aria-label={gt("Move rule down")}
                      className="text-xs text-on-surface-muted hover:text-on-surface-secondary disabled:opacity-30 disabled:hover:text-on-surface-muted px-1"
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      onClick={() => void removeRule(rule)}
                      className="text-xs text-danger hover:text-danger-strong"
                    >
                      {gt("Remove")}
                    </button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
        {canEdit && centres.length > 0 && (
          <NewRuleForm
            api={api}
            orgId={orgId}
            centres={centrePaths}
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
  api,
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
  api: SettingsApi;
  orgId: string;
  centres: CostCentrePathRow[];
  accounts: CostDimensionOption[];
  providers: CostDimensionOption[];
  services: CostDimensionOption[];
  tagKeys: string[];
  nextPriority: number;
  onCreated: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const gt = useGT();
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
      await api.post(`/api/org/${orgId}/cost-centres/rules`, {
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
      onError(e instanceof Error ? e.message : gt("Failed to create rule"));
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
        aria-label={gt("Tag key")}
        className={selectClass}
      >
        <option value="">{gt("Any tag")}</option>
        {tagKeys.map((key) => (
          <option key={key} value={key}>
            {gt("tag: {key}", { key })}
          </option>
        ))}
      </select>
      {tagKey && (
        <input
          type="text"
          value={tagValue}
          onChange={(e) => setTagValue(e.target.value)}
          placeholder={gt("value (blank = any)")}
          aria-label={gt("Tag value")}
          className={selectClass}
        />
      )}
      <select
        value={accountId}
        onChange={(e) => setAccountId(e.target.value)}
        aria-label={gt("Account")}
        className={selectClass}
      >
        <option value="">{gt("Any account")}</option>
        {accounts.map((a) => (
          <option key={a.value} value={a.value}>
            {a.label}
          </option>
        ))}
      </select>
      <select
        value={pluginId}
        onChange={(e) => setPluginId(e.target.value)}
        aria-label={gt("Provider")}
        className={selectClass}
      >
        <option value="">{gt("Any provider")}</option>
        {providers.map((p) => (
          <option key={p.value} value={p.value}>
            {p.label}
          </option>
        ))}
      </select>
      <select
        value={service}
        onChange={(e) => setService(e.target.value)}
        aria-label={gt("Service")}
        className={selectClass}
      >
        <option value="">{gt("Any service")}</option>
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
        aria-label={gt("Cost centre")}
        className={selectClass}
      >
        {centres.map((c) => (
          <option key={c.id} value={c.id}>
            {c.path}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={() => void submit()}
        disabled={submitting || !costCentreId}
        className="px-3 py-1.5 text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg transition-colors"
      >
        {submitting ? gt("Adding…") : gt("Add rule")}
      </button>
    </div>
  );
}
