/**
 * What there is to read about a version before its code: the agent's doubts
 * and decisions first, then what reviewers found and what people said on its
 * lines, then the rest of the trace in the order the agent recorded it. Each
 * is a card that names the file and lines it is about, and shows those lines
 * when it says the code is needed to follow it (`needsCode`). The diffs
 * themselves come after, closed.
 */
import { lazy, Suspense, useMemo, type ReactNode } from "react";
import type { DiffFile, ReviewFinding, ReviewThread, TraceEntry } from "@infrawrench/git-contract";
import { AppLink } from "../../components/AppLink";
import { diffFileId } from "../../components/DiffView";
import { useRepoRef } from "../../layout/RepoLayout";
import { showBidi } from "../../lib/bidi";
import { formatLineHash } from "../../lib/lines";
import { paths } from "../../lib/paths";
import { ReviewThreadView } from "../branch-page/ReviewThreadView";
import { sortFindings, whereLabel } from "./branch";
import { excerptOf, type FocusRange } from "./diff/focus";
import { FindingCard } from "./Findings";
import { TraceEntryView } from "./Trace";

const DiffExcerpt = lazy(() =>
  import("./diff/ReviewDiff").then((module) => ({ default: module.DiffExcerpt })),
);

/** Where in the diff a note's lines are. */
export interface NotePlace {
  readonly path: string;
  readonly range: FocusRange;
}

export type Jump = (path: string, range: FocusRange | null, noteId: string | null) => void;

/** A card's place in the notes, for something that links to it. */
export const noteCardId = (id: string): string => `note-${id}`;
/** The same note where it hangs on its lines in the diff. */
export const diffNoteId = (id: string): string => `diff-note-${id}`;

/** `modules/network/main.tf:97-103`, going to those lines in the diff. */
function Where({
  path,
  start,
  end,
  side = "additions",
  noteId,
  inDiff,
  headOid,
  onJump,
}: {
  path: string;
  start: number | null | undefined;
  end: number | null | undefined;
  side?: FocusRange["side"];
  /** The note as it hangs in the diff, when it does. */
  noteId: string | null;
  inDiff: boolean;
  headOid: string;
  onJump: Jump;
}) {
  const repo = useRepoRef();
  const first = start ?? end ?? null;
  const last = end ?? start ?? null;
  const label = showBidi(whereLabel(path, first, last));
  const look =
    "min-w-0 truncate rounded bg-surface-sunken px-1.5 py-px font-mono text-[11px] text-on-surface-secondary hover:text-on-surface hover:underline";
  // A file this diff does not have is read where it is.
  if (!inDiff) {
    return (
      <AppLink
        href={paths.blob(
          repo,
          headOid,
          path,
          first === null || last === null ? undefined : formatLineHash({ start: first, end: last }),
        )}
        className={look}
      >
        {label}
      </AppLink>
    );
  }
  return (
    <a
      href={`#${diffFileId(path)}`}
      className={look}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        onJump(
          path,
          first === null || last === null ? null : { side, start: first, end: last },
          noteId,
        );
      }}
    >
      {label}
    </a>
  );
}

function Code({ file, place }: { file: DiffFile | undefined; place: NotePlace | undefined }) {
  const hunks = useMemo(
    () => (file === undefined || place === undefined ? [] : excerptOf(file, place.range)),
    [file, place],
  );
  if (file === undefined || hunks.length === 0) return null;
  return (
    <Suspense fallback={null}>
      <DiffExcerpt file={file} hunks={hunks} />
    </Suspense>
  );
}

function Group({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  if (count === 0) return null;
  return (
    <section aria-label={title} className="space-y-2">
      <h3 className="flex items-baseline gap-2 text-xs font-semibold uppercase tracking-wide text-on-surface-muted">
        {title}
        <span className="font-mono font-normal tabular-nums">{count}</span>
      </h3>
      {children}
    </section>
  );
}

export function ReviewNotes({
  traces,
  findings,
  threads,
  files,
  placedAt,
  headOid,
  branchKey,
  onJump,
}: {
  /** The trace entries this diff covers, in the order they were recorded. */
  traces: ReadonlyArray<TraceEntry>;
  findings: ReadonlyArray<ReviewFinding>;
  /** The review threads on lines of this diff. */
  threads: ReadonlyArray<ReviewThread>;
  files: ReadonlyMap<string, DiffFile>;
  /** Where each trace entry's and finding's lines are in this diff, by its id. */
  placedAt: ReadonlyMap<string, NotePlace>;
  headOid: string;
  branchKey: string;
  onJump: Jump;
}) {
  const first = traces.filter((entry) => entry.kind === "doubt" || entry.kind === "decision");
  // Doubts before decisions: a doubt is what the agent asks the reader to settle.
  const prominent = [
    ...first.filter((entry) => entry.kind === "doubt"),
    ...first.filter((entry) => entry.kind === "decision"),
  ];
  const steps = traces.filter((entry) => entry.kind !== "doubt" && entry.kind !== "decision");
  if (traces.length + findings.length + threads.length === 0) return null;

  const traceCard = (entry: TraceEntry) => {
    const place = placedAt.get(entry.id);
    return (
      <li
        key={entry.id}
        id={noteCardId(entry.id)}
        data-kind={entry.kind}
        className="diff-note scroll-mt-24"
      >
        <TraceEntryView
          entry={entry}
          where
          renderWhere={(anchor) => (
            <Where
              path={anchor.path}
              start={anchor.startLine}
              end={anchor.endLine}
              noteId={entry.needsCode && place?.path === anchor.path ? entry.id : null}
              inDiff={files.has(anchor.path)}
              headOid={headOid}
              onJump={onJump}
            />
          )}
        >
          {entry.needsCode && place !== undefined ? (
            <Code file={files.get(place.path)} place={place} />
          ) : null}
        </TraceEntryView>
      </li>
    );
  };

  return (
    <section aria-label="Review notes" className="space-y-5">
      <Group title="Doubts and decisions" count={prominent.length}>
        <ul className="space-y-2">{prominent.map(traceCard)}</ul>
      </Group>
      <Group title="Findings" count={findings.length}>
        <ul className="space-y-2">
          {sortFindings(findings).map((finding) => {
            const place = placedAt.get(finding.id);
            return (
              <li key={finding.id} id={noteCardId(finding.id)} className="diff-note scroll-mt-24">
                <FindingCard
                  finding={finding}
                  branchKey={branchKey}
                  whereLink={
                    finding.path === null ? null : (
                      <Where
                        path={finding.path}
                        start={finding.startLine}
                        end={finding.endLine}
                        side={finding.side === "LEFT" ? "deletions" : "additions"}
                        noteId={finding.needsCode && place !== undefined ? finding.id : null}
                        inDiff={files.has(finding.path)}
                        headOid={headOid}
                        onJump={onJump}
                      />
                    )
                  }
                  code={
                    finding.needsCode && place !== undefined ? (
                      <Code file={files.get(place.path)} place={place} />
                    ) : undefined
                  }
                />
              </li>
            );
          })}
        </ul>
      </Group>
      <Group title="Comments" count={threads.length}>
        <ul className="max-w-[52rem] space-y-2">
          {threads.map((thread) => (
            <li key={thread.id}>
              <ReviewThreadView thread={thread} showLines />
            </li>
          ))}
        </ul>
      </Group>
      <Group title="Steps" count={steps.length}>
        <ol className="space-y-2">{steps.map(traceCard)}</ol>
      </Group>
    </section>
  );
}
