/**
 * A version, read before its code: what the agent recorded and what was
 * found, as cards (`Notes.tsx`), then the changed files, each closed until
 * the reader opens it or follows a card to its lines. An open file shows
 * only the lines something is about until it is asked for in full, with
 * everything that needs the code hung on its lines: each trace entry above
 * the lines it explains, findings and review threads under theirs, and a
 * comment box on any line of the newest version. The changed files are a
 * tree beside it, with the diff's totals under the tree.
 *
 * The diff and the tree are drawn by `@pierre/diffs` and `@pierre/trees`
 * (`./diff/`), loaded when a branch page first shows a diff.
 */
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useLocation } from "@tanstack/react-router";
import type {
  BranchVersion,
  DiffFile,
  ReviewFinding,
  ReviewThread,
  TraceEntry,
} from "@infrawrench/git-contract";
import { ApiError, api } from "../../api/client";
import { usePages } from "../../api/queries";
import { AppLink } from "../../components/AppLink";
import { Button } from "../../components/Button";
import { Segmented } from "../../components/controls";
import { DiffStat, diffFileId, type DiffLayout } from "../../components/DiffView";
import { Checkbox } from "../../components/forms";
import { Icon } from "../../components/icons";
import { EmptyState, ErrorState, Loading, LoadMore } from "../../components/states";
import { useRepoRef } from "../../layout/RepoLayout";
import { cursorQuery } from "../../lib/cursor";
import { shortOid } from "../../lib/format";
import { paths } from "../../lib/paths";
import { useDiffLayout } from "../code/DiffSection";
import { useBranchPage } from "../branch-page/BranchLayout";
import { ReviewCommentForm, ReviewThreadView } from "../branch-page/ReviewThreadView";
import {
  anchorOfLine,
  fileTree,
  indexThreads,
  threadsAt,
  type FileNode,
  type LineAnchor,
} from "../branch-page/review-threads";
import {
  diffFrom,
  diffNotice,
  lineKey,
  placeOnDiff,
  prunedNotice,
  seenOn,
  type DiffMode,
} from "./branch";
import {
  fileView,
  orderFiles,
  rankOf,
  reveal,
  setAll,
  setFull,
  setOpen,
  type DiffViewState,
  type FileNotes,
  type FocusRange,
} from "./diff/focus";
import { rowAbove } from "./diff/patch";
import type { DiffMark, DiffMarkKey, FileNoteCount, PickedLines } from "./diff/ReviewDiff";
import { FindingCard } from "./Findings";
import { ReviewNotes, diffNoteId, type NotePlace } from "./Notes";
import { TraceBlock } from "./Trace";

const ReviewDiff = lazy(() => import("./diff/ReviewDiff"));
const FileTreePane = lazy(() => import("./diff/FileTreePane"));

const keyOf = (mark: DiffMark): DiffMarkKey => `${mark.side}:${mark.lineNumber}`;

/** What hangs under one line of a file. */
interface Hung {
  readonly mark: DiffMark;
  /** Trace entries about the file as a whole (only on line 0). */
  readonly fileTraces: TraceEntry[];
  readonly fileFindings: ReviewFinding[];
  readonly findings: ReviewFinding[];
  readonly threads: ReviewThread[];
  /** Trace entries that explain the lines after this one. */
  readonly traces: TraceEntry[];
}

type HungByLine = ReadonlyMap<DiffMarkKey, Hung>;

const sideOf = (side: "LEFT" | "RIGHT"): DiffMark["side"] =>
  side === "LEFT" ? "deletions" : "additions";

const NO_FOCUS: ReadonlyArray<FocusRange> = [];
const NO_NOTES: FileNoteCount = { count: 0, mustFix: false };

/** The row of the diff that draws a line, inside the renderer's own tree. */
function lineElement(section: HTMLElement, range: FocusRange): Element | null {
  for (const host of section.querySelectorAll("*")) {
    const row = host.shadowRoot?.querySelector(`[data-line="${range.start}"]`);
    if (row !== null && row !== undefined) return row;
  }
  return null;
}

