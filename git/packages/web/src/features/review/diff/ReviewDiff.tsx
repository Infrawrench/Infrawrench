/**
 * The branch page's diff: one file after another, drawn by `@pierre/diffs`
 * (Apache-2.0), with whatever the page hangs on a line (a trace entry, a
 * finding, a review thread, the comment box) as an annotation under it.
 *
 * The renderer draws the lines inside its own element and takes annotations
 * as ordinary children of it, so they are this app's components on this
 * app's styles. It highlights with Shiki's JavaScript engine on the main
 * thread: no worker, no WebAssembly, nothing the page's policy has to allow.
 *
 * This module and the renderer are one lazy chunk (`LazyReviewDiff`); nothing
 * else may import either.
 */
import { memo, useCallback, useMemo, useState, type ReactNode } from "react";
import {
  getSingularPatch,
  type DiffLineAnnotation,
  type FileDiffContentsLoader,
  type FileDiffMetadata,
  type SelectedLineRange,
} from "@pierre/diffs";
import { FileDiff, type FileDiffOptions } from "@pierre/diffs/react";
import type { DiffFile } from "@infrawrench/git-contract";
import { api } from "../../../api/client";
import { queryClient } from "../../../api/queries";
import { AppLink } from "../../../components/AppLink";
import { Badge } from "../../../components/Badge";
import { Button } from "../../../components/Button";
import { linesOf } from "../../../components/CodeView";
import { DiffStat, diffFileId, type DiffLayout } from "../../../components/DiffView";
import { Icon } from "../../../components/icons";
import { showBidi } from "../../../lib/bidi";
import { paths, type RepoRef } from "../../../lib/paths";
import { oldLinesOf, patchLine, patchOf } from "./patch";

/** Where something hangs on a file's diff. Line `0` is above the file's first line. */
export interface DiffMark {
  readonly side: "additions" | "deletions";
  readonly lineNumber: number;
}

export type DiffMarkKey = `${DiffMark["side"]}:${number}`;
export const markKey = (mark: DiffMark): DiffMarkKey => `${mark.side}:${mark.lineNumber}`;

/** The lines a reader picked with the gutter's button, as the renderer names them. */
export interface PickedLines {
  readonly side: DiffMark["side"];
  readonly start: number;
  readonly end: number;
}

export interface ReviewDiffProps {
  readonly repo: RepoRef;
  readonly files: ReadonlyArray<DiffFile>;
  /** The commit of the new side: where hidden lines and "View file" come from. */
  readonly headOid: string;
  readonly layout: DiffLayout;
  /** Fetches one file with its hunks, for a file left out as too large. */
  readonly loadFile?: (path: string) => Promise<DiffFile | undefined>;
  /** The lines of a file something hangs under. Keep the array's identity while nothing changes. */
  readonly marksOf: (file: DiffFile) => ReadonlyArray<DiffMark>;
  /** What hangs under one of those lines. */
  readonly renderMark: (file: DiffFile, mark: DiffMark) => ReactNode;
  /** The gutter's button on a line, or on the lines dragged over. Absent: no button. */
  readonly onPickLines?: (file: DiffFile, lines: PickedLines) => void;
  /** The lines to show as picked: the ones the open comment box is about. */
  readonly picked?: { readonly path: string; readonly lines: PickedLines } | null;
}

const STATUS_LABEL: Record<DiffFile["status"], string | null> = {
  added: "Added",
  modified: null,
  deleted: "Deleted",
  renamed: "Renamed",
  copied: "Copied",
  type_changed: "Type changed",
};

/**
 * The renderer's own colours follow its theme; these place it on the page's:
 * black behind code in the dark scheme as everywhere else on the site, the
 * page's monospace stack, and no rounding of its own inside the file's box.
 */
const HOST_CSS = `
:host {
  --diffs-dark-bg: #000;
  --diffs-font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --diffs-font-size: 12px;
  --diffs-line-height: 20px;
  --diffs-tab-size: 4;
}
`;

const THEME = { light: "pierre-light", dark: "pierre-dark" } as const;

/**
 * Both sides of a file whose diff came as hunks, so the renderer can show
 * the lines between them. Only the new file is fetched: the old one follows
 * from it and the hunks (`oldLinesOf`).
 */
async function loadSides(repo: RepoRef, headOid: string, file: DiffFile) {
  const request = { params: repo, query: { ref: headOid, path: file.path } };
  const blob = await queryClient.fetchQuery({
    queryKey: ["contents", "blob", request],
    queryFn: () => api.contents.blob(request),
  });
  const lines = linesOf(blob.text ?? "");
  const text = (list: ReadonlyArray<string>) =>
    list.length === 0 ? "" : `${list.map(patchLine).join("\n")}\n`;
  const newFile = { name: showBidi(file.path), contents: text(lines) };
  if (file.hunks.length === 0) return { oldFile: null, newFile };
  return {
    oldFile: {
      name: showBidi(file.oldPath ?? file.path),
      contents: text(oldLinesOf(lines, file.hunks)),
    },
    newFile,
  };
}

