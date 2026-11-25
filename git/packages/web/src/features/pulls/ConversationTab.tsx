import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { Review, TimelineItem } from "@infrawrench/git-contract";
import { api } from "../../api/client";
import { queries } from "../../api/queries";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/controls";
import { Field, Input } from "../../components/forms";
import { Icon, type IconName } from "../../components/icons";
import { Markdown } from "../../components/Markdown";
import { RelativeTime, UserLink } from "../../components/people";
import { InlineError } from "../../components/states";
import { useRepoRef } from "../../layout/RepoLayout";
import { CommentCard } from "../issues/CommentCard";
import { CommentForm } from "../issues/CommentForm";
import { LockControl, TriageFields } from "../issues/ThreadSidebar";
import { Timeline, TimelineRow } from "../issues/Timeline";
import { InfrastructureBox } from "./InfrastructureBox";
import { MergeBox } from "./MergeBox";
import { refreshPull, usePull } from "./PullLayout";
import { ReviewButton } from "./ReviewForm";
import { ReviewThreadView } from "./ReviewThreadView";
import { countThreads } from "./review-threads";

const REVIEW: Record<Review["state"], { icon: IconName; tone: string; verb: string }> = {
  approved: { icon: "check", tone: "text-success", verb: "approved these changes" },
  changes_requested: { icon: "fileDiff", tone: "text-danger", verb: "requested changes" },
  commented: { icon: "eye", tone: "text-on-surface-muted", verb: "reviewed" },
  dismissed: { icon: "x", tone: "text-on-surface-muted", verb: "reviewed (dismissed)" },
  pending: { icon: "clock", tone: "text-warning", verb: "started a review" },
};

function DismissButton({ review }: { review: Review }) {
  const repo = useRepoRef();
  const pull = usePull();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const dismiss = useMutation({
    mutationFn: () =>
      api.pulls.dismissReview({
        params: { ...repo, number: pull.number, reviewId: review.id },
        payload: { reason: reason.trim() },
      }),
    onSuccess: () => {
      setOpen(false);
      refreshPull();
    },
  });
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        Dismiss
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Dismiss review"
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              variant="danger"
              busy={dismiss.isPending}
              disabled={reason.trim() === ""}
              onClick={() => dismiss.mutate()}
            >
              Dismiss
            </Button>
          </>
        }
      >
        <Field label="Reason">
          {(control) => (
            <Input
              {...control}
              value={reason}
              maxLength={1000}
              onChange={(event) => setReason(event.target.value)}
            />
          )}
        </Field>
        <InlineError error={dismiss.error} />
      </Dialog>
    </>
  );
}

function ReviewEntry({ item }: { item: Extract<TimelineItem, { type: "review" }> }) {
  const { review, threads } = item;
  const look = REVIEW[review.state];
  // A bare comment on a line is a review of one thread and no words: show the thread alone.
  const bare = review.state === "commented" && review.body.trim() === "";
  return (
    <div className="space-y-2">
      {bare && threads.length > 0 ? null : (
        <TimelineRow icon={look.icon} tone={look.tone}>
          <span className="flex flex-wrap items-center gap-x-1.5">
            {review.author !== null ? <UserLink user={review.author} /> : <span>Someone</span>}
            <span>
              {look.verb}{" "}
              {review.submittedAt !== null ? <RelativeTime iso={review.submittedAt} /> : null}
            </span>
            {review.stale && review.state !== "commented" ? (
              <Badge tone="outline">Of an earlier commit</Badge>
            ) : null}
            {review.viewerCanDismiss ? <DismissButton review={review} /> : null}
          </span>
          {review.state === "dismissed" && review.dismissalReason !== null ? (
            <p className="text-on-surface-secondary">
              Dismissed{review.dismissedBy?.username ? ` by ${review.dismissedBy.username}` : ""}:{" "}
              {review.dismissalReason}
            </p>
          ) : null}
        </TimelineRow>
      )}
      {review.body.trim() !== "" ? (
        <div className="rounded-md border border-border bg-surface-raised px-3 py-2.5 sm:ml-10">
          <Markdown source={review.body} />
        </div>
      ) : null}
      {threads.map((thread) => (
        <div key={thread.id} className="sm:ml-10">
          <ReviewThreadView thread={thread} />
        </div>
      ))}
    </div>
  );
}

const DECISION: Record<string, { icon: IconName; tone: string; label: string }> = {
  approved: { icon: "check", tone: "text-success", label: "Approved" },
  changes_requested: { icon: "fileDiff", tone: "text-danger", label: "Requested changes" },
  commented: { icon: "messageSquare", tone: "text-on-surface-muted", label: "Commented" },
  dismissed: { icon: "x", tone: "text-on-surface-muted", label: "Dismissed" },
};

