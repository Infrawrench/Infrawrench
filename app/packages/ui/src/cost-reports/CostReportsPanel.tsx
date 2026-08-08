import { useCallback, useEffect, useMemo, useState } from "react";

import {
  DEFAULT_COST_GRAPH_CONFIG,
  duplicateCostReportName,
  normalizeCostReportName,
  type CostGraphConfig,
  type CostReport,
  type CostReportInput,
} from "../cost/config.js";
import { CostGraphCard } from "../cost/CostGraphCard.js";
import { CostGraphConfigModal } from "../cost/CostGraphConfigModal.js";
import { Modal } from "../components/Modal.js";
import type { CostsPanelDashboard } from "../cost/types.js";
import type { CostReportsClient } from "./types.js";

function toInput(report: CostReport): CostReportInput {
  return {
    name: report.name,
    ...(report.description ? { description: report.description } : {}),
    config: report.config,
    folderId: report.folderId,
  };
}

function placementSummary(report: CostReport): string {
  const count = report.placements.length;
  if (count === 0) return "On no dashboard";
  if (count === 1) return `On ${report.placements[0]!.dashboardName}`;
  return `On ${count} dashboards`;
}

export interface CostReportsPanelProps {
  client: CostReportsClient;
  /**
   * Which report to show. Absent renders the list. Owned by the host so the
   * URL, the workspace tab, and this panel never disagree about which report
   * is open — the panel asks to change it and re-renders on the way back.
   */
  reportId?: string | undefined;
  /** Open a report (or, with undefined, go back to the list). */
  onSelectReport?: ((reportId: string | undefined) => void) | undefined;
  /** Open a dashboard by id — the placement list links to them. */
  onOpenDashboard?: ((dashboardId: string) => void) | undefined;
}

/**
 * Cost reports — the org's named, saved cost graphs.
 *
 * A report is to a cost graph what a budget is to a budget card: the object is
 * the thing, and a dashboard card is a view onto it. That is why this panel
 * exists at all — before it, a cost graph was a dashboard card and nothing
 * else, so there was no report to fold into a folder, annotate, schedule, or
 * link a colleague to.
 *
 * The chart and the editor are the exact components a dashboard cost card
 * uses ({@link CostGraphCard}, {@link CostGraphConfigModal}); a report is the
 * same config under a name, and forking them would guarantee the two drift.
 */
