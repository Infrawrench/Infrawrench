import { useCallback, useEffect, useMemo, useState } from "react";
import { T, useGT } from "gt-react";
import {
  costReportFolderPaths,
  networkFlowReportCsvFileName,
  networkFlowReportPairsToCsv,
  networkFlowReportToCsv,
  DEFAULT_NETWORK_FLOW_REPORT_CONFIG,
  type CostReportFolder,
  type NetworkFlowReport,
  type NetworkFlowReportInput,
  type NetworkFlowReportOptions,
  type NetworkFlowReportRunResult,
} from "@infrawrench/client-core";

import { ConfirmDeleteModal } from "../components/ConfirmDeleteModal.js";
import { downloadBlob } from "../delivery/download.js";
import { ShareDialog } from "../sharing/ShareDialog.js";
import { NetworkFlowReportEditor } from "./NetworkFlowReportEditor.js";
import { NetworkFlowReportView } from "./NetworkFlowReportView.js";
import { useNetworkFlowReportLabels } from "./labels.js";
import type { NetworkFlowReportsClient } from "./types.js";

const buttonClass =
  "rounded-lg border border-border bg-surface-raised px-3 py-1.5 text-sm text-on-surface hover:border-border-strong";
const linkClass = "hover:text-on-surface-secondary underline";

export interface NetworkFlowReportsSectionProps {
  client: NetworkFlowReportsClient;
}

/**
 * Saved network flow reports, on the Costs page's Network tab: a list filed by
 * report folder, and one open report at a time with its chart, tables, CSV
 * export, sharing, edit and delete.
 *
 * Renders nothing for an org with no flow-capable account and no saved
 * reports, so the tab's other sections still read correctly.
 */
