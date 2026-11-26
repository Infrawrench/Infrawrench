/**
 * A version's diff with everything that is about its lines on them: each
 * trace entry above the lines it explains, findings and review threads
 * under theirs, and a comment box on any line of the newest version.
 */
import { useMemo, useState } from "react";
import type {
  BranchVersion,
  DiffFile,
  DiffLine,
  ReviewFinding,
  ReviewThread,
  TraceEntry,
} from "@infrawrench/git-contract";
import { api } from "../../api/client";
import { usePages } from "../../api/queries";
import { Segmented } from "../../components/controls";
import { DiffStat, DiffView, type DiffLayout } from "../../components/DiffView";
import { Checkbox } from "../../components/forms";
import { Icon } from "../../components/icons";
import { Panel } from "../../components/Panel";
import { EmptyState, ErrorState, Loading, LoadMore } from "../../components/states";
import { useRepoRef } from "../../layout/RepoLayout";
import { cursorQuery } from "../../lib/cursor";
import { plural } from "../../lib/format";
import { useDiffLayout } from "../code/DiffSection";
import { usePull } from "../pulls/PullLayout";
import { ReviewCommentForm, ReviewThreadView } from "../pulls/ReviewThreadView";
import {
  anchorOfLine,
  extendAnchor,
  indexThreads,
  threadsAt,
  type LineAnchor,
} from "../pulls/review-threads";
import { diffFrom, diffNotice, lineKey, placeOnDiff, seenOn, type DiffMode } from "./branch";
import { FindingCard } from "./Findings";
import { TraceBlock } from "./Trace";

