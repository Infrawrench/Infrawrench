import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useGT } from "gt-react";
import {
  DEFAULT_SAVINGS_FINDING_SORT,
  SAVINGS_FINDING_KINDS,
  SAVINGS_FINDING_STATUSES,
  applySavingsFindingView,
  formatMoney,
  isEmptySavingsFindingFilter,
  matchesSavingsFindingFilter,
  summarizeSavingsFindings,
  type SavingsFinding,
  type SavingsFindingFilter,
  type SavingsFindingKind,
  type SavingsFindingMoney,
  type SavingsFindingSort,
  type SavingsFindingStatus,
  type SavingsFindingStatusFilter,
  type SavingsFindingStatusInput,
  type SavingsFindingStatusResult,
  type SavingsFindingsResponse,
  type SavingsView,
  type SavingsViewInput,
} from "@infrawrench/client-core";
import { ShareDialog, type SharingClient } from "../sharing/ShareDialog.js";
import { useDataString } from "../i18n/data-strings.js";
import {
  SavingsStatusModal,
  SavingsViewModal,
  useSavingsStatusLabel,
} from "./SavingsFindingModals.js";

/**
 * Host-injected data access for the findings workflow. Web wraps `apiFetch`;
 * desktop (cloud mode) its IPC channels. Mutations are optional: a host that
 * leaves one out (mobile has no host here; a read-only role could) gets the
 * list without that control.
 */
export interface SavingsFindingsClient {
  listFindings(opts?: { refresh?: boolean }): Promise<SavingsFindingsResponse>;
  setStatus?(input: SavingsFindingStatusInput): Promise<SavingsFindingStatusResult>;
  listViews(): Promise<SavingsView[]>;
  createView?(input: SavingsViewInput): Promise<SavingsView>;
  updateView?(id: string, input: SavingsViewInput): Promise<SavingsView>;
  deleteView?(id: string): Promise<void>;
  /** Per-object sharing for views; the Share button is left out without it. */
  sharing?: SharingClient | undefined;
}

export interface SavingsFindingsSectionProps {
  client: SavingsFindingsClient;
  /** Open a finding's resource (findings with a `resourceId`). */
  onOpenResource?: ((finding: SavingsFinding) => void) | undefined;
}

const SELECT =
  "rounded-lg border border-border bg-surface-sunken px-2 py-1.5 text-sm text-on-surface focus:outline-none focus:border-blue-500";
const BUTTON =
  "rounded-lg border border-border bg-surface-raised px-3 py-1.5 text-sm text-on-surface hover:border-border-strong disabled:opacity-50";

const SORTS: { id: string; sort: SavingsFindingSort }[] = [
  { id: "savings:desc", sort: { field: "savings", direction: "desc" } },
  { id: "savings:asc", sort: { field: "savings", direction: "asc" } },
  { id: "detected:desc", sort: { field: "detected", direction: "desc" } },
  { id: "detected:asc", sort: { field: "detected", direction: "asc" } },
  { id: "status_changed:desc", sort: { field: "status_changed", direction: "desc" } },
  { id: "status_changed:asc", sort: { field: "status_changed", direction: "asc" } },
  { id: "name:asc", sort: { field: "name", direction: "asc" } },
  { id: "name:desc", sort: { field: "name", direction: "desc" } },
];

function sortId(sort: SavingsFindingSort): string {
  return `${sort.field}:${sort.direction}`;
}

function useKindLabel(): (kind: SavingsFindingKind) => string {
  const gt = useGT();
  return (kind) => {
    switch (kind) {
      case "orphan":
        return gt("Orphaned or idle");
      case "oversized":
        return gt("Oversized");
      case "extended_support":
        return gt("Extended support");
      case "seat":
        return gt("Unused seat");
    }
  };
}

const STATUS_BADGE: Record<SavingsFindingStatus, string> = {
  ready: "border-blue-500/40 text-info",
  in_progress: "border-amber-500/40 text-warning",
  completed: "border-emerald-500/40 text-success",
  archived: "border-border text-on-surface-faint",
};