/**
 * Scrolls to something that may not be drawn yet: a file just opened draws
 * its lines a moment later. Looks for it for a second and a half, then
 * settles for the file.
 */
function scrollWhenDrawn(find: () => Element | null, fallback: () => Element | null): void {
  let tries = 0;
  const look = (): void => {
    const target = find();
    if (target !== null) {
      target.scrollIntoView?.({ block: "center" });
      return;
    }
    if (++tries < 25) window.setTimeout(look, 60);
    else fallback()?.scrollIntoView?.({ block: "start" });
  };
  look();
}

/** The rows the tree draws: folded folders and files. Its height follows from them. */
const countRows = (nodes: ReadonlyArray<FileNode>): number =>
  nodes.reduce((total, node) => total + 1 + countRows(node.children), 0);

/** The strip above a diff: what is compared on the left, how it is shown on the right. */
export function DiffBar({ lead, children }: { lead: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border pb-3 text-xs text-on-surface-muted">
      {lead}
      <span className="flex flex-1 flex-wrap items-center justify-end gap-3">{children}</span>
    </div>
  );
}

function Stat({ label, value, tone = "" }: { label: string; value: number; tone?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-border py-1.5 first:border-t-0">
      <dt className="text-on-surface-muted">{label}</dt>
      <dd className={`font-mono font-semibold tabular-nums ${tone || "text-on-surface"}`}>
        {value}
      </dd>
    </div>
  );
}

