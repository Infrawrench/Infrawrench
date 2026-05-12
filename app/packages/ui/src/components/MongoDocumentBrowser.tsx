import { useCallback, useEffect, useRef, useState } from "react";
import { formatErrorMessage } from "../utils.js";

export interface MongoDocumentBrowserProps {
  databaseName: string;
  connected?: boolean;
  onCommand: (command: string, args: (string | number)[]) => Promise<unknown>;
}

interface CollectionStats {
  count: number;
  size: number;
  avgObjSize: number;
  nindexes: number;
}

const PAGE_SIZE = 25;

export function MongoDocumentBrowser({
  databaseName,
  connected = true,
  onCommand,
}: MongoDocumentBrowserProps) {
  const [collections, setCollections] = useState<string[]>([]);
  const [activeCollection, setActiveCollection] = useState<string | null>(null);
  const [collectionStats, setCollectionStats] = useState<CollectionStats | null>(null);
  const [documents, setDocuments] = useState<Record<string, unknown>[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [page, setPage] = useState(0);
  const [filterText, setFilterText] = useState("");
  const [appliedFilter, setAppliedFilter] = useState("{}");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const [collectionsLoading, setCollectionsLoading] = useState(false);
  const [showNewCollection, setShowNewCollection] = useState(false);
  const [newCollectionName, setNewCollectionName] = useState("");
  const [showInsertDoc, setShowInsertDoc] = useState(false);
  const [insertDocText, setInsertDocText] = useState("{\n  \n}");
  const [insertError, setInsertError] = useState<string | null>(null);
  const [droppingCollection, setDroppingCollection] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const refreshCollections = useCallback(async () => {
    setCollectionsLoading(true);
    try {
      const cols = (await onCommand("listCollections", [databaseName])) as string[];
      setCollections(cols);
      if (cols.length > 0) {
        setActiveCollection((prev) => prev ?? cols[0] ?? null);
      }
    } catch (e) {
      setError(formatErrorMessage(e));
    } finally {
      setCollectionsLoading(false);
    }
  }, [databaseName, onCommand]);

  useEffect(() => {
    if (!connected) return;
    void refreshCollections();
  }, [connected, refreshCollections]);

  const fetchDocuments = useCallback(async () => {
    if (!activeCollection || !connected) return;
    setLoading(true);
    setError(null);
    try {
      const [docs, count, stats] = await Promise.all([
        onCommand("find", [
          databaseName,
          activeCollection,
          appliedFilter,
          page * PAGE_SIZE,
          PAGE_SIZE,
        ]) as Promise<Record<string, unknown>[]>,
        onCommand("countDocuments", [
          databaseName,
          activeCollection,
          appliedFilter,
        ]) as Promise<number>,
        onCommand("collectionStats", [databaseName, activeCollection]) as Promise<CollectionStats>,
      ]);
      setDocuments(docs);
      setTotalCount(count);
      setCollectionStats(stats);
      setExpandedIds(new Set());
    } catch (e) {
      setError(formatErrorMessage(e));
      setDocuments([]);
      setTotalCount(0);
    } finally {
      setLoading(false);
    }
  }, [activeCollection, connected, databaseName, appliedFilter, page, onCommand]);

  useEffect(() => {
    void fetchDocuments();
  }, [fetchDocuments]);

  function handleApplyFilter() {
    const trimmed = filterText.trim() || "{}";
    try {
      JSON.parse(trimmed);
      setAppliedFilter(trimmed);
      setPage(0);
    } catch {
      setError("Invalid JSON filter");
    }
  }

  function selectCollection(name: string) {
    setActiveCollection(name);
    setPage(0);
    setFilterText("");
    setAppliedFilter("{}");
  }

  function toggleExpanded(idx: number) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }

  async function handleCreateCollection() {
    const name = newCollectionName.trim();
    if (!name) return;
    try {
      await onCommand("createCollection", [databaseName, name]);
      setNewCollectionName("");
      setShowNewCollection(false);
      await refreshCollections();
      setActiveCollection(name);
      setPage(0);
      setFilterText("");
      setAppliedFilter("{}");
    } catch (e) {
      setError(formatErrorMessage(e));
    }
  }

  async function handleDropCollection(name: string) {
    try {
      await onCommand("dropCollection", [databaseName, name]);
      setDroppingCollection(null);
      if (activeCollection === name) {
        setActiveCollection(null);
        setDocuments([]);
        setTotalCount(0);
      }
      await refreshCollections();
    } catch (e) {
      setError(formatErrorMessage(e));
      setDroppingCollection(null);
    }
  }

  async function handleInsertDocument() {
    if (!activeCollection) return;
    const trimmed = insertDocText.trim();
    setInsertError(null);
    let doc: unknown;
    try {
      doc = JSON.parse(trimmed);
    } catch {
      setInsertError("Invalid JSON");
      return;
    }
    try {
      await onCommand("insertOne", [databaseName, activeCollection, JSON.stringify(doc)]);
      setShowInsertDoc(false);
      setInsertDocText("{\n  \n}");
      void fetchDocuments();
    } catch (e) {
      setInsertError(formatErrorMessage(e));
    }
  }

  async function handleDeleteDocument(doc: Record<string, unknown>) {
    if (!activeCollection) return;
    const id = doc["_id"];
    if (id == null) return;
    try {
      await onCommand("deleteOne", [databaseName, activeCollection, JSON.stringify({ _id: id })]);
      void fetchDocuments();
    } catch (e) {
      setError(formatErrorMessage(e));
    }
  }

  async function handleSaveDocument(doc: Record<string, unknown>, newDocJson: string) {
    if (!activeCollection) return;
    const id = doc["_id"];
    if (id == null) return;
    const { _id: _removed, ...replacement } = JSON.parse(newDocJson) as Record<string, unknown>;
    await onCommand("replaceOne", [
      databaseName,
      activeCollection,
      JSON.stringify({ _id: id }),
      JSON.stringify(replacement),
    ]);
    void fetchDocuments();
  }

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  if (!connected) {
    return (
      <div className="flex-1 flex items-center justify-center text-on-surface-faint text-sm">
        Connecting to MongoDB...
      </div>
    );
  }

  return (
    <div className="flex flex-1 overflow-hidden border-t border-border">
      {/* Collection sidebar */}
      <div className="w-64 border-r border-border flex flex-col overflow-hidden flex-shrink-0 bg-surface">
        <div className="px-3 py-2 border-b border-border/60 flex items-center justify-between">
          <span className="text-xs font-semibold text-on-surface-tertiary uppercase tracking-wide">
            Collections
          </span>
          <button
            onClick={() => setShowNewCollection((v) => !v)}
            className="text-on-surface-faint hover:text-on-surface-secondary transition-colors text-sm leading-none"
            title="Create collection"
          >
            +
          </button>
        </div>
        {showNewCollection && (
          <div className="px-2 py-2 border-b border-border/60 flex gap-1">
            <input
              value={newCollectionName}
              onChange={(e) => setNewCollectionName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleCreateCollection();
                if (e.key === "Escape") setShowNewCollection(false);
              }}
              placeholder="collection name"
              className="flex-1 min-w-0 bg-surface-raised border border-border-strong rounded px-2 py-1 text-xs text-on-surface-secondary font-mono placeholder:text-on-surface-faint focus:outline-none focus:border-blue-500"
              autoFocus
            />
            <button
              onClick={() => void handleCreateCollection()}
              className="px-2 py-1 rounded bg-blue-600 text-xs text-white hover:bg-blue-500 transition-colors flex-shrink-0"
            >
              Create
            </button>
          </div>
        )}
        <div className="flex-1 overflow-y-auto py-1">
          {collectionsLoading ? (
            <div className="px-3 py-2 text-xs text-on-surface-faint">Loading...</div>
          ) : collections.length === 0 ? (
            <div className="px-3 py-2 text-xs text-on-surface-faint">No collections</div>
          ) : (
            collections.map((col) => (
              <div key={col} className="group relative">
                {droppingCollection === col ? (
                  <div className="flex items-center gap-1 px-2 py-1.5">
                    <span className="text-xs text-red-400 truncate flex-1">Drop {col}?</span>
                    <button
                      onClick={() => void handleDropCollection(col)}
                      className="px-1.5 py-0.5 rounded bg-red-600 text-xs text-white hover:bg-red-500 transition-colors flex-shrink-0"
                    >
                      Drop
                    </button>
                    <button
                      onClick={() => setDroppingCollection(null)}
                      className="px-1.5 py-0.5 rounded text-xs text-on-surface-faint hover:text-on-surface-secondary transition-colors flex-shrink-0"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <>
                    <button
                      onClick={() => selectCollection(col)}
                      className={`w-full text-left px-3 py-1.5 text-xs truncate transition-colors pr-7 ${
                        col === activeCollection
                          ? "bg-accent-muted text-accent-on-muted font-medium"
                          : "text-on-surface-tertiary hover:text-on-surface-secondary hover:bg-surface-overlay"
                      }`}
                    >
                      {col}
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setDroppingCollection(col);
                      }}
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 text-on-surface-faint hover:text-red-400 transition-all text-xs px-1"
                      title="Drop collection"
                    >
                      ×
                    </button>
                  </>
                )}
              </div>
            ))
          )}
        </div>
        {collectionStats && activeCollection && (
          <div className="px-3 py-2 border-t border-border/60 space-y-0.5">
            <div className="text-xs text-on-surface-faint">
              {collectionStats.count.toLocaleString()} docs
            </div>
            <div className="text-xs text-on-surface-faint">{collectionStats.nindexes} indexes</div>
            {collectionStats.size > 0 && (
              <div className="text-xs text-on-surface-faint">
                {(collectionStats.size / 1024).toFixed(1)} KB
              </div>
            )}
          </div>
        )}
      </div>

      {/* Document area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Filter bar */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border/60 bg-surface">
          <span className="text-xs text-on-surface-muted flex-shrink-0">Filter:</span>
          <input
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleApplyFilter();
            }}
            placeholder='{ "field": "value" }'
            className="flex-1 bg-surface-raised border border-border-strong rounded px-2 py-1 text-xs text-on-surface-secondary font-mono placeholder:text-on-surface-faint focus:outline-none focus:border-blue-500"
            spellCheck={false}
          />
          <button
            onClick={handleApplyFilter}
            className="px-2.5 py-1 rounded bg-surface-overlay border border-border-strong text-xs text-on-surface-secondary hover:bg-surface-sunken hover:border-border-strong transition-colors"
          >
            Apply
          </button>
          <button
            onClick={() => void fetchDocuments()}
            className="px-2 py-1 rounded text-xs text-on-surface-muted hover:text-on-surface-secondary transition-colors"
            title="Refresh"
          >
            Refresh
          </button>
          {activeCollection && (
            <button
              onClick={() => setShowInsertDoc((v) => !v)}
              className="px-2.5 py-1 rounded bg-blue-600/80 border border-blue-500/50 text-xs text-white hover:bg-blue-600 transition-colors"
            >
              + Insert
            </button>
          )}
        </div>

        {/* Insert document editor */}
        {showInsertDoc && activeCollection && (
          <div className="px-3 py-3 border-b border-border/60 bg-surface/80">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-on-surface-tertiary font-medium">
                Insert Document into{" "}
                <span className="text-on-surface-secondary">{activeCollection}</span>
              </span>
              <button
                onClick={() => {
                  setShowInsertDoc(false);
                  setInsertError(null);
                }}
                className="text-xs text-on-surface-faint hover:text-on-surface-tertiary transition-colors"
              >
                Cancel
              </button>
            </div>
            <textarea
              value={insertDocText}
              onChange={(e) => setInsertDocText(e.target.value)}
              rows={6}
              className="w-full bg-surface-raised border border-border-strong rounded-lg px-3 py-2 text-xs text-on-surface-secondary font-mono placeholder:text-on-surface-faint focus:outline-none focus:border-blue-500 resize-y"
              spellCheck={false}
              placeholder='{ "key": "value" }'
            />
            {insertError && <div className="text-xs text-red-400 mt-1">{insertError}</div>}
            <div className="flex justify-end mt-2">
              <button
                onClick={() => void handleInsertDocument()}
                className="px-3 py-1.5 rounded bg-blue-600 text-xs text-white hover:bg-blue-500 transition-colors"
              >
                Insert Document
              </button>
            </div>
          </div>
        )}

        {/* Error banner */}
        {error && (
          <div className="px-3 py-2 bg-red-500/10 border-b border-red-500/20">
            <span className="text-xs text-red-400">{error}</span>
          </div>
        )}

        {/* Document list */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto">
          {!activeCollection ? (
            <div className="flex items-center justify-center h-full text-on-surface-faint text-sm">
              Select a collection
            </div>
          ) : loading ? (
            <div className="flex items-center justify-center h-full text-on-surface-faint text-sm">
              Loading...
            </div>
          ) : documents.length === 0 ? (
            <div className="flex items-center justify-center h-full text-on-surface-faint text-sm">
              No documents found
            </div>
          ) : (
            <div className="divide-y divide-border/50">
              {documents.map((doc, idx) => (
                <DocumentRow
                  key={idx}
                  doc={doc}
                  index={page * PAGE_SIZE + idx}
                  expanded={expandedIds.has(idx)}
                  onToggle={() => toggleExpanded(idx)}
                  onDelete={() => void handleDeleteDocument(doc)}
                  onSave={(newJson) => handleSaveDocument(doc, newJson)}
                />
              ))}
            </div>
          )}
        </div>

        {/* Pagination footer */}
        {activeCollection && totalCount > 0 && (
          <div className="flex items-center justify-between px-3 py-2 border-t border-border/60 bg-surface">
            <span className="text-xs text-on-surface-muted">
              {totalCount.toLocaleString()} document{totalCount === 1 ? "" : "s"}
              {appliedFilter !== "{}" && " (filtered)"}
            </span>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0}
                className="px-2 py-0.5 rounded text-xs text-on-surface-tertiary hover:text-on-surface-secondary hover:bg-surface-overlay disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
              >
                Prev
              </button>
              <span className="text-xs text-on-surface-muted">
                {page + 1} / {totalPages}
              </span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                disabled={page >= totalPages - 1}
                className="px-2 py-0.5 rounded text-xs text-on-surface-tertiary hover:text-on-surface-secondary hover:bg-surface-overlay disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function DocumentRow({
  doc,
  index,
  expanded,
  onToggle,
  onDelete,
  onSave,
}: {
  doc: Record<string, unknown>;
  index: number;
  expanded: boolean;
  onToggle: () => void;
  onDelete: () => void;
  onSave: (docJson: string) => Promise<void>;
}) {
  const id = doc["_id"];
  const previewFields = Object.entries(doc)
    .filter(([k]) => k !== "_id")
    .slice(0, 4);

  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function startEdit() {
    const { _id: _removed, ...rest } = doc;
    setEditText(JSON.stringify(rest, null, 2));
    setEditError(null);
    setEditing(true);
  }

  async function handleSave() {
    setEditError(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(editText);
    } catch {
      setEditError("Invalid JSON");
      return;
    }
    setSaving(true);
    try {
      await onSave(JSON.stringify(parsed));
      setEditing(false);
    } catch (e) {
      setEditError(formatErrorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  const idLabel = id != null ? formatValue(id) : "";
  const panelId = `mongo-doc-${index}${idLabel ? `-${idLabel}` : ""}`;

  return (
    <div className="group">
      <div className="flex items-center gap-3 px-3 py-2 hover:bg-surface-overlay/30 transition-colors">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-controls={panelId}
          className="flex items-center gap-3 flex-1 min-w-0 text-left cursor-pointer"
        >
          <span
            aria-hidden="true"
            className={`text-on-surface-faint text-xs transition-transform flex-shrink-0 ${expanded ? "rotate-90" : ""}`}
          >
            &#9654;
          </span>
          <span className="text-xs text-on-surface-muted w-8 flex-shrink-0 text-right font-mono">
            {index}
          </span>
          {id != null && (
            <span className="text-xs text-accent/70 font-mono flex-shrink-0 truncate max-w-[160px]">
              {formatValue(id)}
            </span>
          )}
          <div className="flex-1 min-w-0 flex items-center gap-3 overflow-hidden">
            {previewFields.map(([key, val]) => (
              <span key={key} className="text-xs truncate flex-shrink">
                <span className="text-on-surface-faint">{key}:</span>{" "}
                <span className="text-on-surface-tertiary">{formatPreview(val)}</span>
              </span>
            ))}
          </div>
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            startEdit();
            if (!expanded) onToggle();
          }}
          className="opacity-0 group-hover:opacity-100 text-xs text-on-surface-faint hover:text-blue-400 px-1 transition-all flex-shrink-0"
          title="Edit document"
          aria-label={idLabel ? `Edit document ${idLabel}` : "Edit document"}
        >
          Edit
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="opacity-0 group-hover:opacity-100 text-xs text-on-surface-faint hover:text-red-400 px-1 transition-all flex-shrink-0"
          title="Delete document"
          aria-label={idLabel ? `Delete document ${idLabel}` : "Delete document"}
        >
          Delete
        </button>
      </div>
      {expanded && (
        <div id={panelId} className="px-12 pb-3">
          {editing ? (
            <div className="space-y-2">
              <textarea
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                rows={10}
                className="w-full bg-surface-raised border border-border-strong rounded-lg px-3 py-2 text-xs text-on-surface-secondary font-mono focus:outline-none focus:border-blue-500 resize-y"
                spellCheck={false}
              />
              {editError && <div className="text-xs text-red-400">{editError}</div>}
              <div className="flex gap-2 justify-end">
                <button
                  onClick={() => setEditing(false)}
                  className="px-2.5 py-1 rounded text-xs text-on-surface-faint hover:text-on-surface-secondary transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={() => void handleSave()}
                  disabled={saving}
                  className="px-3 py-1 rounded bg-blue-600 text-xs text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
                >
                  {saving ? "Saving…" : "Save"}
                </button>
              </div>
            </div>
          ) : (
            <pre className="text-xs font-mono text-on-surface-secondary bg-surface-raised/50 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap break-words">
              {JSON.stringify(doc, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function formatValue(val: unknown): string {
  if (val === null) return "null";
  if (val === undefined) return "undefined";
  if (typeof val === "object") {
    const oid = (val as Record<string, unknown>)["$oid"];
    if (typeof oid === "string") return oid;
    return JSON.stringify(val);
  }
  return String(val);
}

function formatPreview(val: unknown): string {
  if (val === null) return "null";
  if (val === undefined) return "—";
  if (typeof val === "string") {
    return val.length > 40 ? `"${val.slice(0, 37)}..."` : `"${val}"`;
  }
  if (typeof val === "number" || typeof val === "boolean") return String(val);
  if (Array.isArray(val)) return `[${val.length}]`;
  if (typeof val === "object") {
    const keys = Object.keys(val as object);
    if (keys.length === 1 && keys[0] === "$oid") return formatValue(val);
    if (keys.length === 1 && keys[0] === "$date")
      return String((val as Record<string, unknown>)["$date"]);
    return `{${keys.length}}`;
  }
  return String(val);
}
