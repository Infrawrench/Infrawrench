import { useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { api } from "../../api/client";
import { invalidate } from "../../api/queries";
import { Button, buttonClass } from "../../components/Button";
import { Icon } from "../../components/icons";
import { MarkdownEditor } from "../../components/MarkdownEditor";
import { Avatar } from "../../components/people";
import { InlineError } from "../../components/states";
import { useRepoRef } from "../../layout/RepoLayout";
import { signInHref, useSession } from "../../lib/session";

/**
 * The box at the foot of a thread. `stateActions` are the buttons that change
 * the thread beside "Comment" (close, reopen); they get the draft so "Close
 * with comment" can post it first.
 */
export function CommentForm({
  number,
  canComment,
  locked,
  stateActions,
}: {
  number: number;
  canComment: boolean;
  locked: boolean;
  stateActions?: (draft: { body: string; post: () => Promise<void> }) => ReactNode;
}) {
  const repo = useRepoRef();
  const session = useSession();
  const user = session.data?.user ?? null;
  const [body, setBody] = useState("");
  const comment = useMutation({
    mutationFn: (text: string) =>
      api.issues.createComment({ params: { ...repo, number }, payload: { body: text } }),
    onSuccess: () => {
      setBody("");
      void invalidate("issues");
      void invalidate("pulls", "get");
    },
  });

  if (user === null) {
    return (
      <div className="flex items-center gap-3 rounded-md border border-border bg-surface-raised px-3 py-2.5 text-xs text-on-surface-muted sm:ml-10">
        <a href={signInHref()} className={buttonClass("primary", "sm")}>
          Sign in
        </a>
        to comment
      </div>
    );
  }
  if (!canComment) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-border bg-surface-raised px-3 py-2.5 text-xs text-on-surface-muted sm:ml-10">
        <Icon name="lock" size={13} />
        {locked ? "This conversation is locked" : "You cannot comment here"}
      </div>
    );
  }
  const post = async () => {
    if (body.trim() !== "") await comment.mutateAsync(body);
  };
  return (
    <div className="flex gap-3">
      <div className="hidden pt-1 sm:block">
        <Avatar
          name={user.displayName ?? user.username ?? user.email}
          src={user.avatarUrl}
          size={28}
        />
      </div>
      <div className="min-w-0 flex-1">
        <MarkdownEditor
          label="Comment"
          placeholder="Leave a comment"
          value={body}
          onChange={setBody}
          onSubmit={() => void post()}
          actions={
            <>
              <InlineError error={comment.error} />
              {stateActions?.({ body, post })}
              <Button
                variant="primary"
                busy={comment.isPending}
                disabled={body.trim() === ""}
                onClick={() => void post()}
              >
                Comment
              </Button>
            </>
          }
        />
      </div>
    </div>
  );
}
