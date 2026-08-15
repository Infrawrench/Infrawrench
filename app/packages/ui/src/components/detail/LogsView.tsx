import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useGT } from "gt-react";
import { tailLineOptions } from "@infrawrench/client-core";
import type { LogsCapability, LogsFetchParams, LogsFetchResult } from "@infrawrench/plugin-base";

interface Props {
  capability: LogsCapability;
  /** Fetch a chunk of logs from the plugin — polled by this view when follow is on. */
  onGetLogs: (params: LogsFetchParams) => Promise<LogsFetchResult>;
}

const FOLLOW_INTERVAL_MS = 3000;

export function LogsView({ capability, onGetLogs }: Props) {
  const gt = useGT();
  const [text, setText] = useState<string>("");
  const [containers, setContainers] = useState<string[]>([]);
  const [container, setContainer] = useState<string | null>(null);
  const [tailLines, setTailLines] = useState<number>(capability.defaultTailLines ?? 500);
  // The default may fall outside the fixed presets (e.g. a plugin declaring
  // 200) — include it as an extra option rather than clamp state to the
  // nearest preset, so the control always shows the value actually requested.
  const tailOptions = useMemo(
    () => tailLineOptions(capability.defaultTailLines),
    [capability.defaultTailLines],
  );
  const [previous, setPrevious] = useState(false);
  const [follow, setFollow] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLPreElement | null>(null);
  const latestRequestRef = useRef(0);

  const fetchLogs = useCallback(
    async (opts?: { spinner?: boolean }) => {
      if (opts?.spinner) setLoading(true);
      const requestId = ++latestRequestRef.current;
      setError(null);
      try {
        const params: LogsFetchParams = { tailLines, previous };
        if (container) params.container = container;
        const result = await onGetLogs(params);
        if (requestId !== latestRequestRef.current) return;
        setText(result.text);
        setContainers(result.containers);
        if (!container) setContainer(result.activeContainer);
      } catch (e) {
        if (requestId !== latestRequestRef.current) return;
        setError(String(e));
      } finally {
        if (requestId === latestRequestRef.current) setLoading(false);
      }
    },
    [onGetLogs, tailLines, previous, container],
  );

  useEffect(() => {
    void fetchLogs({ spinner: true });
  }, [fetchLogs]);

  useEffect(() => {
    if (!follow) return;
    const t = setInterval(() => void fetchLogs(), FOLLOW_INTERVAL_MS);
    return () => clearInterval(t);
  }, [follow, fetchLogs]);

  useEffect(() => {
    if (!follow) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [text, follow]);

  if (loading && !text) {
    return (
      <div className="flex items-center justify-center h-full text-on-surface-faint text-sm">
        {gt("Loading logs…")}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-surface shrink-0">
        <span className="text-xs font-semibold text-on-surface-muted uppercase tracking-wide">
          {gt("Logs")}
        </span>
        {containers.length > 1 && (
          <select
            value={container ?? ""}
            onChange={(e) => setContainer(e.target.value)}
            className="text-xs bg-surface-overlay text-on-surface border border-border-strong rounded px-2 py-0.5"
            title={gt("Container")}
            aria-label={gt("Container")}
          >
            {containers.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        )}
        <select
          value={tailLines}
          onChange={(e) => setTailLines(Number(e.target.value))}
          className="text-xs bg-surface-overlay text-on-surface border border-border-strong rounded px-2 py-0.5"
          title={gt("Tail lines")}
          aria-label={gt("Tail lines")}
        >
          {tailOptions.map((n) => (
            <option key={n} value={n}>
              {gt("Last {n}", { n })}
            </option>
          ))}
        </select>
        {capability.supportsPrevious && (
          <label className="flex items-center gap-1 text-xs text-on-surface-tertiary cursor-pointer">
            <input
              type="checkbox"
              checked={previous}
              onChange={(e) => setPrevious(e.target.checked)}
              aria-label={gt("Previous")}
            />
            {gt("Previous")}
          </label>
        )}
        <label className="flex items-center gap-1 text-xs text-on-surface-tertiary cursor-pointer">
          <input
            type="checkbox"
            checked={follow}
            onChange={(e) => setFollow(e.target.checked)}
            aria-label={gt("Follow")}
          />
          {gt("Follow")}
        </label>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              if (text) void navigator.clipboard.writeText(text);
            }}
            className="px-3 py-1 text-xs text-on-surface-tertiary hover:text-white border border-border-strong hover:border-border-strong rounded-md transition-colors"
          >
            {gt("Copy")}
          </button>
          <button
            type="button"
            onClick={() => {
              void fetchLogs({ spinner: true });
            }}
            className="px-3 py-1 text-xs text-on-surface-tertiary hover:text-white border border-border-strong hover:border-border-strong rounded-md transition-colors"
          >
            {gt("Reload")}
          </button>
        </div>
      </div>
      {error && (
        <div className="px-3 py-2 text-xs text-danger font-mono border-b border-border bg-red-500/5 whitespace-pre-wrap shrink-0">
          {error}
        </div>
      )}
      <pre
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-auto bg-surface-sunken/40 text-on-surface text-xs font-mono p-4 whitespace-pre leading-relaxed"
      >
        {text || (loading ? "" : gt("<no output>"))}
      </pre>
    </div>
  );
}
