import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ShareDialog, type ShareTarget } from "../sharing/ShareDialog.js";
import { useGT } from "gt-react";
import { focusExportFilename, focusExportRequestForConfig } from "@infrawrench/client-core";

import {
  DEFAULT_COST_GRAPH_CONFIG,
  costReportFolderMoveBlocker,
  duplicateCostReportName,
  flattenCostReportFolderTree,
  normalizeCostReportName,
  type CostGraphConfig,
  type CostReport,
  type CostReportFolder,
  type CostReportInput,
} from "../cost/config.js";
import { CostGraphCard } from "../cost/CostGraphCard.js";
import { CostGraphConfigModal } from "../cost/CostGraphConfigModal.js";
import { CostAnnotationsSection } from "./CostAnnotationsSection.js";
import { Modal } from "../components/Modal.js";
import type { CostsPanelDashboard } from "../cost/types.js";
import { ReportDeliverySection } from "./ReportDeliverySection.js";
import type { CostReportsClient } from "./types.js";
import { ArrowIcon } from "../components/icons/ChromeIcons.js";
import {
  costReportBulkMoveTargetBlocker,
  costReportListOrder,
  costReportListRange,
  type CostReportListItem,
} from "@infrawrench/client-core";
import {
  BulkActionBar,
  DropZone,
  folderSectionId,
  BulkDeleteModal,
  CostReportFolderRail,
  itemKey,
  parseItemKey,
  type BulkDragState,
} from "./CostReportBulk.js";

/**
 * Hand generated text to the browser's own download path. Works unchanged in
 * the desktop renderer, where Electron routes the blob download through its
 * save dialog, so neither host needs a file API of its own for this.
 */