function FileHeader({
  file,
  repo,
  headOid,
  collapsed,
  onToggle,
}: {
  file: DiffFile;
  repo: RepoRef;
  headOid: string;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const label = STATUS_LABEL[file.status];
  return (
    <div className="sticky top-[var(--review-sticky-top)] z-10 flex min-h-10 rounded-t-md items-center gap-2 border-b border-border bg-surface-raised px-2 py-1.5 text-xs">
      <button
        type="button"
        aria-expanded={!collapsed}
        aria-label={collapsed ? `Show ${file.path}` : `Hide ${file.path}`}
        onClick={onToggle}
        className="inline-flex size-6 shrink-0 items-center justify-center rounded text-on-surface-muted hover:bg-surface-sunken hover:text-on-surface"
      >
        <Icon name={collapsed ? "chevronRight" : "chevronDown"} size={14} />
      </button>
      <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-on-surface">
        {file.oldPath !== null && file.oldPath !== file.path ? (
          <span className="text-on-surface-muted">{showBidi(file.oldPath)} → </span>
        ) : null}
        {showBidi(file.path)}
      </span>
      {label !== null ? <Badge tone="outline">{label}</Badge> : null}
      {file.binary ? null : <DiffStat additions={file.additions} deletions={file.deletions} />}
      {file.status !== "deleted" ? (
        <AppLink
          href={paths.blob(repo, headOid, file.path)}
          aria-label={`View ${file.path}`}
          title="View file"
          className="inline-flex size-6 shrink-0 items-center justify-center rounded text-on-surface-muted hover:bg-surface-sunken hover:text-on-surface"
        >
          <Icon name="file" size={13} />
        </AppLink>
      ) : null}
    </div>
  );
}

const FileSection = memo(function FileSection({
  file: initial,
  repo,
  headOid,
  layout,
  loadFile,
  marksOf,
  renderMark,
  onPickLines,
  picked,
}: Omit<ReviewDiffProps, "files"> & { file: DiffFile }) {
  const [loaded, setLoaded] = useState<DiffFile | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [busy, setBusy] = useState(false);
  const file = loaded ?? initial;
  const marks = marksOf(file);

  const metadata = useMemo<FileDiffMetadata | null>(
    () => (file.hunks.length === 0 ? null : getSingularPatch(patchOf(file))),
    [file],
  );
  const annotations = useMemo<DiffLineAnnotation<DiffMark>[]>(
    () => marks.map((mark) => ({ side: mark.side, lineNumber: mark.lineNumber, metadata: mark })),
    [marks],
  );
  const loadDiffFiles = useCallback<FileDiffContentsLoader>(
    () => loadSides(repo, headOid, file),
    [repo, headOid, file],
  );
  const canExpand = file.status !== "added" && file.status !== "deleted";
  const options = useMemo<FileDiffOptions<DiffMark, undefined>>(
    () => ({
      diffStyle: layout,
      theme: THEME,
      themeType: "system",
      disableFileHeader: true,
      overflow: "scroll",
      hunkSeparators: "line-info",
      expansionLineCount: 20,
      unsafeCSS: HOST_CSS,
      ...(canExpand ? { loadDiffFiles } : {}),
      ...(onPickLines === undefined
        ? {}
        : {
            enableGutterUtility: true,
            onGutterUtilityClick: (range: SelectedLineRange) => {
              const side = range.endSide ?? range.side ?? "additions";
              // A drag across both sides has no one file to be about: the line it ended on.
              const start = (range.side ?? side) === side ? range.start : range.end;
              onPickLines(file, {
                side,
                start: Math.min(start, range.end),
                end: Math.max(start, range.end),
              });
            },
          }),
    }),
    [layout, canExpand, loadDiffFiles, onPickLines, file],
  );
  const selected = useMemo<SelectedLineRange | null>(
    () =>
      picked === null || picked === undefined || picked.path !== file.path
        ? null
        : {
            start: picked.lines.start,
            end: picked.lines.end,
            side: picked.lines.side,
            endSide: picked.lines.side,
          },
    [picked, file.path],
  );
  const renderAnnotation = useCallback(
    (annotation: DiffLineAnnotation<DiffMark>) => renderMark(file, annotation.metadata),
    [renderMark, file],
  );

  const load = async () => {
    if (!loadFile) return;
    setBusy(true);
    try {
      const next = await loadFile(file.path);
      if (next) setLoaded(next);
    } catch {
      // The button stays: the reader can ask again.
    } finally {
      setBusy(false);
    }
  };

  // With no lines to hang them on, what belongs to the file still shows under its name.
  const loose = metadata === null ? marks : [];
  return (
    <section
      id={diffFileId(file.path)}
      aria-label={file.path}
      className="scroll-mt-16 rounded-md border border-border bg-surface-raised"
    >
      <FileHeader
        file={file}
        repo={repo}
        headOid={headOid}
        collapsed={collapsed}
        onToggle={() => setCollapsed((value) => !value)}
      />
      {collapsed ? null : metadata !== null ? (
        <div className="code-surface overflow-hidden rounded-b-md">
          <FileDiff<DiffMark>
            fileDiff={metadata}
            options={options}
            lineAnnotations={annotations}
            selectedLines={selected}
            renderAnnotation={renderAnnotation}
            disableWorkerPool
          />
        </div>
      ) : (
        <>
          {loose.map((mark) => (
            <div key={markKey(mark)}>{renderMark(file, mark)}</div>
          ))}
          <p className="flex flex-wrap items-center gap-3 px-3 py-3 text-xs text-on-surface-muted">
            {file.binary
              ? "Binary file"
              : file.tooLarge
                ? "This diff is large and was left out"
                : file.status === "renamed" || file.status === "copied"
                  ? "Moved without changes"
                  : "No changes to its lines"}
            {file.tooLarge && !file.binary && loadFile ? (
              <Button size="sm" busy={busy} onClick={() => void load()}>
                Load diff
              </Button>
            ) : null}
          </p>
        </>
      )}
    </section>
  );
});

export default function ReviewDiff({ files, ...rest }: ReviewDiffProps) {
  return (
    <div className="space-y-4">
      {files.map((file) => (
        <FileSection key={`${file.oldPath ?? ""}:${file.path}`} {...rest} file={file} />
      ))}
    </div>
  );
}
