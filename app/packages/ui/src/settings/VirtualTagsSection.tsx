import { useCallback, useEffect, useMemo, useState } from "react";
import { T, Var, useGT } from "gt-react";
import {
  DEFAULT_VIRTUAL_TAG_RULE,
  VIRTUAL_TAG_PROCESSING_STATE_LABELS,
  VIRTUAL_TAG_RULE_KINDS,
  VIRTUAL_TAG_RULE_KIND_DESCRIPTIONS,
  VIRTUAL_TAG_RULE_KIND_LABELS,
  VIRTUAL_TAG_VALUE_TRANSFORMS,
  VIRTUAL_TAG_VALUE_TRANSFORM_LABELS,
  CostQueryFormatError,
  describeVirtualTagRule,
  formatCostQuery,
  normalizeVirtualTagInput,
  parseCostQuery,
  virtualTagInputError,
} from "@infrawrench/client-core";
import type {
  BusinessMetric,
  CostDimensionOption,
  CostFilter,
  VirtualTag,
  VirtualTagInput,
  VirtualTagRule,
  VirtualTagRuleKind,
  VirtualTagStats,
  VirtualTagValueTransform,
} from "@infrawrench/client-core";
import { useDataString } from "../i18n/data-strings.js";
import { Modal } from "../components/Modal.js";
import { CostFilterEditor } from "../cost/CostFilterEditor.js";
import type { CostApi } from "../cost/types.js";
import { formatMoney } from "../cost/transform.js";
import { useSettingsHost, type SettingsApi } from "./host.js";
import { CARD, INPUT, LABEL, PRIMARY_BUTTON, SECONDARY_BUTTON } from "./styles.js";

/** A rule plus a client-only id, so reordering keeps each row's React state. */
interface DraftRule {
  uid: number;
  rule: VirtualTagRule;
}

let nextUid = 1;
const draft = (rule: VirtualTagRule): DraftRule => ({ uid: nextUid++, rule });

/** The filter rows a rule's query text stands for; [] when it does not parse. */
function filtersOf(query: string | null): CostFilter[] {
  try {
    return parseCostQuery(query ?? "");
  } catch {
    return [];
  }
}

/**
 * The adapter the shared filter editor needs. Only `loadDimensionValues` is
 * ever called from a filter row; the other two are wired to their real
 * endpoints so the object is honest rather than a stub that throws.
 */
function useCostApi(api: SettingsApi, orgId: string): CostApi {
  return useMemo<CostApi>(
    () => ({
      queryCosts: (req) => api.post(`/api/org/${orgId}/costs/query`, req),
      loadCostStatus: () => api.get(`/api/org/${orgId}/costs/status`),
      loadDimensionValues: async (dimension, tagKey) => {
        const params = new URLSearchParams({ dimension });
        if (tagKey) params.set("tagKey", tagKey);
        const res = await api.get<{ values: Array<string | CostDimensionOption> }>(
          `/api/org/${orgId}/costs/dimensions?${params.toString()}`,
        );
        return res.values.map((v) => (typeof v === "string" ? { value: v, label: v } : v));
      },
    }),
    [api, orgId],
  );
}

/**
 * Settings → Virtual Tags.
 *
 * Next to Cost Centres and Billing Rules because it is the same kind of object
 * (ordered rules over spend) and the people who maintain one maintain the
 * others. Reading needs `costs:read`, editing `costs:write`: a virtual tag adds
 * a way to slice spend and never changes how much there is.
 */
