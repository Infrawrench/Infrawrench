/** Branches: how far each is from the default branch, its last commit, and creating and deleting them. */
import { useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { isValidRefName, type Branch } from "@infrawrench/git-contract";
import { api } from "../../api/client";
import { invalidate, usePages } from "../../api/queries";
import { AppLink } from "../../components/AppLink";
import { Badge } from "../../components/Badge";
import { Button, ButtonLink } from "../../components/Button";
import { ConfirmDialog, Dialog, Segmented } from "../../components/controls";
import { Field, Input, SearchInput } from "../../components/forms";
import { Icon } from "../../components/icons";
import { Page, PageHeader, Panel, Table, Td, Th, Tr } from "../../components/Panel";
import { CommitAuthors, RelativeTime } from "../../components/people";
import { RefPicker } from "../../components/RefPicker";
import { EmptyState, ErrorState, InlineError, Loading, LoadMore } from "../../components/states";
import { paths, type RepoRef } from "../../lib/paths";
import { useRepoRef, useRepository } from "../../layout/RepoLayout";

type View = "all" | "active" | "stale" | "mine";

/** Ahead and behind as two bars from a centre line, with the numbers. */
function Divergence({ branch, base }: { branch: Branch; base: string }) {
  if (branch.ahead === null || branch.behind === null) return null;
  const scale = Math.max(branch.ahead, branch.behind, 1);
  const width = (count: number) => `${Math.max(count === 0 ? 0 : 8, (count / scale) * 100)}%`;
  return (
    <div
      className="flex w-36 items-center text-[11px] text-on-surface-muted"
      title={`${branch.behind} behind and ${branch.ahead} ahead of ${base}`}
    >
      <span className="sr-only">
        {branch.behind} behind, {branch.ahead} ahead of {base}
      </span>
      <span aria-hidden="true" className="flex flex-1 items-center justify-end gap-1">
        {branch.behind}
        <span className="flex w-10 justify-end">
          <span
            className="h-1 rounded-l bg-border-strong"
            style={{ width: width(branch.behind) }}
          />
        </span>
      </span>
      <span aria-hidden="true" className="h-4 w-px bg-border-strong" />
      <span aria-hidden="true" className="flex flex-1 items-center gap-1">
        <span className="flex w-10">
          <span className="h-1 rounded-r bg-accent-subtle" style={{ width: width(branch.ahead) }} />
        </span>
        {branch.ahead}
      </span>
    </div>
  );
}

function NewBranchDialog({
  repo,
  defaultBranch,
  open,
  onClose,
}: {
  repo: RepoRef;
  defaultBranch: string;
  open: boolean;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [from, setFrom] = useState(defaultBranch);
  const create = useMutation({
    mutationFn: () => api.contents.createBranch({ params: repo, payload: { name, from } }),
    onSuccess: () => {
      void invalidate("contents");
      void invalidate("repositories", "get");
      setName("");
      onClose();
    },
  });
  const invalid = name !== "" && !isValidRefName(name);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (name !== "" && !invalid) create.mutate();
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New branch"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            type="submit"
            form="new-branch"
            busy={create.isPending}
            disabled={name === "" || invalid}
          >
            Create branch
          </Button>
        </>
      }
    >
      <form id="new-branch" onSubmit={submit} className="space-y-3">
        <Field label="Name" error={invalid ? "That is not a valid branch name" : null}>
          {(control) => (
            <Input
              {...control}
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          )}
        </Field>
        <div className="space-y-1">
          <span className="block text-xs font-medium text-on-surface">From</span>
          <RefPicker
            repo={repo}
            value={from}
            label="source"
            onSelect={(picked) => setFrom(picked)}
          />
        </div>
        <InlineError error={create.error} />
      </form>
    </Dialog>
  );
}