export function CostReportsPanel({
  client,
  reportId,
  onSelectReport,
  onOpenDashboard,
}: CostReportsPanelProps) {
  const [reports, setReports] = useState<CostReport[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ report: CostReport | null } | null>(null);
  const [placing, setPlacing] = useState<CostReport | null>(null);

  const canWrite = Boolean(client.createReport && client.updateReport && client.deleteReport);
  const canPlace = Boolean(
    client.listDashboards && client.addReportToDashboard && client.removeReportPlacement,
  );

  const refresh = useCallback(async () => {
    // A failure has to be visible: an empty list and a broken list look
    // identical, and one of them means reports you saved are not being shown.
    try {
      setReports(await client.listReports());
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selected = useMemo(
    () => (reportId ? (reports?.find((r) => r.id === reportId) ?? null) : null),
    [reports, reportId],
  );

  async function saveReport(name: string, config: CostGraphConfig) {
    const clean = normalizeCostReportName(name);
    if (!clean) throw new Error("A report needs a name.");
    const target = editing?.report;
    const input: CostReportInput = {
      name: clean,
      ...(target?.description ? { description: target.description } : {}),
      config,
      folderId: target?.folderId ?? null,
    };
    if (target) await client.updateReport?.(target.id, input);
    else {
      const created = await client.createReport?.(input);
      // Land on the new report rather than back on the list: the user just
      // described a chart and wants to see whether it draws what they meant.
      if (created) onSelectReport?.(created.id);
    }
    setEditing(null);
    await refresh();
  }

  async function renameReport(report: CostReport) {
    const raw = window.prompt("Rename report", report.name);
    if (raw === null) return;
    const name = normalizeCostReportName(raw);
    if (!name) return;
    await client.updateReport?.(report.id, { ...toInput(report), name });
    await refresh();
  }

  async function duplicateReport(report: CostReport) {
    const name = duplicateCostReportName(
      report.name,
      (reports ?? []).map((r) => r.name),
    );
    const created = await client.createReport?.({ ...toInput(report), name });
    await refresh();
    if (created) onSelectReport?.(created.id);
  }

  async function deleteReport(report: CostReport) {
    const where =
      report.placements.length > 0
        ? `\n\nIts card will also be removed from ${report.placements
            .map((p) => p.dashboardName)
            .join(", ")}.`
        : "";
    if (!window.confirm(`Delete the report "${report.name}"?${where}`)) return;
    await client.deleteReport?.(report.id);
    if (reportId === report.id) onSelectReport?.(undefined);
    await refresh();
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-6 flex flex-col gap-6">
        {error !== null && (
          <div role="alert" className="text-sm text-red-500">
            Couldn&rsquo;t load reports — {error}{" "}
            <button type="button" onClick={() => void refresh()} className="underline">
              Retry
            </button>
          </div>
        )}

        {selected ? (
          <ReportDetail
            report={selected}
            client={client}
            canWrite={canWrite}
            canPlace={canPlace}
            onBack={() => onSelectReport?.(undefined)}
            onEdit={() => setEditing({ report: selected })}
            onRename={() => void renameReport(selected)}
            onDuplicate={() => void duplicateReport(selected)}
            onDelete={() => void deleteReport(selected)}
            onPlace={() => setPlacing(selected)}
            onOpenDashboard={onOpenDashboard}
          />
        ) : (
          <ReportList
            reports={reports}
            error={error}
            canWrite={canWrite}
            canPlace={canPlace}
            onNew={() => setEditing({ report: null })}
            onOpen={(r) => onSelectReport?.(r.id)}
            onRename={(r) => void renameReport(r)}
            onDuplicate={(r) => void duplicateReport(r)}
            onDelete={(r) => void deleteReport(r)}
            onPlace={setPlacing}
            onOpenDashboard={onOpenDashboard}
          />
        )}
      </div>

      {editing && (
        // The dashboard cost-card editor, unchanged: a report's "title" is its
        // name, and its config is the same blob a cost_graph widget stores.
        <CostGraphConfigModal
          initialConfig={editing.report ? editing.report.config : DEFAULT_COST_GRAPH_CONFIG}
          initialTitle={editing.report?.name ?? ""}
          api={client}
          onSave={saveReport}
          onClose={() => setEditing(null)}
        />
      )}

      {placing && (
        <PlacementModal
          report={placing}
          client={client}
          onClose={() => setPlacing(null)}
          onChanged={refresh}
        />
      )}
    </div>
  );
}

function ReportList({
  reports,
  error,
  canWrite,
  canPlace,
  onNew,
  onOpen,
  onRename,
  onDuplicate,
  onDelete,
  onPlace,
  onOpenDashboard,
}: {
  reports: CostReport[] | null;
  error: string | null;
  canWrite: boolean;
  canPlace: boolean;
  onNew: () => void;
  onOpen: (report: CostReport) => void;
  onRename: (report: CostReport) => void;
  onDuplicate: (report: CostReport) => void;
  onDelete: (report: CostReport) => void;
  onPlace: (report: CostReport) => void;
  onOpenDashboard?: ((dashboardId: string) => void) | undefined;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-on-surface">Cost reports</h2>
          <p className="text-xs text-on-surface-faint mt-0.5">
            A saved cost graph with a name and an address. Put one on as many dashboards as you like
            — editing the report updates all of them.
          </p>
        </div>
        {canWrite && (
          <button
            type="button"
            onClick={onNew}
            className="shrink-0 rounded-lg border border-border bg-surface-raised px-3 py-1.5 text-sm text-on-surface hover:border-border-strong"
          >
            New report
          </button>
        )}
      </div>

      {reports === null && error === null && (
        <p role="status" className="text-sm text-on-surface-faint">
          Loading reports…
        </p>
      )}

      {reports?.length === 0 && (
        <p className="text-sm text-on-surface-faint">
          No reports yet. A one-off chart can still go straight onto a dashboard — a report is for
          the ones you want to keep, name, and share.
        </p>
      )}

      <ul className="flex flex-col gap-2">
        {(reports ?? []).map((report) => (
          <li
            key={report.id}
            className="rounded-xl border border-border bg-surface-raised px-4 py-3 hover:border-border-strong transition-colors"
          >
            <div className="flex items-start justify-between gap-3">
              <button
                type="button"
                onClick={() => onOpen(report)}
                className="min-w-0 text-left"
                title={`Open ${report.name}`}
              >
                <span className="block truncate text-sm font-medium text-on-surface">
                  {report.name}
                </span>
                {report.description && (
                  <span className="block truncate text-xs text-on-surface-faint mt-0.5">
                    {report.description}
                  </span>
                )}
              </button>
              <div className="flex shrink-0 items-center gap-2 text-xs text-on-surface-faint">
                {canPlace && (
                  <button
                    type="button"
                    onClick={() => onPlace(report)}
                    className="hover:text-on-surface-secondary underline"
                  >
                    Dashboards
                  </button>
                )}
                {canWrite && (
                  <>
                    <button
                      type="button"
                      onClick={() => onRename(report)}
                      className="hover:text-on-surface-secondary underline"
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      onClick={() => onDuplicate(report)}
                      className="hover:text-on-surface-secondary underline"
                    >
                      Duplicate
                    </button>
                    <button
                      type="button"
                      onClick={() => onDelete(report)}
                      className="hover:text-red-500 underline"
                    >
                      Delete
                    </button>
                  </>
                )}
              </div>
            </div>
            <div className="mt-1 text-xs text-on-surface-faint">
              <PlacementList report={report} onOpenDashboard={onOpenDashboard} />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ReportDetail({
  report,
  client,
  canWrite,
  canPlace,
  onBack,
  onEdit,
  onRename,
  onDuplicate,
  onDelete,
  onPlace,
  onOpenDashboard,
}: {
  report: CostReport;
  client: CostReportsClient;
  canWrite: boolean;
  canPlace: boolean;
  onBack: () => void;
  onEdit: () => void;
  onRename: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onPlace: () => void;
  onOpenDashboard?: ((dashboardId: string) => void) | undefined;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <button
            type="button"
            onClick={onBack}
            className="text-xs text-on-surface-faint hover:text-on-surface-secondary underline"
          >
            ← All reports
          </button>
          <h2 className="mt-1 truncate text-sm font-semibold text-on-surface">{report.name}</h2>
          {report.description && (
            <p className="truncate text-xs text-on-surface-faint mt-0.5">{report.description}</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2 text-xs text-on-surface-faint">
          {canPlace && (
            <button
              type="button"
              onClick={onPlace}
              className="hover:text-on-surface-secondary underline"
            >
              Dashboards
            </button>
          )}
          {canWrite && (
            <>
              <button
                type="button"
                onClick={onRename}
                className="hover:text-on-surface-secondary underline"
              >
                Rename
              </button>
              <button
                type="button"
                onClick={onDuplicate}
                className="hover:text-on-surface-secondary underline"
              >
                Duplicate
              </button>
              <button type="button" onClick={onDelete} className="hover:text-red-500 underline">
                Delete
              </button>
            </>
          )}
        </div>
      </div>

      {/*
        Same height trick the Costs panel uses: the card draws into a
        `height: 100%` ResponsiveContainer, so a plain flex column parent
        measures zero and the chart renders nothing at all.
      */}
      <div className="h-96 [&>*]:h-full">
        <CostGraphCard
          title={report.name}
          config={report.config}
          api={client}
          onEdit={canWrite ? onEdit : undefined}
        />
      </div>

      <div className="text-xs text-on-surface-faint">
        <PlacementList report={report} onOpenDashboard={onOpenDashboard} />
      </div>
    </section>
  );
}

function PlacementList({
  report,
  onOpenDashboard,
}: {
  report: CostReport;
  onOpenDashboard?: ((dashboardId: string) => void) | undefined;
}) {
  if (report.placements.length === 1 && onOpenDashboard) {
    const only = report.placements[0]!;
    return (
      <button
        type="button"
        onClick={() => onOpenDashboard(only.dashboardId)}
        className="truncate hover:text-on-surface-secondary underline"
        title={`Open ${only.dashboardName}`}
      >
        On {only.dashboardName}
      </button>
    );
  }
  return <span className="truncate">{placementSummary(report)}</span>;
}

/**
 * Add or remove this report's dashboard cards — the same modal the Costs panel
 * gives a budget, for the same reason: the object is the thing, and a card is a
 * view onto it that can come and go without touching it.
 */
function PlacementModal({
  report,
  client,
  onClose,
  onChanged,
}: {
  report: CostReport;
  client: CostReportsClient;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [dashboards, setDashboards] = useState<CostsPanelDashboard[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    client
      .listDashboards?.()
      .then((rows) => setDashboards(rows ?? []))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [client]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await onChanged();
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose} ariaLabel={`Dashboards showing ${report.name}`}>
      <div className="bg-surface-raised border border-border-strong rounded-xl shadow-2xl w-[420px] p-6">
        <h2 className="text-base font-semibold text-on-surface mb-1">Show on a dashboard</h2>
        <p className="text-xs text-on-surface-faint mb-4">
          A card is a view onto this report. Removing one leaves the report intact; editing the
          report changes every card at once.
        </p>

        {error !== null && (
          <div role="alert" className="mb-3 text-sm text-red-500">
            {error}
          </div>
        )}
        {dashboards === null && error === null && (
          <p role="status" className="text-sm text-on-surface-faint">
            Loading dashboards…
          </p>
        )}

        <ul className="flex flex-col gap-1">
          {(dashboards ?? []).map((d) => {
            const placement = report.placements.find((p) => p.dashboardId === d.id);
            return (
              <li key={d.id} className="flex items-center justify-between gap-3 py-1">
                <span className="truncate text-sm text-on-surface">{d.name}</span>
                {placement ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void run(() => client.removeReportPlacement!(placement.widgetId))
                    }
                    className="text-xs text-on-surface-faint hover:text-red-500 underline disabled:opacity-50"
                  >
                    Remove
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void run(() => client.addReportToDashboard!(d.id, report.id, report.name))
                    }
                    className="text-xs text-on-surface-secondary hover:text-on-surface underline disabled:opacity-50"
                  >
                    Add
                  </button>
                )}
              </li>
            );
          })}
        </ul>

        <div className="mt-5 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-border px-3 py-1.5 text-sm text-on-surface hover:border-border-strong"
          >
            Done
          </button>
        </div>
      </div>
    </Modal>
  );
}