export function VirtualTagsSection() {
  const gt = useGT();
  const { orgId, api, has } = useSettingsHost();
  const canRead = has("costs:read");
  const canEdit = has("costs:write");
  const costApi = useCostApi(api, orgId);

  const [tags, setTags] = useState<VirtualTag[] | null>(null);
  const [metrics, setMetrics] = useState<BusinessMetric[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<VirtualTag | "new" | null>(null);

  const load = useCallback(async () => {
    try {
      setTags(await api.get<VirtualTag[]>(`/api/org/${orgId}/virtual-tags`));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to load virtual tags"));
    }
  }, [api, orgId, gt]);

  useEffect(() => {
    if (!canRead) return;
    void load();
    api.get<BusinessMetric[]>(`/api/org/${orgId}/business-metrics`).then(setMetrics, () => {});
  }, [api, orgId, canRead, load]);

  // Poll while anything is queued or processing, so the badge settles on its own.
  const busy = (tags ?? []).some(
    (t) => t.status.state === "pending" || t.status.state === "processing",
  );
  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(timer);
  }, [busy, load]);

  const metricName = useCallback(
    (id: string) => metrics.find((m) => m.id === id)?.name ?? id,
    [metrics],
  );

  async function reprocess(tag: VirtualTag) {
    try {
      await api.post(`/api/org/${orgId}/virtual-tags/${tag.id}/reprocess`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to queue processing"));
    }
  }

  async function remove(tag: VirtualTag) {
    if (!window.confirm(gt('Delete the virtual tag "{name}"?', { name: tag.name }))) return;
    try {
      await api.delete(`/api/org/${orgId}/virtual-tags/${tag.id}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to delete virtual tag"));
    }
  }

  if (!canRead) {
    return (
      <T>
        <div className="text-sm text-on-surface-secondary">
          You need the <code>costs:read</code> permission to see the organisation&rsquo;s virtual
          tags.
        </div>
      </T>
    );
  }

  return (
    <section className="flex flex-col gap-4 max-w-3xl">
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-on-surface">{gt("Virtual tags")}</h2>
          {canEdit && (
            <button type="button" className={PRIMARY_BUTTON} onClick={() => setEditing("new")}>
              {gt("New virtual tag")}
            </button>
          )}
        </div>
        <T>
          <p className="text-sm text-on-surface-secondary">
            Tags the organisation computes from its own rules: merge spellings like env, Environment
            and ENV into one key, give spend a value by any cost filter, and split a shared cost
            across teams by percentage or by a business metric. Rules evaluate in order and the
            first match wins.
          </p>
        </T>
        <T>
          <p className="text-sm text-on-surface-muted">
            Use a virtual tag anywhere a tag works: graphs and reports, saved filters, budgets,
            change alerts, allocation rules and exports. It is computed when a report runs and never
            written into collected spend, and a split shares money rather than copying it, so totals
            never change.
          </p>
        </T>
      </div>

      {error !== null && (
        <div role="alert" className="text-sm text-danger">
          {error}
        </div>
      )}
      {tags === null && <div className="text-sm text-on-surface-muted">{gt("Loading…")}</div>}
      {tags !== null && tags.length === 0 && (
        <p className="text-sm text-on-surface-muted">{gt("No virtual tags yet.")}</p>
      )}

      {(tags ?? []).map((tag) => (
        <VirtualTagCard
          key={tag.id}
          tag={tag}
          canEdit={canEdit}
          metricName={metricName}
          onEdit={() => setEditing(tag)}
          onReprocess={() => void reprocess(tag)}
          onDelete={() => void remove(tag)}
        />
      ))}

      {!canEdit && tags !== null && (
        <T>
          <p className="text-xs text-on-surface-muted">
            Changing these needs the <code>costs:write</code> permission.
          </p>
        </T>
      )}

      {editing !== null && (
        <VirtualTagEditor
          existing={editing === "new" ? null : editing}
          api={api}
          orgId={orgId}
          costApi={costApi}
          metrics={metrics}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await load();
          }}
        />
      )}
    </section>
  );
}

function StatusBadge({ tag }: { tag: VirtualTag }) {
  const gtData = useDataString();
  const tone =
    tag.status.state === "ready"
      ? "text-success border-success/40"
      : tag.status.state === "failed"
        ? "text-danger border-danger/40"
        : "text-on-surface-muted border-border";
  return (
    <span className={`px-2 py-0.5 text-[11px] rounded-full border ${tone}`}>
      {gtData(VIRTUAL_TAG_PROCESSING_STATE_LABELS[tag.status.state])}
    </span>
  );
}

function VirtualTagCard({
  tag,
  canEdit,
  metricName,
  onEdit,
  onReprocess,
  onDelete,
}: {
  tag: VirtualTag;
  canEdit: boolean;
  metricName: (id: string) => string;
  onEdit: () => void;
  onReprocess: () => void;
  onDelete: () => void;
}) {
  const gt = useGT();
  const stats = tag.status.stats;
  return (
    <div className={CARD}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-on-surface">{tag.name}</span>
            <code className="text-xs text-on-surface-muted">{`virtual_tag['${tag.key}']`}</code>
            <StatusBadge tag={tag} />
          </div>
          {tag.description && (
            <p className="text-xs text-on-surface-muted mt-1">{tag.description}</p>
          )}
        </div>
        {canEdit && (
          <div className="flex items-center gap-2 shrink-0">
            <button type="button" className={SECONDARY_BUTTON} onClick={onEdit}>
              {gt("Edit")}
            </button>
            <button
              type="button"
              className="text-xs text-on-surface-secondary hover:text-on-surface underline"
              onClick={onReprocess}
            >
              {gt("Reprocess")}
            </button>
            <button
              type="button"
              className="text-xs text-danger hover:text-danger-strong"
              onClick={onDelete}
            >
              {gt("Delete")}
            </button>
          </div>
        )}
      </div>

      <ol className="mt-3 space-y-1 text-xs text-on-surface-secondary list-decimal list-inside">
        {tag.rules.map((rule, i) => (
          <li key={i} className="truncate">
            {describeVirtualTagRule(rule, metricName)}
          </li>
        ))}
      </ol>
      {tag.defaultValue && (
        <p className="mt-1 text-xs text-on-surface-muted">
          {gt("Everything else: {value}", { value: tag.defaultValue })}
        </p>
      )}

      {tag.status.state === "failed" && tag.status.error && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {tag.status.error}
        </p>
      )}
      {stats && <StatsSummary stats={stats} />}
    </div>
  );
}

/** Coverage, top values and fallbacks, from the last evaluation. */
function StatsSummary({ stats, perRule }: { stats: VirtualTagStats; perRule?: boolean }) {
  const gt = useGT();
  if (stats.currencies.length === 0) {
    return (
      <p className="mt-2 text-xs text-on-surface-muted">
        {gt("No spend in the evaluated range yet.")}
      </p>
    );
  }
  return (
    <div className="mt-3 space-y-2 text-xs">
      {stats.from && stats.to && (
        <p className="text-on-surface-muted">
          {gt("Evaluated over {from} to {to}; {count} distinct values.", {
            from: stats.from,
            to: stats.to,
            count: stats.distinctValues,
          })}
        </p>
      )}
      {stats.currencies.map((c) => {
        const matched = c.total - c.unmatched;
        const pct = c.total !== 0 ? Math.round((matched / c.total) * 1000) / 10 : 0;
        return (
          <div key={c.currency} className="space-y-1">
            <T>
              <p className="text-on-surface-secondary">
                <Var>{pct}</Var>% of <Var>{formatMoney(c.total, c.currency)}</Var> matched a rule;{" "}
                <Var>{formatMoney(c.unmatched, c.currency)}</Var> did not.
              </p>
            </T>
            {perRule && c.byRule.length > 0 && (
              <ul className="text-on-surface-muted">
                {c.byRule.map((amount, i) => (
                  <li key={i}>
                    {gt("Rule {n}: {amount}", {
                      n: i + 1,
                      amount: formatMoney(amount, c.currency),
                    })}
                  </li>
                ))}
              </ul>
            )}
            {c.topValues.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {c.topValues.slice(0, perRule ? 10 : 5).map((v) => (
                  <span
                    key={v.value}
                    className="px-2 py-0.5 rounded bg-surface-overlay text-on-surface-secondary"
                  >
                    {v.value} · {formatMoney(v.amount, c.currency)}
                  </span>
                ))}
              </div>
            )}
          </div>
        );
      })}
      {stats.metricFallbackDays > 0 && (
        <p className="text-warning">
          {gt(
            "{days} days had no complete business metric values, so their split carried the last good weights forward (or split evenly).",
            { days: stats.metricFallbackDays },
          )}
        </p>
      )}
    </div>
  );
}

function VirtualTagEditor({
  existing,
  api,
  orgId,
  costApi,
  metrics,
  onClose,
  onSaved,
}: {
  existing: VirtualTag | null;
  api: SettingsApi;
  orgId: string;
  costApi: CostApi;
  metrics: BusinessMetric[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const gt = useGT();
  const [key, setKey] = useState(existing?.key ?? "");
  const [name, setName] = useState(existing?.name ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [defaultValue, setDefaultValue] = useState(existing?.defaultValue ?? "");
  const [rules, setRules] = useState<DraftRule[]>(() =>
    (existing?.rules ?? [{ ...DEFAULT_VIRTUAL_TAG_RULE }]).map(draft),
  );
  const [tagKeys, setTagKeys] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<VirtualTagStats | null>(null);
  const [previewing, setPreviewing] = useState(false);

  useEffect(() => {
    costApi.loadDimensionValues("tag-keys").then(
      (options) => setTagKeys(options.map((o) => o.value)),
      () => {},
    );
  }, [costApi]);

  const input = (): VirtualTagInput =>
    normalizeVirtualTagInput({
      key,
      name,
      description,
      defaultValue,
      rules: rules.map((r) => r.rule),
    });

  const updateRule = (uid: number, patch: Partial<VirtualTagRule>) =>
    setRules((prev) =>
      prev.map((r) => (r.uid === uid ? { ...r, rule: { ...r.rule, ...patch } } : r)),
    );
  const move = (index: number, delta: number) =>
    setRules((prev) => {
      const next = [...prev];
      const target = index + delta;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });

  async function runPreview() {
    const body = input();
    const problem = virtualTagInputError(body);
    if (problem) {
      setError(problem);
      return;
    }
    setPreviewing(true);
    setError(null);
    try {
      setPreview(await api.post<VirtualTagStats>(`/api/org/${orgId}/virtual-tags/preview`, body));
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Preview failed"));
    } finally {
      setPreviewing(false);
    }
  }

  async function save() {
    const body = input();
    const problem = virtualTagInputError(body);
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (existing) await api.put(`/api/org/${orgId}/virtual-tags/${existing.id}`, body);
      else await api.post(`/api/org/${orgId}/virtual-tags`, body);
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to save virtual tag"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal onClose={onClose} ariaLabel={existing ? gt("Edit virtual tag") : gt("New virtual tag")}>
      <div className="bg-surface-raised border border-border-strong rounded-xl w-[48rem] max-w-[94vw] shadow-2xl">
        <div className="p-5 space-y-4 max-h-[82vh] overflow-y-auto">
          <h2 className="text-lg font-semibold">
            {existing ? gt("Edit virtual tag") : gt("New virtual tag")}
          </h2>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className={LABEL}>{gt("Name")}</span>
              <input
                className={INPUT}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={gt("Team")}
              />
            </label>
            <label className="block">
              <span className={LABEL}>{gt("Key")}</span>
              <input
                className={INPUT}
                value={key}
                disabled={existing !== null}
                onChange={(e) => setKey(e.target.value)}
                placeholder={gt("team")}
                title={
                  existing
                    ? gt("The key cannot change: filters, budgets and reports store it.")
                    : undefined
                }
              />
            </label>
            <label className="block col-span-2">
              <span className={LABEL}>{gt("Description")}</span>
              <input
                className={INPUT}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </label>
          </div>

          <div className="space-y-3">
            <h3 className="text-sm font-semibold">{gt("Rules")}</h3>
            <p className="text-xs text-on-surface-muted">
              {gt(
                "Rules evaluate top to bottom; a row takes the value of the first rule it matches.",
              )}
            </p>
            {rules.map((r, i) => (
              <RuleEditor
                key={r.uid}
                index={i}
                count={rules.length}
                rule={r.rule}
                tagKeys={tagKeys}
                metrics={metrics}
                costApi={costApi}
                onChange={(patch) => updateRule(r.uid, patch)}
                onMove={(delta) => move(i, delta)}
                onRemove={() => setRules((prev) => prev.filter((x) => x.uid !== r.uid))}
              />
            ))}
            <button
              type="button"
              className={SECONDARY_BUTTON}
              onClick={() => setRules((prev) => [...prev, draft({ ...DEFAULT_VIRTUAL_TAG_RULE })])}
            >
              {gt("+ Add rule")}
            </button>
          </div>

          <label className="block">
            <span className={LABEL}>{gt("Value for everything no rule matches (optional)")}</span>
            <input
              className={INPUT}
              value={defaultValue}
              onChange={(e) => setDefaultValue(e.target.value)}
              placeholder={gt("Leave empty to leave it unset")}
            />
          </label>

          {preview && (
            <div className="border border-border rounded-lg p-3">
              <h3 className="text-sm font-semibold">{gt("Preview: last 30 days")}</h3>
              <StatsSummary stats={preview} perRule />
            </div>
          )}

          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <button type="button" className={SECONDARY_BUTTON} onClick={onClose}>
              {gt("Cancel")}
            </button>
            <button
              type="button"
              className={SECONDARY_BUTTON}
              disabled={previewing}
              onClick={() => void runPreview()}
            >
              {previewing ? gt("Previewing…") : gt("Preview")}
            </button>
            <button
              type="button"
              className={PRIMARY_BUTTON}
              disabled={saving}
              onClick={() => void save()}
            >
              {saving ? gt("Saving…") : gt("Save")}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function RuleEditor({
  index,
  count,
  rule,
  tagKeys,
  metrics,
  costApi,
  onChange,
  onMove,
  onRemove,
}: {
  index: number;
  count: number;
  rule: VirtualTagRule;
  tagKeys: string[];
  metrics: BusinessMetric[];
  costApi: CostApi;
  onChange: (patch: Partial<VirtualTagRule>) => void;
  onMove: (delta: number) => void;
  onRemove: () => void;
}) {
  const gt = useGT();
  const gtData = useDataString();
  // The rows are a view of `rule.query`; held here so a half-built row (no
  // values yet) is not lost when it formats to nothing.
  const [filters, setFilters] = useState<CostFilter[]>(() => filtersOf(rule.query));

  const setKind = (kind: VirtualTagRuleKind) => {
    const patch: Partial<VirtualTagRule> = { kind };
    if (kind === "tag" && rule.sources.length === 0) {
      patch.sources = [{ tagKey: "", valuePrefix: null, query: null }];
    }
    if ((kind === "split" || kind === "metric_split") && rule.allocations.length < 2) {
      patch.allocations = [
        { value: "", percent: kind === "split" ? 50 : null, metricId: null },
        { value: "", percent: kind === "split" ? 50 : null, metricId: null },
      ];
    }
    onChange(patch);
  };

  const percentTotal = rule.allocations.reduce((s, a) => s + (a.percent ?? 0), 0);

  return (
    <div className="border border-border rounded-lg p-3 space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold text-on-surface-muted w-12">
          {gt("Rule {n}", { n: index + 1 })}
        </span>
        <select
          aria-label={gt("Rule kind")}
          className={`${INPUT} w-auto`}
          value={rule.kind}
          onChange={(e) => setKind(e.target.value as VirtualTagRuleKind)}
        >
          {VIRTUAL_TAG_RULE_KINDS.map((k) => (
            <option key={k} value={k}>
              {gtData(VIRTUAL_TAG_RULE_KIND_LABELS[k])}
            </option>
          ))}
        </select>
        <span className="flex-1" />
        <button
          type="button"
          className="text-xs text-on-surface-secondary disabled:opacity-40"
          disabled={index === 0}
          onClick={() => onMove(-1)}
          aria-label={gt("Move rule up")}
        >
          ↑
        </button>
        <button
          type="button"
          className="text-xs text-on-surface-secondary disabled:opacity-40"
          disabled={index === count - 1}
          onClick={() => onMove(1)}
          aria-label={gt("Move rule down")}
        >
          ↓
        </button>
        <button type="button" className="text-xs text-danger" onClick={onRemove}>
          {gt("Remove")}
        </button>
      </div>
      <p className="text-xs text-on-surface-muted">
        {gtData(VIRTUAL_TAG_RULE_KIND_DESCRIPTIONS[rule.kind])}
      </p>

      <div>
        <span className={LABEL}>{gt("Applies to (empty matches all spend)")}</span>
        <CostFilterEditor
          filters={filters}
          api={costApi}
          excludeDimensions={["virtual_tag"]}
          onChange={(next) => {
            setFilters(next);
            try {
              const text = formatCostQuery(next);
              onChange({ query: text });
            } catch (e) {
              // A tag row without its key yet: keep the last query that rendered.
              if (e instanceof CostQueryFormatError) return;
              throw e;
            }
          }}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className={LABEL}>{gt("From (optional)")}</span>
          <input
            type="date"
            className={INPUT}
            value={rule.startsOn ?? ""}
            onChange={(e) => onChange({ startsOn: e.target.value || null })}
          />
        </label>
        <label className="block">
          <span className={LABEL}>{gt("Until (optional)")}</span>
          <input
            type="date"
            className={INPUT}
            value={rule.endsOn ?? ""}
            onChange={(e) => onChange({ endsOn: e.target.value || null })}
          />
        </label>
      </div>

      {rule.kind === "value" && (
        <label className="block">
          <span className={LABEL}>{gt("Value")}</span>
          <input
            className={INPUT}
            value={rule.value ?? ""}
            onChange={(e) => onChange({ value: e.target.value })}
            placeholder={gt("payments")}
          />
        </label>
      )}

      {rule.kind === "tag" && (
        <div className="space-y-2">
          <span className={LABEL}>{gt("Tag keys, first present wins")}</span>
          <datalist id={`vt-tag-keys-${index}`}>
            {tagKeys.map((k) => (
              <option key={k} value={k} />
            ))}
          </datalist>
          {rule.sources.map((source, si) => (
            <div key={si} className="grid grid-cols-[1fr_8rem_1fr_auto] gap-2 items-center">
              <input
                className={INPUT}
                list={`vt-tag-keys-${index}`}
                aria-label={gt("Tag key")}
                placeholder={gt("Tag key")}
                value={source.tagKey}
                onChange={(e) =>
                  onChange({
                    sources: rule.sources.map((s, j) =>
                      j === si ? { ...s, tagKey: e.target.value } : s,
                    ),
                  })
                }
              />
              <input
                className={INPUT}
                aria-label={gt("Value prefix")}
                placeholder={gt("Prefix")}
                value={source.valuePrefix ?? ""}
                onChange={(e) =>
                  onChange({
                    sources: rule.sources.map((s, j) =>
                      j === si ? { ...s, valuePrefix: e.target.value || null } : s,
                    ),
                  })
                }
              />
              <input
                className={INPUT}
                aria-label={gt("Only where (cost query)")}
                placeholder={gt("Only where, e.g. provider = 'azure'")}
                value={source.query ?? ""}
                onChange={(e) =>
                  onChange({
                    sources: rule.sources.map((s, j) =>
                      j === si ? { ...s, query: e.target.value || null } : s,
                    ),
                  })
                }
              />
              <button
                type="button"
                className="text-xs text-danger"
                onClick={() => onChange({ sources: rule.sources.filter((_, j) => j !== si) })}
              >
                {gt("Remove")}
              </button>
            </div>
          ))}
          <div className="flex items-center gap-3">
            <button
              type="button"
              className="text-xs text-info hover:text-info-strong"
              onClick={() =>
                onChange({
                  sources: [...rule.sources, { tagKey: "", valuePrefix: null, query: null }],
                })
              }
            >
              {gt("+ Add tag key")}
            </button>
            <label className="flex items-center gap-2 text-xs">
              <span className="text-on-surface-muted">{gt("Case")}</span>
              <select
                className={`${INPUT} w-auto`}
                value={rule.valueTransform}
                onChange={(e) =>
                  onChange({ valueTransform: e.target.value as VirtualTagValueTransform })
                }
              >
                {VIRTUAL_TAG_VALUE_TRANSFORMS.map((t) => (
                  <option key={t} value={t}>
                    {gtData(VIRTUAL_TAG_VALUE_TRANSFORM_LABELS[t])}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
      )}

      {(rule.kind === "split" || rule.kind === "metric_split") && (
        <div className="space-y-2">
          <span className={LABEL}>
            {rule.kind === "split" ? gt("Shares (percent)") : gt("Shares (weighted by metric)")}
          </span>
          {rule.allocations.map((a, ai) => (
            <div key={ai} className="grid grid-cols-[1fr_12rem_auto] gap-2 items-center">
              <input
                className={INPUT}
                aria-label={gt("Value")}
                placeholder={gt("Value")}
                value={a.value}
                onChange={(e) =>
                  onChange({
                    allocations: rule.allocations.map((x, j) =>
                      j === ai ? { ...x, value: e.target.value } : x,
                    ),
                  })
                }
              />
              {rule.kind === "split" ? (
                <input
                  type="number"
                  min={0}
                  max={100}
                  step="any"
                  className={INPUT}
                  aria-label={gt("Percent")}
                  value={a.percent ?? ""}
                  onChange={(e) =>
                    onChange({
                      allocations: rule.allocations.map((x, j) =>
                        j === ai
                          ? { ...x, percent: e.target.value === "" ? null : Number(e.target.value) }
                          : x,
                      ),
                    })
                  }
                />
              ) : (
                <select
                  className={INPUT}
                  aria-label={gt("Business metric")}
                  value={a.metricId ?? ""}
                  onChange={(e) =>
                    onChange({
                      allocations: rule.allocations.map((x, j) =>
                        j === ai ? { ...x, metricId: e.target.value || null } : x,
                      ),
                    })
                  }
                >
                  <option value="">{gt("Choose a metric…")}</option>
                  {metrics.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              )}
              <button
                type="button"
                className="text-xs text-danger"
                onClick={() =>
                  onChange({ allocations: rule.allocations.filter((_, j) => j !== ai) })
                }
              >
                {gt("Remove")}
              </button>
            </div>
          ))}
          <div className="flex items-center gap-3 text-xs">
            <button
              type="button"
              className="text-info hover:text-info-strong"
              onClick={() =>
                onChange({
                  allocations: [
                    ...rule.allocations,
                    { value: "", percent: rule.kind === "split" ? 0 : null, metricId: null },
                  ],
                })
              }
            >
              {gt("+ Add share")}
            </button>
            {rule.kind === "split" && (
              <span
                className={
                  Math.abs(percentTotal - 100) <= 0.01 ? "text-on-surface-muted" : "text-warning"
                }
              >
                {gt("Total: {total}%", { total: Number(percentTotal.toFixed(2)) })}
              </span>
            )}
            {rule.kind === "metric_split" && metrics.length === 0 && (
              <span className="text-warning">
                {gt("No business metrics yet: add one on the Costs panel first.")}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
