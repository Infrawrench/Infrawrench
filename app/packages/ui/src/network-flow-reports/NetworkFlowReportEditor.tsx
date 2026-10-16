import { useId, useMemo, useState } from "react";
import { useGT } from "gt-react";
import {
  COST_RANGE_PRESETS,
  NETWORK_FLOW_REPORT_DIRECTIONS,
  NETWORK_FLOW_REPORT_GRANULARITIES,
  NETWORK_FLOW_REPORT_GROUP_BYS,
  NETWORK_FLOW_REPORT_LIMITS,
  NETWORK_FLOW_REPORT_METRICS,
  NETWORK_FLOW_TRAFFIC_CLASSES,
  flattenCostReportFolderTree,
  normalizeNetworkFlowReportInput,
  type CostRangePreset,
  type CostReportFolder,
  type NetworkFlowReport,
  type NetworkFlowReportConfig,
  type NetworkFlowReportDirection,
  type NetworkFlowReportFilters,
  type NetworkFlowReportInput,
  type NetworkFlowReportOptions,
  type NetworkFlowScope,
} from "@infrawrench/client-core";

import { Modal } from "../components/Modal.js";
import { MultiSelect, type MultiSelectOption } from "../components/MultiSelect.js";
import { useNetworkFlowReportLabels } from "./labels.js";

const labelClass = "block text-xs font-medium text-on-surface-secondary mb-1";
const fieldClass =
  "w-full rounded-lg border border-border bg-surface-sunken px-2.5 py-1.5 text-sm text-on-surface focus:outline-none focus:border-blue-500";

export interface NetworkFlowReportEditorProps {
  /** The report being edited; null creates one from `initialConfig`. */
  report: NetworkFlowReport | null;
  initialConfig: NetworkFlowReportConfig;
  options: NetworkFlowReportOptions | null;
  folders: CostReportFolder[];
  onSave: (input: NetworkFlowReportInput) => Promise<void>;
  onClose: () => void;
}

/**
 * Keep a saved value that is not among the current options (a VPC that has
 * gone quiet, an endpoint past retention) as an option of its own, so opening
 * and re-saving a report never silently drops part of its filter.
 */
function withSaved(options: MultiSelectOption[], saved: readonly string[] | undefined) {
  const known = new Set(options.map((o) => o.value));
  return [
    ...options,
    ...(saved ?? []).filter((v) => !known.has(v)).map((v) => ({ value: v, label: v })),
  ];
}

/**
 * Create or edit a network flow report. Every filter is a picker over values
 * the flow store has actually seen (accounts, VPCs, regions, zones, endpoints,
 * peer services and resource types), never a field for a raw id.
 */
