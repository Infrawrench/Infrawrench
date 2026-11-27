import { useState, type FormEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { Mirror } from "@infrawrench/git-contract";
import { api } from "../../api/client";
import { invalidate, queries } from "../../api/queries";
import { Badge, type BadgeTone } from "../../components/Badge";
import { Button } from "../../components/Button";
import { ConfirmDialog } from "../../components/controls";
import { Checkbox, Field, Input, Textarea } from "../../components/forms";
import { Icon } from "../../components/icons";
import { Panel } from "../../components/Panel";
import { RelativeTime } from "../../components/people";
import { SettingsSection } from "../../components/SideNav";
import { EmptyState, InlineError, QueryView } from "../../components/states";
import { useRepoRef } from "../../layout/RepoLayout";
import { plural } from "../../lib/format";

const DEFAULT_USERNAME = "x-access-token";

const patternsOf = (text: string): string[] =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

function MirrorForm({ mirror, onDone }: { mirror: Mirror | null; onDone: () => void }) {
  const repo = useRepoRef();
  const [url, setUrl] = useState(mirror?.url ?? "");
  const [username, setUsername] = useState(mirror?.username ?? DEFAULT_USERNAME);
  const [credential, setCredential] = useState("");
  const [exclude, setExclude] = useState(mirror?.exclude.join("\n") ?? "");
  const [force, setForce] = useState(mirror?.force ?? true);
  const save = useMutation({
    mutationFn: () => {
      const fields = {
        url: url.trim(),
        username: username.trim(),
        exclude: patternsOf(exclude),
        force,
      };
      return mirror === null
        ? api.mirrors.create({
            params: repo,
            payload: { ...fields, credential: credential.trim() },
          })
        : api.mirrors.update({
            params: { ...repo, mirrorId: mirror.id },
            payload: {
              ...fields,
              ...(credential.trim() !== "" ? { credential: credential.trim() } : {}),
            },
          });
    },
    onSuccess: () => {
      void invalidate("mirrors");
      onDone();
    },
  });
  const moved = mirror !== null && url.trim() !== mirror.url;
  const needsCredential = mirror === null || moved;
  const valid =
    url.trim() !== "" && username.trim() !== "" && (!needsCredential || credential.trim() !== "");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (valid) save.mutate();
  };
  return (
    <form onSubmit={submit} className="space-y-3 px-3 py-3">
      <Field label="Address">
        {(control) => (
          <Input
            {...control}
            type="url"
            value={url}
            required
            autoFocus
            spellCheck={false}
            autoComplete="off"
            maxLength={500}
            placeholder="https://github.com/owner/repository.git"
            onChange={(event) => setUrl(event.target.value)}
            className="max-w-lg font-mono"
          />
        )}
      </Field>
      <Field label="User name">
        {(control) => (
          <Input
            {...control}
            value={username}
            required
            spellCheck={false}
            autoComplete="off"
            maxLength={100}
            onChange={(event) => setUsername(event.target.value)}
            className="max-w-sm font-mono"
          />
        )}
      </Field>
      <Field
        label="Token"
        hint={
          needsCredential
            ? "With write access to the target's contents, and to its workflows if it has any"
            : "Empty keeps the stored token"
        }
      >
        {(control) => (
          <Input
            {...control}
            type="password"
            value={credential}
            required={needsCredential}
            spellCheck={false}
            autoComplete="off"
            maxLength={2000}
            onChange={(event) => setCredential(event.target.value)}
            className="max-w-sm font-mono"
          />
        )}
      </Field>
      <Field
        label="Exclude"
        hint="One pattern a line, such as dependabot/** or refs/tags/nightly-*"
        optional
      >
        {(control) => (
          <Textarea
            {...control}
            rows={3}
            value={exclude}
            spellCheck={false}
            onChange={(event) => setExclude(event.target.value)}
            className="max-w-lg font-mono"
          />
        )}
      </Field>
      <Checkbox
        label="Overwrite and delete branches and tags on the target"
        checked={force}
        onChange={(event) => setForce(event.target.checked)}
      />
      <div className="flex items-center justify-end gap-2">
        <InlineError error={save.error} />
        <Button onClick={onDone}>Cancel</Button>
        <Button type="submit" variant="primary" busy={save.isPending} disabled={!valid}>
          {mirror === null ? "Add mirror" : "Save"}
        </Button>
      </div>
    </form>
  );
}

const statusOf = (mirror: Mirror): { label: string; tone: BadgeTone } => {
  if (!mirror.enabled) return { label: "Off", tone: "outline" };
  if (mirror.running) return { label: "Pushing", tone: "notice" };
  if (mirror.lastStatus === "error") return { label: "Failed", tone: "danger" };
  if (mirror.pending) return { label: "Waiting", tone: "outline" };
  if (mirror.lastStatus === "ok") return { label: "In sync", tone: "success" };
  return { label: "Not run", tone: "outline" };
};

