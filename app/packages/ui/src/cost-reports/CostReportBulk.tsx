import { useState, type ReactNode } from "react";
import { T, Var, useGT } from "gt-react";

import type {
  CostReport,
  CostReportFolder,
  CostReportFolderTreeRow,
  CostReportListItem,
} from "@infrawrench/client-core";
import { Modal } from "../components/Modal.js";

/**
 * Multi-select for the Reports list: the pieces that are not the list itself.
 *
 * Everything a selection can do goes through one request, the all-or-nothing
 * `POST /cost-reports/bulk`, so the list never ends up half-moved. The client
 * still greys out (or refuses to drop onto) the targets the server would
 * reject, using the same rule (`costReportBulkMoveTargetBlocker`), so the 400
 * is a backstop for a stale tree rather than the normal way to learn a move is
 * not allowed.
 */

/** A selection key: `report:<id>` or `folder:<id>`; one Set holds both kinds. */
export function itemKey(item: CostReportListItem): string {
  return `${item.kind}:${item.id}`;
}

export function parseItemKey(key: string): CostReportListItem | null {
  const at = key.indexOf(":");
  const kind = key.slice(0, at);
  if (kind !== "report" && kind !== "folder") return null;
  return { kind, id: key.slice(at + 1) };
}

/** What is being dragged, and whether it is the selection or one stray row. */
export interface BulkDragState {
  items: CostReportListItem[];
  fromSelection: boolean;
}

/**
 * A folder (or the top level) that accepts a drop.
 *
 * The drag payload lives in panel state rather than being read back off
 * `dataTransfer`, because `dragover` cannot read the data (browsers only expose
 * the types until the drop), and deciding whether a folder lights up as a
 * valid target is exactly what has to happen during `dragover`. A refused
 * target never calls `preventDefault`, so the browser shows the no-drop cursor
 * and the tooltip says why.
 */
export function DropZone({
  target,
  drag,
  dropBlocker,
  onDrop,
  className,
  children,
}: {
  target: string | null;
  drag: BulkDragState | null;
  dropBlocker: (target: string | null) => string | null;
  onDrop: (target: string | null) => void;
  className?: string;
  children: ReactNode;
}) {
  const [over, setOver] = useState(false);
  const blocked = drag ? dropBlocker(target) : null;
  const state = !drag || !over ? "" : blocked ? "ring-1 ring-danger/60" : "ring-2 ring-accent";
  return (
    <div
      className={`${className ?? ""} rounded-lg ${state}`}
      title={over && blocked ? blocked : undefined}
      onDragOver={(e) => {
        if (!drag) return;
        if (!over) setOver(true);
        if (blocked) {
          e.dataTransfer.dropEffect = "none";
          return;
        }
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
      }}
      onDragLeave={(e) => {
        // Leaving for a child of this zone is not leaving the zone.
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setOver(false);
      }}
      onDrop={(e) => {
        setOver(false);
        if (!drag || blocked) return;
        e.preventDefault();
        onDrop(target);
      }}
    >
      {children}
    </div>
  );
}

/**
 * The folder sidebar beside the list: every folder as a drop target, plus the
 * top level, and a click jumps the list to that folder's section.
 *
 * Only rendered when the host can bulk-move, because dropping onto it is its
 * reason to exist: the list itself already shows the tree.
 */
