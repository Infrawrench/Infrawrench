import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useGT } from "gt-react";
import {
  compileLogSearch,
  computeAppendedLines,
  logStreamKey,
  splitLogLines,
  LOG_WORKSPACE_LIMITS,
  type LogStreamSelector,
  type LogWorkspaceQuery,
} from "@infrawrench/client-core";
import type { LogResourceOption, LogWorkspaceClient } from "./types.js";

const POLL_INTERVAL_MS = 3000;
const TAIL_OPTIONS = [100, 500, 1000];
const MERGED_LINE_CAP = 3000;

/** Per-stream label colors, assigned round-robin as streams are added. */
const STREAM_COLORS = [
  "text-series-1",
  "text-series-2",
  "text-series-3",
  "text-series-4",
  "text-series-5",
  "text-series-6",
  "text-series-7",
  "text-series-8",
];

interface StreamState {
  selector: LogStreamSelector;
  label: string;
  colorIdx: number;
  containers: string[];
  error: string | null;
  loaded: boolean;
}

interface MergedLine {
  seq: number;
  streamKey: string;
  text: string;
}

export interface LogWorkspacePanelProps {
  client: LogWorkspaceClient;
  /** Open a stream's resource detail page (chip click). Optional. */
  onOpenResource?: ((selector: LogStreamSelector) => void) | undefined;
}

function optionLabel(option: LogResourceOption): string {
  return option.parentDisplayName
    ? `${option.displayName} · ${option.parentDisplayName} · ${option.accountName}`
    : `${option.displayName} · ${option.accountName}`;
}

/**
 * Identity of an option / added stream in the picker. Includes the parent:
 * two clusters in one account can both run a pod with the same
 * namespace/name, so account + resource id alone is ambiguous.
 */
function optionKey(option: {
  accountId: string;
  resourceId: string;
  parentResourceId?: string | undefined;
}): string {
  return `${option.accountId}:${option.parentResourceId ?? ""}:${option.resourceId}`;
}

/**
 * The log workspace: tail several log-capable resources in one pane through
 * the host's per-resource log machinery, interleaved (arrival order, colored
 * per-stream labels) or split into stacked panes, with pause, a unified
 * search box applied client-side across all streams, and — on hosts with
 * cloud storage — saved queries with an optional alert-on-match flag the
 * poller evaluates server-side.
 */