const summaryOf = (mirror: Mirror): string | null => {
  const result = mirror.lastResult;
  if (result === null) return null;
  const parts = [
    result.created > 0 ? `${plural(result.created, "ref")} created` : null,
    result.updated > 0 ? `${plural(result.updated, "ref")} updated` : null,
    result.deleted > 0 ? `${plural(result.deleted, "ref")} deleted` : null,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? "Nothing to push" : parts.join(", ");
};

function MirrorRow({
  mirror,
  onEdit,
  onRemove,
}: {
  mirror: Mirror;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const repo = useRepoRef();
  const params = { ...repo, mirrorId: mirror.id };
  const done = () => void invalidate("mirrors");
  const sync = useMutation({
    mutationFn: () => api.mirrors.sync({ params }),
    onSuccess: done,
  });
  const toggle = useMutation({
    mutationFn: () => api.mirrors.update({ params, payload: { enabled: !mirror.enabled } }),
    onSuccess: done,
  });
  const status = statusOf(mirror);
  const summary = summaryOf(mirror);
  const refused = mirror.lastResult?.refused ?? [];
  return (
    <li className="flex flex-wrap items-start gap-3 border-t border-border px-3 py-2.5 first:border-t-0">
      <Icon name="refresh" size={16} className="mt-0.5 text-on-surface-muted" />
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="flex flex-wrap items-center gap-2 text-xs font-medium text-on-surface">
          <span className="truncate font-mono">{mirror.url}</span>
          <Badge tone={status.tone}>{status.label}</Badge>
          {mirror.force ? null : <Badge tone="outline">No overwrite</Badge>}
        </p>
        <p className="text-xs text-on-surface-muted">
          {mirror.lastSyncedAt === null ? (
            "Never in sync"
          ) : (
            <>
              In sync <RelativeTime iso={mirror.lastSyncedAt} />
            </>
          )}
          {mirror.lastAttemptAt !== null && mirror.lastAttemptAt !== mirror.lastSyncedAt ? (
            <>
              {" "}
              · last run <RelativeTime iso={mirror.lastAttemptAt} />
            </>
          ) : null}
          {summary !== null ? ` · ${summary}` : ""}
          {mirror.nextAttemptAt !== null ? (
            <>
              {" "}
              · next try <RelativeTime iso={mirror.nextAttemptAt} />
            </>
          ) : null}
        </p>
        {mirror.exclude.length > 0 ? (
          <p className="truncate text-xs text-on-surface-muted">
            Excludes <span className="font-mono">{mirror.exclude.join(", ")}</span>
          </p>
        ) : null}
        {mirror.lastError !== null ? (
          <p role="alert" className="text-xs text-danger">
            {mirror.lastError}
          </p>
        ) : null}
        {refused.length > 0 ? (
          <ul className="space-y-0.5 text-xs text-on-surface-muted">
            {refused.map((entry) => (
              <li key={entry.ref} className="truncate">
                <span className="font-mono">{entry.ref}</span>: {entry.reason}
              </li>
            ))}
          </ul>
        ) : null}
        <InlineError error={sync.error ?? toggle.error} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {mirror.enabled ? (
          <Button
            size="sm"
            busy={sync.isPending}
            aria-label={`Push to ${mirror.url} now`}
            onClick={() => sync.mutate()}
          >
            Sync now
          </Button>
        ) : null}
        <Button size="sm" aria-label={`Edit ${mirror.url}`} onClick={onEdit}>
          Edit
        </Button>
        <Button
          size="sm"
          busy={toggle.isPending}
          aria-label={`${mirror.enabled ? "Turn off" : "Turn on"} ${mirror.url}`}
          onClick={() => toggle.mutate()}
        >
          {mirror.enabled ? "Turn off" : "Turn on"}
        </Button>
        <Button size="sm" variant="danger" aria-label={`Remove ${mirror.url}`} onClick={onRemove}>
          Remove
        </Button>
      </div>
    </li>
  );
}

const isBusy = (mirror: Mirror): boolean => mirror.enabled && (mirror.running || mirror.pending);

/** Settings > Mirrors: other Git hosts kept equal to this repository, with each one's last run. */
export function MirrorsPage() {
  const repo = useRepoRef();
  const mirrors = useQuery({
    ...queries.mirrors.list({ params: repo }),
    staleTime: 0,
    // While a run is owed or under way, its state moves.
    refetchInterval: (query) => (query.state.data?.mirrors.some(isBusy) ? 3000 : false),
  });
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Mirror | null>(null);
  const remove = useMutation({
    mutationFn: (mirror: Mirror) =>
      api.mirrors.delete({ params: { ...repo, mirrorId: mirror.id } }),
    onSuccess: () => {
      setRemoving(null);
      void invalidate("mirrors");
    },
  });
  return (
    <SettingsSection
      title="Mirrors"
      actions={
        <Button variant="primary" size="sm" onClick={() => setAdding(true)}>
          Add mirror
        </Button>
      }
    >
      {adding ? (
        <Panel>
          <MirrorForm mirror={null} onDone={() => setAdding(false)} />
        </Panel>
      ) : null}
      <QueryView query={mirrors}>
        {({ mirrors: items }) => (
          <Panel>
            {items.length === 0 ? (
              <EmptyState action={<Button onClick={() => setAdding(true)}>Add mirror</Button>}>
                No mirrors
              </EmptyState>
            ) : (
              <ul>
                {items.map((mirror) =>
                  editing === mirror.id ? (
                    <li key={mirror.id} className="border-t border-border first:border-t-0">
                      <MirrorForm mirror={mirror} onDone={() => setEditing(null)} />
                    </li>
                  ) : (
                    <MirrorRow
                      key={mirror.id}
                      mirror={mirror}
                      onEdit={() => setEditing(mirror.id)}
                      onRemove={() => setRemoving(mirror)}
                    />
                  ),
                )}
              </ul>
            )}
          </Panel>
        )}
      </QueryView>
      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title="Remove mirror"
        confirmLabel="Remove"
        busy={remove.isPending}
        onConfirm={() => removing && remove.mutate(removing)}
      >
        <p>
          <span className="font-mono">{removing?.url}</span> keeps what it has and is no longer
          pushed to. Its token is deleted.
        </p>
        <InlineError error={remove.error} />
      </ConfirmDialog>
    </SettingsSection>
  );
}
