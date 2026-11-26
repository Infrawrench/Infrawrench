import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  REPOSITORY_NAME_MAX_LENGTH,
  type MergeMethod,
  type Repository,
} from "@infrawrench/git-contract";
import { api } from "../../api/client";
import { invalidate, queries, queryClient } from "../../api/queries";
import { useGo } from "../../components/AppLink";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/controls";
import { Checkbox, Field, Input, Select, Textarea } from "../../components/forms";
import { Icon } from "../../components/icons";
import { Panel } from "../../components/Panel";
import { SettingsRow, SettingsSection } from "../../components/SideNav";
import { InlineError } from "../../components/states";
import { useRepoRef, useRepository } from "../../layout/RepoLayout";
import { mayUseName, useRenameAvailability } from "../../lib/name-availability";
import { paths, type RepoRef } from "../../lib/paths";
import { useSession } from "../../lib/session";

const refresh = (repo: RepoRef) => {
  void invalidate("repositories");
  void invalidate("repositoryLists");
  void queryClient.invalidateQueries({ queryKey: ["contents", "listRefs", { params: repo }] });
};

function NameForm({ repository }: { repository: Repository }) {
  const repo = useRepoRef();
  const go = useGo();
  const [name, setName] = useState(repository.name);
  const availability = useRenameAvailability(repo, repository.name, name);
  const rename = useMutation({
    mutationFn: () => api.repositories.rename({ params: repo, payload: { name } }),
    onSuccess: (next) => {
      refresh(repo);
      go(paths.repoSettings({ owner: next.owner.slug, repo: next.name }), { replace: true });
    },
  });
  // Its own name in another case is a rename too.
  const canRename =
    mayUseName(availability) || (availability.state === "same" && name !== repository.name);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (canRename) rename.mutate();
  };
  return (
    <form onSubmit={submit} className="space-y-2">
      <Field
        label="Name"
        error={
          availability.state === "invalid" || availability.state === "taken"
            ? availability.message
            : null
        }
      >
        {(control) => (
          <div className="flex flex-wrap items-center gap-2">
            <Input
              {...control}
              value={name}
              maxLength={REPOSITORY_NAME_MAX_LENGTH}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => setName(event.target.value)}
              className="max-w-xs"
            />
            <Button type="submit" busy={rename.isPending} disabled={!canRename}>
              Rename
            </Button>
            <span role="status" className="text-xs text-success">
              {availability.state === "available" ? (
                <span className="inline-flex items-center gap-1">
                  <Icon name="check" size={12} />
                  Available
                </span>
              ) : null}
            </span>
          </div>
        )}
      </Field>
      <InlineError error={rename.error} />
    </form>
  );
}

