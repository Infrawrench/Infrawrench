import { useState, useEffect, useRef, useCallback } from "react";
import type { StorageObject } from "@infrawrench/plugin-base";
import { formatSize, formatDate, formatErrorMessage } from "../utils.js";
import type { TransferEntry } from "../utils.js";

export interface FileBrowserProps {
  bucketName: string;
  onList: (prefix: string) => Promise<StorageObject[]>;
  onUpload?: (
    bucket: string,
    key: string,
    file: File,
    onProgress: (pct: number) => void,
  ) => Promise<void>;
  /** Whether to show a "Upload Folder" button alongside "Upload Files". Default: true. */
  showFolderUpload?: boolean | undefined;
  onMakeFolder?: (bucket: string, key: string) => Promise<void>;
  onDelete?: (bucket: string, key: string, isDirectory?: boolean) => Promise<void>;
  /** Called with a flat list of object keys. Host shows destination picker and writes to disk. */
  /** `basePath` is the current prefix being browsed — hosts strip it to preserve folder structure. */
  onBatchDownload?: (keys: string[], basePath: string) => Promise<void>;
  /** Format error messages. Defaults to String(). */
  formatError?: (error: unknown) => string;
  /**
   * Path navigation model.
   * - "bucket" (default): paths display as bucketName/prefix, prefix starts at ""
   * - "absolute": paths are absolute (e.g. /home/user), prefix IS the full path
   */
  pathMode?: "bucket" | "absolute" | undefined;
  /** Initial prefix value. For absolute mode, defaults to "/". For bucket mode, defaults to "". */
  initialPrefix?: string | undefined;
}

