import { useState, type FormEvent, type ReactNode } from "react";
import { Button } from "../../components/Button";
import { Input } from "../../components/forms";
import { InlineError } from "../../components/states";
import { ThreadStateBadge, type ThreadKind } from "../../components/StatusIcons";

/** A thread's title with its number, edited in place, and the state line under it. */
export function ThreadHeader({
  title,
  number,
  kind,
  canEdit,
  onRename,
  children,
  actions,
  large = false,
}: {
  title: string;
  number: number;
  kind: ThreadKind;
  canEdit: boolean;
  onRename: (title: string) => Promise<unknown>;
  /** The line beside the state badge: who opened it, the branches. */
  children: ReactNode;
  actions?: ReactNode;
  /** The title as a page's headline, with the state line above it: the branch page. */
  large?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const save = (event: FormEvent) => {
    event.preventDefault();
    const next = draft.trim();
    if (next === "" || next === title) {
      setEditing(false);
      return;
    }
    setBusy(true);
    setError(null);
    onRename(next)
      .then(() => setEditing(false))
      .catch(setError)
      .finally(() => setBusy(false));
  };

  const stateLine = (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-on-surface-muted">
      <ThreadStateBadge kind={kind} />
      {children}
    </div>
  );
  return (
    <div className={large ? "space-y-3" : "mb-4 space-y-2 border-b border-border pb-3"}>
      {large ? stateLine : null}
      {editing ? (
        <form onSubmit={save} className="flex flex-wrap items-center gap-2">
          <Input
            aria-label="Title"
            value={draft}
            autoFocus
            maxLength={256}
            onChange={(event) => setDraft(event.target.value)}
            className={`min-w-56 flex-1 ${large ? "!text-xl" : "!text-sm"}`}
          />
          <Button type="submit" variant="primary" busy={busy}>
            Save
          </Button>
          <Button onClick={() => setEditing(false)}>Cancel</Button>
          <InlineError error={error} />
        </form>
      ) : (
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h1
            className={`min-w-0 font-semibold text-on-surface [overflow-wrap:anywhere] ${
              large ? "text-3xl leading-tight tracking-tight" : "text-xl leading-7"
            }`}
          >
            {title} <span className="font-normal text-on-surface-muted">#{number}</span>
          </h1>
          <div className="flex items-center gap-2">
            {canEdit ? (
              <Button
                size="sm"
                onClick={() => {
                  setDraft(title);
                  setError(null);
                  setEditing(true);
                }}
              >
                Edit
              </Button>
            ) : null}
            {actions}
          </div>
        </div>
      )}
      {large ? null : stateLine}
    </div>
  );
}
