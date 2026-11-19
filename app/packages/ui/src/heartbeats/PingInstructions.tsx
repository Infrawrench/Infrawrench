import { useState } from "react";
import { useGT } from "gt-react";
import { heartbeatCurlSnippet, heartbeatPingUrls } from "@infrawrench/client-core";

function CopyButton({ value, label }: { value: string; label: string }) {
  const gt = useGT();
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className="shrink-0 px-2 py-1 rounded-lg text-xs text-on-surface-secondary hover:bg-surface-sunken transition-colors"
    >
      {copied ? gt("Copied") : gt("Copy")}
    </button>
  );
}

/**
 * The ping URL and the shell snippet that calls it, each with a copy button.
 * The URL is a credential, so it is shown only where the heartbeat is open.
 */
export function PingInstructions({
  pingUrl,
  onRotate,
}: {
  pingUrl: string;
  /** Replace the URL. Omitted on a read-only host. */
  onRotate?: (() => void) | undefined;
}) {
  const gt = useGT();
  const urls = heartbeatPingUrls(pingUrl);
  const snippet = heartbeatCurlSnippet(pingUrl);
  return (
    <div className="space-y-2">
      <div>
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-on-surface-secondary">{gt("Ping URL")}</span>
          {onRotate && (
            <button
              type="button"
              onClick={onRotate}
              className="px-2 py-1 rounded-lg text-xs text-on-surface-secondary hover:bg-surface-sunken transition-colors"
            >
              {gt("Replace URL")}
            </button>
          )}
        </div>
        <div className="flex items-center gap-2 rounded-lg border border-border bg-surface-sunken px-2.5 py-1.5">
          <code className="flex-1 min-w-0 truncate text-xs text-on-surface">{urls.success}</code>
          <CopyButton value={urls.success} label={gt("Copy ping URL")} />
        </div>
      </div>
      <div>
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-on-surface-secondary">{gt("Shell")}</span>
          <CopyButton value={snippet} label={gt("Copy shell snippet")} />
        </div>
        <pre className="overflow-x-auto rounded-lg border border-border bg-surface-sunken px-2.5 py-1.5 text-xs text-on-surface">
          {snippet}
        </pre>
      </div>
    </div>
  );
}
