import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "../lib/invoke";
import { formatSize, formatDate, type TransferEntry, type SftpConfig } from "@infrawrench/ui";
import type { StorageObject } from "@infrawrench/plugin-base";
import { formatErrorMessage } from "../lib/errors";

type SftpEntry = StorageObject;



function normalizePath(p: string): string {
  // Collapse double slashes, ensure leading slash, strip trailing slash (except root)
  const parts = p.replace(/\/+/g, "/").split("/").filter(Boolean);
  return "/" + parts.join("/");
}

function parentPath(p: string): string {
  const parts = p.replace(/\/+/g, "/").split("/").filter(Boolean);
  if (parts.length <= 1) return "/";
  return "/" + parts.slice(0, -1).join("/");
}

interface SftpBrowserPanelProps {
  sftpConfig: SftpConfig;
  initialPath?: string;
}

export function SftpBrowserPanel({ sftpConfig, initialPath = "/" }: SftpBrowserPanelProps) {
  const [currentPath, setCurrentPath] = useState(normalizePath(initialPath));
  const [pathInput, setPathInput] = useState(normalizePath(initialPath));
  const [pathEditing, setPathEditing] = useState(false);
  const [entries, setEntries] = useState<SftpEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [transfers, setTransfers] = useState<TransferEntry[]>([]);
  const [newFolderActive, setNewFolderActive] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [newFolderError, setNewFolderError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmDeleteKey, setConfirmDeleteKey] = useState<string | null>(null);
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [bulkWorking, setBulkWorking] = useState(false);
  const [refreshCount, setRefreshCount] = useState(0);
  const lastClickedIdxRef = useRef<number>(-1);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const newFolderInputRef = useRef<HTMLInputElement>(null);
  const pathInputRef = useRef<HTMLInputElement>(null);

  function reload() {
    setRefreshCount((n) => n + 1);
    setSearch("");
    setSelected(new Set());
    setConfirmBulkDelete(false);
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSelected(new Set());
    invoke<SftpEntry[]>("sftp_list", { config: sftpConfig, path: currentPath })
      .then((items) => { if (!cancelled) setEntries(items); })
      .catch((e) => { if (!cancelled) setError(formatErrorMessage(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [currentPath, refreshCount]);

  // Keep path input in sync when not editing
  useEffect(() => {
    if (!pathEditing) setPathInput(currentPath);
  }, [currentPath, pathEditing]);

  useEffect(() => {
    if (newFolderActive) newFolderInputRef.current?.focus();
  }, [newFolderActive]);

  function navigateTo(p: string) {
    const normalized = normalizePath(p);
    setCurrentPath(normalized);
    setPathInput(normalized);
    setSearch("");
    setSelected(new Set());
    setPathEditing(false);
  }

  function commitPathInput() {
    const trimmed = pathInput.trim();
    if (trimmed) navigateTo(trimmed);
    else setPathInput(currentPath);
    setPathEditing(false);
  }

  const q = search.toLowerCase();
  const filtered = q ? entries.filter((e) => e.name.toLowerCase().includes(q)) : entries;
  const dirs = filtered.filter((e) => e.isDirectory);
  const files = filtered.filter((e) => !e.isDirectory);
  const allFiltered = [...dirs, ...files];

  // ── Selection ──────────────────────────────────────────────────────────────

  function toggleSelect(key: string, idx: number, shiftHeld: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (shiftHeld && lastClickedIdxRef.current >= 0) {
        const lo = Math.min(idx, lastClickedIdxRef.current);
        const hi = Math.max(idx, lastClickedIdxRef.current);
        const adding = !prev.has(key);
        for (let i = lo; i <= hi; i++) {
          const k = allFiltered[i]?.key;
          if (k) adding ? next.add(k) : next.delete(k);
        }
      } else {
        next.has(key) ? next.delete(key) : next.add(key);
      }
      lastClickedIdxRef.current = idx;
      return next;
    });
  }

  const allSelected = allFiltered.length > 0 && allFiltered.every((e) => selected.has(e.key));
  const someSelected = !allSelected && allFiltered.some((e) => selected.has(e.key));

  function toggleAll() {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(allFiltered.map((e) => e.key)));
  }

  // ── Recursive list (for downloading folders) ──────────────────────────────

  const listAllFlat = useCallback(async (p: string): Promise<SftpEntry[]> => {
    const items = await invoke<SftpEntry[]>("sftp_list", { config: sftpConfig, path: p });
    const fileItems = items.filter((e) => !e.isDirectory);
    const dirItems = items.filter((e) => e.isDirectory);
    const nested = await Promise.all(dirItems.map((d) => listAllFlat(d.key)));
    return [...fileItems, ...nested.flat()];
  }, [sftpConfig]);

  // ── Transfers ─────────────────────────────────────────────────────────────

  function addTransfer(name: string): string {
    const id = crypto.randomUUID();
    setTransfers((prev) => [...prev, { id, name, pct: 0, done: false }]);
    return id;
  }
  function updateTransfer(id: string, pct: number) {
    setTransfers((prev) => prev.map((t) => t.id === id ? { ...t, pct } : t));
  }
  function finishTransfer(id: string, error?: string) {
    setTransfers((prev) => prev.map((t) => {
      if (t.id !== id) return t;
      return error
        ? { ...t, pct: 100, done: true, error }
        : { ...t, pct: 100, done: true };
    }));
    setTimeout(() => setTransfers((prev) => prev.filter((t) => t.id !== id)), 2500);
  }

  // ── Upload ─────────────────────────────────────────────────────────────────

  async function handleFiles(fileList: FileList) {
    const arr = Array.from(fileList);
    await Promise.allSettled(arr.map(async (file) => {
      const remotePath = `${currentPath === "/" ? "" : currentPath}/${file.name}`;
      const id = addTransfer(file.name);
      try {
        const buf = await file.arrayBuffer();
        updateTransfer(id, 50);
        await invoke("sftp_upload", { config: sftpConfig, remotePath, data: Buffer.from(buf) });
        finishTransfer(id);
      } catch (e) {
        finishTransfer(id, formatErrorMessage(e));
      }
    }));
    reload();
  }

  // ── Make folder ────────────────────────────────────────────────────────────

  async function handleMakeFolder() {
    const name = newFolderName.trim();
    if (!name) return;
    setNewFolderError(null);
    const folderPath = `${currentPath === "/" ? "" : currentPath}/${name}`;
    try {
      await invoke("sftp_mkdir", { config: sftpConfig, path: folderPath });
      setNewFolderActive(false);
      setNewFolderName("");
      reload();
    } catch (e) {
      setNewFolderError(formatErrorMessage(e));
    }
  }

  // ── Delete ─────────────────────────────────────────────────────────────────

  async function handleDelete(key: string, isDir: boolean) {
    setDeleting(true);
    try {
      await invoke("sftp_delete", { config: sftpConfig, path: key, isDir });
      setConfirmDeleteKey(null);
      reload();
    } catch (e) {
      setConfirmDeleteKey(null);
      setError(formatErrorMessage(e));
    } finally {
      setDeleting(false);
    }
  }

  async function handleBulkDelete() {
    setBulkWorking(true);
    try {
      await Promise.allSettled([...selected].map((key) => {
        const entry = entries.find((e) => e.key === key);
        return invoke("sftp_delete", { config: sftpConfig, path: key, isDir: entry?.isDirectory ?? false });
      }));
      reload();
    } finally {
      setBulkWorking(false);
      setConfirmBulkDelete(false);
    }
  }

  // ── Download ───────────────────────────────────────────────────────────────

  async function handleDownload(keys: string[]) {
    setBulkWorking(true);
    try {
      const result = await invoke<{ canceled?: boolean; filePaths?: string[] }>(
        "show_open_dialog",
        { properties: ["openDirectory"], title: "Choose download destination" },
      );
      if (result.canceled || !result.filePaths?.[0]) return;
      const destFolder = result.filePaths[0];

      // Expand folders to flat file list
      const flatKeys: string[] = [];
      for (const key of keys) {
        const entry = entries.find((e) => e.key === key);
        if (entry?.isDirectory) {
          const flat = await listAllFlat(key);
          flatKeys.push(...flat.map((e) => e.key));
        } else {
          flatKeys.push(key);
        }
      }

      await Promise.allSettled(flatKeys.map(async (remotePath) => {
        const fileName = remotePath.split("/").pop() ?? remotePath;
        const localPath = `${destFolder}/${fileName}`;
        const id = addTransfer(fileName);
        updateTransfer(id, 50);
        try {
          await invoke("sftp_download", { config: sftpConfig, remotePath, localPath });
          finishTransfer(id);
        } catch (e) {
          finishTransfer(id, formatErrorMessage(e));
        }
      }));
    } finally {
      setBulkWorking(false);
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  const activeTransfers = transfers.filter((t) => !t.done);

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-gray-950 overflow-hidden">

      {/* ── Path bar + search + actions ── */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-800/60 flex-shrink-0">
        <span className="text-xs text-gray-500 font-medium flex-shrink-0">Path</span>
        <input
          ref={pathInputRef}
          type="text"
          value={pathInput}
          onChange={(e) => setPathInput(e.target.value)}
          onFocus={() => setPathEditing(true)}
          onBlur={commitPathInput}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.currentTarget.blur(); }
            if (e.key === "Escape") { setPathInput(currentPath); setPathEditing(false); e.currentTarget.blur(); }
          }}
          className="flex-1 min-w-0 bg-gray-900 border border-gray-700 rounded px-2 py-0.5 text-xs font-mono text-gray-200 placeholder-gray-600 focus:outline-none focus:border-gray-500"
          spellCheck={false}
        />

        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter…"
          className="w-36 bg-gray-800 border border-gray-700 rounded px-2 py-0.5 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:border-gray-500"
        />

        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            onClick={() => { setNewFolderActive(true); setNewFolderName(""); setNewFolderError(null); }}
            className="px-2 py-0.5 text-xs text-gray-400 hover:text-gray-200 border border-gray-700 hover:border-gray-500 rounded transition-colors"
          >
            + Folder
          </button>
          <button
            onClick={() => fileInputRef.current?.click()}
            className="px-2 py-0.5 text-xs text-gray-400 hover:text-gray-200 border border-gray-700 hover:border-gray-500 rounded transition-colors"
          >
            ↑ Upload
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => { if (e.target.files?.length) { void handleFiles(e.target.files); e.target.value = ""; } }}
          />
        </div>
      </div>

      {/* ── Selection toolbar ── */}
      {selected.size > 0 && (
        <div className="flex items-center gap-3 px-4 py-1.5 bg-blue-950/40 border-b border-blue-900/40 flex-shrink-0">
          <span className="text-xs text-blue-300 font-medium">{selected.size} selected</span>
          <div className="flex items-center gap-2 ml-auto">
            <button
              onClick={() => void handleDownload([...selected])}
              disabled={bulkWorking}
              className="px-2.5 py-1 text-xs text-gray-300 hover:text-white border border-gray-600 hover:border-gray-400 rounded transition-colors disabled:opacity-40"
            >
              ↓ Download
            </button>
            {confirmBulkDelete ? (
              <span className="flex items-center gap-2">
                <span className="text-xs text-gray-400">Delete {selected.size} item{selected.size !== 1 ? "s" : ""}?</span>
                <button
                  onClick={() => void handleBulkDelete()}
                  disabled={bulkWorking}
                  className="px-2.5 py-1 text-xs bg-red-600 hover:bg-red-500 text-white rounded transition-colors disabled:opacity-40"
                >
                  {bulkWorking ? "Deleting…" : "Confirm"}
                </button>
                <button
                  onClick={() => setConfirmBulkDelete(false)}
                  className="px-2 py-1 text-xs text-gray-500 hover:text-gray-300 transition-colors"
                >
                  Cancel
                </button>
              </span>
            ) : (
              <button
                onClick={() => setConfirmBulkDelete(true)}
                disabled={bulkWorking}
                className="px-2.5 py-1 text-xs text-red-400 hover:text-red-300 border border-red-900/50 hover:border-red-700/50 rounded transition-colors disabled:opacity-40"
              >
                Delete
              </button>
            )}
            <button
              onClick={() => setSelected(new Set())}
              className="text-xs text-gray-600 hover:text-gray-400 transition-colors"
            >
              Clear
            </button>
          </div>
        </div>
      )}

      {/* ── File list ── */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {loading && <div className="px-4 py-3 text-xs text-gray-600">Loading…</div>}
        {error && <div className="px-4 py-3 text-xs text-red-400">{error}</div>}

        {!loading && !error && (
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-gray-950 z-10">
              <tr className="text-gray-600 border-b border-gray-800/50">
                <th className="px-3 py-1.5 w-8">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    ref={(el) => { if (el) el.indeterminate = someSelected; }}
                    onChange={toggleAll}
                    className="w-3 h-3 accent-blue-500 cursor-pointer"
                  />
                </th>
                <th className="text-left px-2 py-1.5 font-medium">Name</th>
                <th className="text-right px-4 py-1.5 font-medium w-24">Size</th>
                <th className="text-right px-4 py-1.5 font-medium w-48">Last modified</th>
              </tr>
            </thead>
            <tbody>
              {/* New folder row */}
              {newFolderActive && (
                <tr className="border-b border-gray-800/30">
                  <td />
                  <td className="px-2 py-1.5" colSpan={3}>
                    <div className="flex items-center gap-2">
                      <span className="text-yellow-600">▶</span>
                      <input
                        ref={newFolderInputRef}
                        value={newFolderName}
                        onChange={(e) => setNewFolderName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void handleMakeFolder();
                          if (e.key === "Escape") { setNewFolderActive(false); setNewFolderName(""); }
                        }}
                        placeholder="Folder name"
                        className="bg-gray-800 border border-gray-600 rounded px-2 py-0.5 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500"
                      />
                      <button
                        onClick={() => void handleMakeFolder()}
                        className="px-2 py-0.5 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors"
                      >
                        Create
                      </button>
                      <button
                        onClick={() => { setNewFolderActive(false); setNewFolderName(""); }}
                        className="text-xs text-gray-600 hover:text-gray-400 transition-colors"
                      >
                        Cancel
                      </button>
                      {newFolderError && <span className="text-xs text-red-400">{newFolderError}</span>}
                    </div>
                  </td>
                </tr>
              )}

              {/* Up row */}
              {currentPath !== "/" && !search && (
                <tr
                  className="hover:bg-gray-800/50 cursor-pointer transition-colors"
                  onClick={() => navigateTo(parentPath(currentPath))}
                >
                  <td />
                  <td className="px-2 py-1.5 text-gray-500 flex items-center gap-2" colSpan={3}>
                    <span className="text-gray-600">↑</span>
                    <span>..</span>
                  </td>
                </tr>
              )}

              {/* Dirs */}
              {dirs.map((d, i) => {
                const isSel = selected.has(d.key);
                return (
                  <tr key={d.key} className={`group transition-colors border-b border-gray-800/20 ${isSel ? "bg-blue-950/30" : "hover:bg-gray-800/50"}`}>
                    <td className="px-3 py-1.5">
                      <input
                        type="checkbox"
                        checked={isSel}
                        onChange={(e) => toggleSelect(d.key, i, e.nativeEvent instanceof MouseEvent && (e.nativeEvent as MouseEvent).shiftKey)}
                        onClick={(e) => e.stopPropagation()}
                        className="w-3 h-3 accent-blue-500 cursor-pointer"
                      />
                    </td>
                    <td className="px-2 py-1.5 cursor-pointer" onClick={() => navigateTo(d.key)}>
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-yellow-600 flex-shrink-0">▶</span>
                        <span className="text-gray-300 truncate">{d.name}/</span>
                      </div>
                    </td>
                    <td className="px-4 py-1.5 text-right text-gray-600">—</td>
                    <td className="px-4 py-1.5 text-right">
                      {confirmDeleteKey === d.key ? (
                        <span className="flex items-center justify-end gap-1.5">
                          <span className="text-gray-500 text-xs">Delete folder?</span>
                          <button
                            onClick={() => void handleDelete(d.key, true)}
                            disabled={deleting}
                            className="text-xs text-red-400 hover:text-red-300 disabled:opacity-40"
                          >
                            {deleting ? "…" : "Yes"}
                          </button>
                          <button
                            onClick={() => setConfirmDeleteKey(null)}
                            className="text-xs text-gray-600 hover:text-gray-400"
                          >
                            No
                          </button>
                        </span>
                      ) : (
                        <button
                          onClick={(e) => { e.stopPropagation(); setConfirmDeleteKey(d.key); }}
                          className="opacity-0 group-hover:opacity-100 text-gray-600 hover:text-red-400 transition-all px-1"
                          title="Delete folder"
                        >
                          ✕
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}

              {/* Files */}
              {files.map((f, i) => {
                const idx = dirs.length + i;
                const isSel = selected.has(f.key);
                return (
                  <tr key={f.key} className={`group transition-colors border-b border-gray-800/20 ${isSel ? "bg-blue-950/30" : "hover:bg-gray-800/30"}`}>
                    <td className="px-3 py-1.5">
                      <input
                        type="checkbox"
                        checked={isSel}
                        onChange={(e) => toggleSelect(f.key, idx, e.nativeEvent instanceof MouseEvent && (e.nativeEvent as MouseEvent).shiftKey)}
                        className="w-3 h-3 accent-blue-500 cursor-pointer"
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-gray-700 flex-shrink-0">·</span>
                        <span className="text-gray-300 truncate" title={f.name}>{f.name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-1.5 text-right text-gray-500 font-mono tabular-nums">{formatSize(f.size)}</td>
                    <td className="px-4 py-1.5 text-right">
                      {confirmDeleteKey === f.key ? (
                        <span className="flex items-center justify-end gap-1.5">
                          <button
                            onClick={() => void handleDelete(f.key, false)}
                            disabled={deleting}
                            className="text-xs text-red-400 hover:text-red-300 disabled:opacity-40"
                          >
                            {deleting ? "…" : "Delete"}
                          </button>
                          <button
                            onClick={() => setConfirmDeleteKey(null)}
                            className="text-xs text-gray-600 hover:text-gray-400"
                          >
                            Cancel
                          </button>
                        </span>
                      ) : (
                        <span className="flex items-center justify-end gap-3">
                          <span className="text-gray-600">{formatDate(f.lastModified)}</span>
                          <span className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-all">
                            <button
                              onClick={() => void handleDownload([f.key])}
                              className="text-gray-600 hover:text-blue-400 transition-colors px-1"
                              title="Download"
                            >
                              ↓
                            </button>
                            <button
                              onClick={() => setConfirmDeleteKey(f.key)}
                              className="text-gray-600 hover:text-red-400 transition-colors px-1"
                              title="Delete"
                            >
                              ✕
                            </button>
                          </span>
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}

              {filtered.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-3 text-gray-600">
                    {search ? "No matches" : "Empty directory"}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {/* ── Footer: transfers + count ── */}
      <div className="flex-shrink-0 border-t border-gray-800/50">
        {activeTransfers.length > 0 && (
          <div className="px-4 py-2 space-y-1 border-b border-gray-800/50 max-h-24 overflow-y-auto">
            {activeTransfers.map((t) => (
              <div key={t.id} className="flex items-center gap-2">
                <span className="text-gray-400 truncate text-xs flex-1 min-w-0">{t.name}</span>
                {t.error ? (
                  <span className="text-red-400 text-xs flex-shrink-0 truncate max-w-48">{t.error}</span>
                ) : (
                  <div className="w-24 flex-shrink-0 flex items-center gap-1.5">
                    <div className="flex-1 bg-gray-800 rounded-full h-1">
                      <div className="bg-blue-500 h-1 rounded-full transition-all" style={{ width: `${t.pct}%` }} />
                    </div>
                    <span className="text-gray-600 text-xs w-7 text-right">{t.pct}%</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        {!loading && !error && (
          <div className="px-4 py-1.5 text-xs text-gray-700">
            {search
              ? `${filtered.length} match${filtered.length !== 1 ? "es" : ""}`
              : [
                  dirs.length > 0 && `${dirs.length} folder${dirs.length !== 1 ? "s" : ""}`,
                  files.length > 0 && `${files.length} file${files.length !== 1 ? "s" : ""}`,
                ].filter(Boolean).join(", ") || "Empty"
            }
          </div>
        )}
      </div>
    </div>
  );
}
