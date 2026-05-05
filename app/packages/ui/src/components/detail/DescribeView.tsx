import { useState, useCallback, useEffect } from "react";
import type { DescribeCapability } from "@infrawrench/plugin-base";

interface Props {
  capability: DescribeCapability;
  /** Fetch the describe text from the plugin */
  onGetDescribe: () => Promise<string>;
}

export function DescribeView({ capability, onGetDescribe }: Props) {
  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchDescribe = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const t = await onGetDescribe();
      setText(t);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [onGetDescribe]);

  useEffect(() => {
    void fetchDescribe();
  }, [fetchDescribe]);

  const language = capability.language ?? "text";

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-on-surface-faint text-sm">
        Loading describe…
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <div className="text-red-400 text-sm font-mono whitespace-pre-wrap max-w-lg">{error}</div>
        <button
          onClick={() => void fetchDescribe()}
          className="px-3 py-1.5 text-xs text-on-surface-tertiary hover:text-white border border-border-strong hover:border-border-strong rounded-md transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-surface shrink-0">
        <span className="text-xs font-semibold text-on-surface-muted uppercase tracking-wide">
          Describe
        </span>
        <span className="text-xs text-on-surface-faint bg-surface-overlay rounded px-1.5 py-0.5">
          {language}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => {
              if (text) void navigator.clipboard.writeText(text);
            }}
            className="px-3 py-1 text-xs text-on-surface-tertiary hover:text-white border border-border-strong hover:border-border-strong rounded-md transition-colors"
          >
            Copy
          </button>
          <button
            onClick={() => void fetchDescribe()}
            className="px-3 py-1 text-xs text-on-surface-tertiary hover:text-white border border-border-strong hover:border-border-strong rounded-md transition-colors"
          >
            Reload
          </button>
        </div>
      </div>
      <pre className="flex-1 min-h-0 overflow-auto bg-surface-sunken/40 text-on-surface text-xs font-mono p-4 whitespace-pre leading-relaxed">
        {text}
      </pre>
    </div>
  );
}
