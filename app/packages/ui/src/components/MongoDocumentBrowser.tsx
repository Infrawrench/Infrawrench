import { useCallback, useEffect, useRef, useState } from "react";
import { useGT } from "gt-react";
import {
  formatMongoPreview,
  formatMongoValue,
  mongoCommands,
  stripMongoId,
  MONGO_PAGE_SIZE,
  type MongoCollectionStats,
} from "@infrawrench/client-core";
import { formatErrorMessage } from "../utils.js";
import { CollectionListItem, DocumentRow, InsertDocumentPanel } from "./document-browser-shared.js";

export interface MongoDocumentBrowserProps {
  databaseName: string;
  connected?: boolean;
  onCommand: (command: string, args: (string | number)[]) => Promise<unknown>;
}

type CollectionStats = MongoCollectionStats;

const PAGE_SIZE = MONGO_PAGE_SIZE;

export function MongoDocumentBrowser({
  databaseName,
  connected = true,
  onCommand,
}: MongoDocumentBrowserProps) {
  const gt = useGT();
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
  const newCollectionInputRef = useRef<HTMLInputElement>(null);

  const refreshCollections = useCallback(async () => {
    setCollectionsLoading(true);
    try {
      const list = mongoCommands.listCollections(databaseName);
      const cols = (await onCommand(list.command, list.args)) as string[];
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
      const findCmd = mongoCommands.find(
        databaseName,
        activeCollection,
        appliedFilter,
        page * PAGE_SIZE,
        PAGE_SIZE,
      );
      const countCmd = mongoCommands.countDocuments(databaseName, activeCollection, appliedFilter);
      const statsCmd = mongoCommands.collectionStats(databaseName, activeCollection);
      const [docs, count, stats] = await Promise.all([
        onCommand(findCmd.command, findCmd.args) as Promise<Record<string, unknown>[]>,
        onCommand(countCmd.command, countCmd.args) as Promise<number>,
        onCommand(statsCmd.command, statsCmd.args) as Promise<CollectionStats>,
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

  useEffect(() => {
    if (showNewCollection) newCollectionInputRef.current?.focus();
  }, [showNewCollection]);

  function handleApplyFilter() {
    const trimmed = filterText.trim() || "{}";
    try {
      JSON.parse(trimmed);
      setAppliedFilter(trimmed);
      setPage(0);
    } catch {
      setError(gt("Invalid JSON filter"));
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
      const cmd = mongoCommands.createCollection(databaseName, name);
      await onCommand(cmd.command, cmd.args);
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
      const cmd = mongoCommands.dropCollection(databaseName, name);
      await onCommand(cmd.command, cmd.args);
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
      setInsertError(gt("Invalid JSON"));
      return;
    }
    try {
      const cmd = mongoCommands.insertOne(databaseName, activeCollection, JSON.stringify(doc));
      await onCommand(cmd.command, cmd.args);
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
      const cmd = mongoCommands.deleteOne(
        databaseName,
        activeCollection,
        JSON.stringify({ _id: id }),
      );
      await onCommand(cmd.command, cmd.args);
      void fetchDocuments();
    } catch (e) {
      setError(formatErrorMessage(e));
    }
  }

  async function handleSaveDocument(doc: Record<string, unknown>, newDocJson: string) {
    if (!activeCollection) return;
    const id = doc["_id"];
    if (id == null) return;
    const cmd = mongoCommands.replaceOne(
      databaseName,
      activeCollection,
      JSON.stringify({ _id: id }),
      stripMongoId(newDocJson),
    );
    await onCommand(cmd.command, cmd.args);
    void fetchDocuments();
  }

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  if (!connected) {
    return (
      <div className="flex-1 flex items-center justify-center text-on-surface-faint text-sm">
        {gt("Connecting to MongoDB…")}
      </div>
    );
  }

  return (
    <div className="flex flex-1 overflow-hidden border-t border-border">
      {/* Collection sidebar */}
      <div className="w-64 border-r border-border flex flex-col overflow-hidden flex-shrink-0 bg-surface">
        <div className="px-3 py-2 border-b border-border/60 flex items-center justify-between">
          <span className="text-xs font-semibold text-on-surface-tertiary uppercase tracking-wide">
            {gt("Collections")}
          </span>
          <button
            type="button"
            onClick={() => setShowNewCollection((v) => !v)}
            className="text-on-surface-faint hover:text-on-surface-secondary transition-colors text-sm leading-none"
            title={gt("Create collection")}
          >
            +
          </button>
        </div>
        {showNewCollection && (
          <div className="p-2 border-b border-border/60 flex gap-1">
            <input
              value={newCollectionName}
              onChange={(e) => setNewCollectionName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleCreateCollection();
                if (e.key === "Escape") setShowNewCollection(false);
              }}
              aria-label={gt("Collection name")}
              placeholder={gt("collection name")}
              className="flex-1 min-w-0 bg-surface-raised border border-border-strong rounded px-2 py-1 text-xs text-on-surface-secondary font-mono placeholder:text-on-surface-faint focus:outline-none focus:border-blue-500"
              ref={newCollectionInputRef}
            />
            <button
              type="button"
              onClick={() => void handleCreateCollection()}
              className="px-2 py-1 rounded bg-blue-600 text-xs text-white hover:bg-blue-500 transition-colors flex-shrink-0"
            >
              {gt("Create")}
            </button>
          </div>
        )}
        <div className="flex-1 overflow-y-auto py-1">
          {collectionsLoading ? (
            <div className="px-3 py-2 text-xs text-on-surface-faint">{gt("Loading…")}</div>
          ) : collections.length === 0 ? (
            <div className="px-3 py-2 text-xs text-on-surface-faint">{gt("No collections")}</div>
          ) : (
            collections.map((col) => (
              <CollectionListItem
                key={col}
                name={col}
                active={col === activeCollection}
                confirming={droppingCollection === col}
                verb="Drop"
                onSelect={() => selectCollection(col)}
                onRequestRemove={() => setDroppingCollection(col)}
                onConfirmRemove={() => void handleDropCollection(col)}
                onCancelRemove={() => setDroppingCollection(null)}
              />
            ))
          )}
        </div>
        {collectionStats && activeCollection && (
          <div className="px-3 py-2 border-t border-border/60 space-y-0.5">
            <div className="text-xs text-on-surface-faint">
              {gt("{count} docs", { count: collectionStats.count.toLocaleString() })}
            </div>
            <div className="text-xs text-on-surface-faint">
              {gt("{count} indexes", { count: collectionStats.nindexes })}
            </div>
            {collectionStats.size > 0 && (
              <div className="text-xs text-on-surface-faint">
                {gt("{size} KB", { size: (collectionStats.size / 1024).toFixed(1) })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Document area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Filter bar */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border/60 bg-surface">
          <span className="text-xs text-on-surface-muted flex-shrink-0">{gt("Filter:")}</span>
          <input
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleApplyFilter();
            }}
            aria-label={gt("Filter query")}
            placeholder='{ "field": "value" }'
            className="flex-1 bg-surface-raised border border-border-strong rounded px-2 py-1 text-xs text-on-surface-secondary font-mono placeholder:text-on-surface-faint focus:outline-none focus:border-blue-500"
            spellCheck={false}
          />
          <button
            type="button"
            onClick={handleApplyFilter}
            className="px-2.5 py-1 rounded bg-surface-overlay border border-border-strong text-xs text-on-surface-secondary hover:bg-surface-sunken hover:border-border-strong transition-colors"
          >
            {gt("Apply")}
          </button>
          <button
            type="button"
            onClick={() => void fetchDocuments()}
            className="px-2 py-1 rounded text-xs text-on-surface-muted hover:text-on-surface-secondary transition-colors"
            title={gt("Refresh")}
          >
            {gt("Refresh")}
          </button>
          {activeCollection && (
            <button
              type="button"
              onClick={() => setShowInsertDoc((v) => !v)}
              className="px-2.5 py-1 rounded bg-blue-600/80 border border-blue-500/50 text-xs text-white hover:bg-blue-600 transition-colors"
            >
              {gt("+ Insert")}
            </button>
          )}
        </div>

        {/* Insert document editor */}
        {showInsertDoc && activeCollection && (
          <InsertDocumentPanel
            collection={activeCollection}
            text={insertDocText}
            error={insertError}
            onTextChange={setInsertDocText}
            onCancel={() => {
              setShowInsertDoc(false);
              setInsertError(null);
            }}
            onSubmit={() => void handleInsertDocument()}
          />
        )}

        {/* Error banner */}
        {error && (
          <div className="px-3 py-2 bg-red-500/10 border-b border-red-500/20">
            <span className="text-xs text-danger">{error}</span>
          </div>
        )}

        {/* Document list */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto">
          {!activeCollection ? (
            <div className="flex items-center justify-center h-full text-on-surface-faint text-sm">
              {gt("Select a collection")}
            </div>
          ) : loading ? (
            <div className="flex items-center justify-center h-full text-on-surface-faint text-sm">
              {gt("Loading…")}
            </div>
          ) : documents.length === 0 ? (
            <div className="flex items-center justify-center h-full text-on-surface-faint text-sm">
              {gt("No documents found")}
            </div>
          ) : (
            <div className="divide-y divide-border/50">
              {documents.map((doc, idx) => (
                <DocumentRow
                  key={idx}
                  doc={doc}
                  index={page * PAGE_SIZE + idx}
                  idLabel={doc["_id"] != null ? formatMongoValue(doc["_id"]) : ""}
                  hiddenKey="_id"
                  panelIdPrefix="mongo-doc"
                  formatPreview={formatMongoPreview}
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
              {totalCount === 1
                ? gt("1 document")
                : gt("{count} documents", { count: totalCount.toLocaleString() })}
              {appliedFilter !== "{}" && gt(" (filtered)")}
            </span>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0}
                className="px-2 py-0.5 rounded text-xs text-on-surface-tertiary hover:text-on-surface-secondary hover:bg-surface-overlay disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
              >
                {gt("Prev")}
              </button>
              <span className="text-xs text-on-surface-muted">
                {gt("{page} / {total}", { page: page + 1, total: totalPages })}
              </span>
              <button
                type="button"
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                disabled={page >= totalPages - 1}
                className="px-2 py-0.5 rounded text-xs text-on-surface-tertiary hover:text-on-surface-secondary hover:bg-surface-overlay disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
              >
                {gt("Next")}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
