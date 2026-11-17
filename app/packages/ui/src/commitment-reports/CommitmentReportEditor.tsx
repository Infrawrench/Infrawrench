import { useId, useMemo, useState } from "react";
import { useGT } from "gt-react";
import {
  COMMITMENT_REPORT_GRANULARITIES,
  COMMITMENT_REPORT_GROUP_BYS,
  COMMITMENT_REPORT_KINDS,
  COMMITMENT_REPORT_LIMITS,
  COMMITMENT_REPORT_METRICS,
  COST_RANGE_PRESETS,
  flattenCostReportFolderTree,
  type CommitmentReport,
  type CommitmentReportConfig,
  type CommitmentReportFilters,
  type CommitmentReportInput,
  type CommitmentReportOptions,
  type CostRangePreset,
  type CostReportFolder,
} from "@infrawrench/client-core";
import {
  CommitmentReportInput as CommitmentReportInputSchema,
  decodeForm,
} from "@infrawrench/api-contract/schemas";

import { Modal } from "../components/Modal.js";
import { CloseIcon, PlusIcon } from "../components/icons/ChromeIcons.js";
import { MultiSelect, type MultiSelectOption } from "../components/MultiSelect.js";
import { useDataString } from "../i18n/data-strings.js";
import { useCommitmentReportLabels } from "./labels.js";

const sectionClass = "text-[11px] font-semibold uppercase tracking-wider text-on-surface-faint";
const labelClass = "block text-xs text-on-surface-tertiary mb-1.5";
const controlClass =
  "h-9 rounded-lg border border-border bg-surface-sunken px-2.5 text-sm text-on-surface focus:outline-none focus:border-accent-subtle";
const fieldClass = `w-full ${controlClass}`;

type FilterKey = keyof CommitmentReportFilters;
const FILTER_KEYS: readonly FilterKey[] = [
  "providers",
  "commitmentTypes",
  "accountIds",
  "services",
  "regions",
  "commitmentIds",
];

export interface CommitmentReportEditorProps {
  /** The report being edited; null creates one from `initialConfig`. */
  report: CommitmentReport | null;
  initialConfig: CommitmentReportConfig;
  options: CommitmentReportOptions | null;
  folders: CostReportFolder[];
  onSave: (input: CommitmentReportInput) => Promise<void>;
  onClose: () => void;
}

/**
 * Keep a saved value that is not among the current options (an account since
 * disconnected, a commitment that left the inventory) as an option of its
 * own, so opening and re-saving a report never silently drops part of its
 * filter.
 */
function withSaved(options: MultiSelectOption[], saved: readonly string[] | undefined) {
  const known = new Set(options.map((o) => o.value));
  return [
    ...options,
    ...(saved ?? []).filter((v) => !known.has(v)).map((v) => ({ value: v, label: v })),
  ];
}

/**
 * A filter list as the API accepts it: each value once, blanks dropped, and
 * absent rather than empty. The schema refuses the other spellings rather
 * than rewriting them, so the editor sends the one it stores.
 */
function canonicalList<T extends string>(values: readonly T[] | undefined): T[] | undefined {
  const seen = new Set<T>();
  for (const value of values ?? []) {
    if (value.trim() !== "") seen.add(value);
  }
  return seen.size > 0 ? [...seen] : undefined;
}

function canonicalFilters(filters: CommitmentReportFilters): CommitmentReportFilters {
  return {
    providers: canonicalList(filters.providers),
    commitmentTypes: canonicalList(filters.commitmentTypes),
    services: canonicalList(filters.services),
    accountIds: canonicalList(filters.accountIds),
    regions: canonicalList(filters.regions),
    commitmentIds: canonicalList(filters.commitmentIds),
  };
}

/**
 * Create or edit a commitment report. Every filter is a picker over what the
 * org actually has (providers, accounts, the services and regions with usage,
 * the commitment inventory), never a field for a raw id.
 */
