import { useCallback, useEffect, useRef, useState } from "react";
import type { LogsCapability, LogsFetchParams, LogsFetchResult } from "@infrawrench/plugin-base";

interface Props {
  capability: LogsCapability;
  /** Fetch a chunk of logs from the plugin — polled by this view when follow is on. */
  onGetLogs: (params: LogsFetchParams) => Promise<LogsFetchResult>;
}

const TAIL_OPTIONS = [100, 500, 1000, 5000];
const FOLLOW_INTERVAL_MS = 3000;

export function LogsView({ capability, onGetLogs }: Props) {
  const [text, setText] = useState<string>("");
  const [containers, setContainers] = useState<string[]>([]);
  const [container, setContainer] = useState<string | null>(null);
  const [tailLines, setTailLines] = useState<number>(capability.defaultTailLines ?? 500);
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
        Loading logs…
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-surface shrink-0">
        <span className="text-xs font-semibold text-on-surface-muted uppercase tracking-wide">
          Logs
        </span>
        {containers.length > 1 && (
          <select
            value={container ?? ""}
            onChange={(e) => setContainer(e.target.value)}
            className="text-xs bg-surface-overlay text-on-surface border border-border-strong rounded px-2 py-0.5"
            title="Container"
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
          title="Tail lines"
        >
          {TAIL_OPTIONS.map((n) => (
            <option key={n} value={n}>
              Last {n}
            </option>
          ))}
        </select>
        {capability.supportsPrevious && (
          <label className="flex items-center gap-1 text-xs text-on-surface-tertiary cursor-pointer">
            <input
              type="checkbox"
              checked={previous}
              onChange={(e) => setPrevious(e.target.checked)}
              aria-label="Previous"
            />
            Previous
          </label>
        )}
        <label className="flex items-center gap-1 text-xs text-on-surface-tertiary cursor-pointer">
          <input
            type="checkbox"
            checked={follow}
            onChange={(e) => setFollow(e.target.checked)}
            aria-label="Follow"
          />
          Follow
        </label>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              if (text) void navigator.clipboard.writeText(text);
            }}
            className="px-3 py-1 text-xs text-on-surface-tertiary hover:text-white border border-border-strong hover:border-border-strong rounded-md transition-colors"
          >
            Copy
          </button>
          <button
            type="button"
            onClick={() => {
              void fetchLogs({ spinner: true });
            }}
            className="px-3 py-1 text-xs text-on-surface-tertiary hover:text-white border border-border-strong hover:border-border-strong rounded-md transition-colors"
          >
            Reload
          </button>
        </div>
      </div>
      {error && (
        <div className="px-3 py-2 text-xs text-red-400 font-mono border-b border-border bg-red-500/5 whitespace-pre-wrap shrink-0">
          {error}
        </div>
      )}
      <pre
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-auto bg-surface-sunken/40 text-on-surface text-xs font-mono p-4 whitespace-pre leading-relaxed"
      >
        {text || (loading ? "" : "<no output>")}
      </pre>
    </div>
  );
}
