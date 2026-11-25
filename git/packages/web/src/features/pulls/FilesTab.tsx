/**
 * Files changed: the diff with review threads under their lines, a comment
 * box on any line (shift-click a second line for a range), a file list, and
 * "Viewed" marks the browser remembers per file version.
 */
import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { DiffFile, DiffLine } from "@infrawrench/git-contract";
import { api } from "../../api/client";
import { queries, usePages } from "../../api/queries";
import { AppLink } from "../../components/AppLink";
import { Segmented } from "../../components/controls";
import { DiffStat, DiffView, diffFileId, type DiffLayout } from "../../components/DiffView";
import { Checkbox } from "../../components/forms";
import { Icon } from "../../components/icons";
import { Panel } from "../../components/Panel";
import { EmptyState, ErrorState, Loading, LoadMore } from "../../components/states";
import { useRepoRef } from "../../layout/RepoLayout";
import { paths } from "../../lib/paths";
import { usePull } from "./PullLayout";
import { ReviewButton } from "./ReviewForm";
import { ReviewCommentForm, ReviewThreadView } from "./ReviewThreadView";
import {
  anchorOfLine,
  countThreads,
  extendAnchor,
  fileTree,
  indexThreads,
  threadsAt,
  threadsPerFile,
  type FileNode,
  type LineAnchor,
} from "./review-threads";
import { cursorQuery } from "../../lib/cursor";

const LAYOUT_KEY = "git-diff-layout";

function readLayout(): DiffLayout {
  try {
    return localStorage.getItem(LAYOUT_KEY) === "split" ? "split" : "unified";
  } catch {
    return "unified";
  }
}

/**
 * The files the reader has ticked off, kept in the browser. A file is viewed
 * at one version of its content: when a push changes it, the mark is gone.
 */
function useViewed(scope: string) {
  const key = `git-viewed:${scope}`;
  const [viewed, setViewed] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(localStorage.getItem(key) ?? "{}") as Record<string, string>;
    } catch {
      return {};
    }
  });
  const toggle = useCallback(
    (file: DiffFile) => {
      setViewed((current) => {
        const version = file.newOid ?? file.oldOid ?? "";
        const next = { ...current };
        if (next[file.path] === version) delete next[file.path];
        else next[file.path] = version;
        try {
          localStorage.setItem(key, JSON.stringify(next));
        } catch {
          // Remembered for this visit only.
        }
        return next;
      });
    },
    [key],
  );
  const isViewed = (file: DiffFile) => viewed[file.path] === (file.newOid ?? file.oldOid ?? "");
  return { isViewed, toggle };
}

function Tree({
  nodes,
  depth,
  files,
  isViewed,
  threadCounts,
}: {
  nodes: ReadonlyArray<FileNode>;
  depth: number;
  files: ReadonlyMap<string, DiffFile>;
  isViewed: (file: DiffFile) => boolean;
  threadCounts: ReadonlyMap<string, number>;
}) {
  return (
    <ul>
      {nodes.map((node) => {
        const file = node.path === null ? undefined : files.get(node.path);
        const indent = { paddingLeft: `${depth * 12 + 6}px` };
        if (node.path === null || file === undefined) {
          return (
            <li key={`dir:${node.name}`}>
              <div
                style={indent}
                className="flex items-center gap-1.5 py-1 pr-1.5 text-xs text-on-surface-muted"
              >
                <Icon name="folder" size={12} />
                <span className="truncate">{node.name}</span>
              </div>
              <Tree
                nodes={node.children}
                depth={depth + 1}
                files={files}
                isViewed={isViewed}
                threadCounts={threadCounts}
              />
            </li>
          );
        }
        const count = threadCounts.get(file.path) ?? 0;
        const tone =
          file.status === "added"
            ? "text-success"
            : file.status === "deleted"
              ? "text-danger"
              : "text-on-surface-muted";
        return (
          <li key={node.path}>
            <a
              href={`#${diffFileId(file.path)}`}
              style={indent}
              className={`flex items-center gap-1.5 rounded py-1 pr-1.5 text-xs hover:bg-surface-sunken ${
                isViewed(file) ? "text-on-surface-muted" : "text-on-surface"
              }`}
            >
              <Icon name="file" size={12} className={tone} />
              <span className="min-w-0 flex-1 truncate">{node.name}</span>
              {count > 0 ? (
                <span className="inline-flex items-center gap-0.5 text-on-surface-muted">
                  <Icon name="messageSquare" size={10} />
                  <span className="sr-only">Threads:</span>
                  {count}
                </span>
              ) : null}
              {isViewed(file) ? <Icon name="check" size={11} className="text-success" /> : null}
            </a>
          </li>
        );
      })}
    </ul>
  );
}