export function BranchesPage() {
  const repository = useRepository();
  const repo = useRepoRef();
  const [view, setView] = useState<View>("all");
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Branch | null>(null);

  const request = { params: repo, query: { view, ...(q === "" ? {} : { q }), limit: 30 } };
  const branches = usePages(
    ["contents", "listBranches", request],
    (cursor) =>
      api.contents.listBranches({
        ...request,
        query: { ...request.query, ...(cursor === undefined ? {} : { cursor }) },
      }),
    { enabled: !repository.isEmpty },
  );

  const remove = useMutation({
    mutationFn: (branch: Branch) =>
      api.contents.deleteBranch({
        params: repo,
        query: { name: branch.name, expectedOid: branch.commit.oid },
      }),
    onSuccess: () => {
      void invalidate("contents");
      void invalidate("repositories", "get");
      setDeleting(null);
    },
  });

  return (
    <Page>
      <PageHeader
        title="Branches"
        actions={
          repository.viewer.canPush && !repository.isEmpty ? (
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Icon name="plus" />
              New branch
            </Button>
          ) : undefined
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            label="Which branches"
            value={view}
            onChange={setView}
            options={[
              { value: "all", label: "All" },
              { value: "active", label: "Active" },
              { value: "stale", label: "Stale" },
              { value: "mine", label: "Yours" },
            ]}
          />
          <SearchInput
            label="Filter branches"
            placeholder="Find a branch"
            value={q}
            onChange={(event) => setQ(event.target.value)}
            className="w-64"
          />
        </div>
      </PageHeader>

      <Panel>
        {repository.isEmpty ? (
          <EmptyState>No branches yet</EmptyState>
        ) : branches.isLoading ? (
          <Loading framed={false} />
        ) : branches.error ? (
          <ErrorState error={branches.error} />
        ) : branches.items.length === 0 ? (
          <EmptyState>No branches match</EmptyState>
        ) : (
          <Table caption="Branches">
            <thead>
              <tr>
                <Th>Branch</Th>
                <Th>Last commit</Th>
                <Th>Behind and ahead</Th>
                <Th>Pull request</Th>
                <Th>
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {branches.items.map((branch) => (
                <Tr key={branch.name}>
                  <Td>
                    <span className="flex items-center gap-2">
                      <AppLink
                        href={paths.tree(repo, branch.name)}
                        className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-on-surface hover:underline"
                      >
                        {branch.name}
                      </AppLink>
                      {branch.isDefault ? <Badge tone="outline">Default</Badge> : null}
                      {branch.protected ? (
                        <Badge tone="outline">
                          <Icon name="lock" size={10} />
                          Protected
                        </Badge>
                      ) : null}
                    </span>
                  </Td>
                  <Td className="text-on-surface-muted">
                    <span className="flex items-center gap-1.5">
                      <CommitAuthors commit={branch.commit} />
                      <RelativeTime iso={branch.commit.committer.when} />
                    </span>
                  </Td>
                  <Td>
                    <Divergence branch={branch} base={repository.defaultBranch} />
                  </Td>
                  <Td>
                    {branch.pullRequest !== null ? (
                      <AppLink
                        href={paths.pull(repo, branch.pullRequest.number)}
                        title={branch.pullRequest.title}
                      >
                        <Badge
                          tone={
                            branch.pullRequest.state === "open"
                              ? "success"
                              : branch.pullRequest.state === "merged"
                                ? "notice"
                                : "danger"
                          }
                        >
                          <Icon name="gitPullRequest" size={10} />#{branch.pullRequest.number}
                          <span className="sr-only">{branch.pullRequest.state}</span>
                        </Badge>
                      </AppLink>
                    ) : null}
                  </Td>
                  <Td className="text-right">
                    <span className="flex items-center justify-end gap-1.5">
                      {branch.isDefault ? null : (
                        <ButtonLink
                          size="sm"
                          href={paths.compare(repo, repository.defaultBranch, branch.name)}
                        >
                          Compare
                        </ButtonLink>
                      )}
                      {branch.viewerCanDelete ? (
                        <button
                          type="button"
                          aria-label={`Delete branch ${branch.name}`}
                          title="Delete branch"
                          onClick={() => {
                            remove.reset();
                            setDeleting(branch);
                          }}
                          className="inline-flex size-6 items-center justify-center rounded text-on-surface-muted hover:bg-danger/10 hover:text-danger"
                        >
                          <Icon name="trash" size={13} />
                        </button>
                      ) : (
                        <span className="size-6" />
                      )}
                    </span>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>
      <LoadMore pages={branches} />

      <NewBranchDialog
        repo={repo}
        defaultBranch={repository.defaultBranch}
        open={creating}
        onClose={() => setCreating(false)}
      />
      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && remove.mutate(deleting)}
        title="Delete branch"
        confirmLabel="Delete branch"
        busy={remove.isPending}
      >
        <p>
          Delete <span className="font-mono font-medium">{deleting?.name}</span>?
          {deleting !== null && deleting.ahead !== null && deleting.ahead > 0
            ? ` It has ${deleting.ahead} ${deleting.ahead === 1 ? "commit" : "commits"} that ${repository.defaultBranch} does not.`
            : ""}
        </p>
        <InlineError error={remove.error} />
      </ConfirmDialog>
    </Page>
  );
}
