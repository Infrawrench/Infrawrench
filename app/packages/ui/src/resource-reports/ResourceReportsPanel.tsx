import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useGT } from "gt-react";
import {
  COST_BASIS_LABELS,
  DEFAULT_RESOURCE_REPORT_CONFIG,
  RESOURCE_REPORT_LIMITS,
  RESOURCE_REPORT_PAGE_SIZES,
  effectiveResourceReportSort,
  flattenCostReportFolderTree,
  formatResourceReportMoney,
  resourceReportCsvFilename,
  resourceReportFilterCount,
  type CostReportFolder,
  type ResourceReport,
  type ResourceReportConfig,
  type ResourceReportInput,
  type ResourceReportOptions,
  type ResourceReportRow,
  type ResourceReportRowsResult,
} from "@infrawrench/client-core";
import { Modal } from "../components/Modal.js";
import { ErrorNotice } from "../components/ErrorNotice.js";
import { ShareDialog, type ShareTarget } from "../sharing/ShareDialog.js";
import { labelClass, selectClass } from "../cost/form-styles.js";
import { useDataString } from "../i18n/data-strings.js";
import { ResourceReportColumnsModal } from "./ResourceReportColumnsModal.js";
import { ResourceReportFiltersModal } from "./ResourceReportFiltersModal.js";
import { ResourceReportsIcon } from "./ResourceReportsIcon.js";
import { useColumnLabel } from "./labels.js";
import type { ResourceReportResourceRef, ResourceReportsClient } from "./types.js";

export interface ResourceReportsPanelProps {
  client: ResourceReportsClient;
  /** The open report; undefined shows the list. */
  reportId?: string | undefined;
  /** Open a report (or go back to the list with null). Hosts mirror it into the URL. */
  onReportChange: (reportId: string | null) => void;
  /** A row's resource: the host opens its detail view. */
  onOpenResource?: ((ref: ResourceReportResourceRef) => void) | undefined;
}

const buttonClass =
  "rounded-lg border border-border px-2.5 py-1 text-sm text-on-surface-secondary hover:text-on-surface hover:bg-surface-sunken disabled:opacity-50";
const primaryClass =
  "rounded-lg bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50";