export function FilesTab() {
  const repo = useRepoRef();
  const pull = usePull();
  const params = { ...repo, number: pull.number };
  const [layout, setLayout] = useState<DiffLayout>(readLayout);
  const [hideWhitespace, setHideWhitespace] = useState(false);
  const [composer, setComposer] = useState<LineAnchor | null>(null);
  const viewed = useViewed(`${repo.owner}/${repo.repo}#${pull.number}`);
  const whitespace = hideWhitespace ? ("ignore" as const) : ("show" as const);

  const diff = usePages<
    DiffFile,
    Awaited<ReturnType<typeof api.pulls.files>> & { items: ReadonlyArray<DiffFile> }
  >(["pulls", "files", params, pull.headOid, whitespace], async (cursor) => {
    const page = await api.pulls.files({
      params,
      query: { ...cursorQuery(cursor), limit: 30, whitespace },
    });
    return { ...page, items: page.files };
  });
  const threads = useQuery(queries.pulls.listThreads({ params }));
  const all = useMemo(() => threads.data?.threads ?? [], [threads.data]);
  const index = useMemo(() => indexThreads(all), [all]);
  const counts = countThreads(all);
  const perFile = useMemo(() => threadsPerFile(all), [all]);
  const canComment = pull.viewer.canReview && pull.viewer.canComment;

  const byPath = useMemo(
    () => new Map(diff.items.map((file) => [file.path, file] as const)),
    [diff.items],
  );
  const tree = useMemo(() => fileTree(diff.items.map((file) => file.path)), [diff.items]);
  const stats = diff.pages[0]?.stats;

  const lineAction = (file: DiffFile, line: DiffLine) => {
    const anchor = anchorOfLine(file.path, line);
    if (anchor === null) return null;
    return (
      <button
        type="button"
        aria-label={`Comment on line ${anchor.line}${anchor.side === "LEFT" ? " (removed)" : ""}`}
        title="Comment on this line. Shift-click another line for a range."
        onClick={(event) =>
          setComposer((current) => (event.shiftKey ? extendAnchor(current, anchor) : anchor))
        }
        className="absolute left-0 top-0.5 inline-flex size-4 items-center justify-center rounded-sm bg-accent text-on-accent opacity-0 focus:opacity-100 group-hover:opacity-100"
      >
        <Icon name="plus" size={10} />
      </button>
    );
  };

  const renderAfterLine = (file: DiffFile, line: DiffLine) => {
    const anchor = anchorOfLine(file.path, line);
    const here = threadsAt(index, file.path, line);
    const composing =
      composer !== null &&
      anchor !== null &&
      composer.path === anchor.path &&
      composer.side === anchor.side &&
      composer.line === anchor.line;
    if (here.length === 0 && !composing) return null;
    return (
      <div className="space-y-px bg-surface">
        {here.map((thread) => (
          <ReviewThreadView key={thread.id} thread={thread} showLines={false} />
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
  if (diff.isLoading) return <Loading />;
  if (diff.items.length === 0) {
    return (
      <Panel>
        <EmptyState>No files changed</EmptyState>
      </Panel>
    );
  }
  const viewedCount = diff.items.filter(viewed.isViewed).length;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-on-surface-muted">
        {stats ? (
          <span className="inline-flex items-center gap-2">
            {stats.filesChanged} {stats.filesChanged === 1 ? "file" : "files"}
            <DiffStat additions={stats.additions} deletions={stats.deletions} />
          </span>
        ) : null}
        <span>
          {viewedCount} of {diff.items.length} viewed
        </span>
        {counts.outdated > 0 ? (
          <AppLink href={paths.pull(repo, pull.number)} className="hover:underline">
            {counts.outdated} outdated {counts.outdated === 1 ? "thread is" : "threads are"} in the
            conversation
          </AppLink>
        ) : null}
        <span className="flex flex-1 flex-wrap items-center justify-end gap-3">
          <Checkbox
            label="Hide whitespace"
            checked={hideWhitespace}
            onChange={(event) => setHideWhitespace(event.target.checked)}
          />
          <Segmented<DiffLayout>
            label="Diff layout"
            value={layout}
            onChange={(next) => {
              setLayout(next);
              try {
                localStorage.setItem(LAYOUT_KEY, next);
              } catch {
                // Kept for this visit only.
              }
            }}
            options={[
              { value: "unified", label: "Unified" },
              { value: "split", label: "Split" },
            ]}
          />
          <ReviewButton pendingComments={counts.pending} />
        </span>
      </div>
      <div className="grid gap-4 lg:grid-cols-[15rem_minmax(0,1fr)]">
        <nav aria-label="Changed files" className="hidden lg:block">
          <div className="sticky top-3 max-h-[calc(100vh-1.5rem)] overflow-y-auto">
            <Tree
              nodes={tree}
              depth={0}
              files={byPath}
              isViewed={viewed.isViewed}
              threadCounts={perFile}
            />
          </div>
        </nav>
        <div className="min-w-0 space-y-4">
          {diff.items.map((file) => {
            const done = viewed.isViewed(file);
            const toggle = (
              <Checkbox
                label="Viewed"
                checked={done}
                onChange={() => viewed.toggle(file)}
                aria-label={`Viewed ${file.path}`}
              />
            );
            return done ? (
              <Panel
                key={file.path}
                id={diffFileId(file.path)}
                className="flex scroll-mt-24 items-center gap-2 bg-surface-inset px-3 py-1.5 text-xs"
              >
                <span className="min-w-0 flex-1 truncate font-mono text-on-surface-muted">
                  {file.path}
                </span>
                <DiffStat additions={file.additions} deletions={file.deletions} />
                {toggle}
              </Panel>
            ) : (
              <div key={file.path} className="space-y-1">
                <div className="flex justify-end">{toggle}</div>
                <DiffView
                  repo={repo}
                  files={[file]}
                  headOid={pull.headOid}
                  layout={layout}
                  loadFile={async (path) =>
                    (await api.pulls.files({ params, query: { path, whitespace } })).files[0]
                  }
                  renderAfterLine={renderAfterLine}
                  {...(canComment ? { lineAction } : {})}
                />
              </div>
            );
          })}
          <LoadMore pages={diff} label="Load more files" />
        </div>
      </div>
    </div>
  );
}