function DetailsForm({ repository }: { repository: Repository }) {
  const repo = useRepoRef();
  const [description, setDescription] = useState(repository.description ?? "");
  const [homepage, setHomepage] = useState(repository.homepageUrl ?? "");
  const [topics, setTopics] = useState(repository.topics.join(", "));
  const [branch, setBranch] = useState(repository.defaultBranch);
  const refs = useQuery({
    ...queries.contents.listRefs({ params: repo, query: { limit: 100 } }),
    enabled: !repository.isEmpty,
  });
  const save = useMutation({
    mutationFn: () =>
      api.repositories.update({
        params: repo,
        payload: {
          description: description.trim() === "" ? null : description.trim(),
          homepageUrl: homepage.trim() === "" ? null : homepage.trim(),
          topics: topics
            .split(/[,\s]+/)
            .map((topic) => topic.trim().toLowerCase())
            .filter(Boolean),
          ...(branch !== repository.defaultBranch ? { defaultBranch: branch } : {}),
        },
      }),
    onSuccess: () => refresh(repo),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate();
  };
  return (
    <form onSubmit={submit} className="space-y-3">
      <Field label="Description" optional>
        {(control) => (
          <Textarea
            {...control}
            rows={2}
            value={description}
            maxLength={350}
            onChange={(event) => setDescription(event.target.value)}
          />
        )}
      </Field>
      <Field label="Website" optional>
        {(control) => (
          <Input
            {...control}
            type="url"
            value={homepage}
            maxLength={500}
            placeholder="https://"
            onChange={(event) => setHomepage(event.target.value)}
          />
        )}
      </Field>
      <Field label="Topics" optional hint="Up to 20, separated by commas">
        {(control) => (
          <Input
            {...control}
            value={topics}
            spellCheck={false}
            onChange={(event) => setTopics(event.target.value)}
          />
        )}
      </Field>
      {repository.isEmpty ? null : (
        <Field label="Default branch">
          {(control) => (
            <Select
              {...control}
              value={branch}
              onChange={(event) => setBranch(event.target.value)}
              className="max-w-xs"
            >
              {[...new Set([branch, ...(refs.data?.branches ?? []).map((item) => item.name)])].map(
                (item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ),
              )}
            </Select>
          )}
        </Field>
      )}
      <div className="flex items-center gap-2">
        <Button type="submit" variant="primary" busy={save.isPending}>
          Save
        </Button>
        <span role="status" className="text-xs text-on-surface-muted">
          {save.isSuccess && !save.isPending ? "Saved" : ""}
        </span>
        <InlineError error={save.error} />
      </div>
    </form>
  );
}

const METHODS: ReadonlyArray<{
  key: "allowMergeCommit" | "allowSquash" | "allowRebase";
  method: MergeMethod;
  label: string;
}> = [
  { key: "allowMergeCommit", method: "merge", label: "Merge commits" },
  { key: "allowSquash", method: "squash", label: "Squash merging" },
  { key: "allowRebase", method: "rebase", label: "Rebase merging" },
];

function Toggles({ repository }: { repository: Repository }) {
  const repo = useRepoRef();
  const update = useMutation({
    mutationFn: (payload: Parameters<typeof api.repositories.update>[0]["payload"]) =>
      api.repositories.update({ params: repo, payload }),
    onSuccess: () => refresh(repo),
  });
  const { merge, features } = repository;
  const allowed = METHODS.filter((item) => merge[item.key]);
  const toggle = (
    label: string,
    checked: boolean,
    onChange: (next: boolean) => void,
    disabled = false,
  ) => (
    <Checkbox
      label={<span className="sr-only">{label}</span>}
      checked={checked}
      disabled={update.isPending || disabled}
      onChange={(event) => onChange(event.target.checked)}
    />
  );
  return (
    <>
      <SettingsSection title="Features">
        <Panel className="divide-y divide-border">
          <SettingsRow title="Issues">
            {toggle("Issues", features.issues, (issues) => update.mutate({ features: { issues } }))}
          </SettingsRow>
        </Panel>
      </SettingsSection>
      <SettingsSection title="Merging">
        <Panel className="divide-y divide-border">
          {METHODS.map((item) => (
            <SettingsRow
              key={item.key}
              title={item.label}
              detail={
                allowed.length === 1 && merge[item.key] ? "At least one method stays on" : undefined
              }
            >
              {toggle(
                item.label,
                merge[item.key],
                (next) =>
                  update.mutate({
                    merge: {
                      [item.key]: next,
                      // The default cannot be a method that was just turned off.
                      ...(!next && merge.defaultMethod === item.method
                        ? {
                            defaultMethod:
                              allowed.find((other) => other.key !== item.key)?.method ?? "merge",
                          }
                        : {}),
                    },
                  }),
                allowed.length === 1 && merge[item.key],
              )}
            </SettingsRow>
          ))}
          <SettingsRow title="Default method">
            <Select
              aria-label="Default merge method"
              value={merge.defaultMethod}
              disabled={update.isPending}
              onChange={(event) =>
                update.mutate({ merge: { defaultMethod: event.target.value as MergeMethod } })
              }
              className="!w-auto"
            >
              {allowed.map((item) => (
                <option key={item.method} value={item.method}>
                  {item.label}
                </option>
              ))}
            </Select>
          </SettingsRow>
          <SettingsRow title="Delete the branch after a merge">
            {toggle("Delete the branch after a merge", merge.deleteBranchOnMerge, (next) =>
              update.mutate({ merge: { deleteBranchOnMerge: next } }),
            )}
          </SettingsRow>
        </Panel>
        <InlineError error={update.error} />
      </SettingsSection>
    </>
  );
}

/** A dialog whose button unlocks once the person types `phrase`. */
function TypedConfirm({
  open,
  onClose,
  title,
  phrase,
  confirmLabel,
  busy,
  error,
  onConfirm,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  phrase: string;
  confirmLabel: string;
  busy: boolean;
  error: unknown;
  onConfirm: () => void;
  children: ReactNode;
}) {
  const [typed, setTyped] = useState("");
  useEffect(() => {
    if (!open) setTyped("");
  }, [open]);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" busy={busy} disabled={typed !== phrase} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
      <Field label={`Type ${phrase} to confirm`}>
        {(control) => (
          <Input
            {...control}
            value={typed}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => setTyped(event.target.value)}
          />
        )}
      </Field>
      <InlineError error={error} />
    </Dialog>
  );
}