export function CostReportFolderRail({
  folderTree,
  drag,
  dropBlocker,
  onDrop,
}: {
  folderTree: CostReportFolderTreeRow[];
  drag: BulkDragState | null;
  dropBlocker: (target: string | null) => string | null;
  onDrop: (target: string | null) => void;
}) {
  const gt = useGT();
  const jump = (folderId: string | null) => {
    const el = document.getElementById(folderSectionId(folderId));
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  return (
    <nav aria-label={gt("Report folders")} className="hidden w-48 shrink-0 md:block">
      <div className="sticky top-0 flex flex-col gap-0.5 pt-1">
        <h3 className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-on-surface-faint">
          {gt("Folders")}
        </h3>
        <DropZone target={null} drag={drag} dropBlocker={dropBlocker} onDrop={onDrop}>
          <button
            type="button"
            onClick={() => jump(null)}
            className="w-full truncate rounded-lg px-2 py-1 text-left text-xs text-on-surface-secondary hover:bg-surface-sunken"
          >
            {gt("Top level")}
          </button>
        </DropZone>
        {folderTree.map(({ folder, depth }) => (
          <DropZone
            key={folder.id}
            target={folder.id}
            drag={drag}
            dropBlocker={dropBlocker}
            onDrop={onDrop}
          >
            <button
              type="button"
              onClick={() => jump(folder.id)}
              className="w-full truncate rounded-lg py-1 pr-2 text-left text-xs text-on-surface-secondary hover:bg-surface-sunken"
              style={{ paddingLeft: 8 + depth * 12 }}
              title={folder.name}
            >
              {folder.name}
            </button>
          </DropZone>
        ))}
        <p className="px-2 pt-2 text-[11px] text-on-surface-faint">
          {gt("Drag reports or folders here to file them.")}
        </p>
      </div>
    </nav>
  );
}

/** The DOM id of a folder's section in the list; null is the top level. */
export function folderSectionId(folderId: string | null): string {
  return folderId ? `cost-report-folder-${folderId}` : "cost-report-folder-top";
}

/**
 * The bar above the list: selection count and what to do with it. Always
 * present (with the shortcut hint) so the keyboard commands are discoverable
 * before anything is selected.
 */
export function BulkActionBar({
  count,
  total,
  error,
  onMove,
  onDelete,
  onSelectAll,
  onClear,
  onDismissError,
}: {
  count: number;
  total: number;
  error: string | null;
  onMove: () => void;
  onDelete: () => void;
  onSelectAll: () => void;
  onClear: () => void;
  onDismissError: () => void;
}) {
  const gt = useGT();
  if (total === 0 && error === null) return null;
  return (
    <div className="flex flex-col gap-2">
      {error !== null && (
        <div role="alert" className="flex items-start justify-between gap-3 text-sm text-danger">
          <span>{error}</span>
          <button type="button" onClick={onDismissError} className="shrink-0 text-xs underline">
            {gt("Dismiss")}
          </button>
        </div>
      )}
      <div
        className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg px-3 py-1.5 text-xs ${
          count > 0
            ? "border border-accent/40 bg-accent/5 text-on-surface"
            : "text-on-surface-faint"
        }`}
        role="toolbar"
        aria-label={gt("Selection")}
      >
        {count > 0 ? (
          <>
            <span className="font-medium" aria-live="polite">
              {gt("{count} selected", { count })}
            </span>
            <button type="button" onClick={onMove} className="underline hover:text-on-surface">
              {gt("Move to folder…")}
            </button>
            <button type="button" onClick={onDelete} className="underline hover:text-danger">
              {gt("Delete…")}
            </button>
            {count < total && (
              <button type="button" onClick={onSelectAll} className="underline">
                {gt("Select all")}
              </button>
            )}
            <button type="button" onClick={onClear} className="underline">
              {gt("Clear")}
            </button>
          </>
        ) : (
          <span>
            {gt(
              "Tick reports or folders to move or delete several at once. Shift-click selects a range; Ctrl+A selects all, M moves, Delete deletes, Esc clears.",
            )}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Confirm a bulk delete, saying exactly what happens to everything touched:
 * reports go (with their dashboard cards and paused schedules), folders go,
 * and whatever a deleted folder still holds falls back to the top level.
 */
export function BulkDeleteModal({
  items,
  reports,
  folders,
  onConfirm,
  onClose,
}: {
  items: CostReportListItem[];
  reports: CostReport[];
  folders: CostReportFolder[];
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const gt = useGT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reportIds = new Set(items.filter((i) => i.kind === "report").map((i) => i.id));
  const folderIds = new Set(items.filter((i) => i.kind === "folder").map((i) => i.id));
  const doomedReports = reports.filter((r) => reportIds.has(r.id));
  const cards = doomedReports.reduce((n, r) => n + r.placements.length, 0);
  // What a deleted folder still holds once this delete lands: its reports
  // that aren't being deleted too, and its subfolders that aren't either.
  const rescuedReports = reports.filter(
    (r) => r.folderId !== null && folderIds.has(r.folderId) && !reportIds.has(r.id),
  ).length;
  const rescuedFolders = folders.filter(
    (f) => f.parentFolderId !== null && folderIds.has(f.parentFolderId) && !folderIds.has(f.id),
  ).length;
  const names = [
    ...doomedReports.map((r) => r.name),
    ...folders.filter((f) => folderIds.has(f.id)).map((f) => f.name),
  ];

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <Modal onClose={() => !busy && onClose()} ariaLabel={gt("Delete selected items")}>
      <div className="bg-surface-raised border border-border-strong rounded-xl shadow-2xl w-[460px] p-6">
        <h2 className="text-base font-semibold text-on-surface mb-1">
          {gt("Delete {reports} reports and {folders} folders?", {
            reports: reportIds.size,
            folders: folderIds.size,
          })}
        </h2>
        <ul className="mb-3 max-h-32 overflow-y-auto text-xs text-on-surface-secondary list-disc pl-5">
          {names.map((name, i) => (
            <li key={`${name}-${i}`} className="truncate">
              {name}
            </li>
          ))}
        </ul>
        <ul className="mb-4 flex flex-col gap-1 text-xs text-on-surface-faint">
          {cards > 0 && (
            <li>
              <T>
                <Var>{cards}</Var> dashboard cards showing these reports are removed too, and their
                delivery schedules stop.
              </T>
            </li>
          )}
          {rescuedReports + rescuedFolders > 0 && (
            <li>
              <T>
                <Var>{rescuedReports}</Var> other reports and <Var>{rescuedFolders}</Var> subfolders
                inside the deleted folders move to the top level; they are not deleted.
              </T>
            </li>
          )}
          <li>{gt("Everything is deleted together, or nothing is.")}</li>
        </ul>

        {error !== null && (
          <div role="alert" className="mb-3 text-sm text-danger">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-lg border border-border px-3 py-1.5 text-sm text-on-surface hover:border-border-strong disabled:opacity-50"
          >
            {gt("Cancel")}
          </button>
          <button
            type="button"
            onClick={() => void confirm()}
            disabled={busy}
            aria-busy={busy}
            className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-50"
          >
            {busy ? gt("Deleting…") : gt("Delete")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