const inputClass =
  "w-full rounded-lg border border-border bg-surface-sunken px-2.5 py-1.5 text-sm text-on-surface focus:outline-none focus:border-blue-500";

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Same download path the cost reports use; Electron routes it through its save dialog. */
function saveTextFile(filename: string, mediaType: string, body: string): void {
  const url = URL.createObjectURL(new Blob([body], { type: mediaType }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Resource reports: saved inventory tables over every synced resource, with
 * per-resource cost. A list of the org's reports (grouped by the report
 * folders cost reports use), and one report as a sortable, paged table whose
 * columns and filters can be changed in place and saved.
 */
export function ResourceReportsPanel({
  client,
  reportId,
  onReportChange,
  onOpenResource,
}: ResourceReportsPanelProps) {
  const [creating, setCreating] = useState(false);
  // Opening a report (from the URL or the list) ends a draft.
  useEffect(() => {
    if (reportId) setCreating(false);
  }, [reportId]);

  if (reportId || creating) {
    return (
      <ReportView
        key={reportId ?? "new"}
        client={client}
        reportId={reportId ?? null}
        onBack={() => {
          setCreating(false);
          onReportChange(null);
        }}
        onSaved={(id) => {
          setCreating(false);
          onReportChange(id);
        }}
        onOpenResource={onOpenResource}
      />
    );
  }
  return (
    <ReportList
      client={client}
      onOpen={(id) => onReportChange(id)}
      onCreate={client.createReport ? () => setCreating(true) : undefined}
    />
  );
}

/* ------------------------------------------------------------------ *
 * List
 * ------------------------------------------------------------------ */

function ReportList({
  client,
  onOpen,
  onCreate,
}: {
  client: ResourceReportsClient;
  onOpen: (id: string) => void;
  onCreate: (() => void) | undefined;
}) {
  const gt = useGT();
  const [reports, setReports] = useState<ResourceReport[] | null>(null);
  const [folders, setFolders] = useState<CostReportFolder[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    Promise.all([client.listReports(), client.listFolders().catch(() => [])])
      .then(([r, f]) => {
        if (!live) return;
        setReports(r);
        setFolders(f);
        setError(null);
      })
      .catch((e: unknown) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [client]);

  const groups = useMemo(() => {
    const tree = flattenCostReportFolderTree(folders);
    const out: Array<{ key: string; title: string | null; reports: ResourceReport[] }> = [];
    const all = reports ?? [];
    const known = new Set(tree.map((r) => r.folder.id));
    const top = all.filter((r) => !r.folderId || !known.has(r.folderId));
    if (top.length > 0) out.push({ key: "top", title: null, reports: top });
    for (const row of tree) {
      const inFolder = all.filter((r) => r.folderId === row.folder.id);
      if (inFolder.length > 0) out.push({ key: row.folder.id, title: row.path, reports: inFolder });
    }
    return out;
  }, [reports, folders]);

  return (
    <div>
      <div className="mb-4 flex items-center gap-3">
        <ResourceReportsIcon size={18} className="text-on-surface-secondary" />
        <h1 className="text-lg font-semibold text-on-surface">{gt("Resource reports")}</h1>
        {onCreate && (
          <button type="button" className={`${primaryClass} ml-auto`} onClick={onCreate}>
            {gt("New report")}
          </button>
        )}
      </div>
      <p className="mb-4 text-sm text-on-surface-faint">
        {gt(
          "Saved tables of your synced resources, with the columns you pick and what each resource costs.",
        )}
      </p>
      {error && <ErrorNotice message={error} className="mb-4" />}
      {reports === null && !error && (
        <p className="text-sm text-on-surface-faint">{gt("Loading reports…")}</p>
      )}
      {reports !== null && reports.length === 0 && (
        <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-on-surface-faint">
          {gt(
            "No resource reports yet. Create one to list resources across every account with their cost.",
          )}
        </div>
      )}
      {groups.map((group) => (
        <section key={group.key} className="mb-5" aria-label={group.title ?? gt("Top level")}>
          {group.title && (
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-on-surface-faint">
              {group.title}
            </h2>
          )}
          <ul className="space-y-2">
            {group.reports.map((r) => {
              const filterCount = resourceReportFilterCount(r.config.filters);
              return (
                <li key={r.id} className="rounded-xl border border-border bg-surface-raised">
                  <button
                    type="button"
                    onClick={() => onOpen(r.id)}
                    className="w-full px-4 py-3 text-left hover:bg-surface-sunken rounded-xl"
                  >
                    <div className="text-sm font-medium text-on-surface">{r.name}</div>
                    {r.description && (
                      <div className="mt-0.5 text-xs text-on-surface-secondary">
                        {r.description}
                      </div>
                    )}
                    <div className="mt-1 text-xs text-on-surface-faint">
                      {gt("{columns} columns · {filters} filters", {
                        columns: r.config.columns.length,
                        filters: filterCount,
                      })}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * One report
 * ------------------------------------------------------------------ */

interface Draft {
  name: string;
  description: string;
  folderId: string | null;
  config: ResourceReportConfig;
}

function draftOf(report: ResourceReport | null): Draft {
  return report
    ? {
        name: report.name,
        description: report.description ?? "",
        folderId: report.folderId,
        config: report.config,
      }
    : { name: "", description: "", folderId: null, config: DEFAULT_RESOURCE_REPORT_CONFIG };
}

function toInput(d: Draft): ResourceReportInput {
  return {
    name: d.name.trim(),
    ...(d.description.trim() ? { description: d.description.trim() } : {}),
    config: d.config,
    folderId: d.folderId,
  };
}

function ReportView({
  client,
  reportId,
  onBack,
  onSaved,
  onOpenResource,
}: {
  client: ResourceReportsClient;
  reportId: string | null;
  onBack: () => void;
  onSaved: (id: string) => void;
  onOpenResource: ((ref: ResourceReportResourceRef) => void) | undefined;
}) {
  const gt = useGT();
  const [report, setReport] = useState<ResourceReport | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(() => draftOf(null));
  const [options, setOptions] = useState<ResourceReportOptions | null>(null);
  const [folders, setFolders] = useState<CostReportFolder[]>([]);
  const [result, setResult] = useState<ResourceReportRowsResult | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [offset, setOffset] = useState(0);
  const [modal, setModal] = useState<"columns" | "filters" | "details" | "delete" | null>(null);
  const [sharing, setSharing] = useState<ShareTarget | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const canWrite = Boolean(client.createReport && client.updateReport && client.deleteReport);

  // Load the saved report (or start a draft).
  useEffect(() => {
    if (!reportId) {
      setReport(null);
      setDraft(draftOf(null));
      return;
    }
    let live = true;
    client
      .getReport(reportId)
      .then((r) => {
        if (!live) return;
        setReport(r);
        setDraft(draftOf(r));
        setLoadError(null);
      })
      .catch((e: unknown) => live && setLoadError(errorText(e)));
    return () => {
      live = false;
    };
  }, [client, reportId]);

  useEffect(() => {
    client
      .listFolders()
      .then(setFolders)
      .catch(() => setFolders([]));
  }, [client]);

  // Picker options, narrowed to the chosen types' metadata fields.
  const typesKey = JSON.stringify(draft.config.filters.resourceTypes);
  useEffect(() => {
    let live = true;
    const types = JSON.parse(typesKey) as ResourceReportConfig["filters"]["resourceTypes"];
    client
      .getOptions(types)
      .then((o) => live && setOptions(o))
      .catch(() => live && setOptions(null));
    return () => {
      live = false;
    };
  }, [client, typesKey]);

  // Run the draft: saved or not, what is on screen is what the table shows.
  const configKey = JSON.stringify(draft.config);
  const ready = reportId === null || report !== null;
  const runSeq = useRef(0);
  useEffect(() => {
    if (!ready) return;
    const seq = ++runSeq.current;
    setRunning(true);
    const timer = setTimeout(() => {
      client
        .query({
          config: JSON.parse(configKey) as ResourceReportConfig,
          offset,
          limit: draft.config.pageSize,
        })
        .then((r) => {
          if (seq !== runSeq.current) return;
          setResult(r);
          setRunError(null);
        })
        .catch((e: unknown) => seq === runSeq.current && setRunError(errorText(e)))
        .finally(() => seq === runSeq.current && setRunning(false));
    }, 200);
    return () => clearTimeout(timer);
  }, [client, configKey, offset, ready, draft.config.pageSize]);

  const fieldLabels = useMemo(
    () => new Map((options?.fields ?? []).map((f) => [f.key, f.label])),
    [options],
  );
  const columnLabel = useColumnLabel(fieldLabels);
  const dirty =
    reportId === null ||
    (report !== null &&
      JSON.stringify(toInput(draftOf(report))) !== JSON.stringify(toInput(draft)));

  const setConfig = useCallback((config: ResourceReportConfig) => {
    setDraft((d) => ({ ...d, config }));
    setOffset(0);
  }, []);

  async function save(next: Draft = draft) {
    setActionError(null);
    try {
      if (!next.name.trim()) {
        setModal("details");
        return;
      }
      if (report && client.updateReport) {
        const updated = await client.updateReport(report.id, toInput(next));
        setReport(updated);
        setDraft(draftOf(updated));
      } else if (client.createReport) {
        const created = await client.createReport(toInput(next));
        onSaved(created.id);
      }
      setModal(null);
    } catch (e: unknown) {
      setActionError(errorText(e));
    }
  }

  async function exportCsv() {
    setExporting(true);
    setActionError(null);
    try {
      const name = draft.name.trim() || gt("Resource report");
      const csv = await client.exportCsv(draft.config, name);
      saveTextFile(resourceReportCsvFilename(name), "text/csv", csv);
    } catch (e: unknown) {
      setActionError(errorText(e));
    } finally {
      setExporting(false);
    }
  }

  function toggleSort(column: string) {
    const current = effectiveResourceReportSort(draft.config);
    const direction =
      current.column === column
        ? current.direction === "asc"
          ? "desc"
          : "asc"
        : column.startsWith("cost:")
          ? "desc"
          : "asc";
    setConfig({ ...draft.config, sort: { column, direction } });
  }

  if (loadError) {
    return (
      <div>
        <button type="button" className={buttonClass} onClick={onBack}>
          {gt("Back to reports")}
        </button>
        <ErrorNotice message={loadError} className="mt-4" />
      </div>
    );
  }

  const filterCount = resourceReportFilterCount(draft.config.filters);
  const sort = effectiveResourceReportSort(draft.config);
  const total = result?.total ?? 0;
  const limit = draft.config.pageSize;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button type="button" className={buttonClass} onClick={onBack}>
          {gt("Back to reports")}
        </button>
        <h1 className="min-w-0 flex-1 truncate text-lg font-semibold text-on-surface">
          {draft.name || gt("New resource report")}
        </h1>
        <button type="button" className={buttonClass} onClick={() => setModal("columns")}>
          {gt("Columns")}
        </button>
        <button type="button" className={buttonClass} onClick={() => setModal("filters")}>
          {filterCount > 0 ? gt("Filters ({count})", { count: filterCount }) : gt("Filters")}
        </button>
        <button
          type="button"
          className={buttonClass}
          disabled={exporting}
          onClick={() => void exportCsv()}
        >
          {exporting ? gt("Exporting…") : gt("Export CSV")}
        </button>
        {report && client.sharing && (
          <button
            type="button"
            className={buttonClass}
            onClick={() =>
              setSharing({ objectType: "resource_report", objectId: report.id, name: report.name })
            }
          >
            {gt("Share")}
          </button>
        )}
        {canWrite && report && (
          <button type="button" className={buttonClass} onClick={() => setModal("details")}>
            {gt("Details")}
          </button>
        )}
        {canWrite && report && (
          <button type="button" className={buttonClass} onClick={() => setModal("delete")}>
            {gt("Delete")}
          </button>
        )}
        {canWrite && (
          <button
            type="button"
            className={primaryClass}
            disabled={!dirty}
            onClick={() => (report ? void save() : setModal("details"))}
          >
            {report ? gt("Save") : gt("Save report")}
          </button>
        )}
      </div>
      {draft.description && (
        <p className="mb-2 text-sm text-on-surface-secondary">{draft.description}</p>
      )}
      {actionError && <ErrorNotice message={actionError} className="mb-3" />}
      <CostNote result={result} />
      {runError && <ErrorNotice message={runError} className="mb-3" />}

      <ReportTable
        result={result}
        columnLabel={columnLabel}
        sort={sort}
        running={running}
        onSort={toggleSort}
        onOpenResource={onOpenResource}
      />

      <div className="mt-3 flex flex-wrap items-center gap-3 text-sm text-on-surface-secondary">
        <span>
          {total === 0
            ? gt("No matching resources")
            : gt("{from} to {to} of {total}", {
                from: (offset + 1).toLocaleString(),
                to: Math.min(offset + limit, total).toLocaleString(),
                total: `${result?.truncated ? "≥" : ""}${total.toLocaleString()}`,
              })}
        </span>
        <button
          type="button"
          className={buttonClass}
          disabled={offset === 0 || running}
          onClick={() => setOffset(Math.max(0, offset - limit))}
        >
          {gt("Previous")}
        </button>
        <button
          type="button"
          className={buttonClass}
          disabled={offset + limit >= total || running}
          onClick={() => setOffset(offset + limit)}
        >
          {gt("Next")}
        </button>
        <label className="ml-auto flex items-center gap-2">
          <span>{gt("Rows per page")}</span>
          <select
            className={`${selectClass} !w-auto`}
            value={limit}
            onChange={(e) => setConfig({ ...draft.config, pageSize: Number(e.target.value) })}
          >
            {[...new Set([...RESOURCE_REPORT_PAGE_SIZES, limit])]
              .sort((a, b) => a - b)
              .map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
          </select>
        </label>
      </div>
      {result?.truncated && (
        <p className="mt-2 text-xs text-warning">
          {gt(
            "This report scanned the first {max} matching resources. Narrow the filters to see everything.",
            {
              max: RESOURCE_REPORT_LIMITS.maxScan.toLocaleString(),
            },
          )}
        </p>
      )}

      {modal === "columns" && (
        <ResourceReportColumnsModal
          config={draft.config}
          options={options}
          fieldLabels={fieldLabels}
          onClose={() => setModal(null)}
          onApply={(next) => {
            setConfig(next);
            setModal(null);
          }}
        />
      )}
      {modal === "filters" && (
        <ResourceReportFiltersModal
          client={client}
          config={draft.config}
          options={options}
          onClose={() => setModal(null)}
          onApply={(next) => {
            setConfig(next);
            setModal(null);
          }}
        />
      )}
      {modal === "details" && (
        <DetailsModal
          draft={draft}
          folders={folders}
          client={client}
          isNew={report === null}
          onClose={() => setModal(null)}
          onFoldersChanged={setFolders}
          onSave={(next) => {
            setDraft(next);
            void save(next);
          }}
        />
      )}
      {modal === "delete" && report && (
        <DeleteModal
          name={report.name}
          onClose={() => setModal(null)}
          onConfirm={async () => {
            await client.deleteReport?.(report.id);
            onBack();
          }}
        />
      )}
      {sharing && client.sharing && (
        <ShareDialog client={client.sharing} target={sharing} onClose={() => setSharing(null)} />
      )}
    </div>
  );
}

function CostNote({ result }: { result: ResourceReportRowsResult | null }) {
  const gt = useGT();
  const gtData = useDataString();
  const cost = result?.cost;
  if (!cost) return null;
  if (!cost.available) {
    return (
      <p className="mb-3 text-xs text-on-surface-faint">
        {cost.reason
          ? gt("Cost columns are empty: {reason}", { reason: cost.reason })
          : gt("Cost columns are empty.")}
      </p>
    );
  }
  const range = cost.windows.find((w) => w.window === "range");
  return (
    <p className="mb-3 text-xs text-on-surface-faint">
      {range &&
        gt(
          "Accrued cost covers {from} to {to}, {basis}. Spend is matched by the provider's resource id, so providers that do not bill per resource show none.",
          {
            from: range.from,
            to: range.to,
            basis: gtData(COST_BASIS_LABELS[cost.basis]).toLowerCase(),
          },
        )}
    </p>
  );
}

function ReportTable({
  result,
  columnLabel,
  sort,
  running,
  onSort,
  onOpenResource,
}: {
  result: ResourceReportRowsResult | null;
  columnLabel: (id: string) => string;
  sort: { column: string; direction: "asc" | "desc" };
  running: boolean;
  onSort: (column: string) => void;
  onOpenResource: ((ref: ResourceReportResourceRef) => void) | undefined;
}) {
  const gt = useGT();
  if (!result) {
    return (
      <div className="rounded-xl border border-border p-6 text-sm text-on-surface-faint">
        {running ? gt("Running report…") : gt("Nothing to show yet.")}
      </div>
    );
  }
  const open = (row: ResourceReportRow) =>
    onOpenResource?.({
      accountId: row.accountId,
      resourceId: row.id,
      pluginId: row.pluginId,
      resourceTypeId: row.resourceTypeId,
    });
  return (
    <div
      className={`overflow-x-auto rounded-xl border border-border ${running ? "opacity-60" : ""}`}
      aria-busy={running}
    >
      <table className="w-full text-sm">
        <thead className="bg-surface-sunken text-left">
          <tr>
            {result.columns.map((col) => {
              const active = sort.column === col.id;
              return (
                <th
                  key={col.id}
                  scope="col"
                  aria-sort={
                    active ? (sort.direction === "asc" ? "ascending" : "descending") : undefined
                  }
                  className={`whitespace-nowrap px-3 py-2 font-medium text-on-surface-secondary ${
                    col.kind === "cost" ? "text-right" : ""
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => onSort(col.id)}
                    className="hover:text-on-surface"
                  >
                    {columnLabel(col.id)}
                    {active ? (sort.direction === "asc" ? " ▲" : " ▼") : ""}
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row) => (
            <tr key={row.id} className="border-t border-border hover:bg-surface-sunken/60">
              {result.columns.map((col, i) => {
                if (col.kind === "cost") {
                  const cell = row.costs[col.id] ?? [];
                  return (
                    <td
                      key={col.id}
                      className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-on-surface"
                    >
                      {cell.length > 0 ? formatResourceReportMoney(cell) : "-"}
                    </td>
                  );
                }
                const text = row.values[col.id] ?? "";
                const shown =
                  col.kind === "core" && col.key === "created" && text
                    ? new Date(text).toLocaleDateString()
                    : text;
                return (
                  <td
                    key={col.id}
                    className="max-w-[24rem] truncate px-3 py-1.5 text-on-surface"
                    title={text || undefined}
                  >
                    {i === 0 && onOpenResource ? (
                      <button
                        type="button"
                        className="text-left font-medium text-on-surface underline-offset-2 hover:underline"
                        onClick={() => open(row)}
                      >
                        {shown || gt("(unnamed)")}
                      </button>
                    ) : (
                      shown
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DetailsModal({
  draft,
  folders,
  client,
  isNew,
  onClose,
  onSave,
  onFoldersChanged,
}: {
  draft: Draft;
  folders: CostReportFolder[];
  client: ResourceReportsClient;
  isNew: boolean;
  onClose: () => void;
  onSave: (next: Draft) => void;
  onFoldersChanged: (folders: CostReportFolder[]) => void;
}) {
  const gt = useGT();
  const nameId = useId();
  const descId = useId();
  const folderId = useId();
  const [name, setName] = useState(draft.name);
  const [description, setDescription] = useState(draft.description);
  const [folder, setFolder] = useState<string | null>(draft.folderId);
  const [newFolder, setNewFolder] = useState("");
  const [error, setError] = useState<string | null>(null);
  const tree = useMemo(() => flattenCostReportFolderTree(folders), [folders]);

  async function addFolder() {
    if (!client.createFolder || !newFolder.trim()) return;
    try {
      const created = await client.createFolder({ name: newFolder.trim(), parentFolderId: null });
      onFoldersChanged([...folders, created]);
      setFolder(created.id);
      setNewFolder("");
    } catch (e: unknown) {
      setError(errorText(e));
    }
  }

  return (
    <Modal onClose={onClose} ariaLabel={isNew ? gt("Save report") : gt("Report details")}>
      <div className="bg-surface-raised border border-border-strong rounded-xl shadow-2xl w-[440px] max-w-[95vw] p-6">
        <h2 className="mb-4 text-base font-semibold text-on-surface">
          {isNew ? gt("Save report") : gt("Report details")}
        </h2>
        <label htmlFor={nameId} className={labelClass}>
          {gt("Name")}
        </label>
        <input
          id={nameId}
          className={inputClass}
          value={name}
          maxLength={RESOURCE_REPORT_LIMITS.maxNameLength}
          onChange={(e) => setName(e.target.value)}
        />
        <label htmlFor={descId} className={`${labelClass} mt-3`}>
          {gt("Description")}
        </label>
        <textarea
          id={descId}
          className={inputClass}
          rows={2}
          value={description}
          maxLength={RESOURCE_REPORT_LIMITS.maxDescriptionLength}
          onChange={(e) => setDescription(e.target.value)}
        />
        <label htmlFor={folderId} className={`${labelClass} mt-3`}>
          {gt("Folder")}
        </label>
        <select
          id={folderId}
          className={selectClass}
          value={folder ?? ""}
          onChange={(e) => setFolder(e.target.value || null)}
        >
          <option value="">{gt("Top level")}</option>
          {tree.map((row) => (
            <option key={row.folder.id} value={row.folder.id}>
              {row.path}
            </option>
          ))}
        </select>
        <p className="mt-1 text-xs text-on-surface-faint">
          {gt(
            "Resource reports share folders with cost reports, and a folder's sharing covers both.",
          )}
        </p>
        {client.createFolder && (
          <div className="mt-2 flex gap-2">
            <input
              className={inputClass}
              value={newFolder}
              aria-label={gt("New folder name")}
              placeholder={gt("New folder name")}
              onChange={(e) => setNewFolder(e.target.value)}
            />
            <button
              type="button"
              className={buttonClass}
              disabled={!newFolder.trim()}
              onClick={() => void addFolder()}
            >
              {gt("Add folder")}
            </button>
          </div>
        )}
        {error && <p className="mt-3 text-sm text-danger">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass}>
            {gt("Cancel")}
          </button>
          <button
            type="button"
            className={primaryClass}
            disabled={!name.trim()}
            onClick={() => onSave({ ...draft, name, description, folderId: folder })}
          >
            {gt("Save")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function DeleteModal({
  name,
  onClose,
  onConfirm,
}: {
  name: string;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const gt = useGT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal onClose={onClose} ariaLabel={gt("Delete report")}>
      <div className="bg-surface-raised border border-border-strong rounded-xl shadow-2xl w-[420px] max-w-[95vw] p-6">
        <h2 className="mb-2 text-base font-semibold text-on-surface">{gt("Delete report")}</h2>
        <p className="text-sm text-on-surface-secondary">
          {gt("Delete {name}? The resources and their cost data are not touched.", { name })}
        </p>
        {error && <p className="mt-3 text-sm text-danger">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass}>
            {gt("Cancel")}
          </button>
          <button
            type="button"
            disabled={busy}
            className="rounded-lg bg-red-600 px-3 py-1 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-50"
            onClick={() => {
              setBusy(true);
              onConfirm().catch((e: unknown) => {
                setError(errorText(e));
                setBusy(false);
              });
            }}
          >
            {gt("Delete")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