function money(list: readonly SavingsFindingMoney[] | null | undefined): string | null {
  const first = list?.[0];
  return first ? formatMoney(first.amount, first.currency) : null;
}

function day(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** The one value a single-select shows for a list filter: "" for any, "*" for several. */
function single(values: readonly string[] | undefined): string {
  if (!values?.length) return "";
  return values.length === 1 ? values[0]! : "*";
}

function setList(
  filter: SavingsFindingFilter,
  field: "pluginIds" | "accountIds" | "regions",
  value: string,
) {
  const next = { ...filter };
  if (value === "") delete next[field];
  else next[field] = [value];
  return next;
}

/**
 * The savings findings workflow at the top of Costs → Savings: every finder's
 * findings in one list with a status (Ready for review, In progress,
 * Completed, Archived), the date each was detected, summary tiles, filters,
 * bulk status changes and saved views. The per-finder sections below it keep
 * the actions (apply a resize, remove a seat, remediation commands); this is
 * where the backlog is worked.
 */
export function SavingsFindingsSection({ client, onOpenResource }: SavingsFindingsSectionProps) {
  const gt = useGT();
  const gtData = useDataString();
  const uid = useId();
  const kindLabel = useKindLabel();
  const statusLabel = useSavingsStatusLabel();

  const [data, setData] = useState<SavingsFindingsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [views, setViews] = useState<SavingsView[]>([]);
  const [viewId, setViewId] = useState<string>("");
  const [status, setStatus] = useState<SavingsFindingStatusFilter>("open");
  const [filter, setFilter] = useState<SavingsFindingFilter>({});
  const [sort, setSort] = useState<SavingsFindingSort>(DEFAULT_SAVINGS_FINDING_SORT);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [bulkStatus, setBulkStatus] = useState<SavingsFindingStatus>("in_progress");
  const [changing, setChanging] = useState<{ keys: string[]; status: SavingsFindingStatus } | null>(
    null,
  );
  const [savingView, setSavingView] = useState<"create" | "update" | null>(null);
  const [sharingView, setSharingView] = useState<SavingsView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const seq = useRef(0);

  const refresh = useCallback(
    async (opts: { refresh?: boolean } = {}) => {
      const mine = ++seq.current;
      setError(null);
      try {
        const [next, nextViews] = await Promise.all([
          client.listFindings(opts),
          client.listViews().catch(() => [] as SavingsView[]),
        ]);
        if (mine !== seq.current) return;
        setData(next);
        setViews(nextViews);
      } catch (e) {
        if (mine === seq.current) setError(e instanceof Error ? e.message : String(e));
      }
    },
    [client],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const findings = useMemo(() => data?.findings ?? [], [data]);
  /** Filtered, every status: what the tabs count and the tiles sum. */
  const filtered = useMemo(
    () => findings.filter((f) => matchesSavingsFindingFilter(f, filter)),
    [findings, filter],
  );
  const rows = useMemo(
    () => applySavingsFindingView(findings, { status, filter, sort }),
    [findings, status, filter, sort],
  );
  const filteredSummary = useMemo(
    () => summarizeSavingsFindings(filtered, null, data?.summary.realizedWindowDays ?? 30),
    [filtered, data],
  );
  const filtering = !isEmptySavingsFindingFilter(filter);

  // Picker options come from the findings themselves: a filter can only ever
  // name something that is on the list.
  const options = useMemo(() => {
    const providers = new Map<string, string>();
    const accounts = new Map<string, string>();
    const regions = new Set<string>();
    const tags = new Map<string, Set<string>>();
    for (const f of findings) {
      if (f.pluginId) providers.set(f.pluginId, f.pluginName ?? f.pluginId);
      if (f.accountId) accounts.set(f.accountId, f.accountName ?? f.accountId);
      if (f.region) regions.add(f.region);
      for (const [k, v] of Object.entries(f.tags)) {
        const set = tags.get(k) ?? new Set<string>();
        set.add(v);
        tags.set(k, set);
      }
    }
    const byLabel = (a: [string, string], b: [string, string]) => a[1].localeCompare(b[1]);
    return {
      providers: [...providers.entries()].sort(byLabel),
      accounts: [...accounts.entries()].sort(byLabel),
      regions: [...regions].sort(),
      tagKeys: [...tags.keys()].sort(),
      tagValues: (key: string) => [...(tags.get(key) ?? [])].sort(),
    };
  }, [findings]);

  const activeView = views.find((v) => v.id === viewId) ?? null;

  function openView(id: string) {
    setViewId(id);
    setSelected(new Set());
    const view = views.find((v) => v.id === id);
    if (!view) {
      setStatus("open");
      setFilter({});
      setSort(DEFAULT_SAVINGS_FINDING_SORT);
      return;
    }
    setStatus(view.status);
    setFilter(view.filter);
    setSort(view.sort);
  }

  const currentInput = (name: string, description: string | null): SavingsViewInput => ({
    name,
    description,
    status,
    filter,
    sort,
  });

  async function saveView(name: string, description: string | null) {
    if (savingView === "update" && activeView && client.updateView) {
      const updated = await client.updateView(activeView.id, currentInput(name, description));
      setViews((prev) => prev.map((v) => (v.id === updated.id ? updated : v)));
      return;
    }
    if (!client.createView) return;
    const created = await client.createView(currentInput(name, description));
    setViews((prev) => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)));
    setViewId(created.id);
  }

  async function deleteView() {
    if (!activeView || !client.deleteView) return;
    if (!window.confirm(gt('Delete the saved view "{name}"?', { name: activeView.name }))) return;
    try {
      await client.deleteView(activeView.id);
      setViews((prev) => prev.filter((v) => v.id !== activeView.id));
      openView("");
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    }
  }

  async function applyStatus(keys: string[], next: SavingsFindingStatus, note: string | null) {
    if (!client.setStatus) return;
    const result = await client.setStatus({ keys, status: next, note });
    const changes = new Map(result.updated.map((u) => [u.key, u]));
    setData((prev) =>
      prev
        ? {
            ...prev,
            findings: prev.findings.map((f) => {
              const c = changes.get(f.key);
              return c
                ? {
                    ...f,
                    status: c.status,
                    statusChangedAt: c.statusChangedAt,
                    statusChangedBy: c.statusChangedBy,
                    statusNote: c.statusNote,
                    resolution: c.resolution,
                  }
                : f;
            }),
          }
        : prev,
    );
    setSelected(new Set());
    setNotice(
      result.missing.length > 0
        ? gt("{count} finding(s) could not be changed; they may have been removed.", {
            count: result.missing.length,
          })
        : null,
    );
  }

  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.key));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.key)));
  const toggle = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const tabs: { id: SavingsFindingStatusFilter; label: string; count: number }[] = [
    {
      id: "open",
      label: gt("Open"),
      count: filteredSummary.counts.ready + filteredSummary.counts.in_progress,
    },
    ...SAVINGS_FINDING_STATUSES.map((s) => ({
      id: s as SavingsFindingStatusFilter,
      label: statusLabel(s),
      count: filteredSummary.counts[s],
    })),
    { id: "all", label: gt("All"), count: filtered.length },
  ];

  const tagKey = filter.tags?.[0]?.key ?? "";
  const tagValue = filter.tags?.[0]?.values?.[0] ?? "";
  const summary = data?.summary;
  const potential = money(filtering ? filteredSummary.potentialMonthly : summary?.potentialMonthly);
  const realized = money(summary?.realized);
  const rate = summary?.savingsRate?.[0];
  const openCount = (filtering ? filteredSummary : summary)?.counts;

  return (
    <section className="flex flex-col gap-3" aria-labelledby={`${uid}-title`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id={`${uid}-title`} className="text-sm font-semibold text-on-surface">
            {gt("Findings")}
          </h2>
          <p className="mt-1 text-xs text-on-surface-secondary">
            {gt(
              "Every savings finding in one list. Move each from Ready for review to In progress and Completed, or archive it. Findings that disappear are completed automatically.",
            )}
          </p>
        </div>
        <button type="button" onClick={() => void refresh({ refresh: true })} className={BUTTON}>
          {gt("Refresh")}
        </button>
      </div>

      {error !== null && (
        <div role="alert" className="text-sm text-danger">
          {gt("Couldn't load savings findings: {error}", { error })}{" "}
          <button type="button" onClick={() => void refresh()} className="underline">
            {gt("Retry")}
          </button>
        </div>
      )}
      {data === null && error === null && (
        <p role="status" className="text-sm text-on-surface-faint">
          {gt("Loading savings findings…")}
        </p>
      )}

      {data !== null && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Tile
              label={filtering ? gt("Potential (filtered)") : gt("Potential savings")}
              value={potential ?? gt("None")}
              caption={
                (filtering ? filteredSummary : summary)?.unpricedOpenCount
                  ? gt("per month, plus {count} unpriced", {
                      count: (filtering ? filteredSummary : summary)!.unpricedOpenCount,
                    })
                  : gt("per month, open findings")
              }
            />
            <Tile
              label={gt("Realized savings")}
              value={summary?.realized === null ? gt("No access") : (realized ?? gt("None"))}
              caption={gt("last {days} days", { days: summary?.realizedWindowDays ?? 30 })}
            />
            <Tile
              label={gt("Savings rate")}
              value={rate ? `${Math.round(rate.rate * 100)}%` : "-"}
              caption={gt("realized ÷ (realized + potential)")}
            />
            <Tile
              label={gt("Open findings")}
              value={String((openCount?.ready ?? 0) + (openCount?.in_progress ?? 0))}
              caption={gt("{ready} ready, {progress} in progress", {
                ready: openCount?.ready ?? 0,
                progress: openCount?.in_progress ?? 0,
              })}
            />
          </div>

          {data.unavailable.length > 0 && (
            <p role="status" className="text-xs text-warning">
              {gt(
                "Some finders could not run just now ({kinds}); their findings are shown as last recorded.",
                { kinds: data.unavailable.map((u) => kindLabel(u.kind)).join(", ") },
              )}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <label
              htmlFor={`${uid}-view`}
              className="text-xs font-medium text-on-surface-secondary"
            >
              {gt("View")}
            </label>
            <select
              id={`${uid}-view`}
              value={viewId}
              onChange={(e) => openView(e.target.value)}
              className={SELECT}
            >
              <option value="">{gt("All findings")}</option>
              {views.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
            {client.createView && (
              <button type="button" onClick={() => setSavingView("create")} className={BUTTON}>
                {activeView ? gt("Save as new view") : gt("Save view")}
              </button>
            )}
            {activeView && client.updateView && (
              <button type="button" onClick={() => setSavingView("update")} className={BUTTON}>
                {gt("Update view")}
              </button>
            )}
            {activeView && client.sharing && (
              <button type="button" onClick={() => setSharingView(activeView)} className={BUTTON}>
                {gt("Share")}
              </button>
            )}
            {activeView && client.deleteView && (
              <button
                type="button"
                onClick={() => void deleteView()}
                className="text-sm text-on-surface-tertiary underline hover:text-danger"
              >
                {gt("Delete view")}
              </button>
            )}
          </div>
          {activeView?.description && (
            <p className="text-xs text-on-surface-faint">{activeView.description}</p>
          )}

          <div className="flex flex-wrap items-end gap-2">
            <FilterSelect
              label={gt("Kind")}
              value={single(filter.kinds)}
              onChange={(v) => {
                const next = { ...filter };
                if (v === "") delete next.kinds;
                else next.kinds = [v as SavingsFindingKind];
                setFilter(next);
              }}
              options={SAVINGS_FINDING_KINDS.map((k) => [k, kindLabel(k)])}
              anyLabel={gt("Any kind")}
              severalLabel={gt("Several")}
            />
            <FilterSelect
              label={gt("Provider")}
              value={single(filter.pluginIds)}
              onChange={(v) => setFilter(setList(filter, "pluginIds", v))}
              options={options.providers.map(([id, label]) => [id, gtData(label)])}
              anyLabel={gt("Any provider")}
              severalLabel={gt("Several")}
            />
            <FilterSelect
              label={gt("Account")}
              value={single(filter.accountIds)}
              onChange={(v) => setFilter(setList(filter, "accountIds", v))}
              options={options.accounts}
              anyLabel={gt("Any account")}
              severalLabel={gt("Several")}
            />
            <FilterSelect
              label={gt("Region")}
              value={single(filter.regions)}
              onChange={(v) => setFilter(setList(filter, "regions", v))}
              options={options.regions.map((r) => [r, r])}
              anyLabel={gt("Any region")}
              severalLabel={gt("Several")}
            />
            <FilterSelect
              label={gt("Tag")}
              value={(filter.tags?.length ?? 0) > 1 ? "*" : tagKey}
              onChange={(v) => {
                const next = { ...filter };
                if (v === "") delete next.tags;
                else next.tags = [{ key: v }];
                setFilter(next);
              }}
              options={options.tagKeys.map((k) => [k, k])}
              anyLabel={gt("Any tag")}
              severalLabel={gt("Several")}
            />
            {tagKey !== "" && (filter.tags?.length ?? 0) === 1 && (
              <FilterSelect
                label={gt("Tag value")}
                value={(filter.tags?.[0]?.values?.length ?? 0) > 1 ? "*" : tagValue}
                onChange={(v) =>
                  setFilter({
                    ...filter,
                    tags: [v === "" ? { key: tagKey } : { key: tagKey, values: [v] }],
                  })
                }
                options={options.tagValues(tagKey).map((v) => [v, v])}
                anyLabel={gt("Any value")}
                severalLabel={gt("Several")}
              />
            )}
            <label className="flex flex-col gap-1">
              <span className="text-xs text-on-surface-secondary">
                {gt("Min. monthly savings")}
              </span>
              <input
                type="number"
                min={0}
                step="any"
                value={filter.minMonthlySavings ?? ""}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  const next = { ...filter };
                  if (e.target.value === "" || !Number.isFinite(n) || n <= 0)
                    delete next.minMonthlySavings;
                  else next.minMonthlySavings = n;
                  setFilter(next);
                }}
                className={`${SELECT} w-28`}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-on-surface-secondary">{gt("Detected from")}</span>
              <input
                type="date"
                value={filter.detectedFrom ?? ""}
                onChange={(e) => {
                  const next = { ...filter };
                  if (e.target.value === "") delete next.detectedFrom;
                  else next.detectedFrom = e.target.value;
                  setFilter(next);
                }}
                className={SELECT}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-on-surface-secondary">{gt("Detected to")}</span>
              <input
                type="date"
                value={filter.detectedTo ?? ""}
                onChange={(e) => {
                  const next = { ...filter };
                  if (e.target.value === "") delete next.detectedTo;
                  else next.detectedTo = e.target.value;
                  setFilter(next);
                }}
                className={SELECT}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-on-surface-secondary">{gt("Search")}</span>
              <input
                type="search"
                value={filter.search ?? ""}
                onChange={(e) => {
                  const next = { ...filter };
                  if (e.target.value === "") delete next.search;
                  else next.search = e.target.value;
                  setFilter(next);
                }}
                placeholder={gt("Name, account or reason")}
                className={SELECT}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-on-surface-secondary">{gt("Sort")}</span>
              <select
                value={sortId(sort)}
                onChange={(e) =>
                  setSort(
                    SORTS.find((s) => s.id === e.target.value)?.sort ??
                      DEFAULT_SAVINGS_FINDING_SORT,
                  )
                }
                className={SELECT}
              >
                <option value="savings:desc">{gt("Savings, highest first")}</option>
                <option value="savings:asc">{gt("Savings, lowest first")}</option>
                <option value="detected:desc">{gt("Newest detected")}</option>
                <option value="detected:asc">{gt("Oldest detected")}</option>
                <option value="status_changed:desc">{gt("Recently changed")}</option>
                <option value="status_changed:asc">{gt("Least recently changed")}</option>
                <option value="name:asc">{gt("Name")}</option>
                <option value="name:desc">{gt("Name, Z to A")}</option>
              </select>
            </label>
            {filtering && (
              <button
                type="button"
                onClick={() => setFilter({})}
                className="pb-1.5 text-sm underline text-on-surface-tertiary"
              >
                {gt("Clear filters")}
              </button>
            )}
          </div>

          <div
            role="tablist"
            aria-label={gt("Finding status")}
            className="flex flex-wrap gap-1 border-b border-border"
          >
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={status === t.id}
                onClick={() => {
                  setStatus(t.id);
                  setSelected(new Set());
                }}
                className={`-mb-px border-b-2 px-3 py-1.5 text-sm ${
                  status === t.id
                    ? "border-blue-500 text-on-surface"
                    : "border-transparent text-on-surface-tertiary hover:text-on-surface"
                }`}
              >
                {t.label} <span className="text-on-surface-faint">{t.count}</span>
              </button>
            ))}
          </div>

          {notice !== null && (
            <p role="status" className="text-xs text-warning">
              {notice}
            </p>
          )}

          {client.setStatus && selected.size > 0 && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface-raised px-3 py-2 text-sm">
              <span className="text-on-surface">
                {gt("{count} selected", { count: selected.size })}
              </span>
              <label htmlFor={`${uid}-bulk`} className="sr-only">
                {gt("New status")}
              </label>
              <select
                id={`${uid}-bulk`}
                value={bulkStatus}
                onChange={(e) => setBulkStatus(e.target.value as SavingsFindingStatus)}
                className={SELECT}
              >
                {SAVINGS_FINDING_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {statusLabel(s)}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => setChanging({ keys: [...selected], status: bulkStatus })}
                className={BUTTON}
              >
                {gt("Change status")}
              </button>
              <button
                type="button"
                onClick={() => setSelected(new Set())}
                className="underline text-on-surface-tertiary"
              >
                {gt("Clear selection")}
              </button>
            </div>
          )}

          {rows.length === 0 ? (
            <p className="text-sm text-on-surface-faint">
              {findings.length === 0
                ? gt(
                    "No savings findings yet. Findings appear here as the finders below report them.",
                  )
                : gt("No findings match this view.")}
            </p>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-border">
              <table className="w-full text-sm">
                <thead className="bg-surface-raised text-left text-xs text-on-surface-secondary">
                  <tr>
                    {client.setStatus && (
                      <th className="w-8 px-3 py-2">
                        <input
                          type="checkbox"
                          checked={allSelected}
                          onChange={toggleAll}
                          aria-label={gt("Select all findings in this list")}
                        />
                      </th>
                    )}
                    <th className="px-3 py-2 font-medium">{gt("Finding")}</th>
                    <th className="px-3 py-2 font-medium text-right whitespace-nowrap">
                      {gt("Monthly savings")}
                    </th>
                    <th className="px-3 py-2 font-medium whitespace-nowrap">{gt("Detected")}</th>
                    <th className="px-3 py-2 font-medium">{gt("Status")}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((f) => (
                    <tr
                      key={f.key}
                      className="border-t border-border align-top hover:bg-surface-raised"
                    >
                      {client.setStatus && (
                        <td className="px-3 py-2.5">
                          <input
                            type="checkbox"
                            checked={selected.has(f.key)}
                            onChange={() => toggle(f.key)}
                            aria-label={gt("Select {name}", { name: f.resourceName })}
                          />
                        </td>
                      )}
                      <td className="px-3 py-2.5">
                        <div className="flex flex-wrap items-center gap-2">
                          {onOpenResource && f.resourceId && f.present ? (
                            <button
                              type="button"
                              onClick={() => onOpenResource(f)}
                              className="text-left font-medium text-on-surface hover:underline"
                            >
                              {f.title}
                            </button>
                          ) : (
                            <span className="font-medium text-on-surface">{f.title}</span>
                          )}
                          <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-on-surface-tertiary">
                            {kindLabel(f.kind)}
                          </span>
                        </div>
                        <div className="mt-0.5 text-xs text-on-surface-faint">
                          {[f.accountName, f.pluginName ? gtData(f.pluginName) : null, f.region]
                            .filter(Boolean)
                            .join(" · ")}
                        </div>
                        {f.detail && (
                          <div className="mt-0.5 text-xs text-on-surface-tertiary">{f.detail}</div>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-right whitespace-nowrap tabular-nums text-on-surface">
                        {f.monthlySavings
                          ? formatMoney(f.monthlySavings.amount, f.monthlySavings.currency)
                          : ""}
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap text-on-surface-secondary">
                        {day(f.detectedAt)}
                      </td>
                      <td className="px-3 py-2.5">
                        <StatusCell
                          finding={f}
                          label={statusLabel(f.status)}
                          onChange={
                            client.setStatus
                              ? (next) => setChanging({ keys: [f.key], status: next })
                              : undefined
                          }
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {changing && (
        <SavingsStatusModal
          count={changing.keys.length}
          status={changing.status}
          onSave={(note) => applyStatus(changing.keys, changing.status, note)}
          onClose={() => setChanging(null)}
        />
      )}
      {savingView && (
        <SavingsViewModal
          editing={savingView === "update"}
          initialName={savingView === "update" ? (activeView?.name ?? "") : ""}
          initialDescription={savingView === "update" ? (activeView?.description ?? "") : ""}
          onSave={saveView}
          onClose={() => setSavingView(null)}
        />
      )}
      {sharingView && client.sharing && (
        <ShareDialog
          client={client.sharing}
          target={{ objectType: "savings_view", objectId: sharingView.id, name: sharingView.name }}
          onClose={() => setSharingView(null)}
        />
      )}
    </section>
  );
}

function Tile({ label, value, caption }: { label: string; value: string; caption: string }) {
  return (
    <div className="rounded-xl border border-border bg-surface-raised px-4 py-3">
      <div className="text-xs text-on-surface-secondary">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums text-on-surface">{value}</div>
      <div className="text-[11px] text-on-surface-faint">{caption}</div>
    </div>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
  anyLabel,
  severalLabel,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly (readonly [string, string])[];
  anyLabel: string;
  severalLabel: string;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-on-surface-secondary">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className={SELECT}>
        <option value="">{anyLabel}</option>
        {value === "*" && (
          <option value="*" disabled>
            {severalLabel}
          </option>
        )}
        {options.map(([id, text]) => (
          <option key={id} value={id}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
}

function StatusCell({
  finding,
  label,
  onChange,
}: {
  finding: SavingsFinding;
  label: string;
  onChange?: ((status: SavingsFindingStatus) => void) | undefined;
}) {
  const gt = useGT();
  const statusLabel = useSavingsStatusLabel();
  const by =
    finding.statusChangedBy?.name ?? (finding.statusChangedBy ? gt("a former member") : null);
  return (
    <div className="flex flex-col gap-1">
      {onChange ? (
        <select
          value={finding.status}
          onChange={(e) => onChange(e.target.value as SavingsFindingStatus)}
          aria-label={gt("Status of {name}", { name: finding.resourceName })}
          className={`rounded-full border bg-transparent px-2 py-0.5 text-xs ${STATUS_BADGE[finding.status]}`}
        >
          {SAVINGS_FINDING_STATUSES.map((s) => (
            <option key={s} value={s}>
              {statusLabel(s)}
            </option>
          ))}
        </select>
      ) : (
        <span
          className={`w-fit rounded-full border px-2 py-0.5 text-xs ${STATUS_BADGE[finding.status]}`}
        >
          {label}
        </span>
      )}
      {finding.statusChangedAt && (
        <span className="text-[11px] text-on-surface-faint">
          {by
            ? gt("{who}, {when}", { who: by, when: day(finding.statusChangedAt) })
            : finding.resolution === "resolved"
              ? gt("Resolved automatically, {when}", { when: day(finding.statusChangedAt) })
              : gt("Reopened automatically, {when}", { when: day(finding.statusChangedAt) })}
        </span>
      )}
      {finding.statusNote && (
        <span className="text-[11px] text-on-surface-tertiary">{finding.statusNote}</span>
      )}
      {!finding.present && finding.status !== "completed" && (
        <span className="text-[11px] text-on-surface-faint">{gt("No longer detected")}</span>
      )}
      {finding.realizedSavings && (
        <span className="text-[11px] text-success">
          {gt("Realized savings recorded: {title}", { title: finding.realizedSavings.title })}
        </span>
      )}
    </div>
  );
}
