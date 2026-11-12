import { useState } from "react";
import { useGT } from "gt-react";
import type { CiDownload } from "@infrawrench/client-core";
import { formatBytes } from "@infrawrench/plugin-base";

/** Lucide's `download`, inline like the app's other icons. */
function DownloadIcon() {
  return (
    <svg
      width={12}
      height={12}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" x2="12" y1="15" y2="3" />
    </svg>
  );
}

/** One file a job kept, with the job it came from. */
export interface CiDownloadRow {
  jobId: string;
  /** The job's name, shown when the list covers more than one job. */
  jobName: string;
  file: CiDownload;
}

/** Fetches a signed link for a file and starts the download. */
export type CiDownloadFn = (jobId: string, path: string) => Promise<void>;

/**
 * The files jobs kept with `downloads:`: name, size, when it expires, and a
 * button that fetches a short-lived link and starts the download.
 */
export function CiDownloadList({
  rows,
  showJob,
  onDownload,
  now = Date.now(),
}: {
  rows: readonly CiDownloadRow[];
  showJob: boolean;
  onDownload: CiDownloadFn;
  now?: number;
}) {
  const gt = useGT();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  if (rows.length === 0) return null;
  const failed = gt("The download could not start");

  return (
    <section aria-label={gt("Downloads")} className="rounded-md border border-border bg-surface">
      <h4 className="border-b border-border px-4 py-2 text-xs font-semibold text-on-surface">
        {gt("Downloads")}
      </h4>
      <ul className="divide-y divide-border">
        {rows.map(({ jobId, jobName, file }) => {
          const key = `${jobId}\n${file.path}`;
          const expires = Date.parse(file.expiresAt);
          const expired = Number.isFinite(expires) && expires <= now;
          const when = Number.isFinite(expires) ? new Date(expires).toLocaleDateString() : "";
          return (
            <li key={key} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate font-mono text-xs text-on-surface" title={file.path}>
                  {file.path}
                </p>
                <p className="text-[11px] text-on-surface-faint">
                  {showJob ? <span className="mr-2">{jobName}</span> : null}
                  <span className="mr-2 tabular-nums">{formatBytes(file.size)}</span>
                  {expired ? gt("Expired") : gt("Kept until {date}", { date: when })}
                  {file.masked ? null : (
                    <span className="ml-2">{gt("Binary: stored as the job left it")}</span>
                  )}
                </p>
                {error?.key === key ? (
                  <p role="alert" className="text-[11px] text-danger">
                    {error.message}
                  </p>
                ) : null}
              </div>
              <button
                type="button"
                disabled={expired || busy === key}
                onClick={() => {
                  setBusy(key);
                  setError(null);
                  onDownload(jobId, file.path)
                    .catch((e: unknown) =>
                      setError({ key, message: e instanceof Error ? e.message : failed }),
                    )
                    .finally(() => setBusy(null));
                }}
                className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs text-on-surface hover:bg-surface-sunken disabled:opacity-50"
              >
                <DownloadIcon />
                {busy === key ? gt("Starting…") : gt("Download")}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
