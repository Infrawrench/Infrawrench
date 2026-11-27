import { useState, type ReactNode } from "react";
import type { ImportedFrom, UserRef } from "@infrawrench/git-contract";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { ConfirmDialog } from "../../components/controls";
import { Icon } from "../../components/icons";
import { Markdown } from "../../components/Markdown";
import { MarkdownEditor } from "../../components/MarkdownEditor";
import { Menu, type MenuItem } from "../../components/Menu";
import { Avatar, RelativeTime, UserLink } from "../../components/people";
import { InlineError } from "../../components/states";
import { ImportedAuthor, importedAuthorName } from "./ImportedFrom";

const ACCESS_LABEL: Record<string, string> = {
  owner: "Owner",
  member: "Member",
  collaborator: "Collaborator",
  author: "Author",
};

export interface CommentCardProps {
  readonly author: UserRef | null;
  /** Where it was imported from: names its author there when no account here is theirs. */
  readonly imported?: ImportedFrom | null | undefined;
  readonly createdAt: string;
  readonly body: string;
  readonly edited?: boolean;
  /** `owner`, `member`, `collaborator`, `author`, or null for no badge. */
  readonly access?: string | null;
  /** What the author did: "commented", "opened this". */
  readonly verb?: string;
  /** Shown instead of an empty body. */
  readonly emptyText?: string;
  readonly canEdit?: boolean;
  readonly canDelete?: boolean;
  readonly onSave?: (body: string) => Promise<unknown>;
  readonly onDelete?: () => Promise<unknown>;
  /** Extra badges in the header: "Pending". */
  readonly badges?: ReactNode;
  /** Without the outer box and avatar column: a reply inside a review thread. */
  readonly compact?: boolean;
  /** The DOM id, for a link to this comment. */
  readonly id?: string;
}

/** A comment: who, when, the Markdown, and editing it in place. */
export function CommentCard({
  author,
  imported = null,
  createdAt,
  body,
  edited = false,
  access = null,
  verb = "commented",
  emptyText = "No description",
  canEdit = false,
  canDelete = false,
  onSave,
  onDelete,
  badges,
  compact = false,
  id,
}: CommentCardProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(body);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [confirming, setConfirming] = useState(false);
  const name =
    author?.displayName ?? author?.username ?? importedAuthorName(imported) ?? "Deleted user";

  const save = () => {
    if (!onSave) return;
    setBusy(true);
    setError(null);
    onSave(draft)
      .then(() => setEditing(false))
      .catch(setError)
      .finally(() => setBusy(false));
  };

  const items: MenuItem[] = [];
  if (canEdit && onSave) {
    items.push({
      label: "Edit",
      icon: <Icon name="pencil" size={12} />,
      onSelect: () => {
        setDraft(body);
        setError(null);
        setEditing(true);
      },
    });
  }
  if (canDelete && onDelete) {
    items.push({
      label: "Delete",
      icon: <Icon name="trash" size={12} />,
      danger: true,
      onSelect: () => setConfirming(true),
    });
  }

  const header = (
    <div
      className={`flex min-h-8 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-on-surface-muted ${
        compact ? "" : "rounded-t-md border-b border-border bg-surface-inset px-3 py-1"
      }`}
    >
      {compact ? <Avatar name={name} src={author?.avatarUrl} size={18} /> : null}
      {author !== null ? (
        <UserLink user={author} />
      ) : imported?.author ? (
        <ImportedAuthor imported={imported} />
      ) : (
        <span>Deleted user</span>
      )}
      <span>
        {verb} <RelativeTime iso={createdAt} />
      </span>
      {edited ? <span>· edited</span> : null}
      <span className="flex flex-1 items-center justify-end gap-1.5">
        {badges}
        {access !== null && ACCESS_LABEL[access] !== undefined ? (
          <Badge tone="outline">{ACCESS_LABEL[access]}</Badge>
        ) : null}
        {items.length > 0 ? (
          <Menu
            label="Comment actions"
            align="end"
            items={items}
            trigger={({ props }) => (
              <button
                {...props}
                type="button"
                aria-label="Comment actions"
                aria-haspopup="menu"
                className="inline-flex size-6 items-center justify-center rounded text-on-surface-muted hover:bg-surface-sunken hover:text-on-surface"
              >
                <Icon name="moreHorizontal" />
              </button>
            )}
          />
        ) : null}
      </span>
    </div>
  );

  const content = editing ? (
    <div className="space-y-2 p-2">
      <MarkdownEditor
        label="Edit comment"
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
  ) : (
    <div className={compact ? "pt-1 pl-6" : "px-3 py-2.5"}>
      {body.trim() === "" ? (
        <p className="text-xs text-on-surface-muted">{emptyText}</p>
      ) : (
        <Markdown source={body} />
      )}
    </div>
  );

  const dialog = (
    <ConfirmDialog
      open={confirming}
      onClose={() => setConfirming(false)}
      title="Delete comment"
      confirmLabel="Delete"
      busy={busy}
      onConfirm={() => {
        if (!onDelete) return;
        setBusy(true);
        onDelete()
          .then(() => setConfirming(false))
          .catch(setError)
          .finally(() => setBusy(false));
      }}
    >
      <p>This comment is removed for everyone.</p>
      <InlineError error={error} />
    </ConfirmDialog>
  );

  if (compact) {
    return (
      <div id={id} className="scroll-mt-24">
        {header}
        {content}
        {dialog}
      </div>
    );
  }
  return (
    <div id={id} className="flex scroll-mt-24 gap-3">
      <div className="hidden pt-1 sm:block">
        <Avatar name={name} src={author?.avatarUrl} size={28} />
      </div>
      <div className="min-w-0 flex-1 rounded-md border border-border bg-surface-raised">
        {header}
        {content}
      </div>
      {dialog}
    </div>
  );
}
