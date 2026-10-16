import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { useGT } from "gt-react";
import {
  COST_RANGE_PRESET_LABELS,
  COST_RANGE_PRESETS,
  K8S_COST_CATEGORIES,
  K8S_EFFICIENCY_LIMITS,
  kubernetesEfficiencyConfigProblem,
  type CostFilter,
  type CostReportFolder,
  type K8sCostCategory,
  type K8sEfficiencyGroupBy,
  type KubernetesEfficiencyConfig,
  type KubernetesEfficiencyReportInput,
} from "@infrawrench/client-core";
import { Modal } from "../components/Modal.js";
import { MultiSelect, type MultiSelectStatus } from "../components/MultiSelect.js";
import { labelClass, selectClass } from "../cost/form-styles.js";
import { useDataString } from "../i18n/data-strings.js";
import { useK8sEfficiencyLabels } from "./labels.js";
import type { KubernetesEfficiencyClient, KubernetesEfficiencyOptions } from "./types.js";

/** The editor's own filter kinds; each is one `CostFilter` on the wire. */
type FilterKind = "cluster" | "region" | "namespace" | "workload" | "node_pool" | "label";

interface DraftFilter {
  kind: FilterKind;
  /** The label key for `label`; ignored otherwise. */
  labelKey: string;
  op: CostFilter["op"];
  values: string[];
}

const FIXED_TAG_KEYS: Partial<Record<FilterKind, string>> = {
  namespace: "namespace",
  workload: "workload",
  node_pool: "node_pool",
};

function toDraft(f: CostFilter): DraftFilter {
  if (f.dimension === "account")
    return { kind: "cluster", labelKey: "", op: f.op, values: f.values };
  if (f.dimension === "region") return { kind: "region", labelKey: "", op: f.op, values: f.values };
  const key = f.tagKey ?? "";
  const fixed = (Object.entries(FIXED_TAG_KEYS) as Array<[FilterKind, string]>).find(
    ([, tagKey]) => tagKey === key,
  );
  return fixed
    ? { kind: fixed[0], labelKey: "", op: f.op, values: f.values }
    : { kind: "label", labelKey: key, op: f.op, values: f.values };
}

function fromDraft(d: DraftFilter): CostFilter | null {
  if (d.values.length === 0) return null;
  if (d.kind === "cluster") return { dimension: "account", op: d.op, values: d.values };
  if (d.kind === "region") return { dimension: "region", op: d.op, values: d.values };
  const tagKey = d.kind === "label" ? d.labelKey.trim() : FIXED_TAG_KEYS[d.kind]!;
  if (!tagKey) return null;
  return { dimension: "tag", tagKey, op: d.op, values: d.values };
}

