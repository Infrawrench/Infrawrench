import { useCallback, useEffect, useRef, useState } from "react";
import { apiPost } from "@/lib/api";

async function kvCommand(input: { accountId: string; command: string; args: (string | number)[] }): Promise<unknown> {
  const { result } = await apiPost<{ result: unknown }>("/api/kv/command", input);
  return result;
}
import { formatErrorMessage } from "@/lib/errors";

interface MongoDocumentBrowserProps {
  accountId: string;
  databaseName: string;
}

interface CollectionStats {
  count: number;
  size: number;
  avgObjSize: number;
  nindexes: number;
}

const PAGE_SIZE = 25;

export function MongoDocumentBrowser({ accountId, databaseName }: MongoDocumentBrowserProps) {
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
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setCollectionsLoading(true);
    kvCommand({ accountId, command: "listCollections", args: [databaseName] })
      .then((result) => {
        if (cancelled) return;
        const cols = result as string[];
        setCollections(cols);
        setCollectionsLoading(false);
        if (cols.length > 0 && !activeCollection) {
          setActiveCollection(cols[0] ?? null);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(formatErrorMessage(e));
          setCollectionsLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, [accountId, databaseName]); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchDocuments = useCallback(async () => {
    if (!activeCollection) return;
    setLoading(true);
    setError(null);
    try {
      const [docs, count, stats] = await Promise.all([
        kvCommand({ accountId, command: "find", args: [databaseName, activeCollection, appliedFilter, page * PAGE_SIZE, PAGE_SIZE] }) as Promise<Record<string, unknown>[]>,
        kvCommand({ accountId, command: "countDocuments", args: [databaseName, activeCollection, appliedFilter] }) as Promise<number>,
        kvCommand({ accountId, command: "collectionStats", args: [databaseName, activeCollection] }) as Promise<CollectionStats>,
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
  }, [activeCollection, accountId, databaseName, appliedFilter, page]);

  useEffect(() => { void fetchDocuments(); }, [fetchDocuments]);

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
      await kvCommand({ accountId, command: "createCollection", args: [databaseName, name] });
      setNewCollectionName("");
      setShowNewCollection(false);
      const cols = await kvCommand({ accountId, command: "listCollections", args: [databaseName] }) as string[];
      setCollections(cols);
      setActiveCollection(name);
      setPage(0);
      setFilterText("");
      setAppliedFilter("{}");
    } catch (e) {
      setError(formatErrorMessage(e));
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
      await kvCommand({ accountId, command: "insertOne", args: [databaseName, activeCollection, JSON.stringify(doc)] });
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
      await kvCommand({ accountId, command: "deleteOne", args: [databaseName, activeCollection, JSON.stringify({ _id: id })] });
      void fetchDocuments();
    } catch (e) {
      setError(formatErrorMessage(e));
    }
  }

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  return (
    <div className="flex flex-1 overflow-hidden border-t border-gray-800">
      {/* Collection sidebar */}
      <div className="w-64 border-r border-gray-800 flex flex-col overflow-hidden flex-shrink-0 bg-gray-950">
        <div className="px-3 py-2 border-b border-gray-800/60 flex items-center justify-between">
          <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Collections</span>
          <button
            onClick={() => setShowNewCollection((v) => !v)}
            className="text-gray-600 hover:text-gray-300 transition-colors text-sm leading-none"
            title="Create collection"
          >
            +
          </button>
        </div>
        {showNewCollection && (
          <div className="px-2 py-2 border-b border-gray-800/60 flex gap-1">
            <input
              value={newCollectionName}
              onChange={(e) => setNewCollectionName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void handleCreateCollection(); }}
              placeholder="collection name"
              className="flex-1 min-w-0 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 font-mono placeholder-gray-600 focus:outline-none focus:border-blue-500"
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
            <div className="px-3 py-2 text-xs text-gray-600">Loading...</div>
          ) : collections.length === 0 ? (
            <div className="px-3 py-2 text-xs text-gray-600">No collections</div>
          ) : (
            collections.map((col) => (
              <button
                key={col}
                onClick={() => selectCollection(col)}
                className={`w-full text-left px-3 py-1.5 text-xs truncate transition-colors ${
                  col === activeCollection
                    ? "bg-blue-600/20 text-blue-200 font-medium"
                    : "text-gray-400 hover:text-gray-200 hover:bg-gray-800"
                }`}
              >
                {col}
              </button>
            ))
          )}
        </div>
        {collectionStats && activeCollection && (
          <div className="px-3 py-2 border-t border-gray-800/60 space-y-0.5">
            <div className="text-xs text-gray-600">{collectionStats.count.toLocaleString()} docs</div>
            <div className="text-xs text-gray-600">{collectionStats.nindexes} indexes</div>
            {collectionStats.size > 0 && (
              <div className="text-xs text-gray-600">
                {(collectionStats.size / 1024).toFixed(1)} KB
              </div>
            )}
          </div>
        )}
      </div>

      {/* Document area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Filter bar */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-800/60 bg-gray-950">
          <span className="text-xs text-gray-500 flex-shrink-0">Filter:</span>
          <input
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleApplyFilter(); }}
            placeholder='{ "field": "value" }'
            className="flex-1 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 font-mono placeholder-gray-600 focus:outline-none focus:border-blue-500"
            spellCheck={false}
          />
          <button
            onClick={handleApplyFilter}
            className="px-2.5 py-1 rounded bg-gray-800 border border-gray-700 text-xs text-gray-300 hover:bg-gray-700 hover:border-gray-600 transition-colors"
          >
            Apply
          </button>
          <button
            onClick={() => void fetchDocuments()}
            className="px-2 py-1 rounded text-xs text-gray-500 hover:text-gray-300 transition-colors"
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
          <div className="px-3 py-3 border-b border-gray-800/60 bg-gray-950/80">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-gray-400 font-medium">Insert Document into <span className="text-gray-200">{activeCollection}</span></span>
              <button
                onClick={() => { setShowInsertDoc(false); setInsertError(null); }}
                className="text-xs text-gray-600 hover:text-gray-400 transition-colors"
              >
                Cancel
              </button>
            </div>
            <textarea
              value={insertDocText}
              onChange={(e) => setInsertDocText(e.target.value)}
              rows={6}
              className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-xs text-gray-200 font-mono placeholder-gray-600 focus:outline-none focus:border-blue-500 resize-y"
              spellCheck={false}
              placeholder='{ "key": "value" }'
            />
            {insertError && (
              <div className="text-xs text-red-400 mt-1">{insertError}</div>
            )}
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
            <div className="flex items-center justify-center h-full text-gray-600 text-sm">
              Select a collection
            </div>
          ) : loading ? (
            <div className="flex items-center justify-center h-full text-gray-600 text-sm">
              Loading...
            </div>
          ) : documents.length === 0 ? (
            <div className="flex items-center justify-center h-full text-gray-600 text-sm">
              No documents found
            </div>
          ) : (
            <div className="divide-y divide-gray-800/50">
              {documents.map((doc, idx) => (
                <DocumentRow
                  key={idx}
                  doc={doc}
                  index={page * PAGE_SIZE + idx}
                  expanded={expandedIds.has(idx)}
                  onToggle={() => toggleExpanded(idx)}
                  onDelete={() => void handleDeleteDocument(doc)}
                />
              ))}
            </div>
          )}
        </div>

        {/* Pagination footer */}
        {activeCollection && totalCount > 0 && (
          <div className="flex items-center justify-between px-3 py-2 border-t border-gray-800/60 bg-gray-950">
            <span className="text-xs text-gray-500">
              {totalCount.toLocaleString()} document{totalCount === 1 ? "" : "s"}
              {appliedFilter !== "{}" && " (filtered)"}
            </span>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0}
                className="px-2 py-0.5 rounded text-xs text-gray-400 hover:text-gray-200 hover:bg-gray-800 disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
              >
                Prev
              </button>
              <span className="text-xs text-gray-500">
                {page + 1} / {totalPages}
              </span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                disabled={page >= totalPages - 1}
                className="px-2 py-0.5 rounded text-xs text-gray-400 hover:text-gray-200 hover:bg-gray-800 disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
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

function DocumentRow({ doc, index, expanded, onToggle, onDelete }: {
  doc: Record<string, unknown>; index: number; expanded: boolean; onToggle: () => void; onDelete: () => void;
}) {
  const id = doc["_id"];
  const previewFields = Object.entries(doc).filter(([k]) => k !== "_id").slice(0, 4);

  return (
    <div className="group">
      <div className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-gray-800/30 transition-colors" onClick={onToggle}>
        <span className={`text-gray-600 text-xs transition-transform flex-shrink-0 ${expanded ? "rotate-90" : ""}`}>&#9654;</span>
        <span className="text-xs text-gray-500 w-8 flex-shrink-0 text-right font-mono">{index}</span>
        {id != null && (
          <span className="text-xs text-blue-400/70 font-mono flex-shrink-0 truncate max-w-[160px]">{formatValue(id)}</span>
        )}
        <div className="flex-1 min-w-0 flex items-center gap-3 overflow-hidden">
          {previewFields.map(([key, val]) => (
            <span key={key} className="text-xs truncate flex-shrink">
              <span className="text-gray-600">{key}:</span>{" "}
              <span className="text-gray-400">{formatPreview(val)}</span>
            </span>
          ))}
        </div>
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          className="opacity-0 group-hover:opacity-100 text-xs text-gray-700 hover:text-red-400 px-1 transition-all flex-shrink-0"
          title="Delete document"
        >
          Delete
        </button>
      </div>
      {expanded && (
        <div className="px-12 pb-3">
          <pre className="text-xs font-mono text-gray-300 bg-gray-900/50 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap break-words">
            {JSON.stringify(doc, null, 2)}
          </pre>
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
  if (val === undefined) return "\u2014";
  if (typeof val === "string") return val.length > 40 ? `"${val.slice(0, 37)}..."` : `"${val}"`;
  if (typeof val === "number" || typeof val === "boolean") return String(val);
  if (Array.isArray(val)) return `[${val.length}]`;
  if (typeof val === "object") {
    const keys = Object.keys(val as object);
    if (keys.length === 1 && keys[0] === "$oid") return formatValue(val);
    if (keys.length === 1 && keys[0] === "$date") return String((val as Record<string, unknown>)["$date"]);
    return `{${keys.length}}`;
  }
  return String(val);
}
