/**
 * A review thread: the lines it was written on (outside the diff), its
 * comments, a reply box and the resolve button. The files view draws the
 * same thread under its line without the lines.
 */
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { DiffHunk, ReviewThread } from "@infrawrench/git-contract";
import { api } from "../../api/client";
import { AppLink } from "../../components/AppLink";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { diffFileId } from "../../components/DiffView";
import { Icon } from "../../components/icons";
import { MarkdownEditor } from "../../components/MarkdownEditor";
import { UserLink } from "../../components/people";
import { InlineError } from "../../components/states";
import { useRepoRef } from "../../layout/RepoLayout";
import { paths } from "../../lib/paths";
import { CommentCard } from "../issues/CommentCard";
import { refreshPull, usePull } from "./PullLayout";
import { instructionFor } from "../review/branch";
import { InstructionBadge, SendToAgentButton, useInstructions } from "../review/Instructions";
import { describeAnchor, startsCollapsed, type LineAnchor } from "./review-threads";

const TONE = { context: "", add: "bg-success/10", delete: "bg-danger/10" } as const;
const MARK = { context: " ", add: "+", delete: "-" } as const;

/** The lines a thread was written on, as they were. */
function HunkLines({ hunk }: { hunk: DiffHunk }) {
  return (
    <div className="overflow-x-auto border-b border-border">
      <table className="w-full border-collapse font-mono text-xs leading-5 [tab-size:4]">
        <tbody>
          {hunk.lines.map((line, index) => (
            <tr key={index} className={TONE[line.type]}>
              <td className="w-px select-none px-2 text-right text-on-surface-faint">
                {line.oldLine ?? ""}
              </td>
              <td className="w-px select-none px-2 text-right text-on-surface-faint">
                {line.newLine ?? ""}
              </td>
              <td className="whitespace-pre pr-4 text-on-surface">
                <span
                  aria-hidden="true"
                  className="inline-block w-4 select-none text-on-surface-muted"
                >
                  {MARK[line.type]}
                </span>
                {line.content}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The box a line comment or a reply is written in. */
export function ReviewCommentForm({
  anchor,
  inReplyTo,
  onDone,
  onCancel,
  autoFocus = true,
}: {
  /** A new thread on these lines. */
  anchor?: LineAnchor;
  /** A reply in this thread. */
  inReplyTo?: string;
  onDone: () => void;
  onCancel: () => void;
  autoFocus?: boolean;
}) {
  const repo = useRepoRef();
  const pull = usePull();
  const [body, setBody] = useState("");
  const reviewing = pull.viewer.pendingReviewId !== null;
  const send = useMutation({
    mutationFn: (pending: boolean) =>
      api.pulls.createReviewComment({
        params: { ...repo, number: pull.number },
        payload: {
          body,
          pending,
          commitOid: pull.headOid,
          ...(inReplyTo !== undefined
            ? { inReplyTo }
            : anchor !== undefined
              ? {
                  path: anchor.path,
                  line: anchor.line,
                  side: anchor.side,
                  ...(anchor.startLine === undefined
                    ? {}
                    : { startLine: anchor.startLine, startSide: anchor.side }),
                }
              : {}),
        },
      }),
    onSuccess: () => {
      refreshPull();
      onDone();
    },
  });
  const empty = body.trim() === "";
  return (
    <div className="space-y-1.5">
      {anchor !== undefined ? (
        <p className="text-xs text-on-surface-muted">{describeAnchor(anchor)}</p>
      ) : null}
      <MarkdownEditor
        label={inReplyTo !== undefined ? "Reply" : "Review comment"}
        placeholder={inReplyTo !== undefined ? "Reply" : "Leave a comment"}
        value={body}
        onChange={setBody}
        rows={3}
        autoFocus={autoFocus}
        onSubmit={() => !empty && send.mutate(reviewing)}
        actions={
          <>
            <InlineError error={send.error} />
            <Button onClick={onCancel}>Cancel</Button>
            {reviewing ? null : (
              <Button disabled={empty || send.isPending} onClick={() => send.mutate(false)}>
                {inReplyTo !== undefined ? "Reply" : "Add single comment"}
              </Button>
            )}
            <Button
              variant="primary"
              disabled={empty}
              busy={send.isPending}
              onClick={() => send.mutate(true)}
            >
              {reviewing ? "Add to review" : "Start a review"}
            </Button>
          </>
        }
      />
    </div>
  );
}

export function ReviewThreadView({
  thread,
  showLines = true,
  branch = false,
}: {
  thread: ReviewThread;
  /** Draw the lines the thread is on: everywhere but under its line in the diff. */
  showLines?: boolean;
  /** On the branch page: name its version, what answered it, and offer it to the agent. */
  branch?: boolean;
}) {
  const repo = useRepoRef();
  const pull = usePull();
  const sent = useInstructions();
  const instruction =
    !branch || sent === null || sent.instructions === null
      ? null
      : instructionFor(sent.instructions, {
          commentIds: thread.comments.map((comment) => comment.id),
        });
  const answeredIn = branch ? (thread.answeredInVersion ?? null) : null;
  const [collapsed, setCollapsed] = useState(() => startsCollapsed(thread));
  const [replying, setReplying] = useState(false);
  const resolve = useMutation({
    mutationFn: () =>
      thread.resolved
        ? api.pulls.unresolveThread({ params: { ...repo, threadId: thread.id } })
        : api.pulls.resolveThread({ params: { ...repo, threadId: thread.id } }),
    onSuccess: (next) => {
      refreshPull();
      setCollapsed(next.resolved);
    },
  });
  const first = thread.comments[0];
  const where = describeAnchor({
    side: thread.side,
    line: thread.line ?? thread.originalLine,
    startLine: thread.line === null ? thread.originalStartLine : thread.startLine,
  });

  return (
    <div
      className={`overflow-hidden bg-surface-raised ${
        showLines ? "rounded-md border border-border" : ""
      }`}
    >
      <div className="flex min-h-8 flex-wrap items-center gap-2 border-b border-border bg-surface-inset px-2 py-1 text-xs">
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Show thread" : "Hide thread"}
          onClick={() => setCollapsed(!collapsed)}
          className="inline-flex size-5 items-center justify-center rounded text-on-surface-muted hover:bg-surface-sunken"
        >
          <Icon name={collapsed ? "chevronRight" : "chevronDown"} />
        </button>
        {showLines ? (
          <AppLink
            href={
              branch
                ? `${paths.pull(repo, pull.number)}#${diffFileId(thread.path)}`
                : `${paths.pullTab(repo, pull.number, "files")}#${diffFileId(thread.path)}`
            }
            className="min-w-0 truncate font-mono text-on-surface hover:underline"
          >
            {thread.path}
          </AppLink>
        ) : null}
        <span className="text-on-surface-muted">{where}</span>
        {collapsed && first ? (
          <span className="min-w-0 flex-1 truncate text-on-surface-muted">
            {first.author?.username ?? "Someone"}: {first.body.split("\n")[0]}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        {branch && thread.version !== undefined && thread.version !== null ? (
          <Badge tone="outline">v{thread.version}</Badge>
        ) : null}
        {answeredIn !== null ? (
          <Badge tone="notice">Answered by v{answeredIn}</Badge>
        ) : thread.outdated ? (
          <Badge tone="warning">Outdated</Badge>
        ) : null}
        {instruction !== null &&
        !(answeredIn !== null && instruction.answeredInVersion === answeredIn) ? (
          <InstructionBadge instruction={instruction} />
        ) : null}
        {thread.resolved ? (
          <Badge tone="success">
            <Icon name="check" size={10} />
            Resolved
          </Badge>
        ) : null}
      </div>
      {collapsed ? null : (
        <>
          {showLines && thread.hunk !== null ? <HunkLines hunk={thread.hunk} /> : null}
          <ul className="space-y-3 px-3 py-2.5">
            {thread.comments.map((comment) => (
              <li key={comment.id}>
                <CommentCard
                  compact
                  author={comment.author}
                  createdAt={comment.createdAt}
                  body={comment.body}
                  edited={comment.edited}
                  canEdit={comment.viewerCanEdit}
                  canDelete={comment.viewerCanDelete}
                  badges={comment.pending ? <Badge tone="warning">Pending</Badge> : undefined}
                  onSave={(body) =>
                    api.pulls
                      .updateReviewComment({
                        params: { ...repo, commentId: comment.id },
                        payload: { body },
                      })
                      .then(refreshPull)
                  }
                  onDelete={() =>
                    api.pulls
                      .deleteReviewComment({ params: { ...repo, commentId: comment.id } })
                      .then(refreshPull)
                  }
                />
              </li>
            ))}
          </ul>
          <div className="space-y-2 border-t border-border px-3 py-2">
            {replying && first ? (
              <ReviewCommentForm
                inReplyTo={first.id}
                onDone={() => setReplying(false)}
                onCancel={() => setReplying(false)}
              />
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                {thread.viewerCanReply ? (
                  <Button size="sm" onClick={() => setReplying(true)}>
                    Reply
                  </Button>
                ) : null}
                {thread.viewerCanResolve ? (
                  <Button size="sm" busy={resolve.isPending} onClick={() => resolve.mutate()}>
                    {thread.resolved ? "Unresolve" : "Resolve"}
                  </Button>
                ) : null}
                {branch && instruction === null && !thread.resolved && first ? (
                  <SendToAgentButton
                    from={{ source: "review_comment", reviewCommentId: first.id }}
                  />
                ) : null}
                {thread.resolved && thread.resolvedBy !== null ? (
                  <span className="inline-flex items-center gap-1 text-xs text-on-surface-muted">
                    Resolved by <UserLink user={thread.resolvedBy} />
                  </span>
                ) : null}
                <InlineError error={resolve.error} />
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