export function NetworkFlowReportEditor({
  report,
  initialConfig,
  options,
  folders,
  onSave,
  onClose,
}: NetworkFlowReportEditorProps) {
  const gt = useGT();
  const labels = useNetworkFlowReportLabels();
  const uid = useId();
  const [name, setName] = useState(report?.name ?? "");
  const [description, setDescription] = useState(report?.description ?? "");
  const [folderId, setFolderId] = useState<string>(report?.folderId ?? "");
  const [config, setConfig] = useState<NetworkFlowReportConfig>(report?.config ?? initialConfig);
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

  const setFilter = <K extends keyof NetworkFlowReportFilters>(
    key: K,
    values: NetworkFlowReportFilters[K],
  ) => {
    const filters = { ...config.filters };
    if (values && values.length > 0) filters[key] = values;
    else delete filters[key];
    setConfig({ ...config, filters });
  };

  const rangeValue = config.dateRange.kind === "relative" ? config.dateRange.preset : "custom";
  const today = new Date().toISOString().slice(0, 10);
  const loading = options ? undefined : ({ kind: "loading" } as const);

  const endpointOptions = (side: "source" | "destination"): MultiSelectOption[] =>
    (options?.endpoints ?? [])
      .filter((e) => e.side === side || e.side === "both")
      .map((e) => ({
        value: e.ref,
        label:
          labels.endpoint(e.ref, e.label) === e.ref
            ? e.ref
            : `${labels.endpoint(e.ref, e.label)} (${e.ref})`,
      }));
  const plain = (values: string[] | undefined): MultiSelectOption[] =>
    (values ?? []).map((v) => ({ value: v, label: v }));

  async function save() {
    const parsed = normalizeNetworkFlowReportInput({
      name,
      description,
      config,
      folderId: folderId || null,
    });
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(parsed.value);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }

  return (
    <Modal
      onClose={onClose}
      ariaLabel={report ? gt("Edit network flow report") : gt("New network flow report")}
    >
      <div className="w-[38rem] max-w-[92vw] rounded-2xl border border-border bg-surface-raised p-5 max-h-[88vh] overflow-y-auto">
        <h2 className="text-lg font-semibold text-on-surface mb-4">
          {report ? gt("Edit network flow report") : gt("New network flow report")}
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
              maxLength={NETWORK_FLOW_REPORT_LIMITS.maxNameLength}
              placeholder={gt("e.g. Cross-zone traffic by flow pair")}
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
              maxLength={NETWORK_FLOW_REPORT_LIMITS.maxDescriptionLength}
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
                            from: new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10),
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
              <p className="text-[11px] text-on-surface-faint mt-1">
                {gt("Flows are kept for 90 days.")}
              </p>
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
                    granularity: e.target.value as NetworkFlowReportConfig["granularity"],
                  })
                }
              >
                {NETWORK_FLOW_REPORT_GRANULARITIES.map((g) => (
                  <option key={g} value={g}>
                    {labels.granularity(g)}
                  </option>
                ))}
              </select>
              <p className="text-[11px] text-on-surface-faint mt-1">
                {gt("No hourly option: flows are stored one row per day.")}
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

          <div className="grid grid-cols-3 gap-3">
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
                    groupBy: e.target.value as NetworkFlowReportConfig["groupBy"],
                  })
                }
              >
                {NETWORK_FLOW_REPORT_GROUP_BYS.map((g) => (
                  <option key={g} value={g}>
                    {labels.groupBy(g)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor={`${uid}-metric`} className={labelClass}>
                {gt("Show")}
              </label>
              <select
                id={`${uid}-metric`}
                className={fieldClass}
                value={config.metric}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    metric: e.target.value as NetworkFlowReportConfig["metric"],
                  })
                }
              >
                {NETWORK_FLOW_REPORT_METRICS.map((m) => (
                  <option key={m} value={m}>
                    {labels.metric(m)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor={`${uid}-topn`} className={labelClass}>
                {gt("Rows listed")}
              </label>
              <input
                id={`${uid}-topn`}
                type="number"
                min={1}
                max={NETWORK_FLOW_REPORT_LIMITS.maxTopN}
                className={fieldClass}
                value={config.topN ?? NETWORK_FLOW_REPORT_LIMITS.defaultTopN}
                onChange={(e) => {
                  const n = Math.round(Number(e.target.value));
                  const { topN: _drop, ...rest } = config;
                  void _drop;
                  setConfig(
                    Number.isFinite(n) && n !== NETWORK_FLOW_REPORT_LIMITS.defaultTopN
                      ? { ...rest, topN: n }
                      : rest,
                  );
                }}
              />
            </div>
          </div>

          <fieldset className="space-y-3 border-t border-border pt-3">
            <legend className="text-xs font-semibold text-on-surface-secondary">
              {gt("Filters")}
            </legend>
            <MultiSelect
              label={gt("Accounts")}
              placeholder={gt("All accounts")}
              value={config.filters.accountIds ?? []}
              onChange={(v) => setFilter("accountIds", v)}
              options={withSaved(
                (options?.accounts ?? []).map((a) => ({
                  value: a.id,
                  label: a.recut ? gt("{name} (Kubernetes cluster)", { name: a.name }) : a.name,
                })),
                config.filters.accountIds,
              )}
              status={loading}
            />
            <MultiSelect
              label={gt("Traffic classes")}
              placeholder={gt("All traffic classes")}
              value={config.filters.trafficClasses ?? []}
              onChange={(v) => setFilter("trafficClasses", v as NetworkFlowScope[])}
              options={(options?.trafficClasses ?? NETWORK_FLOW_TRAFFIC_CLASSES).map((s) => ({
                value: s,
                label: labels.trafficClass(s),
              }))}
            />
            <MultiSelect
              label={gt("Direction")}
              placeholder={gt("Both directions")}
              value={config.filters.directions ?? []}
              onChange={(v) => setFilter("directions", v as NetworkFlowReportDirection[])}
              options={NETWORK_FLOW_REPORT_DIRECTIONS.map((d) => ({
                value: d,
                label: labels.direction(d),
              }))}
            />
            <MultiSelect
              label={gt("VPCs / networks")}
              placeholder={gt("All VPCs and networks")}
              value={config.filters.networks ?? []}
              onChange={(v) => setFilter("networks", v)}
              options={withSaved(plain(options?.networks), config.filters.networks)}
              status={loading}
            />
            <div className="grid grid-cols-2 gap-3">
              <MultiSelect
                label={gt("Regions")}
                placeholder={gt("All regions")}
                value={config.filters.regions ?? []}
                onChange={(v) => setFilter("regions", v)}
                options={withSaved(plain(options?.regions), config.filters.regions)}
                status={loading}
              />
              <MultiSelect
                label={gt("Availability zones")}
                placeholder={gt("All zones")}
                value={config.filters.zones ?? []}
                onChange={(v) => setFilter("zones", v)}
                options={withSaved(plain(options?.zones), config.filters.zones)}
                status={loading}
              />
            </div>
            <MultiSelect
              label={gt("Sources")}
              placeholder={gt("Any source")}
              value={config.filters.sourceRefs ?? []}
              onChange={(v) => setFilter("sourceRefs", v)}
              options={withSaved(endpointOptions("source"), config.filters.sourceRefs)}
              status={loading}
            />
            <MultiSelect
              label={gt("Destinations")}
              placeholder={gt("Any destination")}
              value={config.filters.destinationRefs ?? []}
              onChange={(v) => setFilter("destinationRefs", v)}
              options={withSaved(endpointOptions("destination"), config.filters.destinationRefs)}
              status={loading}
            />
            <div className="grid grid-cols-2 gap-3">
              <MultiSelect
                label={gt("Peer services")}
                placeholder={gt("All services")}
                value={config.filters.services ?? []}
                onChange={(v) => setFilter("services", v)}
                options={withSaved(plain(options?.services), config.filters.services)}
                status={loading}
              />
              <MultiSelect
                label={gt("Peer resource types")}
                placeholder={gt("All resource types")}
                value={config.filters.resourceTypes ?? []}
                onChange={(v) => setFilter("resourceTypes", v)}
                options={withSaved(plain(options?.resourceTypes), config.filters.resourceTypes)}
                status={loading}
              />
            </div>
            <p className="text-[11px] text-on-surface-faint">
              {gt(
                "VPC, region and zone filters match either end of a flow. The peer is the destination of egress and the source of ingress. Without an account filter, Kubernetes cluster traffic is left out because a cloud flow log already counts it.",
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
            className="px-3 py-1.5 rounded-lg text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white transition-colors"
          >
            {saving ? gt("Saving…") : gt("Save")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