export function CommitmentReportEditor({
  report,
  initialConfig,
  options,
  folders,
  onSave,
  onClose,
}: CommitmentReportEditorProps) {
  const gt = useGT();
  const gtData = useDataString();
  const labels = useCommitmentReportLabels();
  const uid = useId();
  const [name, setName] = useState(report?.name ?? "");
  const [description, setDescription] = useState(report?.description ?? "");
  const [folderId, setFolderId] = useState<string>(report?.folderId ?? "");
  const [config, setConfig] = useState<CommitmentReportConfig>(report?.config ?? initialConfig);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [describing, setDescribing] = useState(Boolean(report?.description));
  const [openFilters, setOpenFilters] = useState<FilterKey[]>(() =>
    FILTER_KEYS.filter((k) => (report?.config ?? initialConfig).filters[k]?.length),
  );
  const folderRows = useMemo(() => flattenCostReportFolderTree(folders), [folders]);

  const presetLabel = (p: CostRangePreset): string => {
    switch (p) {
      case "7d":
        return gt("Last 7 days");
      case "30d":
        return gt("Last 30 days");
      case "90d":
        return gt("Last 90 days");
      case "mtd":
        return gt("Month to date");
      case "last_month":
        return gt("Last month");
      case "qtd":
        return gt("Quarter to date");
      case "ytd":
        return gt("Year to date");
      case "6m":
        return gt("Last 6 months");
      case "12m":
        return gt("Last 12 months");
    }
  };

  const setFilter = <K extends keyof CommitmentReportFilters>(
    key: K,
    values: CommitmentReportFilters[K],
  ) => {
    const filters = { ...config.filters };
    if (values && values.length > 0) filters[key] = values;
    else delete filters[key];
    setConfig({ ...config, filters });
  };

  const rangeValue = config.dateRange.kind === "relative" ? config.dateRange.preset : "custom";
  const today = new Date().toISOString().slice(0, 10);

  async function save() {
    // Validated by the request schema the API decodes with, on the canonical
    // spelling of what the form holds (`decodeForm` drops the undefined keys).
    const parsed = decodeForm(CommitmentReportInputSchema, {
      name: name.trim(),
      description: description.trim() || null,
      config: { ...config, filters: canonicalFilters(config.filters) },
      folderId: folderId || null,
    });
    if (!parsed.success) {
      setError(parsed.message || gt("Invalid commitment report"));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(parsed.data);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }

  const loading = options ? undefined : ({ kind: "loading" } as const);
  const plain = (values: string[] | undefined): MultiSelectOption[] =>
    (values ?? []).map((v) => ({ value: v, label: v }));
  const accountName = new Map((options?.accounts ?? []).map((a) => [a.id, a.name]));

  // Every filter the report can carry, in the order they are offered. Only
  // the ones in use get a row; the rest wait behind their "add" pill, so a
  // new report opens as five decisions rather than eleven fields.
  const filterDefs: Array<{
    key: FilterKey;
    label: string;
    options: MultiSelectOption[];
    status?: typeof loading;
  }> = [
    {
      key: "providers",
      label: gt("Providers"),
      options: withSaved(
        (options?.providers ?? []).map((p) => ({
          value: p.pluginId,
          label:
            p.status === "measured"
              ? gtData(p.displayName)
              : gt("{provider} (holdings only, not measurable)", {
                  provider: gtData(p.displayName),
                }),
        })),
        config.filters.providers,
      ),
      status: loading,
    },
    {
      key: "commitmentTypes",
      label: gt("Commitment types"),
      options: COMMITMENT_REPORT_KINDS.map((k) => ({ value: k, label: labels.kind(k) })),
    },
    {
      key: "accountIds",
      label: gt("Accounts"),
      options: withSaved(
        (options?.accounts ?? []).map((a) => ({ value: a.id, label: a.name })),
        config.filters.accountIds,
      ),
      status: loading,
    },
    {
      key: "services",
      label: gt("Services"),
      options: withSaved(plain(options?.services), config.filters.services),
      status: loading,
    },
    {
      key: "regions",
      label: gt("Regions"),
      options: withSaved(plain(options?.regions), config.filters.regions),
      status: loading,
    },
    {
      key: "commitmentIds",
      label: gt("Commitments"),
      options: withSaved(
        (options?.commitments ?? []).map((c) => ({
          value: c.commitmentId,
          label: `${c.description} · ${accountName.get(c.accountId) ?? c.pluginId} · ${labels.kind(c.kind)}`,
        })),
        config.filters.commitmentIds,
      ),
      status: loading,
    },
  ];
  const shownFilters = filterDefs.filter((f) => openFilters.includes(f.key));
  const hiddenFilters = filterDefs.filter((f) => !openFilters.includes(f.key));
  const title = report ? gt("Edit commitment report") : gt("New commitment report");

  return (
    <Modal onClose={onClose} ariaLabel={title}>
      <div className="w-[40rem] max-w-[94vw] max-h-[88vh] flex flex-col rounded-2xl border border-border bg-surface-raised shadow-2xl overflow-hidden">
        <header className="flex items-start gap-3 px-6 pt-5 pb-4">
          <div className="flex-1 min-w-0">
            <h2 className={sectionClass}>{title}</h2>
            <input
              id={`${uid}-name`}
              aria-label={gt("Name")}
              className="mt-1.5 w-full bg-transparent text-xl font-semibold text-on-surface placeholder:text-on-surface-faint focus:outline-none"
              value={name}
              maxLength={COMMITMENT_REPORT_LIMITS.maxNameLength}
              placeholder={gt("Report name")}
              autoFocus
              onChange={(e) => setName(e.target.value)}
            />
            {describing ? (
              <textarea
                id={`${uid}-description`}
                aria-label={gt("Description")}
                className="mt-1 w-full resize-none bg-transparent text-sm text-on-surface-secondary placeholder:text-on-surface-faint focus:outline-none [field-sizing:content]"
                rows={1}
                value={description}
                maxLength={COMMITMENT_REPORT_LIMITS.maxDescriptionLength}
                placeholder={gt("Description")}
                autoFocus={!description}
                onChange={(e) => setDescription(e.target.value)}
              />
            ) : (
              <button
                type="button"
                onClick={() => setDescribing(true)}
                className="mt-1 text-sm text-on-surface-faint hover:text-on-surface-secondary transition-colors"
              >
                {gt("Add a description")}
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={gt("Close")}
            className="-mr-2 rounded-lg p-1.5 text-on-surface-tertiary hover:bg-surface-overlay hover:text-on-surface transition-colors"
          >
            <CloseIcon size={18} />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto border-t border-border px-6 py-5 space-y-6">
          <section className="space-y-3">
            <h3 className={sectionClass}>{gt("Period")}</h3>
            <div className="flex flex-wrap items-center gap-3">
              <select
                id={`${uid}-range`}
                aria-label={gt("Date range")}
                className={`${controlClass} min-w-[11rem]`}
                value={rangeValue}
                onChange={(e) => {
                  const v = e.target.value;
                  setConfig({
                    ...config,
                    dateRange:
                      v === "custom"
                        ? {
                            kind: "absolute",
                            from: new Date(Date.now() - 89 * 86_400_000).toISOString().slice(0, 10),
                            to: today,
                          }
                        : { kind: "relative", preset: v as CostRangePreset },
                  });
                }}
              >
                {COST_RANGE_PRESETS.map((p) => (
                  <option key={p} value={p}>
                    {presetLabel(p)}
                  </option>
                ))}
                <option value="custom">{gt("Custom dates")}</option>
              </select>
              <div
                role="radiogroup"
                aria-label={gt("Granularity")}
                className="inline-flex rounded-lg bg-surface-sunken p-0.5"
              >
                {COMMITMENT_REPORT_GRANULARITIES.map((g) => {
                  const on = config.granularity === g;
                  return (
                    <button
                      key={g}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      onClick={() => setConfig({ ...config, granularity: g })}
                      className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
                        on
                          ? "bg-surface-raised text-on-surface shadow-sm"
                          : "text-on-surface-tertiary hover:text-on-surface"
                      }`}
                    >
                      {labels.granularity(g)}
                    </button>
                  );
                })}
              </div>
            </div>
            {config.dateRange.kind === "absolute" && (
              <div className="flex items-center gap-2">
                <input
                  id={`${uid}-from`}
                  type="date"
                  aria-label={gt("From")}
                  className={controlClass}
                  value={config.dateRange.from}
                  max={today}
                  onChange={(e) =>
                    config.dateRange.kind === "absolute" &&
                    setConfig({
                      ...config,
                      dateRange: { ...config.dateRange, from: e.target.value },
                    })
                  }
                />
                <span className="text-sm text-on-surface-faint">{gt("to")}</span>
                <input
                  id={`${uid}-to`}
                  type="date"
                  aria-label={gt("To")}
                  className={controlClass}
                  value={config.dateRange.to}
                  onChange={(e) =>
                    config.dateRange.kind === "absolute" &&
                    setConfig({ ...config, dateRange: { ...config.dateRange, to: e.target.value } })
                  }
                />
              </div>
            )}
          </section>

          <section className="space-y-3">
            <h3 className={sectionClass}>{gt("Display")}</h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor={`${uid}-metric`} className={labelClass}>
                  {gt("Chart metric")}
                </label>
                <select
                  id={`${uid}-metric`}
                  className={fieldClass}
                  value={config.metric}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      metric: e.target.value as CommitmentReportConfig["metric"],
                    })
                  }
                >
                  {COMMITMENT_REPORT_METRICS.map((m) => (
                    <option key={m} value={m}>
                      {labels.metric(m)}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor={`${uid}-group`} className={labelClass}>
                  {gt("Group by")}
                </label>
                <select
                  id={`${uid}-group`}
                  className={fieldClass}
                  value={config.groupBy}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      groupBy: e.target.value as CommitmentReportConfig["groupBy"],
                    })
                  }
                >
                  {COMMITMENT_REPORT_GROUP_BYS.map((g) => (
                    <option key={g} value={g}>
                      {labels.groupBy(g)}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </section>

          <section className="space-y-3">
            <h3 className={sectionClass}>{gt("Filters")}</h3>
            {shownFilters.length > 0 && (
              <div className="space-y-2">
                {shownFilters.map((f) => (
                  <div key={f.key} className="flex items-start gap-3">
                    <span className="w-36 shrink-0 pt-2 text-sm text-on-surface-secondary">
                      {f.label}
                    </span>
                    <MultiSelect
                      className="flex-1"
                      label={f.label}
                      placeholder={gt("Choose…")}
                      value={config.filters[f.key] ?? []}
                      onChange={(v) => setFilter(f.key, v as never)}
                      options={f.options}
                      status={f.status}
                    />
                    <button
                      type="button"
                      onClick={() => {
                        setFilter(f.key, undefined);
                        setOpenFilters(openFilters.filter((k) => k !== f.key));
                      }}
                      aria-label={gt("Remove the {filter} filter", { filter: f.label })}
                      className="mt-1 rounded-lg p-1.5 text-on-surface-faint hover:bg-surface-overlay hover:text-on-surface transition-colors"
                    >
                      <CloseIcon size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {hiddenFilters.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {hiddenFilters.map((f) => (
                  <button
                    key={f.key}
                    type="button"
                    onClick={() => setOpenFilters([...openFilters, f.key])}
                    className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-border px-3 py-1 text-sm text-on-surface-tertiary hover:border-accent-subtle hover:text-on-surface transition-colors"
                  >
                    <PlusIcon size={12} />
                    {f.label}
                  </button>
                ))}
              </div>
            )}
          </section>

          {error && (
            <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
              {error}
            </p>
          )}
        </div>

        <footer className="flex items-center gap-3 border-t border-border bg-surface px-6 py-3.5">
          <label htmlFor={`${uid}-folder`} className="text-sm text-on-surface-tertiary">
            {gt("Folder")}
          </label>
          <select
            id={`${uid}-folder`}
            className={`${controlClass} max-w-[14rem]`}
            value={folderId}
            onChange={(e) => setFolderId(e.target.value)}
          >
            <option value="">{gt("Top level")}</option>
            {folderRows.map((row) => (
              <option key={row.folder.id} value={row.folder.id}>
                {row.path}
              </option>
            ))}
          </select>
          <div className="ml-auto flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3.5 py-2 rounded-lg text-sm text-on-surface-secondary hover:bg-surface-overlay transition-colors"
            >
              {gt("Cancel")}
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-accent hover:bg-accent-hover disabled:opacity-50 text-on-accent transition-colors"
            >
              {saving ? gt("Saving…") : report ? gt("Save changes") : gt("Create report")}
            </button>
          </div>
        </footer>
      </div>
    </Modal>
  );
}