export function NetworkFlowReportsSection({ client }: NetworkFlowReportsSectionProps) {
  const gt = useGT();
  const labels = useNetworkFlowReportLabels();
  const [reports, setReports] = useState<NetworkFlowReport[] | null>(null);
  const [folders, setFolders] = useState<CostReportFolder[]>([]);
  const [options, setOptions] = useState<NetworkFlowReportOptions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [run, setRun] = useState<NetworkFlowReportRunResult | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [editing, setEditing] = useState<{ report: NetworkFlowReport | null } | null>(null);
  const [sharing, setSharing] = useState<NetworkFlowReport | null>(null);
  const [deleting, setDeleting] = useState<NetworkFlowReport | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [list, folderList, opts] = await Promise.all([
        client.listReports(),
        client.listFolders().catch(() => [] as CostReportFolder[]),
        client.getOptions(),
      ]);
      setReports(list);
      setFolders(folderList);
      setOptions(opts);
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const open = reports?.find((r) => r.id === openId) ?? null;

  useEffect(() => {
    if (!openId) {
      setRun(null);
      return;
    }
    let cancelled = false;
    setRunning(true);
    setRunError(null);
    void (async () => {
      try {
        const result = await client.runReport(openId);
        if (!cancelled) setRun(result);
      } catch (e: unknown) {
        if (!cancelled) setRunError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setRunning(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // `open?.updatedAt` re-runs the report after an edit saves.
  }, [client, openId, open?.updatedAt]);

  const paths = useMemo(() => costReportFolderPaths(folders), [folders]);
  const groups = useMemo(() => {
    const byFolder = new Map<string, NetworkFlowReport[]>();
    for (const r of reports ?? []) {
      // A folder that no longer exists reads as top level, never as hidden.
      const key = r.folderId && paths.has(r.folderId) ? r.folderId : "";
      const list = byFolder.get(key) ?? [];
      list.push(r);
      byFolder.set(key, list);
    }
    return [...byFolder.entries()]
      .map(([folderId, list]) => ({ folderId, path: folderId ? paths.get(folderId)! : "", list }))
      .sort((a, b) =>
        a.folderId === "" ? -1 : b.folderId === "" ? 1 : a.path.localeCompare(b.path),
      );
  }, [reports, paths]);

  if (!error && reports !== null && reports.length === 0 && (options?.accounts.length ?? 0) === 0) {
    return null;
  }

  const canCreate = Boolean(client.createReport);
  const canEdit = Boolean(client.updateReport);
  const canDelete = Boolean(client.deleteReport);

  async function saveReport(input: NetworkFlowReportInput) {
    const existing = editing?.report;
    const saved = existing
      ? await client.updateReport!(existing.id, input)
      : await client.createReport!(input);
    setEditing(null);
    await refresh();
    setOpenId(saved.id);
  }

  function exportCsv(kind: "series" | "pairs") {
    if (!run || !open) return;
    const csv = kind === "pairs" ? networkFlowReportPairsToCsv(run) : networkFlowReportToCsv(run);
    downloadBlob(
      new Blob([csv], { type: "text/csv;charset=utf-8" }),
      networkFlowReportCsvFileName(open.name, run.from, run.to, kind),
    );
  }

  return (
    <section className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-on-surface-secondary">
            {gt("Network flow reports")}
          </h2>
          <T>
            <p className="text-xs text-on-surface-muted mt-1">
              Bytes and estimated cost by flow pair over time, saved and shared like cost reports.
            </p>
          </T>
        </div>
        {canCreate && (
          <button
            type="button"
            className={buttonClass}
            onClick={() => setEditing({ report: null })}
          >
            {gt("New report")}
          </button>
        )}
      </div>

      {error && (
        <div role="alert" className="text-sm text-danger">
          {gt("Couldn't load network flow reports: {error}", { error })}{" "}
          <button type="button" onClick={() => void refresh()} className="underline">
            {gt("Retry")}
          </button>
        </div>
      )}

      {reports === null && !error && (
        <p role="status" className="text-sm text-on-surface-faint">
          {gt("Loading network flow reports…")}
        </p>
      )}

      {reports?.length === 0 && (
        <p className="text-sm text-on-surface-faint">
          {gt(
            "No network flow reports yet. A report tracks bytes and estimated cost for the traffic you choose, by pair, class, zone or VPC.",
          )}
        </p>
      )}

      {open ? (
        <div className="border border-border rounded-xl p-4 space-y-4">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="min-w-0">
              <button
                type="button"
                className="text-xs text-on-surface-faint hover:text-on-surface-secondary"
                onClick={() => setOpenId(null)}
              >
                {gt("← All network flow reports")}
              </button>
              <h3 className="text-base font-semibold text-on-surface mt-1">{open.name}</h3>
              {open.description && (
                <p className="text-xs text-on-surface-muted mt-0.5">{open.description}</p>
              )}
              <p className="text-xs text-on-surface-faint mt-0.5">
                {labels.metric(open.config.metric)} · {labels.granularity(open.config.granularity)}{" "}
                · {labels.groupBy(open.config.groupBy)}
                {run && <> · {gt("{from} to {to}", { from: run.from, to: run.to })}</>}
              </p>
            </div>
            <div className="flex items-center gap-3 text-xs text-on-surface-faint">
              {run && (
                <>
                  <button type="button" className={linkClass} onClick={() => exportCsv("series")}>
                    {gt("Export CSV")}
                  </button>
                  <button type="button" className={linkClass} onClick={() => exportCsv("pairs")}>
                    {gt("Export pairs CSV")}
                  </button>
                </>
              )}
              {client.sharing && (
                <button type="button" className={linkClass} onClick={() => setSharing(open)}>
                  {gt("Share")}
                </button>
              )}
              {canEdit && (
                <button
                  type="button"
                  className={linkClass}
                  onClick={() => setEditing({ report: open })}
                >
                  {gt("Edit")}
                </button>
              )}
              {canDelete && (
                <button
                  type="button"
                  className="hover:text-danger underline"
                  onClick={() => setDeleting(open)}
                >
                  {gt("Delete")}
                </button>
              )}
            </div>
          </div>
          {running && !run && (
            <p role="status" className="text-sm text-on-surface-faint">
              {gt("Running report…")}
            </p>
          )}
          {runError && (
            <p role="alert" className="text-sm text-danger">
              {runError}
            </p>
          )}
          {run && <NetworkFlowReportView key={run.reportId + run.to} result={run} />}
        </div>
      ) : (
        groups.length > 0 && (
          <div className="space-y-3">
            {groups.map((group) => (
              <div key={group.folderId || "top"}>
                {group.folderId && (
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-on-surface-secondary mb-1">
                    {group.path}
                  </h3>
                )}
                <ul className="border border-border rounded-xl divide-y divide-border overflow-hidden">
                  {group.list.map((r) => (
                    <li key={r.id}>
                      <button
                        type="button"
                        onClick={() => setOpenId(r.id)}
                        className="w-full text-left p-3 hover:bg-surface-sunken"
                      >
                        <span className="text-sm font-medium text-on-surface-secondary">
                          {r.name}
                        </span>
                        <span className="block text-xs text-on-surface-muted mt-0.5">
                          {labels.metric(r.config.metric)} ·{" "}
                          {labels.granularity(r.config.granularity)} ·{" "}
                          {labels.groupBy(r.config.groupBy)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )
      )}

      {editing && (
        <NetworkFlowReportEditor
          report={editing.report}
          initialConfig={DEFAULT_NETWORK_FLOW_REPORT_CONFIG}
          options={options}
          folders={folders}
          onSave={saveReport}
          onClose={() => setEditing(null)}
        />
      )}

      {sharing && client.sharing && (
        <ShareDialog
          client={client.sharing}
          target={{ objectType: "network_flow_report", objectId: sharing.id, name: sharing.name }}
          onClose={() => setSharing(null)}
          onSaved={() => void refresh()}
        />
      )}

      {deleting && (
        <ConfirmDeleteModal
          kind={gt("network flow report")}
          name={deleting.name}
          onConfirm={async () => {
            await client.deleteReport!(deleting.id);
            setDeleting(null);
            setOpenId(null);
            await refresh();
          }}
          onClose={() => setDeleting(null)}
        />
      )}
    </section>
  );
}