/** Folders as "Parent / Child" paths, for a flat select. */
function folderPaths(folders: CostReportFolder[]): Array<{ id: string; path: string }> {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const pathOf = (f: CostReportFolder): string => {
    const parts = [f.name];
    const seen = new Set([f.id]);
    let parent = f.parentFolderId ? byId.get(f.parentFolderId) : undefined;
    while (parent && !seen.has(parent.id)) {
      parts.unshift(parent.name);
      seen.add(parent.id);
      parent = parent.parentFolderId ? byId.get(parent.parentFolderId) : undefined;
    }
    return parts.join(" / ");
  };
  return folders
    .map((f) => ({ id: f.id, path: pathOf(f) }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

export interface KubernetesEfficiencyEditorProps {
  client: KubernetesEfficiencyClient;
  initial: KubernetesEfficiencyReportInput;
  /** True when editing a saved report rather than creating one. */
  existing: boolean;
  onSave: (input: KubernetesEfficiencyReportInput) => Promise<void>;
  onClose: () => void;
}

export function KubernetesEfficiencyEditor({
  client,
  initial,
  existing,
  onSave,
  onClose,
}: KubernetesEfficiencyEditorProps) {
  const gt = useGT();
  const gtData = useDataString();
  const uid = useId();
  const labels = useK8sEfficiencyLabels();
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description ?? "");
  const [folderId, setFolderId] = useState<string | null>(initial.folderId ?? null);
  const [config, setConfig] = useState<KubernetesEfficiencyConfig>(initial.config);
  const [filters, setFilters] = useState<DraftFilter[]>(() => initial.config.filters.map(toDraft));
  const [options, setOptions] = useState<KubernetesEfficiencyOptions | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [folders, setFolders] = useState<CostReportFolder[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadOptions = useCallback(() => {
    setOptionsError(null);
    client
      .getOptions()
      .then(setOptions)
      .catch((e: unknown) => setOptionsError(e instanceof Error ? e.message : String(e)));
  }, [client]);

  useEffect(() => {
    loadOptions();
  }, [loadOptions]);

  useEffect(() => {
    if (!client.listFolders) return;
    let cancelled = false;
    client
      .listFolders()
      .then((next) => {
        if (!cancelled) setFolders(next);
      })
      // Filing is optional: without folders the report saves at the top level.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [client]);

  const set = (patch: Partial<KubernetesEfficiencyConfig>) =>
    setConfig((prev) => ({ ...prev, ...patch }));

  const effective: KubernetesEfficiencyConfig = useMemo(() => {
    const wire = filters.map(fromDraft).filter((f): f is CostFilter => f !== null);
    const next: KubernetesEfficiencyConfig = { ...config, filters: wire };
    if (next.groupBy !== "label") delete next.groupByLabelKey;
    if (next.categories && next.categories.length === 0) delete next.categories;
    return next;
  }, [config, filters]);

  const problem = kubernetesEfficiencyConfigProblem(effective);
  const trimmedName = name.trim();
  const nameProblem =
    trimmedName.length === 0
      ? gt("Name the report.")
      : trimmedName.length > K8S_EFFICIENCY_LIMITS.maxNameLength
        ? gt("The name is too long.")
        : null;

  async function save() {
    if (problem || nameProblem) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({
        name: trimmedName,
        ...(description.trim() ? { description: description.trim() } : {}),
        config: effective,
        folderId,
      });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }

  const labelKeyOptions = options?.labelKeys ?? [];
  const groupLabel = (group: string) =>
    group === "k8s_pod_label"
      ? gt("Pod labels")
      : group === "k8s_node_label"
        ? gt("Node labels")
        : group === "k8s_pvc_label"
          ? gt("Volume labels")
          : group === "k8s"
            ? gt("Kubernetes")
            : gt("Tags");

  const renderLabelKeySelect = (id: string, value: string, onChange: (key: string) => void) => (
    <select
      id={id}
      className={selectClass}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{gt("Choose a label…")}</option>
      {value && !labelKeyOptions.some((g) => g.keys.some((k) => k.key === value)) && (
        <option value={value}>{value}</option>
      )}
      {labelKeyOptions.map((g) => (
        <optgroup key={g.group} label={groupLabel(g.group)}>
          {g.keys.map((k) => (
            <option key={k.key} value={k.key}>
              {k.name}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );

  const categories = config.categories ?? [];
  const toggleCategory = (c: K8sCostCategory) =>
    set({
      categories: categories.includes(c) ? categories.filter((x) => x !== c) : [...categories, c],
    });

  return (
    <Modal
      onClose={onClose}
      ariaLabel={existing ? gt("Edit efficiency report") : gt("New efficiency report")}
    >
      <div className="flex max-h-[85vh] w-[min(46rem,92vw)] flex-col overflow-hidden rounded-xl border border-border-strong bg-surface-raised shadow-2xl">
        <div className="border-b border-border px-5 py-3">
          <h2 className="text-sm font-semibold text-on-surface">
            {existing ? gt("Edit efficiency report") : gt("New efficiency report")}
          </h2>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor={`${uid}-name`} className={labelClass}>
                {gt("Name")}
              </label>
              <input
                id={`${uid}-name`}
                className={selectClass}
                value={name}
                maxLength={K8S_EFFICIENCY_LIMITS.maxNameLength}
                onChange={(e) => setName(e.target.value)}
                placeholder={gt("Payments cluster efficiency")}
              />
            </div>
            <div>
              <label htmlFor={`${uid}-folder`} className={labelClass}>
                {gt("Folder")}
              </label>
              <select
                id={`${uid}-folder`}
                className={selectClass}
                value={folderId ?? ""}
                onChange={(e) => setFolderId(e.target.value || null)}
              >
                <option value="">{gt("No folder")}</option>
                {folderPaths(folders).map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.path}
                  </option>
                ))}
              </select>
            </div>
            <div className="sm:col-span-2">
              <label htmlFor={`${uid}-description`} className={labelClass}>
                {gt("Description")}
              </label>
              <textarea
                id={`${uid}-description`}
                className={selectClass}
                rows={2}
                value={description}
                maxLength={K8S_EFFICIENCY_LIMITS.maxDescriptionLength}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div>
              <label htmlFor={`${uid}-range`} className={labelClass}>
                {gt("Date range")}
              </label>
              <select
                id={`${uid}-range`}
                className={selectClass}
                value={config.dateRange.kind === "relative" ? config.dateRange.preset : "custom"}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === "custom") {
                    const today = new Date().toISOString().slice(0, 10);
                    set({ dateRange: { kind: "absolute", from: today, to: today } });
                  } else {
                    set({
                      dateRange: {
                        kind: "relative",
                        preset: v as (typeof COST_RANGE_PRESETS)[number],
                      },
                    });
                  }
                }}
              >
                {COST_RANGE_PRESETS.map((p) => (
                  <option key={p} value={p}>
                    {gtData(COST_RANGE_PRESET_LABELS[p])}
                  </option>
                ))}
                <option value="custom">{gt("Custom…")}</option>
              </select>
            </div>
            <div>
              <label htmlFor={`${uid}-granularity`} className={labelClass}>
                {gt("Granularity")}
              </label>
              <select
                id={`${uid}-granularity`}
                className={selectClass}
                value={config.granularity}
                onChange={(e) =>
                  set({ granularity: e.target.value as KubernetesEfficiencyConfig["granularity"] })
                }
              >
                <option value="day">{labels.granularity("day")}</option>
                <option value="week">{labels.granularity("week")}</option>
                <option value="month">{labels.granularity("month")}</option>
              </select>
            </div>
            <div>
              <label htmlFor={`${uid}-group-by`} className={labelClass}>
                {gt("Group by")}
              </label>
              <select
                id={`${uid}-group-by`}
                className={selectClass}
                value={config.groupBy}
                onChange={(e) => set({ groupBy: e.target.value as K8sEfficiencyGroupBy })}
              >
                {(
                  ["cluster", "namespace", "workload", "label", "node_pool", "category"] as const
                ).map((g) => (
                  <option key={g} value={g}>
                    {labels.groupBy(g)}
                  </option>
                ))}
              </select>
            </div>
            {config.dateRange.kind === "absolute" && (
              <>
                <div>
                  <label htmlFor={`${uid}-from`} className={labelClass}>
                    {gt("From")}
                  </label>
                  <input
                    id={`${uid}-from`}
                    type="date"
                    className={selectClass}
                    value={config.dateRange.from}
                    onChange={(e) =>
                      set({
                        dateRange: {
                          kind: "absolute",
                          from: e.target.value,
                          to: config.dateRange.kind === "absolute" ? config.dateRange.to : "",
                        },
                      })
                    }
                  />
                </div>
                <div>
                  <label htmlFor={`${uid}-to`} className={labelClass}>
                    {gt("To")}
                  </label>
                  <input
                    id={`${uid}-to`}
                    type="date"
                    className={selectClass}
                    value={config.dateRange.to}
                    onChange={(e) =>
                      set({
                        dateRange: {
                          kind: "absolute",
                          from: config.dateRange.kind === "absolute" ? config.dateRange.from : "",
                          to: e.target.value,
                        },
                      })
                    }
                  />
                </div>
              </>
            )}
            {config.groupBy === "label" && (
              <div className="sm:col-span-3">
                <label htmlFor={`${uid}-group-label`} className={labelClass}>
                  {gt("Label to group by")}
                </label>
                {renderLabelKeySelect(`${uid}-group-label`, config.groupByLabelKey ?? "", (key) =>
                  set({ groupByLabelKey: key || undefined }),
                )}
              </div>
            )}
          </div>

          <fieldset className="flex flex-col gap-2">
            <legend className={labelClass}>{gt("Cost categories")}</legend>
            <div className="flex flex-wrap gap-2">
              {K8S_COST_CATEGORIES.map((c) => (
                <label
                  key={c}
                  className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-on-surface"
                >
                  <input
                    type="checkbox"
                    checked={categories.includes(c)}
                    onChange={() => toggleCategory(c)}
                    className="accent-blue-500"
                  />
                  {labels.category(c)}
                </label>
              ))}
            </div>
            <p className="text-xs text-on-surface-faint">
              {gt("None ticked includes every category.")}
            </p>
          </fieldset>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <fieldset>
              <legend className={labelClass}>{gt("Idle capacity and overhead")}</legend>
              <div className="flex flex-col gap-1 text-sm text-on-surface">
                <label className="flex items-start gap-2">
                  <input
                    type="radio"
                    name={`${uid}-idle`}
                    checked={config.idle === "separate"}
                    onChange={() => set({ idle: "separate" })}
                    className="mt-1 accent-blue-500"
                  />
                  <span>
                    {gt("Separate rows")}
                    <span className="block text-xs text-on-surface-faint">
                      {gt("Idle capacity and cluster overhead are their own rows.")}
                    </span>
                  </span>
                </label>
                <label className="flex items-start gap-2">
                  <input
                    type="radio"
                    name={`${uid}-idle`}
                    checked={config.idle === "spread"}
                    onChange={() => set({ idle: "spread" })}
                    className="mt-1 accent-blue-500"
                  />
                  <span>
                    {gt("Spread across groups")}
                    <span className="block text-xs text-on-surface-faint">
                      {gt(
                        "Shared out per cluster and period in proportion to what each group was allocated.",
                      )}
                    </span>
                  </span>
                </label>
              </div>
            </fieldset>
            <fieldset>
              <legend className={labelClass}>{gt("Efficiency basis")}</legend>
              <div className="flex flex-col gap-1 text-sm text-on-surface">
                <label className="flex items-start gap-2">
                  <input
                    type="radio"
                    name={`${uid}-basis`}
                    checked={config.basis === "total"}
                    onChange={() => set({ basis: "total" })}
                    className="mt-1 accent-blue-500"
                  />
                  <span>
                    {gt("Total cost")}
                    <span className="block text-xs text-on-surface-faint">
                      {gt("Used ÷ measured total. Idle capacity and overhead count against it.")}
                    </span>
                  </span>
                </label>
                <label className="flex items-start gap-2">
                  <input
                    type="radio"
                    name={`${uid}-basis`}
                    checked={config.basis === "allocated"}
                    onChange={() => set({ basis: "allocated" })}
                    className="mt-1 accent-blue-500"
                  />
                  <span>
                    {gt("Allocated cost")}
                    <span className="block text-xs text-on-surface-faint">
                      {gt("Used ÷ what workloads requested. Only their own reservations count.")}
                    </span>
                  </span>
                </label>
              </div>
            </fieldset>
          </div>

          <fieldset className="flex flex-col gap-2">
            <legend className={labelClass}>{gt("Filters")}</legend>
            {optionsError !== null && (
              <p role="alert" className="text-xs text-danger">
                {gt("Couldn’t load the filter options: {error}", { error: optionsError })}{" "}
                <button type="button" className="underline" onClick={loadOptions}>
                  {gt("Retry")}
                </button>
              </p>
            )}
            {filters.length === 0 && (
              <p className="text-xs text-on-surface-faint">
                {gt("Every Kubernetes cluster you can see, unfiltered.")}
              </p>
            )}
            {filters.map((f, i) => (
              <FilterRow
                key={i}
                index={i}
                filter={f}
                client={client}
                options={options}
                renderLabelKeySelect={renderLabelKeySelect}
                onChange={(next) => setFilters((prev) => prev.map((p, j) => (j === i ? next : p)))}
                onRemove={() => setFilters((prev) => prev.filter((_, j) => j !== i))}
              />
            ))}
            {filters.length < K8S_EFFICIENCY_LIMITS.maxFilters && (
              <button
                type="button"
                className="self-start rounded-md border border-border px-2 py-1 text-xs text-on-surface-secondary hover:text-on-surface"
                onClick={() =>
                  setFilters((prev) => [
                    ...prev,
                    { kind: "namespace", labelKey: "", op: "in", values: [] },
                  ])
                }
              >
                {gt("Add filter")}
              </button>
            )}
          </fieldset>
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-border px-5 py-3">
          <p role="status" className="text-xs text-danger">
            {error ?? nameProblem ?? (problem ? gtData(problem) : "")}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md px-3 py-1.5 text-sm text-on-surface-secondary hover:text-on-surface"
            >
              {gt("Cancel")}
            </button>
            <button
              type="button"
              disabled={saving || Boolean(problem) || Boolean(nameProblem)}
              onClick={() => void save()}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              {saving ? gt("Saving…") : existing ? gt("Save") : gt("Create report")}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function FilterRow({
  index,
  filter,
  client,
  options,
  renderLabelKeySelect,
  onChange,
  onRemove,
}: {
  index: number;
  filter: DraftFilter;
  client: KubernetesEfficiencyClient;
  options: KubernetesEfficiencyOptions | null;
  renderLabelKeySelect: (id: string, value: string, onChange: (key: string) => void) => ReactNode;
  onChange: (next: DraftFilter) => void;
  onRemove: () => void;
}) {
  const gt = useGT();
  const uid = useId();
  const [fetched, setFetched] = useState<{ key: string; values: string[] } | null>(null);
  const [status, setStatus] = useState<MultiSelectStatus | undefined>(undefined);

  // Namespace, cluster, region and node pool come with the options; workload
  // and arbitrary labels are fetched for the chosen key.
  const tagKey =
    filter.kind === "label" ? filter.labelKey : filter.kind === "workload" ? "workload" : "";
  useEffect(() => {
    if (!tagKey) return;
    let cancelled = false;
    setStatus({ kind: "loading" });
    client
      .getTagValues(tagKey)
      .then((values) => {
        if (cancelled) return;
        setFetched({ key: tagKey, values });
        setStatus(
          values.length === 0
            ? { kind: "empty", message: gt("No values recorded yet.") }
            : undefined,
        );
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setStatus({ kind: "error", message: e instanceof Error ? e.message : String(e) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [client, tagKey, gt]);

  const valueOptions = useMemo(() => {
    const plain = (values: string[]) => values.map((v) => ({ value: v, label: v }));
    switch (filter.kind) {
      case "cluster":
        return (options?.clusters ?? []).map((c) => ({ value: c.id, label: c.name }));
      case "region":
        return plain(options?.regions ?? []);
      case "namespace":
        return plain(options?.namespaces ?? []);
      case "node_pool":
        return plain(options?.nodePools ?? []);
      default:
        return plain(fetched && fetched.key === tagKey ? fetched.values : []);
    }
  }, [filter.kind, options, fetched, tagKey]);

  const kindLabel = (k: FilterKind) =>
    k === "cluster"
      ? gt("Cluster")
      : k === "region"
        ? gt("Region")
        : k === "namespace"
          ? gt("Namespace")
          : k === "workload"
            ? gt("Workload")
            : k === "node_pool"
              ? gt("Node pool")
              : gt("Label");

  return (
    <div className="grid grid-cols-1 gap-2 rounded-lg border border-border p-2 sm:grid-cols-[9rem_7rem_1fr_auto]">
      <select
        aria-label={gt("Filter {n} dimension", { n: index + 1 })}
        className={selectClass}
        value={filter.kind}
        onChange={(e) => onChange({ ...filter, kind: e.target.value as FilterKind, values: [] })}
      >
        {(["cluster", "region", "namespace", "workload", "node_pool", "label"] as const).map(
          (k) => (
            <option key={k} value={k}>
              {kindLabel(k)}
            </option>
          ),
        )}
      </select>
      <select
        aria-label={gt("Filter {n} operator", { n: index + 1 })}
        className={selectClass}
        value={filter.op}
        onChange={(e) => onChange({ ...filter, op: e.target.value as CostFilter["op"] })}
      >
        <option value="in">{gt("is")}</option>
        <option value="not_in">{gt("is not")}</option>
      </select>
      <div className="flex flex-col gap-2 min-w-0">
        {filter.kind === "label" &&
          renderLabelKeySelect(`${uid}-key`, filter.labelKey, (key) =>
            onChange({ ...filter, labelKey: key, values: [] }),
          )}
        <MultiSelect
          label={gt("Filter {n} values", { n: index + 1 })}
          options={valueOptions}
          value={filter.values}
          onChange={(values) => onChange({ ...filter, values })}
          status={tagKey ? status : undefined}
          placeholder={gt("Choose values…")}
        />
      </div>
      <button
        type="button"
        onClick={onRemove}
        className="self-start rounded-md px-2 py-1.5 text-xs text-on-surface-secondary hover:text-danger"
      >
        {gt("Remove")}
      </button>
    </div>
  );
}