function saveTextFile(filename: string, mediaType: string, body: string): void {
  const url = URL.createObjectURL(new Blob([body], { type: mediaType }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoked on the next tick: revoking synchronously can cancel the download
  // before the browser has started reading the blob.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function toInput(report: CostReport): CostReportInput {
  return {
    name: report.name,
    ...(report.description ? { description: report.description } : {}),
    config: report.config,
    folderId: report.folderId,
  };
}

function placementSummary(gt: ReturnType<typeof useGT>, report: CostReport): string {
  const count = report.placements.length;
  if (count === 0) return gt("On no dashboard");
  if (count === 1) return gt("On {name}", { name: report.placements[0]!.dashboardName });
  return gt("On {count} dashboards", { count });
}

/** What a move modal offers: the top level, then every folder as a tree row. */
interface MoveTarget {
  folderId: string | null;
  label: string;
  depth: number;
  /** Why this target can't be picked (shown as the tooltip), or undefined. */
  blocked?: string | undefined;
}

/** Who the move modal is moving: one item, or the whole selection. */
type Moving =
  | { kind: "report"; report: CostReport }
  | { kind: "folder"; folder: CostReportFolder }
  | { kind: "selection" };

export interface CostReportsPanelProps {
  client: CostReportsClient;
  /**
   * Which report to show. Absent renders the list. Owned by the host so the
   * URL, the workspace tab, and this panel never disagree about which report
   * is open: the panel asks to change it and re-renders on the way back.
   */
  reportId?: string | undefined;
  /** Open a report (or, with undefined, go back to the list). */
  onSelectReport?: ((reportId: string | undefined) => void) | undefined;
  /** Open a dashboard by id: the placement list links to them. */
  onOpenDashboard?: ((dashboardId: string) => void) | undefined;
}

/**
 * Cost reports: the org's named, saved cost graphs.
 *
 * A report is to a cost graph what a budget is to a budget card: the object is
 * the thing, and a dashboard card is a view onto it. That is why this panel
 * exists at all: before it, a cost graph was a dashboard card and nothing
 * else, so there was no report to fold into a folder, annotate, schedule, or
 * link a colleague to.
 *
 * The list groups reports into folders: pure organization, rendered as an
 * indented tree inside the existing card list. Filing a report changes nothing
 * but where it appears here; deleting a folder drops its contents back to the
 * top level, never deletes a report, and the confirm says so.
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
  const gt = useGT();
  const [reports, setReports] = useState<CostReport[] | null>(null);
  const [folders, setFolders] = useState<CostReportFolder[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ report: CostReport | null } | null>(null);
  const [placing, setPlacing] = useState<CostReport | null>(null);
  const [moving, setMoving] = useState<Moving | null>(null);

  const [sharingTarget, setSharingTarget] = useState<ShareTarget | null>(null);
  const onShare = client.sharing ? setSharingTarget : undefined;
  const canWrite = Boolean(client.createReport && client.updateReport && client.deleteReport);
  const canPlace = Boolean(
    client.listDashboards && client.addReportToDashboard && client.removeReportPlacement,
  );
  const canManageFolders = Boolean(
    client.createFolder && client.updateFolder && client.deleteFolder,
  );
  // Multi-select only exists when there is something to do with a selection.
  const canBulk = canWrite && Boolean(client.bulkUpdate);
  /** Selected items as `itemKey`s, in no particular order. */
  const [selection, setSelection] = useState<ReadonlySet<string>>(() => new Set());
  /** The last item clicked without shift: where a shift-click range starts. */
  const anchorRef = useRef<CostReportListItem | null>(null);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [drag, setDrag] = useState<BulkDragState | null>(null);

  const refresh = useCallback(async () => {
    // A failure has to be visible: an empty list and a broken list look
    // identical, and one of them means reports you saved are not being shown.
    try {
      const [reportRows, folderRows] = await Promise.all([
        client.listReports(),
        client.listFolders(),
      ]);
      setReports(reportRows);
      setFolders(folderRows);
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

  const folderTree = useMemo(() => flattenCostReportFolderTree(folders), [folders]);
  const listOrder = useMemo(() => costReportListOrder(folders, reports ?? []), [folders, reports]);

  // Drop what a refresh took away (deleted elsewhere, or moved out of sight):
  // a selection must never act on an item the list no longer shows.
  useEffect(() => {
    setSelection((prev) => {
      if (prev.size === 0) return prev;
      const present = new Set(listOrder.map(itemKey));
      const next = new Set([...prev].filter((k) => present.has(k)));
      return next.size === prev.size ? prev : next;
    });
  }, [listOrder]);

  const selectedItems = useMemo(
    () => [...selection].map(parseItemKey).filter((i): i is CostReportListItem => i !== null),
    [selection],
  );

  function toggleItem(item: CostReportListItem, range: boolean) {
    const anchor = anchorRef.current;
    setSelection((prev) => {
      const next = new Set(prev);
      if (range && anchor) {
        // A range takes the anchor's state: shift-clicking after selecting
        // selects the run, after deselecting clears it, the way file lists do.
        const on = prev.has(itemKey(anchor));
        for (const i of costReportListRange(listOrder, anchor, item)) {
          if (on) next.add(itemKey(i));
          else next.delete(itemKey(i));
        }
        return next;
      }
      const key = itemKey(item);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    if (!range || !anchor) anchorRef.current = item;
  }

  /** Select (or, when all already are, deselect) every report filed in a folder. */
  function toggleFolderContents(folderId: string) {
    const keys = (reports ?? [])
      .filter((r) => r.folderId === folderId)
      .map((r) => itemKey({ kind: "report", id: r.id }));
    setSelection((prev) => {
      const next = new Set(prev);
      const all = keys.length > 0 && keys.every((k) => prev.has(k));
      for (const k of keys) {
        if (all) next.delete(k);
        else next.add(k);
      }
      return next;
    });
  }

  function selectAll() {
    setSelection(new Set(listOrder.map(itemKey)));
  }

  function clearSelection() {
    setSelection(new Set());
    anchorRef.current = null;
  }

  async function runBulkMove(items: readonly CostReportListItem[], target: string | null) {
    if (!client.bulkUpdate || items.length === 0) return;
    setBulkError(null);
    await client.bulkUpdate({
      action: "move",
      reportIds: items.filter((i) => i.kind === "report").map((i) => i.id),
      folderIds: items.filter((i) => i.kind === "folder").map((i) => i.id),
      targetFolderId: target,
    });
    await refresh();
  }

  /** A drop onto a folder (null is the top level): moves what was dragged. */
  async function dropOnFolder(target: string | null) {
    const dragged = drag;
    setDrag(null);
    if (!dragged) return;
    try {
      await runBulkMove(dragged.items, target);
      // Only a dragged selection is consumed by the drop; dragging one
      // unselected row leaves whatever else was selected alone.
      if (dragged.fromSelection) clearSelection();
    } catch (e: unknown) {
      setBulkError(e instanceof Error ? e.message : String(e));
    }
  }

  /** What a drag starting on `item` carries: the selection if it is part of it. */
  function startDrag(item: CostReportListItem) {
    const inSelection = selection.has(itemKey(item));
    setDrag({ items: inSelection ? selectedItems : [item], fromSelection: inSelection });
  }

  /** Why the current drag cannot land on `target`, or null when it can. */
  function dropBlocker(target: string | null): string | null {
    if (!drag) return null;
    const folderIds = drag.items.filter((i) => i.kind === "folder").map((i) => i.id);
    return costReportBulkMoveTargetBlocker(folders, folderIds, target);
  }

  async function runBulkDelete() {
    if (!client.bulkUpdate) return;
    await client.bulkUpdate({
      action: "delete",
      reportIds: selectedItems.filter((i) => i.kind === "report").map((i) => i.id),
      folderIds: selectedItems.filter((i) => i.kind === "folder").map((i) => i.id),
    });
    if (reportId && selection.has(itemKey({ kind: "report", id: reportId }))) {
      onSelectReport?.(undefined);
    }
    clearSelection();
    setBulkDeleting(false);
    await refresh();
  }

  const folderPathById = useMemo(
    () => new Map(folderTree.map((row) => [row.folder.id, row.path])),
    [folderTree],
  );

  async function saveReport(name: string, config: CostGraphConfig) {
    const clean = normalizeCostReportName(name);
    if (!clean) throw new Error(gt("A report needs a name."));
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
    const raw = window.prompt(gt("Rename report"), report.name);
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
        ? gt("\n\nIts card will also be removed from {names}.", {
            names: report.placements.map((p) => p.dashboardName).join(", "),
          })
        : "";
    if (!window.confirm(gt('Delete the report "{name}"?{where}', { name: report.name, where })))
      return;
    await client.deleteReport?.(report.id);
    if (reportId === report.id) onSelectReport?.(undefined);
    await refresh();
  }

  async function createFolder(parent: CostReportFolder | null) {
    const raw = window.prompt(
      parent ? gt('New folder inside "{name}"', { name: parent.name }) : gt("New folder name"),
      "",
    );
    if (raw === null) return;
    const name = raw.trim();
    if (!name) return;
    await client.createFolder?.({ name, parentFolderId: parent?.id ?? null });
    await refresh();
  }

  async function renameFolder(folder: CostReportFolder) {
    const raw = window.prompt(gt("Rename folder"), folder.name);
    if (raw === null) return;
    const name = raw.trim();
    if (!name) return;
    await client.updateFolder?.(folder.id, { name, parentFolderId: folder.parentFolderId });
    await refresh();
  }

  async function deleteFolder(folder: CostReportFolder) {
    // The confirm has to say what actually happens: nothing inside is deleted;
    // reports and subfolders drop back to the top level of the list.
    const reportCount = (reports ?? []).filter((r) => r.folderId === folder.id).length;
    const subfolderCount = folders.filter((f) => f.parentFolderId === folder.id).length;
    const consequences: string[] = [];
    if (reportCount > 0) {
      consequences.push(
        reportCount === 1
          ? gt("its report moves to the top of the list")
          : gt("its {count} reports move to the top of the list", { count: reportCount }),
      );
    }
    if (subfolderCount > 0) {
      consequences.push(
        subfolderCount === 1
          ? gt("its subfolder becomes a top-level folder")
          : gt("its {count} subfolders become top-level folders", { count: subfolderCount }),
      );
    }
    const joined = consequences.join(gt(", and "));
    const detail = joined
      ? `\n\n${joined[0]!.toUpperCase()}${joined.slice(1)}${gt(". No reports are deleted.")}`
      : "";
    if (!window.confirm(gt('Delete the folder "{name}"?{detail}', { name: folder.name, detail })))
      return;
    await client.deleteFolder?.(folder.id);
    await refresh();
  }

  async function applyMove(target: string | null) {
    if (!moving) return;
    if (moving.kind === "selection") {
      await runBulkMove(selectedItems, target);
      clearSelection();
    } else if (moving.kind === "report") {
      await client.updateReport?.(moving.report.id, {
        ...toInput(moving.report),
        folderId: target,
      });
    } else {
      await client.updateFolder?.(moving.folder.id, {
        name: moving.folder.name,
        parentFolderId: target,
      });
    }
    setMoving(null);
    await refresh();
  }

  const moveTargets = useMemo<MoveTarget[]>(() => {
    if (!moving) return [];
    if (moving.kind === "selection") {
      // The whole selection against the tree it would produce: the server's
      // rule, so no pickable row comes back as a 400.
      const folderIds = selectedItems.filter((i) => i.kind === "folder").map((i) => i.id);
      const parentOf = (i: CostReportListItem) =>
        i.kind === "report"
          ? (reports?.find((r) => r.id === i.id)?.folderId ?? null)
          : (folders.find((f) => f.id === i.id)?.parentFolderId ?? null);
      const blockedFor = (target: string | null) =>
        selectedItems.length > 0 && selectedItems.every((i) => parentOf(i) === target)
          ? gt("Already here")
          : (costReportBulkMoveTargetBlocker(folders, folderIds, target) ?? undefined);
      return [
        { folderId: null, label: gt("Top level (no folder)"), depth: 0, blocked: blockedFor(null) },
        ...folderTree.map(({ folder, depth }) => ({
          folderId: folder.id,
          label: folder.name,
          depth: depth + 1,
          blocked: blockedFor(folder.id),
        })),
      ];
    }
    const subjectFolderId = moving.kind === "folder" ? moving.folder.id : null;
    const currentParent =
      moving.kind === "report" ? moving.report.folderId : moving.folder.parentFolderId;
    const targets: MoveTarget[] = [
      {
        folderId: null,
        label: gt("Top level (no folder)"),
        depth: 0,
        blocked: currentParent === null ? gt("Already here") : undefined,
      },
    ];
    for (const { folder, depth } of folderTree) {
      // A report can go in any folder; a folder move obeys the same rule the
      // server enforces, so nothing pickable here can come back as a 400.
      const blocked =
        moving.kind === "folder"
          ? (costReportFolderMoveBlocker(folders, subjectFolderId, folder.id) ?? undefined)
          : undefined;
      targets.push({
        folderId: folder.id,
        label: folder.name,
        depth: depth + 1,
        blocked: folder.id === currentParent ? gt("Already here") : blocked,
      });
    }
    return targets;
  }, [moving, folderTree, folders, reports, selectedItems, gt]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-6 flex flex-col gap-6">
        {error !== null && (
          <div role="alert" className="text-sm text-danger">
            {gt("Couldn’t load reports — {error}", { error })}{" "}
            <button type="button" onClick={() => void refresh()} className="underline">
              {gt("Retry")}
            </button>
          </div>
        )}

        {selected ? (
          <ReportDetail
            report={selected}
            folderPath={selected.folderId ? (folderPathById.get(selected.folderId) ?? null) : null}
            client={client}
            canWrite={canWrite}
            canPlace={canPlace}
            onBack={() => onSelectReport?.(undefined)}
            onEdit={() => setEditing({ report: selected })}
            onRename={() => void renameReport(selected)}
            onMove={() => setMoving({ kind: "report", report: selected })}
            onDuplicate={() => void duplicateReport(selected)}
            onDelete={() => void deleteReport(selected)}
            onPlace={() => setPlacing(selected)}
            onShare={
              onShare
                ? () =>
                    onShare({
                      objectType: "cost_report",
                      objectId: selected.id,
                      name: selected.name,
                    })
                : undefined
            }
            onOpenDashboard={onOpenDashboard}
          />
        ) : (
          <div className="flex gap-6">
            {canBulk && folders.length > 0 && (
              <CostReportFolderRail
                folderTree={folderTree}
                drag={drag}
                dropBlocker={dropBlocker}
                onDrop={(target) => void dropOnFolder(target)}
              />
            )}
            <div className="min-w-0 flex-1 flex flex-col gap-3">
              {canBulk && (
                <BulkActionBar
                  count={selection.size}
                  total={listOrder.length}
                  error={bulkError}
                  onMove={() => setMoving({ kind: "selection" })}
                  onDelete={() => setBulkDeleting(true)}
                  onSelectAll={selectAll}
                  onClear={clearSelection}
                  onDismissError={() => setBulkError(null)}
                />
              )}
              <ReportList
                reports={reports}
                folders={folders}
                error={error}
                selection={canBulk ? selection : null}
                onToggle={toggleItem}
                onToggleFolderContents={toggleFolderContents}
                drag={drag}
                onDragItem={startDrag}
                onDragEnd={() => setDrag(null)}
                dropBlocker={dropBlocker}
                onDropOnFolder={(target) => void dropOnFolder(target)}
                onKeyCommand={(command) => {
                  if (command === "select-all") selectAll();
                  else if (command === "clear") clearSelection();
                  else if (selection.size === 0) return;
                  else if (command === "move") setMoving({ kind: "selection" });
                  else if (command === "delete") setBulkDeleting(true);
                }}
                canWrite={canWrite}
                canPlace={canPlace}
                canManageFolders={canManageFolders}
                onNew={() => setEditing({ report: null })}
                onNewFolder={(parent) => void createFolder(parent)}
                onOpen={(r) => onSelectReport?.(r.id)}
                onRename={(r) => void renameReport(r)}
                onMove={(r) => setMoving({ kind: "report", report: r })}
                onDuplicate={(r) => void duplicateReport(r)}
                onDelete={(r) => void deleteReport(r)}
                onPlace={setPlacing}
                onRenameFolder={(f) => void renameFolder(f)}
                onMoveFolder={(f) => setMoving({ kind: "folder", folder: f })}
                onDeleteFolder={(f) => void deleteFolder(f)}
                onShare={onShare}
                onOpenDashboard={onOpenDashboard}
              />
            </div>
          </div>
        )}
      </div>

      {bulkDeleting && (
        <BulkDeleteModal
          items={selectedItems}
          reports={reports ?? []}
          folders={folders}
          onConfirm={runBulkDelete}
          onClose={() => setBulkDeleting(false)}
        />
      )}

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

      {sharingTarget && client.sharing && (
        <ShareDialog
          client={client.sharing}
          target={sharingTarget}
          onClose={() => setSharingTarget(null)}
          onSaved={() => void refresh()}
        />
      )}

      {moving && (
        <MoveToFolderModal
          subjectName={
            moving.kind === "report"
              ? moving.report.name
              : moving.kind === "folder"
                ? moving.folder.name
                : gt("{count} selected items", { count: selectedItems.length })
          }
          targets={moveTargets}
          onPick={applyMove}
          onClose={() => setMoving(null)}
        />
      )}
    </div>
  );
}

function ReportList({
  reports,
  folders,
  error,
  canWrite,
  canPlace,
  canManageFolders,
  onNew,
  onNewFolder,
  onOpen,
  onRename,
  onMove,
  onDuplicate,
  onDelete,
  onPlace,
  onRenameFolder,
  onMoveFolder,
  onDeleteFolder,
  onShare,
  onOpenDashboard,
  selection,
  onToggle,
  onToggleFolderContents,
  drag,
  onDragItem,
  onDragEnd,
  dropBlocker,
  onDropOnFolder,
  onKeyCommand,
}: {
  reports: CostReport[] | null;
  folders: CostReportFolder[];
  error: string | null;
  /** Selected `itemKey`s, or null when this host cannot act on a selection. */
  selection: ReadonlySet<string> | null;
  onToggle: (item: CostReportListItem, range: boolean) => void;
  onToggleFolderContents: (folderId: string) => void;
  drag: BulkDragState | null;
  onDragItem: (item: CostReportListItem) => void;
  onDragEnd: () => void;
  dropBlocker: (target: string | null) => string | null;
  onDropOnFolder: (target: string | null) => void;
  onKeyCommand: (command: "select-all" | "clear" | "move" | "delete") => void;
  canWrite: boolean;
  canPlace: boolean;
  canManageFolders: boolean;
  onNew: () => void;
  onNewFolder: (parent: CostReportFolder | null) => void;
  onOpen: (report: CostReport) => void;
  onRename: (report: CostReport) => void;
  onMove: (report: CostReport) => void;
  onDuplicate: (report: CostReport) => void;
  onDelete: (report: CostReport) => void;
  onPlace: (report: CostReport) => void;
  onRenameFolder: (folder: CostReportFolder) => void;
  onMoveFolder: (folder: CostReportFolder) => void;
  onDeleteFolder: (folder: CostReportFolder) => void;
  onShare?: ((target: ShareTarget) => void) | undefined;
  onOpenDashboard?: ((dashboardId: string) => void) | undefined;
}) {
  const gt = useGT();
  const tree = useMemo(() => flattenCostReportFolderTree(folders), [folders]);
  const byFolder = useMemo(() => {
    const known = new Set(folders.map((f) => f.id));
    const map = new Map<string | null, CostReport[]>();
    for (const r of reports ?? []) {
      // A report pointing at a folder this list can't see files at the top
      // level rather than vanishing.
      const key = r.folderId !== null && known.has(r.folderId) ? r.folderId : null;
      const list = map.get(key) ?? [];
      list.push(r);
      map.set(key, list);
    }
    return map;
  }, [reports, folders]);

  const reportProps = {
    canWrite,
    canPlace,
    onOpen,
    onRename,
    onMove,
    onDuplicate,
    onDelete,
    onPlace,
    onShare,
    selection,
    onToggle,
    onDragItem,
    onDragEnd,
  };

  /**
   * The list's keyboard commands, live whenever focus is inside it (a row's
   * checkbox or button) and never while typing in a field.
   */
  function onKeyDown(e: KeyboardEvent<HTMLElement>) {
    if (!selection) return;
    const el = e.target as HTMLElement;
    if (el.closest("input[type=text], input[type=search], textarea, select, [contenteditable]")) {
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    let command: "select-all" | "clear" | "move" | "delete" | null = null;
    if (mod && e.key.toLowerCase() === "a") command = "select-all";
    else if (e.key === "Escape" && selection.size > 0) command = "clear";
    else if (!mod && !e.altKey && e.key.toLowerCase() === "m") command = "move";
    else if (e.key === "Delete" || (e.key === "Backspace" && mod)) command = "delete";
    if (!command) return;
    e.preventDefault();
    onKeyCommand(command);
  }

  return (
    <section className="flex flex-col gap-3" onKeyDown={onKeyDown}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-on-surface">{gt("Cost reports")}</h2>
          <p className="text-xs text-on-surface-faint mt-0.5">
            {gt(
              "A saved cost graph with a name and an address. Put one on as many dashboards as you like — editing the report updates all of them.",
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {canManageFolders && (
            <button
              type="button"
              onClick={() => onNewFolder(null)}
              className="rounded-lg border border-border bg-surface-raised px-3 py-1.5 text-sm text-on-surface hover:border-border-strong"
            >
              {gt("New folder")}
            </button>
          )}
          {canWrite && (
            <button
              type="button"
              onClick={onNew}
              className="rounded-lg border border-border bg-surface-raised px-3 py-1.5 text-sm text-on-surface hover:border-border-strong"
            >
              {gt("New report")}
            </button>
          )}
        </div>
      </div>

      {reports === null && error === null && (
        <p role="status" className="text-sm text-on-surface-faint">
          {gt("Loading reports…")}
        </p>
      )}

      {reports?.length === 0 && folders.length === 0 && (
        <p className="text-sm text-on-surface-faint">
          {gt(
            "No reports yet. A one-off chart can still go straight onto a dashboard — a report is for the ones you want to keep, name, and share.",
          )}
        </p>
      )}

      <ul className="flex flex-col gap-2" id={folderSectionId(null)}>
        {(byFolder.get(null) ?? []).map((report) => (
          <ReportRow
            key={report.id}
            report={report}
            onOpenDashboard={onOpenDashboard}
            {...reportProps}
          />
        ))}
      </ul>

      {tree.map(({ folder, depth }) => {
        const contents = byFolder.get(folder.id) ?? [];
        // The depth rule the server enforces decides whether "New subfolder"
        // is even offered: an offer that 400s is worse than no offer.
        const canNest =
          canManageFolders && costReportFolderMoveBlocker(folders, null, folder.id) === null;
        const folderItem: CostReportListItem = { kind: "folder", id: folder.id };
        const allContentsSelected =
          selection !== null &&
          contents.length > 0 &&
          contents.every((r) => selection.has(itemKey({ kind: "report", id: r.id })));
        return (
          <DropZone
            key={folder.id}
            target={folder.id}
            drag={drag}
            dropBlocker={dropBlocker}
            onDrop={onDropOnFolder}
            className="flex flex-col gap-2"
          >
            <div
              id={folderSectionId(folder.id)}
              className="flex flex-col gap-2"
              style={{ marginLeft: depth * 20 }}
            >
              <div
                className="flex items-center justify-between gap-3 mt-1"
                draggable={selection !== null}
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", folder.name);
                  onDragItem(folderItem);
                }}
                onDragEnd={onDragEnd}
              >
                <h3 className="flex min-w-0 items-center gap-2 truncate text-xs font-semibold uppercase tracking-wide text-on-surface-secondary">
                  {selection !== null && (
                    <SelectBox
                      checked={selection.has(itemKey(folderItem))}
                      label={gt("Select folder {name}", { name: folder.name })}
                      onToggle={(range) => onToggle(folderItem, range)}
                    />
                  )}
                  <span className="truncate">{folder.name}</span>
                  <span className="ml-2 font-normal normal-case tracking-normal text-on-surface-faint">
                    {contents.length === 0
                      ? gt("empty")
                      : gt("{count} report{plural}", {
                          count: contents.length,
                          plural: contents.length === 1 ? "" : "s",
                        })}
                  </span>
                </h3>
                {(canManageFolders || onShare || selection !== null) && (
                  <div className="flex shrink-0 items-center gap-2 text-xs text-on-surface-faint">
                    {selection !== null && contents.length > 0 && (
                      <button
                        type="button"
                        onClick={() => onToggleFolderContents(folder.id)}
                        className="hover:text-on-surface-secondary underline"
                      >
                        {allContentsSelected ? gt("Deselect contents") : gt("Select contents")}
                      </button>
                    )}
                    {onShare && (
                      <button
                        type="button"
                        onClick={() =>
                          onShare({
                            objectType: "cost_report_folder",
                            objectId: folder.id,
                            name: folder.name,
                          })
                        }
                        className="hover:text-on-surface-secondary underline"
                      >
                        {gt("Share")}
                      </button>
                    )}
                    {canManageFolders && canNest && (
                      <button
                        type="button"
                        onClick={() => onNewFolder(folder)}
                        className="hover:text-on-surface-secondary underline"
                      >
                        {gt("New subfolder")}
                      </button>
                    )}
                    {canManageFolders && (
                      <>
                        <button
                          type="button"
                          onClick={() => onRenameFolder(folder)}
                          className="hover:text-on-surface-secondary underline"
                        >
                          {gt("Rename")}
                        </button>
                        <button
                          type="button"
                          onClick={() => onMoveFolder(folder)}
                          className="hover:text-on-surface-secondary underline"
                        >
                          {gt("Move")}
                        </button>
                        <button
                          type="button"
                          onClick={() => onDeleteFolder(folder)}
                          className="hover:text-danger underline"
                        >
                          {gt("Delete")}
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
              {contents.length > 0 && (
                <ul className="flex flex-col gap-2">
                  {contents.map((report) => (
                    <ReportRow
                      key={report.id}
                      report={report}
                      onOpenDashboard={onOpenDashboard}
                      {...reportProps}
                    />
                  ))}
                </ul>
              )}
            </div>
          </DropZone>
        );
      })}
    </section>
  );
}

function ReportRow({
  report,
  canWrite,
  canPlace,
  onOpen,
  onRename,
  onMove,
  onDuplicate,
  onDelete,
  onPlace,
  onShare,
  onOpenDashboard,
  selection,
  onToggle,
  onDragItem,
  onDragEnd,
}: {
  report: CostReport;
  canWrite: boolean;
  canPlace: boolean;
  selection: ReadonlySet<string> | null;
  onToggle: (item: CostReportListItem, range: boolean) => void;
  onDragItem: (item: CostReportListItem) => void;
  onDragEnd: () => void;
  onShare?: ((target: ShareTarget) => void) | undefined;
  onOpen: (report: CostReport) => void;
  onRename: (report: CostReport) => void;
  onMove: (report: CostReport) => void;
  onDuplicate: (report: CostReport) => void;
  onDelete: (report: CostReport) => void;
  onPlace: (report: CostReport) => void;
  onOpenDashboard?: ((dashboardId: string) => void) | undefined;
}) {
  const gt = useGT();
  const item: CostReportListItem = { kind: "report", id: report.id };
  const selected = selection?.has(itemKey(item)) ?? false;
  return (
    <li
      className={`rounded-xl border bg-surface-raised px-4 py-3 hover:border-border-strong transition-colors ${
        selected ? "border-accent/60" : "border-border"
      }`}
      draggable={selection !== null}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", report.name);
        onDragItem(item);
      }}
      onDragEnd={onDragEnd}
    >
      <div className="flex items-start justify-between gap-3">
        {selection !== null && (
          <span className="pt-0.5">
            <SelectBox
              checked={selected}
              label={gt("Select {name}", { name: report.name })}
              onToggle={(range) => onToggle(item, range)}
            />
          </span>
        )}
        <button
          type="button"
          onClick={() => onOpen(report)}
          className="min-w-0 flex-1 text-left"
          title={gt("Open {name}", { name: report.name })}
        >
          <span className="block truncate text-sm font-medium text-on-surface">{report.name}</span>
          {report.description && (
            <span className="block truncate text-xs text-on-surface-faint mt-0.5">
              {report.description}
            </span>
          )}
        </button>
        <div className="flex shrink-0 items-center gap-2 text-xs text-on-surface-faint">
          {onShare && (
            <button
              type="button"
              onClick={() =>
                onShare({ objectType: "cost_report", objectId: report.id, name: report.name })
              }
              className="hover:text-on-surface-secondary underline"
            >
              {gt("Share")}
            </button>
          )}
          {canPlace && (
            <button
              type="button"
              onClick={() => onPlace(report)}
              className="hover:text-on-surface-secondary underline"
            >
              {gt("Dashboards")}
            </button>
          )}
          {canWrite && (
            <>
              <button
                type="button"
                onClick={() => onRename(report)}
                className="hover:text-on-surface-secondary underline"
              >
                {gt("Rename")}
              </button>
              <button
                type="button"
                onClick={() => onMove(report)}
                className="hover:text-on-surface-secondary underline"
              >
                {gt("Move")}
              </button>
              <button
                type="button"
                onClick={() => onDuplicate(report)}
                className="hover:text-on-surface-secondary underline"
              >
                {gt("Duplicate")}
              </button>
              <button
                type="button"
                onClick={() => onDelete(report)}
                className="hover:text-danger underline"
              >
                {gt("Delete")}
              </button>
            </>
          )}
        </div>
      </div>
      <div className="mt-1 text-xs text-on-surface-faint">
        <PlacementList report={report} onOpenDashboard={onOpenDashboard} />
      </div>
    </li>
  );
}

function ReportDetail({
  report,
  folderPath,
  client,
  canWrite,
  canPlace,
  onBack,
  onEdit,
  onRename,
  onMove,
  onDuplicate,
  onDelete,
  onPlace,
  onShare,
  onOpenDashboard,
}: {
  report: CostReport;
  folderPath: string | null;
  client: CostReportsClient;
  canWrite: boolean;
  canPlace: boolean;
  onBack: () => void;
  onEdit: () => void;
  onRename: () => void;
  onMove: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onPlace: () => void;
  onShare?: (() => void) | undefined;
  onOpenDashboard?: ((dashboardId: string) => void) | undefined;
}) {
  const gt = useGT();
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);

  async function downloadPdf() {
    if (!client.downloadReportPdf) return;
    setPdfBusy(true);
    setPdfError(null);
    try {
      await client.downloadReportPdf(report.id, report.name);
    } catch (e: unknown) {
      setPdfError(e instanceof Error ? e.message : String(e));
    } finally {
      setPdfBusy(false);
    }
  }

  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  // The report's own range, resolved now (a "last 30 days" report downloads
  // the last 30 days as of today), its filters and its saved filter.
  async function downloadFocus() {
    if (!client.downloadFocusExport) return;
    setExporting(true);
    setExportError(null);
    try {
      const request = focusExportRequestForConfig(report.config);
      const csv = await client.downloadFocusExport(request);
      saveTextFile(focusExportFilename(request, report.name), "text/csv;charset=utf-8", csv);
    } catch (e) {
      setExportError(e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(false);
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <button
            type="button"
            onClick={onBack}
            className="text-xs text-on-surface-faint hover:text-on-surface-secondary underline"
          >
            <span className="inline-flex items-center gap-1">
              <ArrowIcon direction="left" size={12} />
              {gt("All reports")}
            </span>
          </button>
          {folderPath && (
            <span className="ml-2 text-xs text-on-surface-faint" title={gt("Folder")}>
              {folderPath}
            </span>
          )}
          <h2 className="mt-1 truncate text-sm font-semibold text-on-surface">{report.name}</h2>
          {report.description && (
            <p className="truncate text-xs text-on-surface-faint mt-0.5">{report.description}</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2 text-xs text-on-surface-faint">
          {client.downloadReportPdf && (
            <button
              type="button"
              disabled={pdfBusy}
              aria-busy={pdfBusy}
              onClick={() => void downloadPdf()}
              className="hover:text-on-surface-secondary underline disabled:opacity-50"
            >
              {pdfBusy ? gt("Preparing PDF…") : gt("Download PDF")}
            </button>
          )}
          {client.downloadFocusExport && (
            <button
              type="button"
              onClick={() => void downloadFocus()}
              disabled={exporting}
              title={gt(
                "Download this report's rows as a FOCUS 1.3 CSV: billed and effective cost, charge and service categories, and tags, one row per resource per day",
              )}
              className="hover:text-on-surface-secondary underline disabled:opacity-50"
            >
              {exporting ? gt("Preparing FOCUS CSV…") : gt("Download FOCUS CSV")}
            </button>
          )}
          {onShare && (
            <button
              type="button"
              onClick={onShare}
              className="hover:text-on-surface-secondary underline"
            >
              {gt("Share")}
            </button>
          )}
          {canPlace && (
            <button
              type="button"
              onClick={onPlace}
              className="hover:text-on-surface-secondary underline"
            >
              {gt("Dashboards")}
            </button>
          )}
          {canWrite && (
            <>
              <button
                type="button"
                onClick={onRename}
                className="hover:text-on-surface-secondary underline"
              >
                {gt("Rename")}
              </button>
              <button
                type="button"
                onClick={onMove}
                className="hover:text-on-surface-secondary underline"
              >
                {gt("Move")}
              </button>
              <button
                type="button"
                onClick={onDuplicate}
                className="hover:text-on-surface-secondary underline"
              >
                {gt("Duplicate")}
              </button>
              <button type="button" onClick={onDelete} className="hover:text-danger underline">
                {gt("Delete")}
              </button>
            </>
          )}
        </div>
      </div>

      {pdfError !== null && (
        <div role="alert" className="text-sm text-danger">
          {gt("Couldn't export the report as a PDF: {error}", { error: pdfError })}
        </div>
      )}
      {exportError !== null && (
        <p className="text-xs text-danger" role="alert">
          {gt("Couldn’t download the FOCUS CSV — {error}", { error: exportError })}
        </p>
      )}

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
          // The chart draws this report's own notes as well as the org-wide
          // ones, and a note written from it defaults to this report's scope.
          annotationReportId={report.id}
          annotationReportName={report.name}
        />
      </div>

      <div className="text-xs text-on-surface-faint">
        <PlacementList report={report} onOpenDashboard={onOpenDashboard} />
      </div>

      {/* The same notes as a list, where you go to fix a date you can no
          longer see, or move a note between this report and org-wide. */}
      <CostAnnotationsSection reportId={report.id} reportName={report.name} client={client} />

      {/* Scheduled sends to Slack/Teams/email; renders nothing when the host
          provides no notifications client (e.g. a surface without them). */}
      <ReportDeliverySection reportId={report.id} client={client} />
    </section>
  );
}

/**
 * A row's selection checkbox. Shift held while toggling extends the range from
 * the last plain toggle, for keyboard (Shift+Space) and pointer alike: the
 * change event's native event carries the modifier either way.
 */
function SelectBox({
  checked,
  label,
  onToggle,
}: {
  checked: boolean;
  label: string;
  onToggle: (range: boolean) => void;
}) {
  return (
    <input
      type="checkbox"
      checked={checked}
      aria-label={label}
      onChange={(e) => {
        const native = e.nativeEvent as Event & { shiftKey?: boolean };
        onToggle(native.shiftKey === true);
      }}
      className="size-3.5 shrink-0 cursor-pointer accent-current"
    />
  );
}

function PlacementList({
  report,
  onOpenDashboard,
}: {
  report: CostReport;
  onOpenDashboard?: ((dashboardId: string) => void) | undefined;
}) {
  const gt = useGT();
  if (report.placements.length === 1 && onOpenDashboard) {
    const only = report.placements[0]!;
    return (
      <button
        type="button"
        onClick={() => onOpenDashboard(only.dashboardId)}
        className="truncate hover:text-on-surface-secondary underline"
        title={gt("Open {name}", { name: only.dashboardName })}
      >
        {gt("On {name}", { name: only.dashboardName })}
      </button>
    );
  }
  return <span className="truncate">{placementSummary(gt, report)}</span>;
}

/**
 * Pick a folder for a report or a folder: the "drag" of this list, as a menu.
 *
 * Targets a move can never succeed at (the current location, a folder inside
 * the thing being moved, a parent past the depth limit) are shown disabled
 * with the reason, using the exact rule the server enforces, so nothing
 * pickable here comes back as a 400.
 */
function MoveToFolderModal({
  subjectName,
  targets,
  onPick,
  onClose,
}: {
  subjectName: string;
  targets: MoveTarget[];
  onPick: (folderId: string | null) => Promise<void>;
  onClose: () => void;
}) {
  const gt = useGT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pick(folderId: string | null) {
    setBusy(true);
    setError(null);
    try {
      await onPick(folderId);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose} ariaLabel={gt("Move {name}", { name: subjectName })}>
      <div className="bg-surface-raised border border-border-strong rounded-xl shadow-2xl w-[420px] p-6">
        <h2 className="text-base font-semibold text-on-surface mb-1">
          {gt("Move “{name}”", { name: subjectName })}
        </h2>
        <p className="text-xs text-on-surface-faint mb-4">
          {gt("Folders only organize this list — moving changes nothing about the report itself.")}
        </p>

        {error !== null && (
          <div role="alert" className="mb-3 text-sm text-danger">
            {error}
          </div>
        )}

        <ul className="flex flex-col gap-1 max-h-72 overflow-y-auto">
          {targets.map((target) => (
            <li key={target.folderId ?? "__root__"}>
              <button
                type="button"
                disabled={busy || target.blocked !== undefined}
                onClick={() => void pick(target.folderId)}
                title={target.blocked}
                className="w-full truncate rounded-lg px-2 py-1.5 text-left text-sm text-on-surface hover:bg-surface disabled:opacity-40"
                style={target.depth > 0 ? { paddingLeft: 8 + target.depth * 16 } : undefined}
              >
                {target.label}
              </button>
            </li>
          ))}
        </ul>

        <div className="mt-5 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-border px-3 py-1.5 text-sm text-on-surface hover:border-border-strong"
          >
            {gt("Cancel")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * Add or remove this report's dashboard cards; the same modal the Costs panel
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
  const gt = useGT();
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
    <Modal onClose={onClose} ariaLabel={gt("Dashboards showing {name}", { name: report.name })}>
      <div className="bg-surface-raised border border-border-strong rounded-xl shadow-2xl w-[420px] p-6">
        <h2 className="text-base font-semibold text-on-surface mb-1">
          {gt("Show on a dashboard")}
        </h2>
        <p className="text-xs text-on-surface-faint mb-4">
          {gt(
            "A card is a view onto this report. Removing one leaves the report intact; editing the report changes every card at once.",
          )}
        </p>

        {error !== null && (
          <div role="alert" className="mb-3 text-sm text-danger">
            {error}
          </div>
        )}
        {dashboards === null && error === null && (
          <p role="status" className="text-sm text-on-surface-faint">
            {gt("Loading dashboards…")}
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
                    className="text-xs text-on-surface-faint hover:text-danger underline disabled:opacity-50"
                  >
                    {gt("Remove")}
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
                    {gt("Add")}
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
            {gt("Done")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
