import { useState, type FormEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "../../api/client";
import { invalidate, queries } from "../../api/queries";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { ConfirmDialog } from "../../components/controls";
import { Checkbox, Field, Input, Textarea } from "../../components/forms";
import { Icon } from "../../components/icons";
import { Panel } from "../../components/Panel";
import { RelativeTime } from "../../components/people";
import { SettingsSection } from "../../components/SideNav";
import { EmptyState, InlineError, QueryView } from "../../components/states";
import { useRepoRef, useRepository } from "../../layout/RepoLayout";
import type { DeployKey } from "@infrawrench/git-contract";

function KeyForm({ onDone }: { onDone: () => void }) {
  const repo = useRepoRef();
  const [title, setTitle] = useState("");
  const [key, setKey] = useState("");
  const [write, setWrite] = useState(false);
  const add = useMutation({
    mutationFn: () =>
      api.deployKeys.create({
        params: repo,
        payload: { title: title.trim(), key: key.trim(), readOnly: !write },
      }),
    onSuccess: () => {
      void invalidate("deployKeys");
      onDone();
    },
  });
  const valid = title.trim() !== "" && key.trim() !== "";
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (valid) add.mutate();
  };
  return (
    <form onSubmit={submit} className="space-y-3 px-3 py-3">
      <Field label="Title">
        {(control) => (
          <Input
            {...control}
            value={title}
            required
            autoFocus
            maxLength={100}
            onChange={(event) => setTitle(event.target.value)}
            className="max-w-sm"
          />
        )}
      </Field>
      <Field label="Public key" hint="One line, as in id_ed25519.pub">
        {(control) => (
          <Textarea
            {...control}
            rows={3}
            value={key}
            required
            spellCheck={false}
            placeholder="ssh-ed25519 AAAA..."
            onChange={(event) => setKey(event.target.value)}
            className="font-mono"
          />
        )}
      </Field>
      <Checkbox
        label="Allow pushes with this key"
        checked={write}
        onChange={(event) => setWrite(event.target.checked)}
      />
      <div className="flex items-center justify-end gap-2">
        <InlineError error={add.error} />
        <Button onClick={onDone}>Cancel</Button>
        <Button type="submit" variant="primary" busy={add.isPending} disabled={!valid}>
          Add key
        </Button>
      </div>
    </form>
  );
}

/** Deploy keys, while Git over SSH is offered: they are SSH keys. */
export function DeployKeysPage() {
  const repository = useRepository();
  if (repository.sshCloneUrl === null) {
    return (
      <SettingsSection title="Deploy keys">
        <EmptyState>Git over SSH is turned off, and deploy keys are SSH keys.</EmptyState>
      </SettingsSection>
    );
  }
  return <DeployKeys />;
}

function DeployKeys() {
  const repo = useRepoRef();
  const keys = useQuery(queries.deployKeys.list({ params: repo }));
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<DeployKey | null>(null);
  const remove = useMutation({
    mutationFn: (key: DeployKey) => api.deployKeys.delete({ params: { ...repo, keyId: key.id } }),
    onSuccess: () => {
      setRemoving(null);
      void invalidate("deployKeys");
    },
  });
  return (
    <SettingsSection
      title="Deploy keys"
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
                No deploy keys
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
                      <p className="flex flex-wrap items-center gap-2 text-xs font-medium text-on-surface">
                        {key.title}
                        <Badge tone={key.readOnly ? "outline" : "warning"}>
                          {key.readOnly ? "Read" : "Read and write"}
                        </Badge>
                      </p>
                      <p className="truncate font-mono text-[11px] text-on-surface-muted">
                        {key.fingerprint}
                      </p>
                      <p className="text-xs text-on-surface-muted">
                        {key.algorithm} · added <RelativeTime iso={key.createdAt} />
                        {key.addedBy?.username ? ` by ${key.addedBy.username}` : ""} ·{" "}
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
        title="Delete deploy key"
        confirmLabel="Delete"
        busy={remove.isPending}
        onConfirm={() => removing && remove.mutate(removing)}
      >
        <p>
          Anything that clones or pushes with <span className="font-medium">{removing?.title}</span>{" "}
          stops working.
        </p>
        <InlineError error={remove.error} />
      </ConfirmDialog>
    </SettingsSection>
  );
}