function DangerZone({ repository }: { repository: Repository }) {
  const repo = useRepoRef();
  const go = useGo();
  const session = useSession();
  const fullName = `${repo.owner}/${repo.repo}`;
  const [dialog, setDialog] = useState<"visibility" | "archive" | "transfer" | "delete" | null>(
    null,
  );
  const close = () => setDialog(null);
  const [target, setTarget] = useState("");
  const nextVisibility = repository.visibility === "public" ? "private" : "public";

  const owners = [
    ...(session.data?.user?.username ? [session.data.user.username] : []),
    ...(session.data?.organizations ?? []).flatMap((organization) =>
      organization.namespace !== null && organization.permissions.includes("git:admin")
        ? [organization.namespace]
        : [],
    ),
  ].filter((slug) => slug.toLowerCase() !== repo.owner.toLowerCase());

  const visibility = useMutation({
    mutationFn: () =>
      api.repositories.setVisibility({ params: repo, payload: { visibility: nextVisibility } }),
    onSuccess: () => {
      close();
      refresh(repo);
    },
  });
  const archive = useMutation({
    mutationFn: () =>
      api.repositories.update({ params: repo, payload: { archived: !repository.archived } }),
    onSuccess: () => {
      close();
      refresh(repo);
    },
  });
  const transfer = useMutation({
    mutationFn: () => api.repositories.transfer({ params: repo, payload: { owner: target } }),
    onSuccess: (next) => {
      refresh(repo);
      go(paths.repo({ owner: next.owner.slug, repo: next.name }));
    },
  });
  const remove = useMutation({
    mutationFn: () => api.repositories.delete({ params: repo, query: { confirm: fullName } }),
    onSuccess: () => {
      void invalidate("repositoryLists");
      go(paths.namespace(repo.owner));
    },
  });

  return (
    <SettingsSection title="Danger zone" danger>
      <Panel className="divide-y divide-border">
        <SettingsRow
          title="Visibility"
          detail={
            repository.visibility === "public"
              ? "Public: anyone can read and clone it"
              : "Private: only people with access"
          }
        >
          <Button variant="danger" onClick={() => setDialog("visibility")}>
            Make {nextVisibility}
          </Button>
        </SettingsRow>
        <SettingsRow
          title={repository.archived ? "Unarchive" : "Archive"}
          detail={repository.archived ? "Archived: read-only for everyone" : undefined}
        >
          <Button variant="danger" onClick={() => setDialog("archive")}>
            {repository.archived ? "Unarchive" : "Archive"}
          </Button>
        </SettingsRow>
        <SettingsRow title="Transfer">
          <Button
            variant="danger"
            disabled={owners.length === 0}
            onClick={() => {
              setTarget(owners[0] ?? "");
              setDialog("transfer");
            }}
          >
            Transfer
          </Button>
        </SettingsRow>
        <SettingsRow title="Delete this repository">
          <Button variant="danger" onClick={() => setDialog("delete")}>
            Delete
          </Button>
        </SettingsRow>
      </Panel>

      <TypedConfirm
        open={dialog === "visibility"}
        onClose={close}
        title={`Make ${nextVisibility}`}
        phrase={fullName}
        confirmLabel={`Make ${nextVisibility}`}
        busy={visibility.isPending}
        error={visibility.error}
        onConfirm={() => visibility.mutate()}
      >
        <p>
          {nextVisibility === "public"
            ? "Anyone will be able to read and clone the code, its history, issues and branches."
            : "Only people with access will be able to read it. Stars from people who lose access are removed."}
        </p>
      </TypedConfirm>
      <Dialog
        open={dialog === "archive"}
        onClose={close}
        title={repository.archived ? "Unarchive repository" : "Archive repository"}
        footer={
          <>
            <Button onClick={close}>Cancel</Button>
            <Button variant="danger" busy={archive.isPending} onClick={() => archive.mutate()}>
              {repository.archived ? "Unarchive" : "Archive"}
            </Button>
          </>
        }
      >
        <p>
          {repository.archived
            ? "Pushes, issues and branch pages work again."
            : "Nobody can push, comment, or open issues until it is unarchived."}
        </p>
        <InlineError error={archive.error} />
      </Dialog>
      <TypedConfirm
        open={dialog === "transfer"}
        onClose={close}
        title="Transfer repository"
        phrase={fullName}
        confirmLabel="Transfer"
        busy={transfer.isPending}
        error={transfer.error}
        onConfirm={() => transfer.mutate()}
      >
        <Field label="New owner">
          {(control) => (
            <Select {...control} value={target} onChange={(event) => setTarget(event.target.value)}>
              {owners.map((slug) => (
                <option key={slug} value={slug}>
                  {slug}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <p>Links to {fullName} stop working.</p>
      </TypedConfirm>
      <TypedConfirm
        open={dialog === "delete"}
        onClose={close}
        title="Delete repository"
        phrase={fullName}
        confirmLabel="Delete repository"
        busy={remove.isPending}
        error={remove.error}
        onConfirm={() => remove.mutate()}
      >
        <p>
          The code, issues, branch pages and Terraform state of {fullName} are deleted. This cannot
          be undone.
        </p>
      </TypedConfirm>
    </SettingsSection>
  );
}

export function GeneralPage() {
  const repository = useRepository();
  return (
    <>
      <SettingsSection title="General">
        <div className="max-w-2xl space-y-4">
          <NameForm key={repository.name} repository={repository} />
          <DetailsForm repository={repository} />
        </div>
      </SettingsSection>
      <Toggles repository={repository} />
      <DangerZone repository={repository} />
    </>
  );
}