/** Each reviewer's newest verdict. */
function Reviewers({ reviews }: { reviews: ReadonlyArray<Review> }) {
  const newest = new Map<string, Review>();
  for (const review of reviews) {
    if (review.state === "pending" || review.author === null) continue;
    const before = newest.get(review.author.id);
    // A verdict outranks a later plain comment by the same person.
    if (before && review.state === "commented" && before.state !== "commented") continue;
    newest.set(review.author.id, review);
  }
  return (
    <section className="border-b border-border pb-3">
      <h2 className="mb-1.5 text-xs font-semibold text-on-surface-secondary">Reviewers</h2>
      {newest.size === 0 ? (
        <p className="text-xs text-on-surface-muted">No reviews</p>
      ) : (
        <ul className="space-y-1">
          {[...newest.values()].map((review) => {
            const look = DECISION[review.state]!;
            return (
              <li key={review.id} className="flex items-center justify-between gap-2 text-xs">
                {review.author !== null ? <UserLink user={review.author} avatar /> : null}
                <span
                  role="img"
                  aria-label={look.label}
                  title={review.stale ? `${look.label} an earlier commit` : look.label}
                  className={`inline-flex ${look.tone} ${review.stale ? "opacity-60" : ""}`}
                >
                  <Icon name={look.icon} size={13} />
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function ConversationTab() {
  const repo = useRepoRef();
  const pull = usePull();
  const { number } = pull;
  const params = { ...repo, number };
  const reviews = useQuery(queries.pulls.listReviews({ params }));
  const threads = useQuery(queries.pulls.listThreads({ params }));
  const counts = countThreads(threads.data?.threads ?? []);

  const update = useMutation({
    mutationFn: (payload: Parameters<typeof api.pulls.update>[0]["payload"]) =>
      api.pulls.update({ params, payload }),
    onSuccess: refreshPull,
  });
  const close = useMutation({
    mutationFn: () => api.pulls.close({ params }),
    onSuccess: refreshPull,
  });
  const reopen = useMutation({
    mutationFn: () => api.pulls.reopen({ params }),
    onSuccess: refreshPull,
  });
  const toDraft = useMutation({
    mutationFn: () => api.pulls.setDraft({ params, payload: { draft: true } }),
    onSuccess: refreshPull,
  });

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_16rem]">
      <div className="min-w-0 space-y-3">
        <CommentCard
          author={pull.author}
          createdAt={pull.createdAt}
          body={pull.body}
          edited={pull.bodyEditedAt !== null}
          access="author"
          canEdit={pull.viewer.canEdit}
          onSave={(body) => update.mutateAsync({ body })}
        />
        <Timeline
          number={number}
          kind="pulls"
          renderReview={(item) => <ReviewEntry item={item} />}
        />
        <InfrastructureBox number={number} />
        <MergeBox pull={pull} />
        <CommentForm
          number={number}
          canComment={pull.viewer.canComment}
          locked={pull.locked}
          stateActions={({ body, post }) =>
            pull.state === "merged" || !pull.viewer.canClose ? null : pull.state === "open" ? (
              <Button busy={close.isPending} onClick={() => void post().then(() => close.mutate())}>
                <Icon name="gitPullRequestClosed" size={13} className="text-danger" />
                {body.trim() === "" ? "Close pull request" : "Close with comment"}
              </Button>
            ) : (
              <Button
                busy={reopen.isPending}
                disabled={!pull.headRefExists}
                title={pull.headRefExists ? undefined : "Restore the branch first"}
                onClick={() => void post().then(() => reopen.mutate())}
              >
                Reopen pull request
              </Button>
            )
          }
        />
        <InlineError error={update.error ?? close.error ?? reopen.error ?? toDraft.error} />
      </div>
      <aside aria-label="Details">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <ReviewButton pendingComments={counts.pending} />
          {counts.unresolved > 0 ? (
            <span className="text-xs text-on-surface-muted">{counts.unresolved} unresolved</span>
          ) : null}
        </div>
        <Reviewers reviews={reviews.data?.reviews ?? []} />
        <div className="pt-3">
          <TriageFields
            kind="pulls"
            canTriage={pull.viewer.canTriage}
            shown={pull}
            value={{
              labels: pull.labels.map((label) => label.name),
              assignees: pull.assignees.flatMap((user) => user.username ?? []),
              milestone: pull.milestone?.number ?? null,
            }}
            onChange={(next) =>
              update.mutate({
                labels: [...next.labels],
                assignees: [...next.assignees],
                milestone: next.milestone,
              })
            }
          />
        </div>
        {pull.state === "open" && !pull.draft && pull.viewer.canEdit ? (
          <section className="border-t border-border py-3">
            <button
              type="button"
              disabled={toDraft.isPending}
              onClick={() => toDraft.mutate()}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-on-surface-secondary hover:text-on-surface disabled:opacity-60"
            >
              <Icon name="gitPullRequestDraft" size={13} />
              Convert to draft
            </button>
          </section>
        ) : null}
        {pull.viewer.canTriage ? (
          <div className="border-t border-border">
            <LockControl number={number} locked={pull.locked} />
          </div>
        ) : null}
      </aside>
    </div>
  );
}
