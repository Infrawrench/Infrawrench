import { useState, useRef, useEffect, useCallback } from "react";
import type { QueryCostEstimate, SqlTableMeta } from "@infrawrench/plugin-base";

export interface QueryResult {
  rows: Record<string, unknown>[];
  durationMs: number;
}

interface Props {
  tables: SqlTableMeta[];
  defaultQuery: string;
  onRunQuery: (sql: string) => Promise<QueryResult>;
  /** Run a mutation with typed params ($1, $2 …); returns rows affected */
  onExecute?: (sql: string, params: unknown[]) => Promise<number>;
  /** When provided, the editor shows an "Estimate" button that runs a dry-run cost query. */
  onEstimateQueryCost?: (sql: string) => Promise<QueryCostEstimate>;
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(2)} KiB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(2)} MiB`;
  if (n < 1024 ** 4) return `${(n / 1024 ** 3).toFixed(2)} GiB`;
  return `${(n / 1024 ** 4).toFixed(2)} TiB`;
}

function formatUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0.00";
  if (n < 0.01) return `< $0.01`;
  if (n < 1) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

/** Parse the first table name after FROM in a SQL string */
function parseTableName(sql: string): string | null {
  const m = sql.match(/\bFROM\s+"?([a-z_][a-z0-9_]*)"?/i);
  return m?.[1] ?? null;
}

function csvEscape(val: unknown): string {
  if (val === null || val === undefined) return "";
  const s = typeof val === "object" ? JSON.stringify(val) : String(val);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function rowsToCsv(rows: Record<string, unknown>[], columns: string[]): string {
  const header = columns.map(csvEscape).join(",");
  const body = rows.map((r) => columns.map((c) => csvEscape(r[c])).join(",")).join("\r\n");
  return `${header}\r\n${body}`;
}

function downloadCsv(filename: string, csv: string) {
  const blob = new Blob(["﻿", csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Map information_schema data_type → Postgres cast suffix for $n params */
function pgCast(dataType: string): string {
  switch (dataType) {
    case "timestamp without time zone":
      return "::timestamp";
    case "timestamp with time zone":
      return "::timestamptz";
    case "date":
      return "::date";
    case "time without time zone":
      return "::time";
    case "boolean":
      return "::boolean";
    case "integer":
      return "::integer";
    case "bigint":
      return "::bigint";
    case "smallint":
      return "::smallint";
    case "numeric":
    case "decimal":
      return "::numeric";
    case "double precision":
      return "::float8";
    case "real":
      return "::float4";
    case "uuid":
      return "::uuid";
    case "json":
      return "::json";
    case "jsonb":
      return "::jsonb";
    default:
      return "";
  }
}

export function SqlEditorView({
  tables,
  defaultQuery,
  onRunQuery,
  onExecute,
  onEstimateQueryCost,
}: Props) {
  const [query, setQuery] = useState(defaultQuery);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [estimate, setEstimate] = useState<QueryCostEstimate | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [estimateError, setEstimateError] = useState<string | null>(null);
  const [tableSearch, setTableSearch] = useState("");
  const [expandedTables, setExpandedTables] = useState<Set<string>>(new Set());

  const runEstimate = useCallback(
    async (sql: string) => {
      if (!onEstimateQueryCost || !sql.trim()) return;
      setEstimating(true);
      setEstimateError(null);
      setEstimate(null);
      try {
        const r = await onEstimateQueryCost(sql);
        setEstimate(r);
      } catch (e) {
        setEstimateError(String(e));
      } finally {
        setEstimating(false);
      }
    },
    [onEstimateQueryCost],
  );

  // Inline editing state
  const [editingRow, setEditingRow] = useState<number | null>(null);
  const [editValues, setEditValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const runQuery = useCallback(
    async (sql: string) => {
      if (!sql.trim()) return;
      setRunning(true);
      setError(null);
      setResult(null);
      setEditingRow(null);
      setSaveError(null);
      try {
        const r = await onRunQuery(sql);
        setResult(r);
      } catch (e) {
        setError(String(e));
      } finally {
        setRunning(false);
      }
    },
    [onRunQuery],
  );

  useEffect(() => {
    runQuery(defaultQuery);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      runQuery(query);
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      const ta = textareaRef.current;
      if (!ta) return;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      setQuery(query.slice(0, start) + "  " + query.slice(end));
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = start + 2;
      });
    }
  }

  function clickTable(tableName: string) {
    const sql = `SELECT * FROM ${tableName} LIMIT 100;`;
    setQuery(sql);
    textareaRef.current?.focus();
    runQuery(sql);
  }

  function toggleTableExpand(tableName: string) {
    setExpandedTables((prev) => {
      const next = new Set(prev);
      if (next.has(tableName)) next.delete(tableName);
      else next.add(tableName);
      return next;
    });
  }

  // Derive editable context from the current query + result
  const tableName = parseTableName(query);
  const tableMeta = tableName ? tables.find((t) => t.name === tableName) : null;
  const pkCols: string[] = tableMeta?.pkColumns ?? [];
  const columns = result && result.rows.length > 0 ? Object.keys(result.rows[0]!) : [];
  const canEdit = !!onExecute && pkCols.length > 0 && pkCols.every((pk) => columns.includes(pk));

  function startEdit(rowIdx: number, row: Record<string, unknown>) {
    setEditingRow(rowIdx);
    setSaveError(null);
    setEditValues(
      Object.fromEntries(columns.map((k) => [k, row[k] === null ? "" : String(row[k] ?? "")])),
    );
  }

  function cancelEdit() {
    setEditingRow(null);
    setSaveError(null);
  }

  async function saveEdit(originalRow: Record<string, unknown>) {
    if (!tableName || !onExecute || pkCols.length === 0) return;
    setSaving(true);
    setSaveError(null);
    try {
      const colTypeMap = new Map((tableMeta?.columns ?? []).map((c) => [c.name, c.type]));

      // Only include columns whose value actually changed
      const changedCols = columns.filter((c) => {
        if (pkCols.includes(c)) return false;
        const original = originalRow[c] === null ? "" : String(originalRow[c] ?? "");
        return editValues[c] !== original;
      });

      if (changedCols.length === 0) {
        setEditingRow(null);
        return;
      }

      const params: unknown[] = [];
      const setClauses = changedCols.map((col) => {
        const val = editValues[col];
        params.push(val === "" ? null : val);
        const cast = pgCast(colTypeMap.get(col) ?? "");
        return `"${col}" = $${params.length}${cast}`;
      });
      const whereClauses = pkCols.map((pk) => {
        params.push(originalRow[pk]);
        const cast = pgCast(colTypeMap.get(pk) ?? "");
        return `"${pk}" = $${params.length}${cast}`;
      });

      const sql = `UPDATE "${tableName}" SET ${setClauses.join(", ")} WHERE ${whereClauses.join(" AND ")}`;
      await onExecute(sql, params);
      setEditingRow(null);
      await runQuery(query);
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setSaving(false);
    }
  }

  const filteredTables = tableSearch
    ? tables.filter((t) => t.name.toLowerCase().includes(tableSearch.toLowerCase()))
    : tables;

  return (
    <div className="flex h-full overflow-hidden">
      {/* Table browser */}
      <div className="w-52 shrink-0 border-r border-border flex flex-col bg-surface">
        <div className="px-3 py-2 border-b border-border">
          <input
            type="text"
            aria-label="Search tables"
            placeholder="Search tables…"
            value={tableSearch}
            onChange={(e) => setTableSearch(e.target.value)}
            className="w-full bg-surface-raised border border-border-strong rounded-md px-2 py-1 text-xs text-on-surface-secondary placeholder:text-on-surface-faint focus:outline-none focus:border-border-strong"
          />
        </div>
        <div className="flex-1 overflow-y-auto py-1">
          {tables.length === 0 ? (
            <p className="px-3 py-2 text-xs text-on-surface-faint">No tables found</p>
          ) : filteredTables.length === 0 ? (
            <p className="px-3 py-2 text-xs text-on-surface-faint">No matches</p>
          ) : (
            filteredTables.map((table) => {
              const expanded = expandedTables.has(table.name);
              const pks = new Set(table.pkColumns ?? []);
              return (
                <div key={table.name}>
                  <div className="flex items-center group">
                    <button
                      type="button"
                      onClick={() => toggleTableExpand(table.name)}
                      aria-expanded={expanded}
                      aria-label={`${expanded ? "Collapse" : "Expand"} ${table.name} columns`}
                      className="w-4 h-6 flex items-center justify-center text-on-surface-faint hover:text-on-surface-tertiary shrink-0"
                    >
                      {table.columns.length > 0 && (
                        <svg
                          aria-hidden="true"
                          className={`size-2.5 transition-transform ${expanded ? "rotate-90" : ""}`}
                          viewBox="0 0 6 10"
                          fill="none"
                        >
                          <path
                            d="M1 1l4 4-4 4"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                          />
                        </svg>
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => clickTable(table.name)}
                      className="flex-1 text-left p-1 text-xs text-on-surface-secondary hover:text-white hover:bg-surface-overlay rounded truncate leading-tight"
                    >
                      {table.name}
                    </button>
                  </div>
                  {expanded && table.columns.length > 0 && (
                    <div className="ml-4 border-l border-border pl-2 mb-0.5">
                      {table.columns.map((col) => (
                        <div key={col.name} className="flex items-baseline gap-1.5 py-0.5">
                          {pks.has(col.name) && (
                            <span
                              className="text-yellow-500 text-xs leading-none"
                              title="Primary key"
                              aria-label="Primary key"
                            >
                              ⚿
                            </span>
                          )}
                          <span className="text-xs text-on-surface-tertiary truncate">
                            {col.name}
                          </span>
                          <span className="text-xs text-on-surface-faint truncate shrink-0">
                            {col.type}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Editor + results */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Editor */}
        <div
          className="flex flex-col border-b border-border"
          style={{ minHeight: "160px", maxHeight: "40%" }}
        >
          <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-surface">
            <span className="text-xs font-semibold text-on-surface-muted uppercase tracking-wide">
              Query
            </span>
            <div className="ml-auto flex items-center gap-2">
              {estimateError && (
                <span
                  className="text-xs text-red-400 font-mono max-w-xs truncate"
                  title={estimateError}
                >
                  {estimateError}
                </span>
              )}
              {estimate && !estimateError && (
                <span className="text-xs text-on-surface-tertiary font-mono">
                  {estimate.cacheHit ? (
                    <>cache hit · free</>
                  ) : (
                    <>
                      {formatBytes(estimate.bytesProcessed)}
                      {typeof estimate.estimatedCostUsd === "number" && (
                        <> · {formatUsd(estimate.estimatedCostUsd)}</>
                      )}
                    </>
                  )}
                </span>
              )}
              {result && (
                <span className="text-xs text-on-surface-faint">
                  {result.rows.length} row{result.rows.length !== 1 ? "s" : ""} ·{" "}
                  {result.durationMs}ms
                </span>
              )}
              {result && result.rows.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    const cols = Object.keys(result.rows[0]!);
                    const name = parseTableName(query) ?? "query";
                    const ts = new Date().toISOString().replace(/[:.]/g, "-");
                    downloadCsv(`${name}-${ts}.csv`, rowsToCsv(result.rows, cols));
                  }}
                  title="Download results as CSV"
                  className="px-3 py-1 text-xs font-medium border border-border-strong hover:border-blue-500 text-on-surface-secondary rounded-md transition-colors whitespace-nowrap"
                >
                  Export CSV
                </button>
              )}
              {onEstimateQueryCost && (
                <button
                  type="button"
                  onClick={() => runEstimate(query)}
                  disabled={estimating}
                  title={
                    estimate?.pricingNote ?? "Dry-run query to estimate scanned bytes and cost"
                  }
                  className="px-3 py-1 text-xs font-medium border border-border-strong hover:border-blue-500 disabled:opacity-50 text-on-surface-secondary rounded-md transition-colors whitespace-nowrap"
                >
                  {estimating ? "Estimating…" : "Estimate"}
                </button>
              )}
              <button
                type="button"
                onClick={() => runQuery(query)}
                disabled={running}
                className="px-3 py-1 text-xs font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-md transition-colors whitespace-nowrap"
              >
                {running ? "Running…" : "Run  ⌘↵"}
              </button>
            </div>
          </div>
          <textarea
            ref={textareaRef}
            aria-label="SQL query"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            spellCheck={false}
            className="flex-1 bg-surface-raised px-4 py-3 text-xs font-mono text-on-surface-secondary placeholder:text-on-surface-faint focus:outline-none resize-none"
            placeholder="SELECT …"
          />
        </div>

        {/* Results */}
        <div className="flex-1 overflow-auto bg-surface">
          {error && (
            <div className="p-4 text-xs text-red-400 font-mono whitespace-pre-wrap">{error}</div>
          )}
          {!error && !result && !running && (
            <div className="p-4 text-xs text-on-surface-faint">Run a query to see results.</div>
          )}
          {running && <div className="p-4 text-xs text-on-surface-faint">Running…</div>}
          {result && result.rows.length === 0 && !error && (
            <div className="p-4 text-xs text-on-surface-faint">Query returned no rows.</div>
          )}

          {result && result.rows.length > 0 && (
            <>
              {saveError && (
                <div className="px-3 py-2 text-xs text-red-400 font-mono border-b border-border">
                  {saveError}
                </div>
              )}
              <table className="w-full text-xs border-collapse">
                <thead className="sticky top-0 bg-surface-raised z-10">
                  <tr>
                    {canEdit && <th className="w-8 border-b border-border" />}
                    {columns.map((col) => (
                      <th
                        key={col}
                        className="px-3 py-2 text-left border-b border-border whitespace-nowrap"
                      >
                        <span
                          className={
                            pkCols.includes(col)
                              ? "text-yellow-400 font-semibold"
                              : "text-on-surface-tertiary font-semibold"
                          }
                        >
                          {col}
                          {pkCols.includes(col) && (
                            <span className="ml-1 text-yellow-600 text-xs">PK</span>
                          )}
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((row, i) => {
                    const isEditing = editingRow === i;
                    return (
                      <tr
                        key={i}
                        className={`border-b border-border/40 ${isEditing ? "bg-surface-overlay/60" : i % 2 === 0 ? "" : "bg-surface-raised/30"} hover:bg-surface-overlay/20`}
                      >
                        {canEdit && (
                          <td className="w-8 px-1 text-center">
                            {isEditing ? (
                              <div className="flex flex-col gap-0.5">
                                <button
                                  type="button"
                                  onClick={() => saveEdit(row)}
                                  disabled={saving}
                                  className="text-accent hover:text-accent-on-muted text-xs leading-none disabled:opacity-40"
                                  title="Save"
                                >
                                  {saving ? "…" : "✓"}
                                </button>
                                <button
                                  type="button"
                                  onClick={cancelEdit}
                                  className="text-on-surface-muted hover:text-on-surface-secondary text-xs leading-none"
                                  title="Cancel"
                                >
                                  ✕
                                </button>
                              </div>
                            ) : (
                              <button
                                type="button"
                                onClick={() => startEdit(i, row)}
                                className="text-on-surface-faint hover:text-on-surface-secondary opacity-0 group-hover:opacity-100 transition-all text-xs"
                                title="Edit row"
                              >
                                ✎
                              </button>
                            )}
                          </td>
                        )}
                        {columns.map((col) => {
                          const val = row[col];
                          const isPk = pkCols.includes(col);
                          if (isEditing && !isPk) {
                            return (
                              <td key={col} className="px-1 py-0.5">
                                <input
                                  aria-label={`Edit ${col}`}
                                  value={editValues[col] ?? ""}
                                  onChange={(e) =>
                                    setEditValues((prev) => ({ ...prev, [col]: e.target.value }))
                                  }
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter" && !e.shiftKey) {
                                      e.preventDefault();
                                      saveEdit(row);
                                    }
                                    if (e.key === "Escape") cancelEdit();
                                  }}
                                  className="w-full bg-surface-sunken border border-border-strong rounded px-2 py-0.5 text-xs font-mono text-on-surface focus:outline-none focus:border-blue-400"
                                  placeholder="NULL"
                                />
                              </td>
                            );
                          }
                          const editable = canEdit && !isPk;
                          return (
                            <td
                              key={col}
                              className={`px-3 py-1.5 font-mono whitespace-nowrap max-w-xs overflow-hidden text-ellipsis ${isPk ? "text-yellow-600 dark:text-yellow-300/80" : "text-on-surface-secondary"}`}
                              title={val === null ? "NULL" : String(val)}
                              onDoubleClick={editable ? () => startEdit(i, row) : undefined}
                              tabIndex={editable ? 0 : undefined}
                              onKeyDown={
                                editable
                                  ? (e) => {
                                      if (e.key === "Enter" || e.key === " ") {
                                        e.preventDefault();
                                        startEdit(i, row);
                                      }
                                    }
                                  : undefined
                              }
                            >
                              {val === null ? (
                                <span className="text-on-surface-faint not-italic">NULL</span>
                              ) : typeof val === "object" ? (
                                <span className="text-on-surface-tertiary">
                                  {JSON.stringify(val)}
                                </span>
                              ) : (
                                String(val)
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
