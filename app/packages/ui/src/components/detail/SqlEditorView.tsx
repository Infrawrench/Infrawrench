import { useState, useRef, useEffect, useCallback } from "react";
import type { SqlTableMeta } from "@infrawrench/plugin-base";

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
}

/** Parse the first table name after FROM in a SQL string */
function parseTableName(sql: string): string | null {
  const m = sql.match(/\bFROM\s+"?([a-z_][a-z0-9_]*)"?/i);
  return m?.[1] ?? null;
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

export function SqlEditorView({ tables, defaultQuery, onRunQuery, onExecute }: Props) {
  const [query, setQuery] = useState(defaultQuery);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [tableSearch, setTableSearch] = useState("");
  const [expandedTables, setExpandedTables] = useState<Set<string>>(new Set());

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
      <div className="w-52 shrink-0 border-r border-gray-800 flex flex-col bg-gray-950">
        <div className="px-3 py-2 border-b border-gray-800">
          <input
            type="text"
            placeholder="Search tables…"
            value={tableSearch}
            onChange={(e) => setTableSearch(e.target.value)}
            className="w-full bg-gray-900 border border-gray-700 rounded-md px-2 py-1 text-xs text-gray-300 placeholder-gray-600 focus:outline-none focus:border-gray-500"
          />
        </div>
        <div className="flex-1 overflow-y-auto py-1">
          {tables.length === 0 ? (
            <p className="px-3 py-2 text-xs text-gray-600">No tables found</p>
          ) : filteredTables.length === 0 ? (
            <p className="px-3 py-2 text-xs text-gray-600">No matches</p>
          ) : (
            filteredTables.map((table) => {
              const expanded = expandedTables.has(table.name);
              const pks = new Set(table.pkColumns ?? []);
              return (
                <div key={table.name}>
                  <div className="flex items-center group">
                    <button
                      onClick={() => toggleTableExpand(table.name)}
                      className="w-4 h-6 flex items-center justify-center text-gray-600 hover:text-gray-400 shrink-0"
                    >
                      {table.columns.length > 0 && (
                        <svg
                          className={`w-2.5 h-2.5 transition-transform ${expanded ? "rotate-90" : ""}`}
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
                      onClick={() => clickTable(table.name)}
                      className="flex-1 text-left px-1 py-1 text-xs text-gray-300 hover:text-white hover:bg-gray-800 rounded truncate leading-tight"
                    >
                      {table.name}
                    </button>
                  </div>
                  {expanded && table.columns.length > 0 && (
                    <div className="ml-4 border-l border-gray-800 pl-2 mb-0.5">
                      {table.columns.map((col) => (
                        <div key={col.name} className="flex items-baseline gap-1.5 py-0.5">
                          {pks.has(col.name) && (
                            <span
                              className="text-yellow-500 text-xs leading-none"
                              title="Primary key"
                            >
                              ⚿
                            </span>
                          )}
                          <span className="text-xs text-gray-400 truncate">{col.name}</span>
                          <span className="text-xs text-gray-600 truncate shrink-0">
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
          className="flex flex-col border-b border-gray-800"
          style={{ minHeight: "160px", maxHeight: "40%" }}
        >
          <div className="flex items-center gap-2 px-3 py-1.5 border-b border-gray-800 bg-gray-950">
            <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
              Query
            </span>
            <div className="ml-auto flex items-center gap-2">
              {result && (
                <span className="text-xs text-gray-600">
                  {result.rows.length} row{result.rows.length !== 1 ? "s" : ""} ·{" "}
                  {result.durationMs}ms
                </span>
              )}
              <button
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
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            spellCheck={false}
            className="flex-1 bg-gray-900 px-4 py-3 text-xs font-mono text-gray-200 placeholder-gray-600 focus:outline-none resize-none"
            placeholder="SELECT …"
          />
        </div>

        {/* Results */}
        <div className="flex-1 overflow-auto bg-gray-950">
          {error && (
            <div className="p-4 text-xs text-red-400 font-mono whitespace-pre-wrap">{error}</div>
          )}
          {!error && !result && !running && (
            <div className="p-4 text-xs text-gray-600">Run a query to see results.</div>
          )}
          {running && <div className="p-4 text-xs text-gray-600">Running…</div>}
          {result && result.rows.length === 0 && !error && (
            <div className="p-4 text-xs text-gray-600">Query returned no rows.</div>
          )}

          {result && result.rows.length > 0 && (
            <>
              {saveError && (
                <div className="px-3 py-2 text-xs text-red-400 font-mono border-b border-gray-800">
                  {saveError}
                </div>
              )}
              <table className="w-full text-xs border-collapse">
                <thead className="sticky top-0 bg-gray-900 z-10">
                  <tr>
                    {canEdit && <th className="w-8 border-b border-gray-800" />}
                    {columns.map((col) => (
                      <th
                        key={col}
                        className="px-3 py-2 text-left border-b border-gray-800 whitespace-nowrap"
                      >
                        <span
                          className={
                            pkCols.includes(col)
                              ? "text-yellow-400 font-semibold"
                              : "text-gray-400 font-semibold"
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
                        className={`border-b border-gray-800/40 ${isEditing ? "bg-gray-800/60" : i % 2 === 0 ? "" : "bg-gray-900/30"} hover:bg-gray-800/20`}
                      >
                        {canEdit && (
                          <td className="w-8 px-1 text-center">
                            {isEditing ? (
                              <div className="flex flex-col gap-0.5">
                                <button
                                  onClick={() => saveEdit(row)}
                                  disabled={saving}
                                  className="text-blue-400 hover:text-blue-300 text-xs leading-none disabled:opacity-40"
                                  title="Save"
                                >
                                  {saving ? "…" : "✓"}
                                </button>
                                <button
                                  onClick={cancelEdit}
                                  className="text-gray-500 hover:text-gray-300 text-xs leading-none"
                                  title="Cancel"
                                >
                                  ✕
                                </button>
                              </div>
                            ) : (
                              <button
                                onClick={() => startEdit(i, row)}
                                className="text-gray-600 hover:text-gray-300 opacity-0 group-hover:opacity-100 transition-all text-xs"
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
                                  className="w-full bg-gray-700 border border-gray-500 rounded px-2 py-0.5 text-xs font-mono text-gray-100 focus:outline-none focus:border-blue-400"
                                  placeholder="NULL"
                                />
                              </td>
                            );
                          }
                          return (
                            <td
                              key={col}
                              className={`px-3 py-1.5 font-mono whitespace-nowrap max-w-xs overflow-hidden text-ellipsis ${isPk ? "text-yellow-300/80" : "text-gray-300"}`}
                              title={val === null ? "NULL" : String(val)}
                              onDoubleClick={canEdit && !isPk ? () => startEdit(i, row) : undefined}
                            >
                              {val === null ? (
                                <span className="text-gray-600 not-italic">NULL</span>
                              ) : typeof val === "object" ? (
                                <span className="text-gray-400">{JSON.stringify(val)}</span>
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