export function VersionDiff({
  version,
  mode,
  latest,
  traces,
  findings,
  threads,
}: {
  version: BranchVersion;
  mode: DiffMode;
  /** The newest version: where review threads sit and new comments go. */
  latest: boolean;
  /** Every entry of the branch's trace; this picks the ones the diff covers. */
  traces: ReadonlyArray<TraceEntry>;
  findings: ReadonlyArray<ReviewFinding>;
  threads: ReadonlyArray<ReviewThread>;
}) {
  const repo = useRepoRef();
  const pull = usePull();
  const params = { ...repo, number: pull.number, version: String(version.number) };
  const from = diffFrom(mode);
  const [layout, setLayout] = useDiffLayout();
  const [hideWhitespace, setHideWhitespace] = useState(false);
  const [composer, setComposer] = useState<LineAnchor | null>(null);
  const whitespace = hideWhitespace ? ("ignore" as const) : ("show" as const);

  const diff = usePages(
    ["versions", "diff", params, from, whitespace, version.tipOid],
    async (cursor) => {
      const page = await api.versions.diff({
        params,
        query: { ...cursorQuery(cursor), limit: 30, whitespace, from },
      });
      return { ...page, items: page.files };
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
  const canComment = latest && pull.viewer.canReview && pull.viewer.canComment;

  const lineAction = (file: DiffFile, line: DiffLine) => {
    const anchor = anchorOfLine(file.path, line);
    if (anchor === null || (anchor.side === "LEFT" && !whole)) return null;
    return (
      <button
        type="button"
        aria-label={`Comment on line ${anchor.line}${anchor.side === "LEFT" ? " (removed)" : ""}`}
        title="Comment on this line. Shift-click another line for a range."
        onClick={(event) =>
          setComposer((current) => (event.shiftKey ? extendAnchor(current, anchor) : anchor))
        }
        className="absolute top-0.5 left-0 inline-flex size-4 items-center justify-center rounded-sm bg-accent text-on-accent opacity-0 group-hover:opacity-100 focus:opacity-100"
      >
        <Icon name="plus" size={10} />
      </button>
    );
  };

  const renderBeforeLine = (file: DiffFile, line: DiffLine) => {
    if (line.type === "delete" || line.newLine === null) return null;
    const entries = placed.traceAt.get(lineKey(file.path, "RIGHT", line.newLine));
    return entries === undefined ? null : <TraceBlock entries={entries} />;
  };

  const renderAfterLine = (file: DiffFile, line: DiffLine) => {
    const anchor = anchorOfLine(file.path, line);
    if (anchor === null) return null;
    const found = placed.findingAt.get(lineKey(anchor.path, anchor.side, anchor.line)) ?? [];
    const here = threadsAt(index, file.path, line);
    const composing =
      composer !== null &&
      composer.path === anchor.path &&
      composer.side === anchor.side &&
      composer.line === anchor.line;
    if (found.length === 0 && here.length === 0 && !composing) return null;
    return (
      <div className="divide-y divide-border bg-surface">
        {found.map((finding) => (
          <div key={finding.id} className="border-l-2 border-danger/60">
            <FindingCard finding={finding} number={pull.number} where={false} />
          </div>
        ))}
        {here.map((thread) => (
          <ReviewThreadView key={thread.id} thread={thread} showLines={false} branch />
        ))}
        {composing ? (
          <div className="bg-surface-raised p-2.5">
            <ReviewCommentForm
              anchor={composer}
              onDone={() => setComposer(null)}
              onCancel={() => setComposer(null)}
            />
          </div>
        ) : null}
      </div>
    );
  };

  if (diff.error) return <ErrorState error={diff.error} />;
  if (diff.isLoading || first === undefined) return <Loading shape="code" />;
  const notice = diffNotice(first);

  return (
    <section aria-label="Changes" className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-on-surface-muted">
        <span className="inline-flex items-center gap-2">
          {first.kind === "whole"
            ? `v${first.to} against its base`
            : `v${first.from} to v${first.to}`}
          <span aria-hidden="true">·</span>
          {plural(first.stats.filesChanged, "file")}
          <DiffStat additions={first.stats.additions} deletions={first.stats.deletions} />
        </span>
        <span className="flex flex-1 flex-wrap items-center justify-end gap-3">
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
        </span>
      </div>
      {notice !== null ? (
        <p
          role="note"
          className="flex items-start gap-2 rounded-md border border-border bg-surface-raised px-3 py-2 text-xs text-on-surface-secondary"
        >
          <Icon name="alertCircle" size={13} className="mt-0.5 text-warning" />
          {notice}
        </p>
      ) : null}
      {placed.traces.length > 0 ? (
        <Panel>
          <TraceBlock entries={placed.traces} where label="About the whole change" />
        </Panel>
      ) : null}
      {diff.items.length === 0 ? (
        <Panel>
          <EmptyState>
            {first.kind === "whole"
              ? "No files changed"
              : `Nothing changed between v${first.from} and v${first.to}`}
          </EmptyState>
        </Panel>
      ) : (
        <div className="space-y-4">
          {diff.items.map((file) => {
            const fileTraces = placed.traceOfFile.get(file.path) ?? [];
            const fileFindings = placed.findingOfFile.get(file.path) ?? [];
            return (
              <div key={file.path} className="space-y-1.5">
                {fileTraces.length > 0 || fileFindings.length > 0 ? (
                  <Panel className="divide-y divide-border">
                    <TraceBlock entries={fileTraces} where />
                    {fileFindings.map((finding) => (
                      <FindingCard key={finding.id} finding={finding} number={pull.number} />
                    ))}
                  </Panel>
                ) : null}
                <DiffView
                  repo={repo}
                  files={[file]}
                  headOid={version.tipOid}
                  layout={layout}
                  loadFile={async (path) =>
                    (await api.versions.diff({ params, query: { path, whitespace, from } }))
                      .files[0]
                  }
                  renderBeforeLine={renderBeforeLine}
                  renderAfterLine={renderAfterLine}
                  {...(canComment ? { lineAction } : {})}
                />
              </div>
            );
          })}
          <LoadMore pages={diff} label="Load more files" />
        </div>
      )}
    </section>
  );
}