export function LogWorkspacePanel({ client, onOpenResource }: LogWorkspacePanelProps) {
  const gt = useGT();
  const [options, setOptions] = useState<LogResourceOption[]>([]);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [optionsLoading, setOptionsLoading] = useState(true);

  const [streams, setStreams] = useState<StreamState[]>([]);
  const [merged, setMerged] = useState<MergedLine[]>([]);
  const [paused, setPaused] = useState(false);
  const [tailLines, setTailLines] = useState(500);
  const [search, setSearch] = useState("");
  const [view, setView] = useState<"interleaved" | "split">("interleaved");

  // Saved queries (cloud only)
  const savedQueriesClient = client.savedQueries;
  const [saved, setSaved] = useState<LogWorkspaceQuery[]>([]);
  const [activeQueryId, setActiveQueryId] = useState<string | null>(null);
  const [queryName, setQueryName] = useState("");
  const [alertEnabled, setAlertEnabled] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Lazy instance state: stable mutable collections created once, without a
  // per-render allocation and without mutating a ref during render.
  const [lastLines] = useState(() => new Map<string, string[]>());
  const [inFlight] = useState(() => new Set<string>());
  const seqRef = useRef(0);
  const streamsRef = useRef(streams);
  const tailRef = useRef(tailLines);
  // Layout effects run during commit, before any microtask queued by the
  // event handlers below — so queueMicrotask(pollAll) always sees fresh refs.
  useLayoutEffect(() => {
    streamsRef.current = streams;
  }, [streams]);
  useLayoutEffect(() => {
    tailRef.current = tailLines;
  }, [tailLines]);

  useEffect(() => {
    let cancelled = false;
    setOptionsLoading(true);
    client
      .listLogResources()
      .then((resources) => {
        if (cancelled) return;
        setOptions(resources);
        setOptionsError(null);
      })
      .catch((e) => {
        if (!cancelled) setOptionsError(String(e instanceof Error ? e.message : e));
      })
      .finally(() => {
        if (!cancelled) setOptionsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  useEffect(() => {
    if (!savedQueriesClient) return;
    let cancelled = false;
    savedQueriesClient
      .list()
      .then((queries) => {
        if (!cancelled) setSaved(queries);
      })
      .catch(() => {
        /* saved queries are an enhancement — the tail pane works without them */
      });
    return () => {
      cancelled = true;
    };
  }, [savedQueriesClient]);

  const pollStream = useCallback(
    async (stream: StreamState) => {
      const key = logStreamKey(stream.selector);
      if (inFlight.has(key)) return;
      inFlight.add(key);
      try {
        const params = {
          tailLines: tailRef.current,
          ...(stream.selector.container ? { container: stream.selector.container } : {}),
        };
        const result = await client.fetchLogs(stream.selector, params);
        // The stream may have been removed while the fetch was in flight.
        if (!streamsRef.current.some((s) => logStreamKey(s.selector) === key)) return;
        const nextLines = splitLogLines(result.text);
        const prevLines = lastLines.get(key);
        const appended = prevLines ? computeAppendedLines(prevLines, nextLines) : nextLines;
        lastLines.set(key, nextLines);
        if (appended.length > 0) {
          const startSeq = seqRef.current;
          seqRef.current += appended.length;
          setMerged((m) => {
            const next = m.concat(
              appended.map((text, i) => ({ seq: startSeq + i, streamKey: key, text })),
            );
            return next.length > MERGED_LINE_CAP ? next.slice(next.length - MERGED_LINE_CAP) : next;
          });
        }
        setStreams((all) =>
          all.map((s) =>
            logStreamKey(s.selector) === key
              ? { ...s, containers: result.containers, error: null, loaded: true }
              : s,
          ),
        );
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        setStreams((all) =>
          all.map((s) =>
            logStreamKey(s.selector) === key ? { ...s, error: message, loaded: true } : s,
          ),
        );
      } finally {
        inFlight.delete(key);
      }
    },
    [client, inFlight, lastLines],
  );

  const pollAll = useCallback(() => {
    for (const stream of streamsRef.current) void pollStream(stream);
  }, [pollStream]);

  useEffect(() => {
    if (paused || streams.length === 0) return;
    const t = setInterval(pollAll, POLL_INTERVAL_MS);
    return () => clearInterval(t);
  }, [paused, streams.length, pollAll]);

  const purgeStream = useCallback(
    (key: string) => {
      lastLines.delete(key);
      setMerged((m) => m.filter((line) => line.streamKey !== key));
    },
    [lastLines],
  );

  const addStream = useCallback(
    (option: LogResourceOption) => {
      const selector: LogStreamSelector = {
        resourceId: option.resourceId,
        accountId: option.accountId,
        pluginId: option.pluginId,
        resourceTypeId: option.resourceTypeId,
        ...(option.parentResourceId ? { parentResourceId: option.parentResourceId } : {}),
      };
      const key = logStreamKey(selector);
      if (streamsRef.current.some((s) => logStreamKey(s.selector) === key)) return;
      const added: StreamState = {
        selector,
        label: option.displayName,
        colorIdx: 0,
        containers: [],
        error: null,
        loaded: false,
      };
      setStreams((all) =>
        all.some((s) => logStreamKey(s.selector) === key)
          ? all
          : [...all, { ...added, colorIdx: all.length % STREAM_COLORS.length }],
      );
      // Fetch immediately so the pane fills without waiting for the interval.
      // pollStream only needs the selector, so the pre-commit copy is fine.
      queueMicrotask(() => void pollStream(added));
    },
    [pollStream],
  );

  const removeStream = useCallback(
    (key: string) => {
      setStreams((all) => all.filter((s) => logStreamKey(s.selector) !== key));
      purgeStream(key);
    },
    [purgeStream],
  );

  const setStreamContainer = useCallback(
    (key: string, container: string) => {
      setStreams((all) =>
        all.map((s) => {
          if (logStreamKey(s.selector) !== key) return s;
          const selector: LogStreamSelector = {
            ...s.selector,
            ...(container ? { container } : {}),
          };
          if (!container) delete (selector as { container?: string }).container;
          return { ...s, selector, loaded: false };
        }),
      );
      purgeStream(key);
      queueMicrotask(pollAll);
    },
    [purgeStream, pollAll],
  );

  /** Replace the whole workspace with a saved query's streams and search. */
  const loadQuery = useCallback(
    (query: LogWorkspaceQuery) => {
      lastLines.clear();
      setMerged([]);
      const optionByKey = new Map(options.map((o) => [optionKey(o), o] as const));
      setStreams(
        query.resources.map((selector, i) => ({
          selector,
          // `||` (not `??`): each fallback can be an empty string — a blank
          // display name or an id with fewer than three `:` segments — and
          // must fall through to the next non-empty label.
          label:
            optionByKey.get(optionKey(selector))?.displayName ||
            selector.resourceId.split(":").slice(2).join(":") ||
            selector.resourceId,
          colorIdx: i % STREAM_COLORS.length,
          containers: [],
          error: null,
          loaded: false,
        })),
      );
      setSearch(query.search);
      setQueryName(query.name);
      setAlertEnabled(query.alertEnabled);
      setActiveQueryId(query.id);
      setSaveError(null);
      queueMicrotask(pollAll);
    },
    [options, pollAll, lastLines],
  );

  const resetToNewQuery = useCallback(() => {
    setActiveQueryId(null);
    setQueryName("");
    setAlertEnabled(false);
    setSaveError(null);
  }, []);

  const saveQuery = useCallback(async () => {
    if (!savedQueriesClient) return;
    setSaveBusy(true);
    setSaveError(null);
    const payload = {
      name: queryName,
      resources: streamsRef.current.map((s) => s.selector),
      search,
      alertEnabled,
    };
    try {
      const result = activeQueryId
        ? await savedQueriesClient.update(activeQueryId, payload)
        : await savedQueriesClient.create(payload);
      setActiveQueryId(result.id);
      setSaved((all) => {
        const rest = all.filter((q) => q.id !== result.id);
        return [...rest, result].sort((a, b) => a.name.localeCompare(b.name));
      });
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaveBusy(false);
    }
  }, [savedQueriesClient, queryName, search, alertEnabled, activeQueryId]);

  const deleteQuery = useCallback(async () => {
    if (!savedQueriesClient || !activeQueryId) return;
    setSaveBusy(true);
    setSaveError(null);
    try {
      await savedQueriesClient.remove(activeQueryId);
      setSaved((all) => all.filter((q) => q.id !== activeQueryId));
      resetToNewQuery();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaveBusy(false);
    }
  }, [savedQueriesClient, activeQueryId, resetToNewQuery]);

  const compiled = useMemo(() => compileLogSearch(search), [search]);
  const streamByKey = useMemo(
    () => new Map(streams.map((s) => [logStreamKey(s.selector), s] as const)),
    [streams],
  );
  const visible = useMemo(() => {
    if (compiled.error) return merged;
    if (compiled.matchAll) return merged;
    return merged.filter((line) => compiled.test(line.text));
  }, [merged, compiled]);

  const addedKeys = useMemo(() => new Set(streams.map((s) => optionKey(s.selector))), [streams]);
  const addableOptions = useMemo(
    () => options.filter((o) => !addedKeys.has(optionKey(o))),
    [options, addedKeys],
  );
  const activeQuery = activeQueryId ? (saved.find((q) => q.id === activeQueryId) ?? null) : null;

  const interleavedRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (paused) return;
    const el = interleavedRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visible, paused, view]);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {savedQueriesClient && (
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-surface shrink-0 flex-wrap">
          <span className="text-xs font-semibold text-on-surface-muted uppercase tracking-wide">
            {gt("Log workspace")}
          </span>
          <select
            value={activeQueryId ?? ""}
            onChange={(e) => {
              const query = saved.find((q) => q.id === e.target.value);
              if (query) loadQuery(query);
              else resetToNewQuery();
            }}
            className="text-xs bg-surface-overlay text-on-surface border border-border-strong rounded px-2 py-0.5"
            title={gt("Saved queries")}
            aria-label={gt("Saved queries")}
          >
            <option value="">{gt("New workspace…")}</option>
            {saved.map((q) => (
              <option key={q.id} value={q.id}>
                {q.name}
                {q.alertEnabled ? gt(" (alert)") : ""}
              </option>
            ))}
          </select>
          <input
            type="text"
            value={queryName}
            onChange={(e) => setQueryName(e.target.value)}
            placeholder={gt("Query name")}
            aria-label={gt("Query name")}
            maxLength={LOG_WORKSPACE_LIMITS.maxNameLength}
            className="text-xs bg-surface-overlay text-on-surface border border-border-strong rounded px-2 py-0.5 w-40"
          />
          <label
            className="flex items-center gap-1 text-xs text-on-surface-tertiary cursor-pointer"
            title={gt(
              "Evaluate this query server-side every few minutes and notify when a line matches (requires a non-empty search)",
            )}
          >
            <input
              type="checkbox"
              checked={alertEnabled}
              onChange={(e) => setAlertEnabled(e.target.checked)}
              disabled={search.trim().length === 0 && !alertEnabled}
              aria-label={gt("Alert on match")}
            />
            {gt("Alert on match")}
          </label>
          <button
            type="button"
            onClick={() => void saveQuery()}
            disabled={saveBusy || streams.length === 0 || queryName.trim().length === 0}
            className="px-3 py-1 text-xs text-on-surface-tertiary hover:text-white border border-border-strong rounded-md transition-colors disabled:opacity-50"
          >
            {activeQueryId ? gt("Save") : gt("Save query")}
          </button>
          {activeQueryId && (
            <>
              <button
                type="button"
                onClick={resetToNewQuery}
                disabled={saveBusy}
                className="px-3 py-1 text-xs text-on-surface-tertiary hover:text-white border border-border-strong rounded-md transition-colors"
                title={gt("Keep the streams but save under a new name")}
              >
                {gt("Save as new…")}
              </button>
              <button
                type="button"
                onClick={() => void deleteQuery()}
                disabled={saveBusy}
                className="px-3 py-1 text-xs text-danger hover:text-danger-strong border border-border-strong rounded-md transition-colors"
              >
                {gt("Delete")}
              </button>
            </>
          )}
          {saveError && <span className="text-xs text-danger">{saveError}</span>}
          {!saveError && activeQuery?.alertEnabled && (
            <span className="text-xs text-on-surface-faint">
              {activeQuery.lastEvalError
                ? gt("Alert error: {error}", { error: activeQuery.lastEvalError })
                : activeQuery.lastMatchAt
                  ? gt("Last match {date}", {
                      date: new Date(activeQuery.lastMatchAt).toLocaleString(),
                    })
                  : activeQuery.lastEvalAt
                    ? gt("No matches yet")
                    : gt("Alert pending first evaluation")}
            </span>
          )}
        </div>
      )}

      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-surface shrink-0 flex-wrap">
        <select
          value=""
          onChange={(e) => {
            const option = addableOptions.find((o) => optionKey(o) === e.target.value);
            if (option) addStream(option);
          }}
          disabled={optionsLoading || addableOptions.length === 0}
          className="text-xs bg-surface-overlay text-on-surface border border-border-strong rounded px-2 py-0.5 max-w-64"
          title={gt("Add a log stream")}
          aria-label={gt("Add a log stream")}
        >
          <option value="">
            {optionsLoading
              ? gt("Loading resources…")
              : addableOptions.length === 0
                ? options.length === 0
                  ? gt("No log-capable resources")
                  : gt("All resources added")
                : gt("+ Add resource…")}
          </option>
          {addableOptions.map((o) => (
            <option key={optionKey(o)} value={optionKey(o)}>
              {optionLabel(o)}
            </option>
          ))}
        </select>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={gt('Search all streams — terms, "phrases", -not, /regex/')}
          maxLength={LOG_WORKSPACE_LIMITS.maxSearchLength}
          className="text-xs bg-surface-overlay text-on-surface border border-border-strong rounded px-2 py-0.5 flex-1 min-w-40 font-mono"
          aria-label={gt("Search across all streams")}
        />
        <select
          value={tailLines}
          onChange={(e) => setTailLines(Number(e.target.value))}
          className="text-xs bg-surface-overlay text-on-surface border border-border-strong rounded px-2 py-0.5"
          title={gt("Tail lines per stream")}
          aria-label={gt("Tail lines per stream")}
        >
          {TAIL_OPTIONS.map((n) => (
            <option key={n} value={n}>
              {gt("Last {count}", { count: n })}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => {
            if (paused) queueMicrotask(pollAll);
            setPaused((p) => !p);
          }}
          className={`px-3 py-1 text-xs border border-border-strong rounded-md transition-colors ${
            paused ? "text-warning" : "text-on-surface-tertiary hover:text-white"
          }`}
        >
          {paused ? gt("Resume") : gt("Pause")}
        </button>
        <button
          type="button"
          onClick={() => setView((v) => (v === "interleaved" ? "split" : "interleaved"))}
          className="px-3 py-1 text-xs text-on-surface-tertiary hover:text-white border border-border-strong rounded-md transition-colors"
          title={gt("Toggle between one merged stream and stacked per-resource panes")}
        >
          {view === "interleaved" ? gt("Split view") : gt("Interleaved")}
        </button>
        <button
          type="button"
          onClick={() => {
            lastLines.clear();
            setMerged([]);
            queueMicrotask(pollAll);
          }}
          className="px-3 py-1 text-xs text-on-surface-tertiary hover:text-white border border-border-strong rounded-md transition-colors"
        >
          {gt("Clear")}
        </button>
      </div>

      {streams.length > 0 && (
        <div className="flex items-center gap-2 px-3 py-1 border-b border-border bg-surface shrink-0 flex-wrap">
          {streams.map((stream) => {
            const key = logStreamKey(stream.selector);
            // Sidecar streams (pods behind a managed cluster) have no detail
            // page of their own — the chip stays a plain label.
            const openable = onOpenResource && !stream.selector.parentResourceId;
            return (
              <span
                key={key}
                className="flex items-center gap-1.5 text-xs bg-surface-overlay border border-border rounded-full pl-2 pr-1 py-0.5"
              >
                <button
                  type="button"
                  onClick={() => (openable ? onOpenResource(stream.selector) : undefined)}
                  className={`font-medium ${STREAM_COLORS[stream.colorIdx]} ${openable ? "hover:underline" : "cursor-default"}`}
                  title={stream.selector.resourceId}
                >
                  {stream.label}
                </button>
                {stream.containers.length > 1 && (
                  <select
                    value={stream.selector.container ?? stream.containers[0]}
                    onChange={(e) => setStreamContainer(key, e.target.value)}
                    className="text-xs bg-surface text-on-surface border border-border rounded px-1"
                    title={gt("Container")}
                    aria-label={gt("Container for {label}", { label: stream.label })}
                  >
                    {stream.containers.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                )}
                {stream.error && (
                  <span className="text-danger" title={stream.error}>
                    !
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => removeStream(key)}
                  className="text-on-surface-faint hover:text-white px-1"
                  aria-label={gt("Remove {label}", { label: stream.label })}
                >
                  ×
                </button>
              </span>
            );
          })}
          {!compiled.matchAll && !compiled.error && (
            <span className="text-xs text-on-surface-faint ml-auto">
              {gt("{visible} of {total} lines match", {
                visible: visible.length,
                total: merged.length,
              })}
            </span>
          )}
        </div>
      )}

      {compiled.error && (
        <div className="px-3 py-1.5 text-xs text-danger font-mono border-b border-border bg-red-500/5 shrink-0">
          {compiled.error}
        </div>
      )}
      {optionsError && (
        <div className="px-3 py-1.5 text-xs text-danger font-mono border-b border-border bg-red-500/5 shrink-0">
          {optionsError}
        </div>
      )}

      {streams.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-on-surface-faint text-sm p-8 text-center">
          {optionsLoading
            ? gt("Loading log-capable resources…")
            : options.length === 0
              ? gt(
                  "No resources with log support were found. Pods, deployments, Cloud Run services and managed databases are typical sources.",
                )
              : gt("Add resources above to start tailing their logs side by side.")}
        </div>
      ) : view === "interleaved" ? (
        <div
          ref={interleavedRef}
          className="flex-1 min-h-0 overflow-auto bg-surface-sunken/40 text-on-surface text-xs font-mono p-4 leading-relaxed"
        >
          {visible.length === 0 ? (
            <span className="text-on-surface-faint">
              {merged.length === 0 ? gt("<no output yet>") : gt("<no lines match the search>")}
            </span>
          ) : (
            visible.map((line) => {
              const stream = streamByKey.get(line.streamKey);
              return (
                <div key={line.seq} className="whitespace-pre-wrap break-all">
                  <span className={`${stream ? STREAM_COLORS[stream.colorIdx] : ""} select-none`}>
                    [{stream?.label ?? "?"}]{" "}
                  </span>
                  {line.text}
                </div>
              );
            })
          )}
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-auto flex flex-col">
          {streams.map((stream) => {
            const key = logStreamKey(stream.selector);
            const lines = visible.filter((line) => line.streamKey === key);
            return (
              <SplitPane
                key={key}
                title={stream.label}
                colorClass={STREAM_COLORS[stream.colorIdx] ?? ""}
                error={stream.error}
                lines={lines}
                paused={paused}
                empty={
                  !stream.loaded
                    ? gt("Loading…")
                    : merged.some((l) => l.streamKey === key)
                      ? gt("<no lines match the search>")
                      : gt("<no output yet>")
                }
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

interface SplitPaneProps {
  title: string;
  colorClass: string;
  error: string | null;
  lines: MergedLine[];
  paused: boolean;
  empty: string;
}

function SplitPane({ title, colorClass, error, lines, paused, empty }: SplitPaneProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (paused) return;
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, paused]);
  return (
    <div className="flex-1 min-h-32 flex flex-col border-b border-border last:border-b-0">
      <div className="px-3 py-1 bg-surface border-b border-border text-xs shrink-0 flex items-center gap-2">
        <span className={`font-semibold ${colorClass}`}>{title}</span>
        {error && (
          <span className="text-danger font-mono truncate" title={error}>
            {error}
          </span>
        )}
      </div>
      <div
        ref={ref}
        className="flex-1 min-h-0 overflow-auto bg-surface-sunken/40 text-on-surface text-xs font-mono px-4 py-2 leading-relaxed"
      >
        {lines.length === 0 ? (
          <span className="text-on-surface-faint">{empty}</span>
        ) : (
          lines.map((line) => (
            <div key={line.seq} className="whitespace-pre-wrap break-all">
              {line.text}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
