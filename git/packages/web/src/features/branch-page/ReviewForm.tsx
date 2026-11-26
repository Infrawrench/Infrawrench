import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api } from "../../api/client";
import { Button, buttonClass } from "../../components/Button";
import { RadioCards, Textarea } from "../../components/forms";
import { Icon } from "../../components/icons";
import { Popover } from "../../components/Menu";
import { InlineError } from "../../components/states";
import { useRepoRef } from "../../layout/RepoLayout";
import type { ReviewEvent } from "@infrawrench/git-contract";
import { plural } from "../../lib/format";
import { refreshBranchPage, useBranchPage } from "./BranchLayout";

/**
 * "Finish review": the summary, the verdict, and submit. With comments
 * pending it submits that review; without, it is a review of its own.
 */
export function ReviewButton({ pendingComments }: { pendingComments: number }) {
  const repo = useRepoRef();
  const page = useBranchPage();
  const [body, setBody] = useState("");
  const [event, setEvent] = useState<ReviewEvent>("comment");
  const params = { ...repo, branch: page.key };
  const reviewId = page.viewer.pendingReviewId;

  const submit = useMutation({
    mutationFn: () =>
      reviewId !== null
        ? api.branches.submitReview({ params: { ...params, reviewId }, payload: { event, body } })
        : api.branches.createReview({ params, payload: { event, body, commitOid: page.headOid } }),
    onSuccess: () => {
      setBody("");
      setEvent("comment");
      refreshBranchPage();
    },
  });
  const discard = useMutation({
    mutationFn: () =>
      api.branches.discardReview({ params: { ...params, reviewId: reviewId ?? "" } }),
    onSuccess: refreshBranchPage,
  });

  if (!page.viewer.canReview) return null;
  const needsText = event === "comment" && pendingComments === 0;
  const own = !page.viewer.canApprove;

  return (
    <Popover
      align="end"
      className="w-80"
      trigger={({ props }) => (
        <button
          {...props}
          type="button"
          aria-haspopup="dialog"
          className={buttonClass("primary", "md")}
        >
          {reviewId !== null ? "Finish review" : "Review changes"}
          {pendingComments > 0 ? (
            <span className="rounded-full bg-on-accent/20 px-1.5 text-[10px] leading-4">
              {pendingComments}
            </span>
          ) : null}
          <Icon name="chevronDown" size={12} />
        </button>
      )}
    >
      {({ close }) => (
        <div role="dialog" aria-label="Finish review" className="space-y-3 p-3">
          {pendingComments > 0 ? (
            <p className="text-xs text-on-surface-muted">
              {plural(pendingComments, "pending comment")}
            </p>
          ) : null}
          <Textarea
            aria-label="Review summary"
            placeholder="Summary"
            rows={4}
            value={body}
            onChange={(change) => setBody(change.target.value)}
          />
          <RadioCards<ReviewEvent>
            legend="Verdict"
            name="review-event"
            value={event}
            onChange={setEvent}
            options={[
              { value: "comment", label: "Comment" },
              { value: "approve", label: "Approve", disabled: own },
              { value: "request_changes", label: "Request changes", disabled: own },
            ]}
          />
          {own ? (
            <p className="text-xs text-on-surface-muted">
              The author cannot approve or request changes.
            </p>
          ) : null}
          <InlineError error={submit.error ?? discard.error} />
          <div className="flex items-center justify-between gap-2">
            {reviewId !== null ? (
              <Button
                variant="danger"
                busy={discard.isPending}
                onClick={() => discard.mutate(undefined, { onSuccess: close })}
              >
                Discard review
              </Button>
            ) : (
              <span />
            )}
            <Button
              variant="primary"
              busy={submit.isPending}
              disabled={needsText && body.trim() === ""}
              onClick={() => submit.mutate(undefined, { onSuccess: close })}
            >
              Submit review
            </Button>
          </div>
        </div>
      )}
    </Popover>
  );
}
