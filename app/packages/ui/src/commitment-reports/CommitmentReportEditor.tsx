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
  type CommitmentKind,
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
import { MultiSelect, type MultiSelectOption } from "../components/MultiSelect.js";
import { useDataString } from "../i18n/data-strings.js";
import { useCommitmentReportLabels } from "./labels.js";

const labelClass = "block text-xs font-medium text-on-surface-secondary mb-1";
const fieldClass =
  "w-full rounded-lg border border-border bg-surface-sunken px-2.5 py-1.5 text-sm text-on-surface focus:outline-none focus:border-accent-subtle";

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

  return (
    <Modal
      onClose={onClose}
      ariaLabel={report ? gt("Edit commitment report") : gt("New commitment report")}
    >
      <div className="w-[36rem] max-w-[92vw] rounded-2xl border border-border bg-surface-raised p-5 max-h-[88vh] overflow-y-auto">
        <h2 className="text-lg font-semibold text-on-surface mb-4">
          {report ? gt("Edit commitment report") : gt("New commitment report")}
        </h2>

        <div className="space-y-4">
          <div>
            <label htmlFor={`${uid}-name`} className={labelClass}>
              {gt("Name")}
            </label>
            <input
              id={`${uid}-name`}
              className={fieldClass}
              value={name}
              maxLength={COMMITMENT_REPORT_LIMITS.maxNameLength}
              placeholder={gt("e.g. Savings plan coverage by account")}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div>
            <label htmlFor={`${uid}-description`} className={labelClass}>
              {gt("Description")}
            </label>
            <textarea
              id={`${uid}-description`}
              className={fieldClass}
              rows={2}
              value={description}
              maxLength={COMMITMENT_REPORT_LIMITS.maxDescriptionLength}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          <div>
            <label htmlFor={`${uid}-folder`} className={labelClass}>
              {gt("Folder")}
            </label>
            <select
              id={`${uid}-folder`}
              className={fieldClass}
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
            <p className="text-[11px] text-on-surface-faint mt-1">
              {gt("The same folders as cost reports. Create and rename folders under Reports.")}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor={`${uid}-range`} className={labelClass}>
                {gt("Date range")}
              </label>
              <select
                id={`${uid}-range`}
                className={fieldClass}
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
            </div>
            <div>
              <label htmlFor={`${uid}-granularity`} className={labelClass}>
                {gt("Granularity")}
              </label>
              <select
                id={`${uid}-granularity`}
                className={fieldClass}
                value={config.granularity}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    granularity: e.target.value as CommitmentReportConfig["granularity"],
                  })
                }
              >
                {COMMITMENT_REPORT_GRANULARITIES.map((g) => (
                  <option key={g} value={g}>
                    {labels.granularity(g)}
                  </option>
                ))}
              </select>
              <p className="text-[11px] text-on-surface-faint mt-1">
                {gt("No hourly option: spend is collected one row per day.")}
              </p>
            </div>
          </div>

          {config.dateRange.kind === "absolute" && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor={`${uid}-from`} className={labelClass}>
                  {gt("From")}
                </label>
                <input
                  id={`${uid}-from`}
                  type="date"
                  className={fieldClass}
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
              </div>
              <div>
                <label htmlFor={`${uid}-to`} className={labelClass}>
                  {gt("To")}
                </label>
                <input
                  id={`${uid}-to`}
                  type="date"
                  className={fieldClass}
                  value={config.dateRange.to}
                  onChange={(e) =>
                    config.dateRange.kind === "absolute" &&
                    setConfig({ ...config, dateRange: { ...config.dateRange, to: e.target.value } })
                  }
                />
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
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
          </div>

          <fieldset className="space-y-3 border-t border-border pt-3">
            <legend className="text-xs font-semibold text-on-surface-secondary">
              {gt("Filters")}
            </legend>
            <MultiSelect
              label={gt("Providers")}
              placeholder={gt("All providers")}
              value={config.filters.providers ?? []}
              onChange={(v) => setFilter("providers", v)}
              options={withSaved(
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
              )}
              status={loading}
            />
            <MultiSelect
              label={gt("Commitment types")}
              placeholder={gt("All commitment types")}
              value={config.filters.commitmentTypes ?? []}
              onChange={(v) => setFilter("commitmentTypes", v as CommitmentKind[])}
              options={COMMITMENT_REPORT_KINDS.map((k) => ({ value: k, label: labels.kind(k) }))}
            />
            <MultiSelect
              label={gt("Accounts")}
              placeholder={gt("All accounts")}
              value={config.filters.accountIds ?? []}
              onChange={(v) => setFilter("accountIds", v)}
              options={withSaved(
                (options?.accounts ?? []).map((a) => ({ value: a.id, label: a.name })),
                config.filters.accountIds,
              )}
              status={loading}
            />
            <MultiSelect
              label={gt("Services")}
              placeholder={gt("All services")}
              value={config.filters.services ?? []}
              onChange={(v) => setFilter("services", v)}
              options={withSaved(plain(options?.services), config.filters.services)}
              status={loading}
            />
            <MultiSelect
              label={gt("Regions")}
              placeholder={gt("All regions")}
              value={config.filters.regions ?? []}
              onChange={(v) => setFilter("regions", v)}
              options={withSaved(plain(options?.regions), config.filters.regions)}
              status={loading}
            />
            <MultiSelect
              label={gt("Commitments")}
              placeholder={gt("All commitments")}
              value={config.filters.commitmentIds ?? []}
              onChange={(v) => setFilter("commitmentIds", v)}
              options={withSaved(
                (options?.commitments ?? []).map((c) => ({
                  value: c.commitmentId,
                  label: `${c.description} · ${accountName.get(c.accountId) ?? c.pluginId} · ${labels.kind(c.kind)}`,
                })),
                config.filters.commitmentIds,
              )}
              status={loading}
            />
            <p className="text-[11px] text-on-surface-faint">
              {gt(
                "A commitment type or commitment filter narrows the commitment side only; uncovered usage stays in as the rest of the coverage denominator. AWS covered usage is not tied to a specific commitment, so it matches no commitment filter.",
              )}
            </p>
          </fieldset>

          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
        </div>

        <div className="flex justify-end gap-2 mt-5">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-lg text-sm text-on-surface-secondary hover:bg-surface-sunken transition-colors"
          >
            {gt("Cancel")}
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving}
            className="px-3 py-1.5 rounded-lg text-sm bg-accent hover:bg-accent-hover disabled:opacity-50 text-on-accent transition-colors"
          >
            {saving ? gt("Saving…") : gt("Save")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
