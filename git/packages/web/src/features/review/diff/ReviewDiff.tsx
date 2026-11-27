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
import type { DiffFile, DiffHunk } from "@infrawrench/git-contract";
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
import { plural } from "../../../lib/format";
import {
  focusFile,
  linesOfHunks,
  type FileView,
  type FocusGap,
  type FocusLines,
  type FocusRange,
} from "./focus";
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
  /** The lines of a file its notes are about: what its diff is cut down to. Keep its identity too. */
  readonly focusOf: (file: DiffFile) => ReadonlyArray<FocusRange>;
  /** How many notes a file has, for its header, and whether one must be fixed. */
  readonly notesOf: (file: DiffFile) => FileNoteCount;
  /** Whether a file is shown, in full, and what the reader asked to see of it. */
  readonly viewOf: (path: string) => FileView;
  readonly onToggle: (path: string, open: boolean) => void;
  readonly onFull: (path: string, full: boolean) => void;
  readonly onReveal: (path: string, ranges: ReadonlyArray<FocusRange>) => void;
}

export interface FileNoteCount {
  readonly count: number;
  readonly mustFix: boolean;
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
  notes,
  onToggle,
}: {
  file: DiffFile;
  repo: RepoRef;
  headOid: string;
  collapsed: boolean;
  notes: FileNoteCount;
  onToggle: () => void;
}) {
  const label = STATUS_LABEL[file.status];
  return (
    <div
      className={`sticky top-[var(--review-sticky-top)] z-10 flex min-h-10 items-center gap-2 bg-surface-raised px-2 py-1.5 text-xs ${
        collapsed ? "rounded-md" : "rounded-t-md border-b border-border"
      }`}
    >
      <button
        type="button"
        aria-expanded={!collapsed}
        aria-label={collapsed ? `Show ${file.path}` : `Hide ${file.path}`}
        onClick={onToggle}
        className="inline-flex size-6 shrink-0 items-center justify-center rounded text-on-surface-muted hover:bg-surface-sunken hover:text-on-surface"
      >
        <Icon name={collapsed ? "chevronRight" : "chevronDown"} size={14} />
      </button>
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        onClick={onToggle}
        className="min-w-0 flex-1 truncate text-left font-mono text-[12px] text-on-surface"
      >
        {file.oldPath !== null && file.oldPath !== file.path ? (
          <span className="text-on-surface-muted">{showBidi(file.oldPath)} → </span>
        ) : null}
        {showBidi(file.path)}
      </button>
      {notes.count > 0 ? (
        <Badge tone={notes.mustFix ? "danger" : "notice"}>
          <Icon name="messageSquare" size={10} />
          {plural(notes.count, "note")}
        </Badge>
      ) : null}
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

type PickHandler = NonNullable<ReviewDiffProps["onPickLines"]>;

/** The renderer's options for a file, or for a part of one. */
function useDiffOptions({
  file,
  layout,
  onPickLines,
  loadDiffFiles,
}: {
  file: DiffFile;
  layout: DiffLayout;
  onPickLines?: PickHandler | undefined;
  /** Absent for a part of a file: the lines it leaves out are not all unchanged. */
  loadDiffFiles?: FileDiffContentsLoader | undefined;
}): FileDiffOptions<DiffMark, undefined> {
  return useMemo<FileDiffOptions<DiffMark, undefined>>(
    () => ({
      diffStyle: layout,
      theme: THEME,
      themeType: "system",
      disableFileHeader: true,
      overflow: "scroll",
      // Between the hunks of a part only a rule: what it leaves out there is unchanged.
      hunkSeparators: loadDiffFiles === undefined ? "simple" : "line-info",
      expansionLineCount: 20,
      unsafeCSS: HOST_CSS,
      ...(loadDiffFiles === undefined ? {} : { loadDiffFiles }),
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
    [layout, loadDiffFiles, onPickLines, file],
  );
}

interface LinesProps {
  readonly file: DiffFile;
  /** The file's own hunks for the whole diff, or the ones of a part of it. */
  readonly hunks: ReadonlyArray<DiffHunk>;
  readonly layout: DiffLayout;
  readonly marks: ReadonlyArray<DiffMark>;
  readonly renderMark: ReviewDiffProps["renderMark"];
  readonly onPickLines?: PickHandler | undefined;
  readonly selected: SelectedLineRange | null;
  readonly loadDiffFiles?: FileDiffContentsLoader | undefined;
}

/** Hunks of a file drawn as one diff, with what hangs on their lines. */
const Lines = memo(function Lines({
  file,
  hunks,
  layout,
  marks,
  renderMark,
  onPickLines,
  selected,
  loadDiffFiles,
}: LinesProps) {
  const whole = hunks === file.hunks;
  const metadata = useMemo<FileDiffMetadata>(
    () => getSingularPatch(patchOf(whole ? file : { ...file, hunks })),
    [file, hunks, whole],
  );
  const annotations = useMemo<DiffLineAnnotation<DiffMark>[]>(() => {
    const drawn = whole ? null : linesOfHunks(hunks);
    return marks
      .filter((mark) => drawn === null || drawn.has(markKey(mark)))
      .map((mark) => ({ side: mark.side, lineNumber: mark.lineNumber, metadata: mark }));
  }, [marks, hunks, whole]);
  const options = useDiffOptions({ file, layout, onPickLines, loadDiffFiles });
  const renderAnnotation = useCallback(
    (annotation: DiffLineAnnotation<DiffMark>) => renderMark(file, annotation.metadata),
    [renderMark, file],
  );
  return (
    <FileDiff<DiffMark>
      fileDiff={metadata}
      options={options}
      lineAnnotations={annotations}
      selectedLines={selected}
      renderAnnotation={renderAnnotation}
      disableWorkerPool
    />
  );
});

function Gap({ gap, onShow }: { gap: FocusGap; onShow: () => void }) {
  const label = plural(gap.changed, "more changed line");
  return (
    <button
      type="button"
      onClick={onShow}
      aria-label={`Show ${label}`}
      className="flex w-full items-center justify-center gap-2 border-y border-dashed border-border-strong bg-surface-sunken px-3 py-1.5 font-sans text-xs text-on-surface-secondary hover:bg-surface-inset hover:text-on-surface"
    >
      <Icon name="unfoldVertical" size={13} className="text-on-surface-muted" />
      <span className="font-medium">{label}</span>
      <span className="underline underline-offset-2">Show</span>
    </button>
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
  focusOf,
  notesOf,
  open,
  full,
  reveals,
  onToggle,
  onFull,
  onReveal,
}: Omit<ReviewDiffProps, "files" | "viewOf"> & FileView & { file: DiffFile }) {
  const [loaded, setLoaded] = useState<DiffFile | null>(null);
  const [busy, setBusy] = useState(false);
  const file = loaded ?? initial;
  const marks = marksOf(file);
  const anchors = focusOf(file);
  const collapsed = !open;

  // What the file is cut down to: what its notes are about, what hangs on it, what was asked for.
  const focused = useMemo(
    () =>
      focusFile(file, [
        ...anchors,
        ...marks
          .filter((mark) => mark.lineNumber > 0)
          .map((mark) => ({ side: mark.side, start: mark.lineNumber, end: mark.lineNumber })),
        ...reveals,
      ]),
    [file, anchors, marks, reveals],
  );
  const loadDiffFiles = useCallback<FileDiffContentsLoader>(
    () => loadSides(repo, headOid, file),
    [repo, headOid, file],
  );
  const canExpand = file.status !== "added" && file.status !== "deleted";
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

  const hasLines = file.hunks.length > 0;
  const inParts = hasLines && focused !== null && !full;
  const shared = { file, layout, marks, renderMark, onPickLines, selected };
  // With no lines to hang them on, what belongs to the file shows under its name. In parts,
  // what belongs above the file's first line is drawn here too, above the first part.
  const loose = !hasLines ? marks : inParts ? marks.filter((mark) => mark.lineNumber === 0) : [];
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
        notes={notesOf(file)}
        onToggle={() => onToggle(file.path, collapsed)}
      />
      {collapsed ? null : (
        <>
          {hasLines && focused !== null ? (
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-surface px-3 py-1.5 text-xs text-on-surface-secondary">
              <span>
                {full
                  ? `All ${plural(focused.totalChanged, "changed line")}`
                  : `Showing ${focused.shownChanged} of ${plural(focused.totalChanged, "changed line")}`}
              </span>
              <Button size="sm" onClick={() => onFull(file.path, !full)}>
                <Icon name={full ? "minus" : "unfoldVertical"} size={12} />
                {full ? "Show less" : "Show full diff"}
              </Button>
            </p>
          ) : null}
          {loose.map((mark) => (
            <div key={markKey(mark)}>{renderMark(file, mark)}</div>
          ))}
          {!hasLines ? (
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
          ) : (
            <div className="code-surface overflow-hidden rounded-b-md">
              {inParts && focused !== null ? (
                focused.pieces.map((piece: FocusLines | FocusGap) =>
                  piece.kind === "gap" ? (
                    <Gap
                      key={piece.key}
                      gap={piece}
                      onShow={() => onReveal(file.path, piece.reveal)}
                    />
                  ) : (
                    <Lines key={piece.key} {...shared} hunks={piece.hunks} />
                  ),
                )
              ) : (
                <Lines
                  {...shared}
                  hunks={file.hunks}
                  loadDiffFiles={canExpand ? loadDiffFiles : undefined}
                />
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
});

export default function ReviewDiff({ files, viewOf, ...rest }: ReviewDiffProps) {
  return (
    <div className="space-y-2">
      {files.map((file) => (
        <FileSection
          key={`${file.oldPath ?? ""}:${file.path}`}
          {...rest}
          {...viewOf(file.path)}
          file={file}
        />
      ))}
    </div>
  );
}

/** The few lines a card is about, drawn as the diff draws them. Unified: a card is narrow. */
export const DiffExcerpt = memo(function DiffExcerpt({
  file,
  hunks,
}: {
  file: DiffFile;
  hunks: ReadonlyArray<DiffHunk>;
}) {
  const metadata = useMemo<FileDiffMetadata>(
    () => getSingularPatch(patchOf({ ...file, hunks })),
    [file, hunks],
  );
  const options = useDiffOptions({ file, layout: "unified" });
  return (
    <div className="code-surface overflow-hidden rounded border border-border">
      <FileDiff<DiffMark> fileDiff={metadata} options={options} disableWorkerPool />
    </div>
  );
});
