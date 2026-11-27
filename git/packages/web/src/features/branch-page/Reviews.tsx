/** A review in a branch's conversation, and who reviewed it. */
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { Review, TimelineItem } from "@infrawrench/git-contract";
import { api } from "../../api/client";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/controls";
import { Field, Input } from "../../components/forms";
import { Icon, type IconName } from "../../components/icons";
import { Markdown } from "../../components/Markdown";
import { RelativeTime, UserLink } from "../../components/people";
import { InlineError } from "../../components/states";
import { useRepoRef } from "../../layout/RepoLayout";
import { TimelineRow } from "../issues/Timeline";
import { refreshBranchPage, useBranchPage } from "./BranchLayout";
import { ReviewThreadView } from "./ReviewThreadView";

const REVIEW: Record<Review["state"], { icon: IconName; tone: string; verb: string }> = {
  approved: { icon: "check", tone: "text-success", verb: "approved these changes" },
  changes_requested: { icon: "fileDiff", tone: "text-danger", verb: "requested changes" },
  commented: { icon: "eye", tone: "text-on-surface-muted", verb: "reviewed" },
  dismissed: { icon: "x", tone: "text-on-surface-muted", verb: "reviewed (dismissed)" },
  pending: { icon: "clock", tone: "text-warning", verb: "started a review" },
};

function DismissButton({ review }: { review: Review }) {
  const repo = useRepoRef();
  const page = useBranchPage();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const dismiss = useMutation({
    mutationFn: () =>
      api.branches.dismissReview({
        params: { ...repo, branch: page.key, reviewId: review.id },
        payload: { reason: reason.trim() },
      }),
    onSuccess: () => {
      setOpen(false);
      refreshBranchPage();
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

/** A review in the conversation: its verdict, its words, and the threads it started. */
export function ReviewEntry({ item }: { item: Extract<TimelineItem, { type: "review" }> }) {
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
export function Reviewers({ reviews }: { reviews: ReadonlyArray<Review> }) {
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