export function VersionDiff({
  version,
  mode,
  latest,
  traces,
  findings,
  threads,
  lead,
  actions,
  view,
  onView,
}: {
  version: BranchVersion;
  mode: DiffMode;
  /** The newest version: where review threads sit and new comments go. */
  latest: boolean;
  /** Every entry of the branch's trace; this picks the ones the diff covers. */
  traces: ReadonlyArray<TraceEntry>;
  findings: ReadonlyArray<ReviewFinding>;
  threads: ReadonlyArray<ReviewThread>;
  /** The start of the strip above the diff: the page's switch between what to compare. */
  lead?: ReactNode;
  /** The end of that strip: marking the version reviewed. */
  actions?: ReactNode;
  /** Which files are open and how far, kept by the page so a change of version keeps it. */
  view: DiffViewState;
  onView: (change: (state: DiffViewState) => DiffViewState) => void;
}) {
  const repo = useRepoRef();
  const page = useBranchPage();
  const params = useMemo(
    () => ({ ...repo, branch: page.key, version: String(version.number) }),
    [repo, page.key, version.number],
  );
  const from = diffFrom(mode);
  const [layout, setLayout] = useDiffLayout();
  const [hideWhitespace, setHideWhitespace] = useState(false);
  const [composer, setComposer] = useState<LineAnchor | null>(null);
  const whitespace = hideWhitespace ? ("ignore" as const) : ("show" as const);

  const diff = usePages(
    ["versions", "diff", params, from, whitespace, version.tipOid],
    async (cursor) => {
      const answer = await api.versions.diff({
        params,
        query: { ...cursorQuery(cursor), limit: 30, whitespace, from },
      });
      return { ...answer, items: answer.files };
    },
  );
  const first = diff.pages[0];
  const whole = first === undefined || first.kind === "whole";
  const since = first?.from ?? null;

  // What this diff covers: everything up to the version for the whole change,
  // otherwise only the versions after the one it compares from.
  const covered = useMemo(
    () =>
      traces.filter(
        (entry) =>
          entry.version !== null &&
          entry.version <= version.number &&
          (since === null || entry.version > since),
      ),
    [traces, version.number, since],
  );
  const seen = useMemo(
    () => findings.filter((finding) => seenOn(finding, version.number)),
    [findings, version.number],
  );
  const placed = useMemo(
    () =>
      placeOnDiff(diff.items, covered, seen, {
        oldSide: whole,
        version: version.number,
        headOid: version.tipOid,
      }),
    [diff.items, covered, seen, whole, version.number, version.tipOid],
  );
  // Threads are carried to the newest head: a removed line's only has a place against the base.
  const index = useMemo(
    () => indexThreads(latest ? threads.filter((thread) => whole || thread.side === "RIGHT") : []),
    [threads, latest, whole],
  );
  const canComment = latest && page.viewer.canReview && page.viewer.canComment;

  // Everything the page hangs on each file's lines, and the lines themselves. A trace
  // entry or a finding hangs there only when it says the code is needed to follow it;
  // what a person wrote on a line always does. Beside it: where each note's lines are,
  // what each file's diff is cut down to, and the threads the diff has a line for.
  const { hung, placedAt, focus, shownThreads } = useMemo(() => {
    const byFile = new Map<string, Map<DiffMarkKey, Hung>>();
    const placedAt = new Map<string, NotePlace>();
    const focus = new Map<string, FocusRange[]>();
    const shownThreads = new Set<ReviewThread>();
    const inFocus = (path: string, range: FocusRange): void => {
      const list = focus.get(path);
      if (list) list.push(range);
      else focus.set(path, [range]);
    };
    for (const file of diff.items) {
      const lines = new Map<DiffMarkKey, Hung>();
      const at = (mark: DiffMark): Hung => {
        const key = keyOf(mark);
        let entry = lines.get(key);
        if (entry === undefined) {
          entry = {
            mark,
            fileTraces: [],
            fileFindings: [],
            findings: [],
            threads: [],
            traces: [],
          };
          lines.set(key, entry);
        }
        return entry;
      };
      const top: DiffMark = {
        side: file.status === "deleted" ? "deletions" : "additions",
        lineNumber: 0,
      };
      const fileTraces = (placed.traceOfFile.get(file.path) ?? []).filter(
        (entry) => entry.needsCode,
      );
      const fileFindings = (placed.findingOfFile.get(file.path) ?? []).filter(
        (finding) => finding.needsCode,
      );
      if (fileTraces.length > 0) at(top).fileTraces.push(...fileTraces);
      if (fileFindings.length > 0) at(top).fileFindings.push(...fileFindings);
      for (const hunk of file.hunks) {
        for (const line of hunk.lines) {
          const anchor = anchorOfLine(file.path, line);
          if (anchor === null) continue;
          const mark = { side: sideOf(anchor.side), lineNumber: anchor.line };
          for (const finding of placed.findingAt.get(
            lineKey(anchor.path, anchor.side, anchor.line),
          ) ?? []) {
            const range = {
              side: mark.side,
              start: Math.min(finding.startLine ?? anchor.line, anchor.line),
              end: anchor.line,
            };
            placedAt.set(finding.id, { path: file.path, range });
            if (!finding.needsCode) continue;
            at(mark).findings.push(finding);
            inFocus(file.path, range);
          }
          const here = threadsAt(index, file.path, line);
          if (here.length > 0) {
            at(mark).threads.push(...here);
            for (const thread of here) {
              shownThreads.add(thread);
              inFocus(file.path, {
                side: mark.side,
                start: Math.min(thread.startLine ?? anchor.line, anchor.line),
                end: anchor.line,
              });
            }
          }
          if (line.type !== "delete" && line.newLine !== null) {
            const from = line.newLine;
            const entries = placed.traceAt.get(lineKey(file.path, "RIGHT", from)) ?? [];
            const above = entries.length === 0 ? null : rowAbove(file, from, layout);
            for (const entry of entries) {
              const anchored = entry.anchors.find((item) => item.path === file.path);
              const range = {
                side: "additions" as const,
                start: from,
                end: Math.max(anchored?.endLine ?? from, from),
              };
              placedAt.set(entry.id, { path: file.path, range });
              if (!entry.needsCode || above === null) continue;
              at(above).traces.push(entry);
              inFocus(file.path, range);
            }
          }
        }
      }
      byFile.set(file.path, lines);
    }
    return { hung: byFile, placedAt, focus, shownThreads: [...shownThreads] };
  }, [diff.items, placed, index, layout]);

  // What each file has on it, whether or not it hangs on a line: the count on its
  // header, and the order the files go in.
  const { notes, counts } = useMemo(() => {
    const has = new Set(diff.items.map((file) => file.path));
    const mustFix = new Set<string>();
    const traced = new Map<string, number>();
    const noted = new Set<string>();
    const counts = new Map<string, { count: number; mustFix: boolean }>();
    const count = (path: string, must = false): void => {
      const own = counts.get(path) ?? { count: 0, mustFix: false };
      counts.set(path, { count: own.count + 1, mustFix: own.mustFix || must });
    };
    for (const [at, entry] of covered.entries()) {
      const anchor = entry.anchors.find((item) => has.has(item.path));
      if (anchor === undefined) continue;
      if (!traced.has(anchor.path)) traced.set(anchor.path, at);
      count(anchor.path);
    }
    for (const finding of seen) {
      if (finding.path === null || !has.has(finding.path)) continue;
      const must = finding.status === "open" && finding.severity === "must_fix";
      if (must) mustFix.add(finding.path);
      noted.add(finding.path);
      count(finding.path, must);
    }
    for (const thread of shownThreads) {
      noted.add(thread.path);
      count(thread.path);
    }
    const notes: FileNotes = { mustFix, traced, noted };
    return { notes, counts };
  }, [diff.items, covered, seen, shownThreads]);
  // A file the reader is writing on stays where it is when their comment lands on it.
  const held = useRef(new Map<string, number>());
  const ordered = useMemo(() => orderFiles(diff.items, notes, held.current), [diff.items, notes]);
  const byPath = useMemo(() => new Map(diff.items.map((file) => [file.path, file])), [diff.items]);
  const marked = useMemo(() => {
    const out = new Map<string, "must_fix" | "noted">();
    for (const [path, own] of counts) out.set(path, own.mustFix ? "must_fix" : "noted");
    return out;
  }, [counts]);
  const marks = useMemo(() => {
    const byFile = new Map<string, DiffMark[]>();
    for (const [path, lines] of hung) {
      byFile.set(
        path,
        [...lines.values()].map((entry) => entry.mark),
      );
    }
    return byFile;
  }, [hung]);

  // The open comment box is one more thing on one line of one file.
  const composerMark = useMemo<DiffMark | null>(
    () => (composer === null ? null : { side: sideOf(composer.side), lineNumber: composer.line }),
    [composer],
  );
  const composerMarks = useMemo(() => {
    if (composer === null || composerMark === null) return null;
    const own = marks.get(composer.path) ?? [];
    return own.some((mark) => keyOf(mark) === keyOf(composerMark)) ? own : [...own, composerMark];
  }, [composer, composerMark, marks]);
  const marksOf = useCallback(
    (file: DiffFile): ReadonlyArray<DiffMark> =>
      composer !== null && composerMarks !== null && composer.path === file.path
        ? composerMarks
        : (marks.get(file.path) ?? NO_MARKS),
    [composer, composerMarks, marks],
  );
  const focusOf = useCallback(
    (file: DiffFile): ReadonlyArray<FocusRange> => focus.get(file.path) ?? NO_FOCUS,
    [focus],
  );
  const notesOf = useCallback(
    (file: DiffFile): FileNoteCount => counts.get(file.path) ?? NO_NOTES,
    [counts],
  );
  const viewOf = useCallback((path: string) => fileView(view, path), [view]);
  const onToggle = useCallback(
    (path: string, open: boolean) => onView((state) => setOpen(state, path, open)),
    [onView],
  );
  const onFull = useCallback(
    (path: string, full: boolean) => onView((state) => setFull(state, path, full)),
    [onView],
  );
  const onReveal = useCallback(
    (path: string, ranges: ReadonlyArray<FocusRange>) =>
      onView((state) => reveal(state, path, ranges)),
    [onView],
  );
  const picked = useMemo(
    () =>
      composer === null
        ? null
        : {
            path: composer.path,
            lines: {
              side: sideOf(composer.side),
              start: composer.startLine ?? composer.line,
              end: composer.line,
            },
          },
    [composer],
  );

  const renderMark = useCallback(
    (file: DiffFile, mark: DiffMark) => {
      const here: Hung | undefined = (hung.get(file.path) as HungByLine | undefined)?.get(
        keyOf(mark),
      );
      const composing =
        composer !== null &&
        composerMark !== null &&
        composer.path === file.path &&
        keyOf(composerMark) === keyOf(mark);
      if (here === undefined && !composing) return null;
      const cards =
        (here?.fileFindings.length ?? 0) +
        (here?.findings.length ?? 0) +
        (here?.threads.length ?? 0) +
        (composing ? 1 : 0);
      return (
        <div className="space-y-2 px-3 py-2 font-sans">
          {here !== undefined && here.fileTraces.length > 0 ? (
            <div className="diff-note">
              <TraceBlock entries={here.fileTraces} where />
            </div>
          ) : null}
          {cards > 0 ? (
            <div className="diff-note divide-y divide-border">
              {(here?.fileFindings ?? []).map((finding) => (
                <FindingCard key={finding.id} finding={finding} branchKey={page.key} />
              ))}
              {(here?.findings ?? []).map((finding) => (
                <div
                  key={finding.id}
                  id={diffNoteId(finding.id)}
                  className="border-l-2 border-l-danger/60"
                >
                  <FindingCard finding={finding} branchKey={page.key} where={false} />
                </div>
              ))}
              {(here?.threads ?? []).map((thread) => (
                <ReviewThreadView key={thread.id} thread={thread} showLines={false} />
              ))}
              {composing && composer !== null ? (
                <div className="bg-surface-raised p-2.5">
                  <ReviewCommentForm
                    anchor={composer}
                    onDone={() => setComposer(null)}
                    onCancel={() => setComposer(null)}
                  />
                </div>
              ) : null}
            </div>
          ) : null}
          {here !== undefined && here.traces.length > 0 ? (
            <div className="diff-note">
              <TraceBlock entries={here.traces} idOf={(entry) => diffNoteId(entry.id)} />
            </div>
          ) : null}
        </div>
      );
    },
    [hung, composer, composerMark, page.key],
  );

  const onPickLines = useCallback(
    (file: DiffFile, lines: PickedLines) => {
      // A removed line only has a place against the base.
      if (lines.side === "deletions" && !whole) return;
      if (!held.current.has(file.path)) held.current.set(file.path, rankOf(file.path, notes));
      // A file shown whole because nothing is on it would be cut down to this comment
      // the moment the box opened. It stays whole.
      const bare =
        (focus.get(file.path)?.length ?? 0) === 0 && (marks.get(file.path)?.length ?? 0) === 0;
      if (bare) {
        onView((state) =>
          fileView(state, file.path).reveals.length === 0 ? setFull(state, file.path, true) : state,
        );
      }
      setComposer({
        path: file.path,
        side: lines.side === "deletions" ? "LEFT" : "RIGHT",
        line: lines.end,
        ...(lines.start === lines.end ? {} : { startLine: lines.start }),
      });
    },
    [whole, notes, focus, marks, onView],
  );
  const loadFile = useCallback(
    async (path: string) =>
      (await api.versions.diff({ params, query: { path, whitespace, from } })).files[0],
    [params, whitespace, from],
  );
  const section = (path: string) => document.getElementById(diffFileId(path));
  // Picking a file in the tree opens it and goes to it.
  const goToFile = useCallback(
    (path: string) => {
      onView((state) => setOpen(state, path, true));
      section(path)?.scrollIntoView?.({ block: "start" });
    },
    [onView],
  );
  // A card's file and lines: the file opens with those lines among the ones it shows.
  const jump = useCallback(
    (path: string, range: FocusRange | null, noteId: string | null) => {
      onView((state) =>
        range === null ? setOpen(state, path, true) : reveal(state, path, [range]),
      );
      if (range === null) {
        section(path)?.scrollIntoView?.({ block: "start" });
        return;
      }
      scrollWhenDrawn(
        () => {
          const note = noteId === null ? null : document.getElementById(diffNoteId(noteId));
          const host = section(path);
          return note ?? (host === null ? null : lineElement(host, range));
        },
        () => section(path),
      );
    },
    [onView],
  );
  // An address that names a file (`#diff-<path>`) opens it, once.
  const hash = useLocation({ select: (location) => location.hash });
  const opened = useRef<string | null>(null);
  useEffect(() => {
    if (hash === opened.current) return;
    const file = diff.items.find((item) => diffFileId(item.path) === hash);
    if (file === undefined) return;
    opened.current = hash;
    onView((state) => setOpen(state, file.path, true));
  }, [hash, diff.items, onView]);
  const anyOpen = diff.items.some((file) => fileView(view, file.path).open);
  const anyClosed = diff.items.some((file) => !fileView(view, file.path).open);
  const treeRows = useMemo(
    () => countRows(fileTree(diff.items.map((file) => file.path))),
    [diff.items],
  );

  const controls = (
    <>
      <Checkbox
        label="Hide whitespace"
        checked={hideWhitespace}
        onChange={(event) => setHideWhitespace(event.target.checked)}
      />
      <Segmented<DiffLayout>
        label="Diff layout"
        value={layout}
        onChange={setLayout}
        options={[
          { value: "unified", label: "Unified" },
          { value: "split", label: "Split" },
        ]}
      />
      {actions}
    </>
  );

  if (diff.error instanceof ApiError && diff.error.code === "version_pruned") {
    const recorded = traces.filter((entry) => entry.version === version.number);
    return (
      <section aria-label="Changes" className="space-y-4">
        <DiffBar lead={lead}>{actions}</DiffBar>
        <p
          role="note"
          className="flex items-start gap-2 rounded-md border border-border bg-surface-raised px-3 py-2 text-xs text-on-surface-secondary"
        >
          <Icon name="archive" size={13} className="mt-0.5 text-on-surface-muted" />
          <span>
            {prunedNotice({ version: version.number, mode, merged: page.state === "merged" })}
            {page.mergeCommitOid !== null ? (
              <>
                {" "}
                The change as merged is commit{" "}
                <AppLink
                  href={paths.commit(repo, page.mergeCommitOid)}
                  className="font-mono text-on-surface hover:underline"
                >
                  {shortOid(page.mergeCommitOid)}
                </AppLink>
                .
              </>
            ) : null}
          </span>
        </p>
        {recorded.length > 0 ? (
          <div className="diff-note max-w-3xl">
            <TraceBlock entries={recorded} where label={`Recorded for v${version.number}`} />
          </div>
        ) : null}
      </section>
    );
  }
  if (diff.error) return <ErrorState error={diff.error} />;
  // The strip is built the same while the diff loads, so its buttons are the same ones after.
  if (diff.isLoading || first === undefined) {
    return (
      <section aria-label="Changes" className="space-y-4">
        <DiffBar
          lead={
            <>
              {lead}
              {null}
            </>
          }
        >
          {controls}
        </DiffBar>
        <Loading shape="code" />
      </section>
    );
  }
  const notice = diffNotice(first);
  const reviewNotes = (
    <ReviewNotes
      traces={covered}
      findings={seen}
      threads={shownThreads}
      files={byPath}
      placedAt={placedAt}
      headOid={version.tipOid}
      branchKey={page.key}
      onJump={jump}
    />
  );

  return (
    <section aria-label="Changes" className="space-y-4">
      <DiffBar
        lead={
          <>
            {lead}
            <span className="inline-flex items-center gap-2">
              {first.kind === "whole"
                ? `v${first.to} against its base`
                : `v${first.from} to v${first.to}`}
            </span>
          </>
        }
      >
        {controls}
      </DiffBar>
      {first.source === "merge" && page.mergeCommitOid !== null ? (
        <p
          role="note"
          className="flex items-start gap-2 rounded-md border border-border bg-surface-raised px-3 py-2 text-xs text-on-surface-secondary"
        >
          <Icon name="archive" size={13} className="mt-0.5 text-on-surface-muted" />
          <span>
            The commits of v{first.to} are no longer kept. This is the change as it was merged, read
            from commit{" "}
            <AppLink
              href={paths.commit(repo, page.mergeCommitOid)}
              className="font-mono text-on-surface hover:underline"
            >
              {shortOid(page.mergeCommitOid)}
            </AppLink>
            .
          </span>
        </p>
      ) : null}
      {notice !== null ? (
        <p
          role="note"
          className="flex items-start gap-2 rounded-md border border-border bg-surface-raised px-3 py-2 text-xs text-on-surface-secondary"
        >
          <Icon name="alertCircle" size={13} className="mt-0.5 text-warning" />
          {notice}
        </p>
      ) : null}
      {diff.items.length === 0 ? (
        <>
          {reviewNotes}
          <EmptyState>
            {first.kind === "whole"
              ? "No files changed"
              : `Nothing changed between v${first.from} and v${first.to}`}
          </EmptyState>
        </>
      ) : (
        <>
          {reviewNotes}
          <div className="grid items-start gap-6 lg:grid-cols-[17rem_minmax(0,1fr)]">
            <aside
              aria-label="Files"
              className="hidden max-h-[calc(100vh-var(--review-sticky-top)-1rem)] flex-col lg:sticky lg:top-[calc(var(--review-sticky-top)+0.5rem)] lg:flex"
            >
              <div
                className="min-h-0 shrink"
                style={{ height: `${treeRows * 26 + 8}px`, minHeight: "3rem" }}
              >
                <Suspense fallback={null}>
                  <FileTreePane files={diff.items} marked={marked} onPick={goToFile} />
                </Suspense>
              </div>
              <dl
                aria-label="Diff stats"
                className="mt-3 shrink-0 border-t border-border pt-2 text-xs"
              >
                <Stat label="Files" value={first.stats.filesChanged} />
                <Stat label="Additions" value={first.stats.additions} tone="text-success" />
                <Stat label="Deletions" value={first.stats.deletions} tone="text-danger" />
              </dl>
            </aside>
            <div className="min-w-0 space-y-3">
              <div className="flex flex-wrap items-center gap-2 text-xs text-on-surface-muted">
                <h3 className="font-semibold uppercase tracking-wide">Files</h3>
                <span className="font-mono tabular-nums">{first.stats.filesChanged}</span>
                <span className="lg:hidden">
                  <DiffStat additions={first.stats.additions} deletions={first.stats.deletions} />
                </span>
                <span className="flex-1" />
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!anyClosed}
                  onClick={() => onView((state) => setAll(state, true))}
                >
                  <Icon name="unfoldVertical" size={12} />
                  Expand all
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!anyOpen}
                  onClick={() => onView((state) => setAll(state, false))}
                >
                  <Icon name="minus" size={12} />
                  Collapse all
                </Button>
              </div>
              <Suspense fallback={<Loading shape="code" />}>
                <ReviewDiff
                  repo={repo}
                  files={ordered}
                  focusOf={focusOf}
                  notesOf={notesOf}
                  viewOf={viewOf}
                  onToggle={onToggle}
                  onFull={onFull}
                  onReveal={onReveal}
                  headOid={version.tipOid}
                  layout={layout}
                  loadFile={loadFile}
                  marksOf={marksOf}
                  renderMark={renderMark}
                  picked={picked}
                  {...(canComment ? { onPickLines } : {})}
                />
              </Suspense>
              <LoadMore pages={diff} label="Load more files" />
            </div>
          </div>
        </>
      )}
    </section>
  );
}

const NO_MARKS: ReadonlyArray<DiffMark> = [];