export function FileBrowser({
  bucketName,
  onList,
  onUpload,
  onMakeFolder,
  onDelete,
  onBatchDownload,
  formatError = formatErrorMessage,
  pathMode = "bucket",
  showFolderUpload = true,
  initialPrefix,
}: FileBrowserProps) {
  const isAbsolute = pathMode === "absolute";
  const defaultPrefix = initialPrefix ?? (isAbsolute ? "/" : "");
  const [prefix, setPrefix] = useState(defaultPrefix);
  const [pathInput, setPathInput] = useState(isAbsolute ? defaultPrefix : bucketName);
  const [pathEditing, setPathEditing] = useState(false);
  const [objects, setObjects] = useState<StorageObject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [transfers, setTransfers] = useState<TransferEntry[]>([]);
  const [newFolderActive, setNewFolderActive] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [newFolderError, setNewFolderError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [confirmDeleteKey, setConfirmDeleteKey] = useState<string | null>(null);
  const [bulkWorking, setBulkWorking] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const lastClickedIdxRef = useRef<number>(-1);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const newFolderInputRef = useRef<HTMLInputElement>(null);
  const [refreshCount, setRefreshCount] = useState(0);

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
    onList(prefix)
      .then((items) => {
        if (!cancelled) setObjects(items);
      })
      .catch((e) => {
        if (!cancelled) setError(formatError(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [prefix, refreshCount]);

  // Keep path input in sync with current prefix when not editing
  useEffect(() => {
    if (!pathEditing) {
      const displayPath = isAbsolute
        ? prefix
        : prefix
          ? `${bucketName}/${prefix.replace(/\/$/, "")}`
          : bucketName;
      setPathInput(displayPath);
    }
  }, [prefix, bucketName, pathEditing, isAbsolute]);

  useEffect(() => {
    if (newFolderActive) newFolderInputRef.current?.focus();
  }, [newFolderActive]);

  function navigateTo(newPrefix: string) {
    if (isAbsolute) {
      // Normalize: collapse slashes, ensure leading slash
      const parts = newPrefix.replace(/\/+/g, "/").split("/").filter(Boolean);
      setPrefix("/" + parts.join("/"));
    } else {
      setPrefix(newPrefix ? (newPrefix.endsWith("/") ? newPrefix : `${newPrefix}/`) : "");
    }
    setSearch("");
    setSelected(new Set());
    setPathEditing(false);
  }

  function commitPathInput() {
    const trimmed = pathInput.trim();
    if (isAbsolute) {
      if (trimmed) navigateTo(trimmed);
      else setPathInput(prefix);
    } else {
      // Strip leading bucket name if present, then use remainder as prefix
      const withoutBucket = trimmed.startsWith(`${bucketName}/`)
        ? trimmed.slice(bucketName.length + 1)
        : trimmed === bucketName
          ? ""
          : trimmed;
      navigateTo(withoutBucket);
    }
    setPathEditing(false);
  }

  const q = search.toLowerCase();
  const filtered = q ? objects.filter((o) => o.name.toLowerCase().includes(q)) : objects;
  const dirs = filtered.filter((o) => o.isDirectory);
  const files = filtered.filter((o) => !o.isDirectory);
  const allFiltered = [...dirs, ...files];

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

  const allSelected = allFiltered.length > 0 && allFiltered.every((o) => selected.has(o.key));
  const someSelected = !allSelected && allFiltered.some((o) => selected.has(o.key));

  function toggleAll() {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(allFiltered.map((o) => o.key)));
    }
  }

  const listAllFlat = useCallback(
    async (p: string): Promise<StorageObject[]> => {
      const items = await onList(p);
      const fileItems = items.filter((o) => !o.isDirectory);
      const dirItems = items.filter((o) => o.isDirectory);
      const nested = await Promise.all(dirItems.map((d) => listAllFlat(d.key)));
      return [...fileItems, ...nested.flat()];
    },
    [onList],
  );

  function addTransfer(name: string): string {
    const id = crypto.randomUUID();
    setTransfers((prev) => [...prev, { id, name, pct: 0, done: false }]);
    return id;
  }
  function updateTransfer(id: string, pct: number) {
    setTransfers((prev) => prev.map((t) => (t.id === id ? { ...t, pct } : t)));
  }
  function finishTransfer(id: string, error?: string) {
    setTransfers((prev) =>
      prev.map((t) => {
        if (t.id !== id) return t;
        return error ? { ...t, pct: 100, done: true, error } : { ...t, pct: 100, done: true };
      }),
    );
    setTimeout(() => setTransfers((prev) => prev.filter((t) => t.id !== id)), 2500);
  }

  async function handleFiles(fileList: FileList, isFolder = false) {
    if (!onUpload) return;
    const arr = Array.from(fileList);
    await Promise.allSettled(
      arr.map(async (file) => {
        const relativePath = isFolder ? file.webkitRelativePath || file.name : file.name;
        const key = isAbsolute
          ? `${prefix === "/" ? "" : prefix}/${relativePath}`
          : prefix + relativePath;
        const id = addTransfer(relativePath);
        try {
          await onUpload(bucketName, key, file, (pct) => updateTransfer(id, pct));
          finishTransfer(id);
        } catch (e) {
          finishTransfer(id, formatError(e));
        }
      }),
    );
    reload();
  }

  async function handleMakeFolder() {
    const name = newFolderName.trim();
    if (!name || !onMakeFolder) return;
    setNewFolderError(null);
    try {
      const folderKey = isAbsolute ? `${prefix === "/" ? "" : prefix}/${name}` : `${prefix}${name}`;
      await onMakeFolder(bucketName, folderKey);
      setNewFolderActive(false);
      setNewFolderName("");
      reload();
    } catch (e) {
      setNewFolderError(formatError(e));
    }
  }

  async function handleDelete(key: string, isDirectory?: boolean) {
    if (!onDelete) return;
    setDeleting(true);
    try {
      await onDelete(bucketName, key, isDirectory);
      setConfirmDeleteKey(null);
      reload();
    } catch (e) {
      setConfirmDeleteKey(null);
      setError(formatError(e));
    } finally {
      setDeleting(false);
    }
  }

  async function handleBulkDelete() {
    if (!onDelete) return;
    setBulkWorking(true);
    try {
      await Promise.allSettled(
        [...selected].map((key) => {
          const obj = objects.find((o) => o.key === key);
          return onDelete!(bucketName, key, obj?.isDirectory);
        }),
      );
      reload();
    } finally {
      setBulkWorking(false);
      setConfirmBulkDelete(false);
    }
  }

  async function handleDownload(keys: string[]) {
    if (!onBatchDownload) return;
    setBulkWorking(true);
    try {
      // Expand any selected folders to a flat list of file keys
      const flatKeys: string[] = [];
      for (const key of keys) {
        const obj = objects.find((o) => o.key === key);
        if (obj?.isDirectory) {
          const flat = await listAllFlat(obj.key);
          flatKeys.push(...flat.map((o) => o.key));
        } else {
          flatKeys.push(key);
        }
      }
      await onBatchDownload(flatKeys, prefix);
    } finally {
      setBulkWorking(false);
    }
  }

  const activeTransfers = transfers.filter((t) => !t.done);
  const canWrite = !!onUpload || !!onMakeFolder;

  return (
    <div className="flex-1 min-h-0 border-t border-border bg-surface flex flex-col">
      {/* ── Header: path bar + search + actions ── */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border/60 flex-shrink-0">
        <label
          htmlFor="file-browser-path"
          className="text-xs text-on-surface-muted font-medium flex-shrink-0"
        >
          Path
        </label>
        <input
          id="file-browser-path"
          type="text"
          value={pathInput}
          onChange={(e) => setPathInput(e.target.value)}
          onFocus={() => setPathEditing(true)}
          onBlur={commitPathInput}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.currentTarget.blur();
            }
            if (e.key === "Escape") {
              const displayPath = isAbsolute
                ? prefix
                : prefix
                  ? `${bucketName}/${prefix.replace(/\/$/, "")}`
                  : bucketName;
              setPathInput(displayPath);
              setPathEditing(false);
              e.currentTarget.blur();
            }
          }}
          className="flex-1 min-w-0 bg-surface-raised border border-border-strong rounded px-2 py-0.5 text-xs font-mono text-on-surface-secondary placeholder:text-on-surface-faint focus:outline-none focus:border-border-strong"
          spellCheck={false}
        />

        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter…"
          className="w-36 bg-surface-overlay border border-border-strong rounded px-2 py-0.5 text-xs text-on-surface-secondary placeholder:text-on-surface-faint focus:outline-none focus:border-border-strong"
        />

        {canWrite && (
          <div className="flex items-center gap-1 flex-shrink-0">
            {onMakeFolder && (
              <button
                onClick={() => {
                  setNewFolderActive(true);
                  setNewFolderName("");
                  setNewFolderError(null);
                }}
                className="px-2 py-0.5 text-xs text-on-surface-tertiary hover:text-on-surface-secondary border border-border-strong hover:border-border-strong rounded transition-colors"
              >
                + Folder
              </button>
            )}
            {onUpload && (
              <>
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="px-2 py-0.5 text-xs text-on-surface-tertiary hover:text-on-surface-secondary border border-border-strong hover:border-border-strong rounded transition-colors"
                >
                  ↑ Files
                </button>
                {showFolderUpload && (
                  <button
                    onClick={() => folderInputRef.current?.click()}
                    className="px-2 py-0.5 text-xs text-on-surface-tertiary hover:text-on-surface-secondary border border-border-strong hover:border-border-strong rounded transition-colors"
                  >
                    ↑ Folder
                  </button>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    if (e.target.files?.length) {
                      void handleFiles(e.target.files);
                      e.target.value = "";
                    }
                  }}
                />
                {showFolderUpload && (
                  <input
                    ref={folderInputRef}
                    type="file"
                    // @ts-expect-error webkitdirectory non-standard
                    webkitdirectory=""
                    multiple
                    className="hidden"
                    onChange={(e) => {
                      if (e.target.files?.length) {
                        void handleFiles(e.target.files, true);
                        e.target.value = "";
                      }
                    }}
                  />
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* ── Selection toolbar ── */}
      {selected.size > 0 && (
        <div className="flex items-center gap-3 px-4 py-1.5 bg-accent-muted/40 border-b border-accent-muted-border/40 flex-shrink-0">
          <span className="text-xs text-accent-on-muted font-medium">{selected.size} selected</span>
          <div className="flex items-center gap-2 ml-auto">
            {onBatchDownload && (
              <button
                onClick={() => void handleDownload([...selected])}
                disabled={bulkWorking}
                className="px-2.5 py-1 text-xs text-on-surface-secondary hover:text-white border border-border-strong hover:border-border-strong rounded transition-colors disabled:opacity-40"
              >
                ↓ Download
              </button>
            )}
            {onDelete &&
              (confirmBulkDelete ? (
                <span className="flex items-center gap-2">
                  <span className="text-xs text-on-surface-tertiary">
                    Delete {selected.size} item{selected.size !== 1 ? "s" : ""}?
                  </span>
                  <button
                    onClick={() => void handleBulkDelete()}
                    disabled={bulkWorking}
                    className="px-2.5 py-1 text-xs bg-red-600 hover:bg-red-500 text-white rounded transition-colors disabled:opacity-40"
                  >
                    {bulkWorking ? "Deleting…" : "Confirm"}
                  </button>
                  <button
                    onClick={() => setConfirmBulkDelete(false)}
                    className="px-2 py-1 text-xs text-on-surface-muted hover:text-on-surface-secondary transition-colors"
                  >
                    Cancel
                  </button>
                </span>
              ) : (
                <button
                  onClick={() => setConfirmBulkDelete(true)}
                  disabled={bulkWorking}
                  className="px-2.5 py-1 text-xs text-red-500 dark:text-red-400 hover:text-red-600 dark:hover:text-red-300 border border-red-300 dark:border-red-900/50 hover:border-red-400 dark:hover:border-red-700/50 rounded transition-colors disabled:opacity-40"
                >
                  Delete
                </button>
              ))}
            <button
              onClick={() => setSelected(new Set())}
              className="text-xs text-on-surface-faint hover:text-on-surface-tertiary transition-colors"
            >
              Clear
            </button>
          </div>
        </div>
      )}

      {/* ── File list ── */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {loading && <div className="px-4 py-3 text-xs text-on-surface-faint">Loading…</div>}
        {error && <div className="px-4 py-3 text-xs text-red-400">{error}</div>}

        {!loading && !error && (
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-surface z-10">
              <tr className="text-on-surface-faint border-b border-border/50">
                <th className="px-3 py-1.5 w-8">
                  <input
                    type="checkbox"
                    aria-label="Select all items"
                    checked={allSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = someSelected;
                    }}
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
                <tr className="border-b border-border/30">
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
                          if (e.key === "Escape") {
                            setNewFolderActive(false);
                            setNewFolderName("");
                          }
                        }}
                        placeholder="Folder name"
                        className="bg-surface-overlay border border-border-strong rounded px-2 py-0.5 text-xs text-on-surface-secondary placeholder:text-on-surface-faint focus:outline-none focus:border-blue-500"
                      />
                      <button
                        onClick={() => void handleMakeFolder()}
                        className="px-2 py-0.5 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors"
                      >
                        Create
                      </button>
                      <button
                        onClick={() => {
                          setNewFolderActive(false);
                          setNewFolderName("");
                        }}
                        className="text-xs text-on-surface-faint hover:text-on-surface-tertiary transition-colors"
                      >
                        Cancel
                      </button>
                      {newFolderError && (
                        <span className="text-xs text-red-400">{newFolderError}</span>
                      )}
                    </div>
                  </td>
                </tr>
              )}

              {/* Up row */}
              {((isAbsolute && prefix !== "/") || (!isAbsolute && prefix)) && !search && (
                <tr
                  role="button"
                  tabIndex={0}
                  aria-label="Go to parent folder"
                  className="hover:bg-surface-overlay/50 cursor-pointer transition-colors"
                  onClick={() => {
                    if (isAbsolute) {
                      const parts = prefix.split("/").filter(Boolean);
                      parts.pop();
                      navigateTo(parts.length ? "/" + parts.join("/") : "/");
                    } else {
                      const parts = prefix.replace(/\/$/, "").split("/");
                      parts.pop();
                      navigateTo(parts.length ? parts.join("/") : "");
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      if (isAbsolute) {
                        const parts = prefix.split("/").filter(Boolean);
                        parts.pop();
                        navigateTo(parts.length ? "/" + parts.join("/") : "/");
                      } else {
                        const parts = prefix.replace(/\/$/, "").split("/");
                        parts.pop();
                        navigateTo(parts.length ? parts.join("/") : "");
                      }
                    }
                  }}
                >
                  <td />
                  <td
                    className="px-2 py-1.5 text-on-surface-muted flex items-center gap-2"
                    colSpan={3}
                  >
                    <span aria-hidden="true" className="text-on-surface-faint">
                      ↑
                    </span>
                    <span>..</span>
                  </td>
                </tr>
              )}

              {/* Dirs */}
              {dirs.map((d, i) => {
                const idx = i; // dirs come first in allFiltered
                const isSel = selected.has(d.key);
                return (
                  <tr
                    key={d.key}
                    className={`group transition-colors border-b border-border/20 ${isSel ? "bg-accent-muted/30" : "hover:bg-surface-overlay/50"}`}
                  >
                    <td className="px-3 py-1.5">
                      <input
                        type="checkbox"
                        checked={isSel}
                        onChange={(e) =>
                          toggleSelect(
                            d.key,
                            idx,
                            e.nativeEvent instanceof MouseEvent &&
                              (e.nativeEvent as MouseEvent).shiftKey,
                          )
                        }
                        onClick={(e) => e.stopPropagation()}
                        className="w-3 h-3 accent-blue-500 cursor-pointer"
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      <button
                        type="button"
                        onClick={() => navigateTo(d.key)}
                        aria-label={`Open folder ${d.name}`}
                        className="flex items-center gap-2 min-w-0 w-full text-left cursor-pointer"
                      >
                        <span aria-hidden="true" className="text-yellow-600 flex-shrink-0">
                          ▶
                        </span>
                        <span className="text-on-surface-secondary truncate">{d.name}/</span>
                      </button>
                    </td>
                    <td className="px-4 py-1.5 text-right text-on-surface-faint">—</td>
                    <td className="px-4 py-1.5 text-right">
                      {onDelete &&
                        (confirmDeleteKey === d.key ? (
                          <span className="flex items-center justify-end gap-1.5">
                            <span className="text-on-surface-muted text-xs">Delete folder?</span>
                            <button
                              onClick={() => void handleDelete(d.key, true)}
                              disabled={deleting}
                              className="text-xs text-red-400 hover:text-red-500 dark:text-red-300 disabled:opacity-40"
                            >
                              {deleting ? "…" : "Yes"}
                            </button>
                            <button
                              onClick={() => setConfirmDeleteKey(null)}
                              className="text-xs text-on-surface-faint hover:text-on-surface-tertiary"
                            >
                              No
                            </button>
                          </span>
                        ) : (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setConfirmDeleteKey(d.key);
                            }}
                            className="opacity-0 group-hover:opacity-100 text-on-surface-faint hover:text-red-400 transition-all px-1"
                            title="Delete folder"
                            aria-label={`Delete folder ${d.name}`}
                          >
                            ✕
                          </button>
                        ))}
                    </td>
                  </tr>
                );
              })}

              {/* Files */}
              {files.map((f, i) => {
                const idx = dirs.length + i;
                const isSel = selected.has(f.key);
                return (
                  <tr
                    key={f.key}
                    className={`group transition-colors border-b border-border/20 ${isSel ? "bg-accent-muted/30" : "hover:bg-surface-overlay/30"}`}
                  >
                    <td className="px-3 py-1.5">
                      <input
                        type="checkbox"
                        checked={isSel}
                        onChange={(e) =>
                          toggleSelect(
                            f.key,
                            idx,
                            e.nativeEvent instanceof MouseEvent &&
                              (e.nativeEvent as MouseEvent).shiftKey,
                          )
                        }
                        className="w-3 h-3 accent-blue-500 cursor-pointer"
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-on-surface-faint flex-shrink-0">·</span>
                        <span className="text-on-surface-secondary truncate" title={f.name}>
                          {f.name}
                        </span>
                        {f.contentType && (
                          <span className="text-on-surface-faint flex-shrink-0">
                            {f.contentType.split("/").pop()}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-1.5 text-right text-on-surface-muted font-mono tabular-nums">
                      {formatSize(f.size)}
                    </td>
                    <td className="px-4 py-1.5 text-right">
                      {onDelete && confirmDeleteKey === f.key ? (
                        <span className="flex items-center justify-end gap-1.5">
                          <button
                            onClick={() => void handleDelete(f.key, false)}
                            disabled={deleting}
                            className="text-xs text-red-400 hover:text-red-500 dark:text-red-300 disabled:opacity-40"
                          >
                            {deleting ? "…" : "Delete"}
                          </button>
                          <button
                            onClick={() => setConfirmDeleteKey(null)}
                            className="text-xs text-on-surface-faint hover:text-on-surface-tertiary"
                          >
                            Cancel
                          </button>
                        </span>
                      ) : (
                        <span className="flex items-center justify-end gap-3">
                          <span className="text-on-surface-faint">
                            {formatDate(f.lastModified)}
                          </span>
                          <span className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-all">
                            {onBatchDownload && (
                              <button
                                onClick={() => void handleDownload([f.key])}
                                className="text-on-surface-faint hover:text-accent transition-colors px-1"
                                title="Download"
                                aria-label={`Download ${f.name}`}
                              >
                                ↓
                              </button>
                            )}
                            {onDelete && (
                              <button
                                onClick={() => setConfirmDeleteKey(f.key)}
                                className="text-on-surface-faint hover:text-red-400 transition-colors px-1"
                                title="Delete"
                                aria-label={`Delete ${f.name}`}
                              >
                                ✕
                              </button>
                            )}
                          </span>
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}

              {filtered.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-3 text-on-surface-faint">
                    {search ? "No matches" : "Empty folder"}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {/* ── Footer: transfers + count ── */}
      <div className="flex-shrink-0 border-t border-border/50">
        {activeTransfers.length > 0 && (
          <div className="px-4 py-2 space-y-1 border-b border-border/50 max-h-24 overflow-y-auto">
            {activeTransfers.map((t) => (
              <div key={t.id} className="flex items-center gap-2">
                <span className="text-on-surface-tertiary truncate text-xs flex-1 min-w-0">
                  {t.name}
                </span>
                {t.error ? (
                  <span className="text-red-400 text-xs flex-shrink-0 truncate max-w-48">
                    {t.error}
                  </span>
                ) : (
                  <div className="w-24 flex-shrink-0 flex items-center gap-1.5">
                    <div className="flex-1 bg-surface-overlay rounded-full h-1">
                      <div
                        className="bg-blue-500 h-1 rounded-full transition-all"
                        style={{ width: `${t.pct}%` }}
                      />
                    </div>
                    <span className="text-on-surface-faint text-xs w-7 text-right">{t.pct}%</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        {!loading && !error && (
          <div className="px-4 py-1.5 text-xs text-on-surface-faint">
            {search
              ? `${filtered.length} match${filtered.length !== 1 ? "es" : ""}`
              : [
                  dirs.length > 0 && `${dirs.length} folder${dirs.length !== 1 ? "s" : ""}`,
                  files.length > 0 && `${files.length} file${files.length !== 1 ? "s" : ""}`,
                ]
                  .filter(Boolean)
                  .join(", ") || "Empty"}
          </div>
        )}
      </div>
    </div>
  );
}
