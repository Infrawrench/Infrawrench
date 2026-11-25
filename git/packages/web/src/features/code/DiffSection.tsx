/**
 * The files-changed half of a commit or comparison: the stats line, the file
 * list, the unified/split switch and the diff, a page of files at a time.
 */
import { useState } from "react";
import type { Diff, DiffFile, DiffFileSummary } from "@infrawrench/git-contract";
import { usePages } from "../../api/queries";
import { Segmented } from "../../components/controls";
import { DiffStat, DiffView, diffFileId, type DiffLayout } from "../../components/DiffView";
import { Icon, type IconName } from "../../components/icons";
import { Panel } from "../../components/Panel";
import { ErrorState, Loading, LoadMore } from "../../components/states";
import { plural } from "../../lib/format";
import type { RepoRef } from "../../lib/paths";

const LAYOUT_KEY = "git-diff-layout";

/** The reader's unified/split choice, remembered across pages. */
export function useDiffLayout(): [DiffLayout, (layout: DiffLayout) => void] {
  const [layout, setLayout] = useState<DiffLayout>(() => {
    try {
      return localStorage.getItem(LAYOUT_KEY) === "split" ? "split" : "unified";
    } catch {
      return "unified";
    }
  });
  return [
    layout,
    (next) => {
      setLayout(next);
      try {
        localStorage.setItem(LAYOUT_KEY, next);
      } catch {
        // Not remembered; the choice still holds for this page.
      }
    },
  ];
}

const STATUS_ICON: Record<
  DiffFileSummary["status"],
  { icon: IconName; tone: string; label: string }
> = {
  added: { icon: "plus", tone: "text-success", label: "Added" },
  modified: { icon: "circleDot", tone: "text-warning", label: "Modified" },
  deleted: { icon: "minus", tone: "text-danger", label: "Deleted" },
  renamed: { icon: "chevronRight", tone: "text-on-surface-muted", label: "Renamed" },
  copied: { icon: "copy", tone: "text-on-surface-muted", label: "Copied" },
  type_changed: { icon: "circleDot", tone: "text-on-surface-muted", label: "Type changed" },
};

export function DiffSection({
  repo,
  queryKey,
  files,
  filesTruncated,
  stats,
  fetchPage,
  fetchFile,
}: {
  repo: RepoRef;
  /** Identifies the diff: the endpoint and its request. */
  queryKey: ReadonlyArray<unknown>;
  /** The file list, known before any hunks. */
  files: ReadonlyArray<DiffFileSummary>;
  filesTruncated: boolean;
  stats: Diff["stats"];
  fetchPage: (cursor: string | undefined) => Promise<Diff>;
  /** One file with its hunks, whatever its size. */
  fetchFile: (path: string) => Promise<DiffFile | undefined>;
}) {
  const [layout, setLayout] = useDiffLayout();
  const diff = usePages(queryKey, async (cursor) => {
    const page = await fetchPage(cursor);
    return { ...page, items: page.files };
  });
  const headOid = diff.pages[0]?.headOid;
  return (
    <section aria-label="Changes" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-xs text-on-surface-secondary">
          <span className="font-medium text-on-surface">
            {plural(stats.filesChanged, "file")} changed
          </span>
          <DiffStat additions={stats.additions} deletions={stats.deletions} />
        </p>
        <Segmented
          label="Diff layout"
          value={layout}
          onChange={setLayout}
          options={[
            { value: "unified", label: "Unified" },
            { value: "split", label: "Split" },
          ]}
        />
      </div>
      {files.length > 1 ? (
        <Panel>
          <ul
            aria-label="Changed files"
            className="max-h-64 divide-y divide-border overflow-y-auto"
          >
            {files.map((file) => {
              const status = STATUS_ICON[file.status];
              return (
                <li key={`${file.oldPath ?? ""}:${file.path}`}>
                  <a
                    href={`#${diffFileId(file.path)}`}
                    className="flex items-center gap-2 px-3 py-1 text-xs hover:bg-surface-inset"
                  >
                    <span role="img" aria-label={status.label} className="inline-flex">
                      <Icon name={status.icon} size={12} className={status.tone} />
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-on-surface">
                      {file.oldPath !== null && file.oldPath !== file.path ? (
                        <span className="text-on-surface-muted">{file.oldPath} → </span>
                      ) : null}
                      {file.path}
                    </span>
                    {file.binary ? (
                      <span className="text-on-surface-faint">Binary</span>
                    ) : (
                      <DiffStat additions={file.additions} deletions={file.deletions} />
                    )}
                  </a>
                </li>
              );
            })}
          </ul>
          {filesTruncated ? (
            <p className="border-t border-border px-3 py-1.5 text-xs text-on-surface-muted">
              More files changed than are listed.
            </p>
          ) : null}
        </Panel>
      ) : null}
      {diff.isLoading ? (
        <Loading />
      ) : diff.error ? (
        <ErrorState error={diff.error} />
      ) : headOid !== undefined ? (
        <>
          <DiffView
            repo={repo}
            files={diff.items}
            headOid={headOid}
            layout={layout}
            loadFile={fetchFile}
          />
          <LoadMore pages={diff} label="More files" />
        </>
      ) : null}
    </section>
  );
}
