import { useState, type FormEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "../../api/client";
import { invalidate, queries } from "../../api/queries";
import { Button } from "../../components/Button";
import { ConfirmDialog } from "../../components/controls";
import { Field, Input, Textarea } from "../../components/forms";
import { Icon } from "../../components/icons";
import { Panel } from "../../components/Panel";
import { RelativeTime } from "../../components/people";
import { SettingsSection } from "../../components/SideNav";
import { EmptyState, InlineError, QueryView } from "../../components/states";
import type { UserKey } from "@infrawrench/git-contract";
import { useSession } from "../../lib/session";
import { commentOfKey } from "./keys";

function KeyForm({ onDone }: { onDone: () => void }) {
  const [title, setTitle] = useState("");
  const [key, setKey] = useState("");
  const add = useMutation({
    mutationFn: () =>
      api.account.createKey({
        payload: { key: key.trim(), ...(title.trim() === "" ? {} : { title: title.trim() }) },
      }),
    onSuccess: () => {
      void invalidate("account", "listKeys");
      onDone();
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (key.trim() !== "") add.mutate();
  };
  const comment = commentOfKey(key);
  return (
    <form onSubmit={submit} className="space-y-3 px-3 py-3">
      <Field label="Public key" hint="One line, as in ~/.ssh/id_ed25519.pub">
        {(control) => (
          <Textarea
            {...control}
            rows={4}
            value={key}
            required
            autoFocus
            spellCheck={false}
            placeholder="ssh-ed25519 AAAA... you@host"
            onChange={(event) => setKey(event.target.value)}
            className="font-mono"
          />
        )}
      </Field>
      <Field label="Title" optional>
        {(control) => (
          <Input
            {...control}
            value={title}
            maxLength={100}
            placeholder={comment ?? ""}
            onChange={(event) => setTitle(event.target.value)}
            className="max-w-sm"
          />
        )}
      </Field>
      <div className="flex items-center justify-end gap-2">
        <InlineError error={add.error} />
        <Button onClick={onDone}>Cancel</Button>
        <Button type="submit" variant="primary" busy={add.isPending} disabled={key.trim() === ""}>
          Add key
        </Button>
      </div>
    </form>
  );
}

/** SSH keys, while Git over SSH is offered. */
export function KeysPage() {
  const session = useSession();
  if (session.data !== undefined && !session.data.sshEnabled) {
    return (
      <SettingsSection title="SSH keys">
        <EmptyState>
          Git over SSH is turned off. Clone and push over HTTPS with an access token.
        </EmptyState>
      </SettingsSection>
    );
  }
  return <SshKeys />;
}

function SshKeys() {
  const keys = useQuery(queries.account.listKeys());
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<UserKey | null>(null);
  const remove = useMutation({
    mutationFn: (key: UserKey) => api.account.deleteKey({ params: { keyId: key.id } }),
    onSuccess: () => {
      setRemoving(null);
      void invalidate("account", "listKeys");
    },
  });
  return (
    <SettingsSection
      title="SSH keys"
      actions={
        <Button variant="primary" size="sm" onClick={() => setAdding(true)}>
          Add key
        </Button>
      }
    >
      {adding ? (
        <Panel>
          <KeyForm onDone={() => setAdding(false)} />
        </Panel>
      ) : null}
      <QueryView query={keys}>
        {({ keys: items }) => (
          <Panel>
            {items.length === 0 ? (
              <EmptyState action={<Button onClick={() => setAdding(true)}>Add key</Button>}>
                No SSH keys
              </EmptyState>
            ) : (
              <ul>
                {items.map((key) => (
                  <li
                    key={key.id}
                    className="flex flex-wrap items-center gap-3 border-t border-border px-3 py-2.5 first:border-t-0"
                  >
                    <Icon name="key" size={16} className="text-on-surface-muted" />
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <p className="text-xs font-medium text-on-surface">{key.title}</p>
                      <p className="truncate font-mono text-[11px] text-on-surface-muted">
                        {key.fingerprint}
                      </p>
                      <p className="text-xs text-on-surface-muted">
                        {key.algorithm} · added <RelativeTime iso={key.createdAt} /> ·{" "}
                        {key.lastUsedAt === null ? (
                          "never used"
                        ) : (
                          <>
                            last used <RelativeTime iso={key.lastUsedAt} />
                          </>
                        )}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="danger"
                      aria-label={`Delete ${key.title}`}
                      onClick={() => setRemoving(key)}
                    >
                      Delete
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        )}
      </QueryView>
      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title="Delete SSH key"
        confirmLabel="Delete"
        busy={remove.isPending}
        onConfirm={() => removing && remove.mutate(removing)}
      >
        <p>
          Git over SSH with <span className="font-medium">{removing?.title}</span> stops working.
        </p>
        <InlineError error={remove.error} />
      </ConfirmDialog>
    </SettingsSection>
  );
}
