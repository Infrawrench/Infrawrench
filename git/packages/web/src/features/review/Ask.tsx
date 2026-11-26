/**
 * The ask at the top of a branch page: what was asked for, as the page's
 * opening text rather than a comment in a box, and edited in place.
 */
import { useState } from "react";
import type { UserRef } from "@infrawrench/git-contract";
import { Button } from "../../components/Button";
import { Icon } from "../../components/icons";
import { Markdown } from "../../components/Markdown";
import { MarkdownEditor } from "../../components/MarkdownEditor";
import { Avatar, RelativeTime, UserLink } from "../../components/people";
import { InlineError } from "../../components/states";

export function Ask({
  author,
  createdAt,
  body,
  edited,
  canEdit,
  onSave,
}: {
  author: UserRef | null;
  createdAt: string;
  body: string;
  edited: boolean;
  canEdit: boolean;
  onSave: (body: string) => Promise<unknown>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(body);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const name = author?.displayName ?? author?.username ?? "Deleted user";

  const save = () => {
    setBusy(true);
    setError(null);
    onSave(draft)
      .then(() => setEditing(false))
      .catch(setError)
      .finally(() => setBusy(false));
  };

  return (
    <section aria-label="Ask" className="max-w-3xl">
      <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-on-surface-muted">
        <Avatar name={name} src={author?.avatarUrl} size={18} />
        {author !== null ? <UserLink user={author} /> : <span>Deleted user</span>}
        <span>
          asked <RelativeTime iso={createdAt} />
        </span>
        {edited ? <span>· edited</span> : null}
        {canEdit && !editing ? (
          <button
            type="button"
            onClick={() => {
              setDraft(body);
              setError(null);
              setEditing(true);
            }}
            className="ml-1 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-on-surface-muted hover:bg-surface-sunken hover:text-on-surface"
          >
            <Icon name="pencil" size={11} />
            Edit ask
          </button>
        ) : null}
      </p>
      {editing ? (
        <div className="mt-3">
          <MarkdownEditor
            label="Ask"
            value={draft}
            onChange={setDraft}
            autoFocus
            onSubmit={save}
            actions={
              <>
                <InlineError error={error} />
                <Button onClick={() => setEditing(false)}>Cancel</Button>
                <Button variant="primary" busy={busy} onClick={save}>
                  Save
                </Button>
              </>
            }
          />
        </div>
      ) : body.trim() === "" ? (
        <p className="mt-3 text-sm text-on-surface-muted">No ask written</p>
      ) : (
        <div className="branch-ask mt-3">
          <Markdown source={body} />
        </div>
      )}
    </section>
  );
}
