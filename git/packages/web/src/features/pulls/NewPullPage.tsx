import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ApiError, api } from "../../api/client";
import { invalidate, queries } from "../../api/queries";
import { AppLink, useGo } from "../../components/AppLink";
import { Badge, CommitStatusIcon } from "../../components/Badge";
import { Button, ButtonLink, buttonClass } from "../../components/Button";
import { DiffStat } from "../../components/DiffView";
import { Checkbox, Field, Input } from "../../components/forms";
import { Icon } from "../../components/icons";
import { MarkdownEditor } from "../../components/MarkdownEditor";
import { Page, Panel, PanelHeader } from "../../components/Panel";
import { CommitAuthor, RelativeTime } from "../../components/people";
import { RefPicker } from "../../components/RefPicker";
import { EmptyState, ErrorState, InlineError, Loading } from "../../components/states";
import { useRepoRef, useRepository } from "../../layout/RepoLayout";
import { plural, shortOid } from "../../lib/format";
import { HeadRepoPicker } from "../../components/HeadRepoPicker";
import { paths } from "../../lib/paths";
import { formatHead, headQuery, parseHead } from "../../lib/refs";
import { signInHref, useSession } from "../../lib/session";
import { TriageFields, type ThreadTriage } from "../issues/ThreadSidebar";
import { showBidi } from "../../lib/bidi";

/** `feature/vpc-peering` as a first guess at a title: `Vpc peering`. */
function titleFromBranch(branch: string): string {
  const words = (branch.split("/").pop() ?? branch).replace(/[-_]+/g, " ").trim();
  return words === "" ? "" : words[0]!.toUpperCase() + words.slice(1);
}

export function NewPullPage({
  base,
  head,
}: {
  base: string | undefined;
  head: string | undefined;
}) {
  const repo = useRepoRef();
  const repository = useRepository();
  const session = useSession();
  const go = useGo();
  const baseRef = base ?? repository.defaultBranch;
  const pick = (next: { base?: string; head?: string }) =>
    go(
      paths.newPull(repo, {
        base: next.base ?? baseRef,
        ...((next.head ?? head) === undefined ? {} : { head: next.head ?? head! }),
      }),
      { replace: true },
    );

  // The head as the URL writes it: a branch here, or `owner/name:branch` in a fork.
  const parsed = parseHead(head ?? "");
  const headRepo = parsed.repository ?? repo;
  const cross = parsed.repository !== null;
  const headLabel = cross ? `${headRepo.owner}:${parsed.ref}` : parsed.ref;
  const ready = head !== undefined && parsed.ref !== "" && (cross || head !== baseRef);
  const comparison = useQuery({
    ...queries.contents.compare({
      params: repo,
      query: { base: baseRef, ...headQuery(parsed) },
    }),
    enabled: ready,
    retry: false,
  });

  const [title, setTitle] = useState("");
  const [touched, setTouched] = useState(false);
  const [body, setBody] = useState("");
  const [draft, setDraft] = useState(false);
  const [triage, setTriage] = useState<ThreadTriage>({
    labels: [],
    assignees: [],
    milestone: null,
  });

  // Until the person types one, the title follows the branches picked.
  const suggestion =
    comparison.data === undefined || head === undefined
      ? ""
      : comparison.data.commits.length === 1
        ? comparison.data.commits[0]!.summary
        : titleFromBranch(parsed.ref);
  useEffect(() => {
    if (!touched) setTitle(suggestion);
  }, [suggestion, touched]);

  const create = useMutation({
    mutationFn: () =>
      api.pulls.create({
        params: repo,
        payload: {
          title: title.trim(),
          body,
          base: baseRef,
          ...headQuery(parsed),
          draft,
          labels: [...triage.labels],
          assignees: [...triage.assignees],
          milestone: triage.milestone,
        },
      }),
    onSuccess: (pull) => {
      void invalidate("pulls");
      void invalidate("repositories", "get");
      void invalidate("contents", "listBranches");
      go(paths.pull(repo, pull.number));
    },
  });

  if (session.data !== undefined && session.data.user === null) {
    return (
      <Page>
        <EmptyState
          action={
            <a href={signInHref()} className={buttonClass("primary")}>
              Sign in
            </a>
          }
        >
          Sign in to open a pull request
        </EmptyState>
      </Page>
    );
  }

  const data = comparison.data;
  const existing = data?.pullRequest ?? null;
  const canCreate = data !== undefined && data.ahead > 0 && existing === null;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (canCreate && title.trim() !== "") create.mutate();
  };

  return (
    <Page>
      <h1 className="mb-3 text-base font-semibold text-on-surface">New pull request</h1>
      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface-raised px-3 py-2 text-xs text-on-surface-muted">
        <Icon name="gitCompare" />
        <span>base</span>
        <RefPicker
          repo={repo}
          value={baseRef}
          branchesOnly
          label="base"
          onSelect={(name) => pick({ base: name })}
        />
        <span aria-hidden="true">←</span>
        <span>compare</span>
        <HeadRepoPicker
          base={repo}
          value={headRepo}
          onSelect={(fork) =>
            pick({
              head:
                fork === null
                  ? repository.defaultBranch
                  : formatHead(repo, {
                      repository: { owner: fork.owner.slug, repo: fork.name },
                      ref: fork.defaultBranch,
                    }),
            })
          }
        />
        <RefPicker
          repo={headRepo}
          value={head === undefined ? "Choose a branch" : parsed.ref}
          branchesOnly
          label="head"
          onSelect={(name) =>
            pick({ head: formatHead(repo, { repository: parsed.repository, ref: name }) })
          }
        />
        {data !== undefined ? (
          <span className="ml-auto inline-flex items-center gap-1.5">
            {data.mergeable === false ? (
              <>
                <Icon name="xCircle" size={13} className="text-danger" />
                Conflicts with {baseRef}
              </>
            ) : data.mergeable === true && data.ahead > 0 ? (
              <>
                <Icon name="check" size={13} className="text-success" />
                Merges without conflicts
              </>
            ) : null}
          </span>
        ) : null}
      </div>

      {!ready ? (
        <Panel>
          <EmptyState>
            {head === undefined ? "Choose the branch to merge" : "Choose two different branches"}
          </EmptyState>
        </Panel>
      ) : comparison.error ? (
        <Panel>
          <ErrorState error={comparison.error} />
        </Panel>
      ) : data === undefined ? (
        <Loading />
      ) : (
        <div className="space-y-4">
          {existing !== null ? (
            <Panel className="flex flex-wrap items-center gap-2 px-3 py-2.5 text-xs">
              <Icon name="gitPullRequest" className="text-success" />
              <span className="text-on-surface-muted">
                A pull request is open for these branches:
              </span>
              <AppLink
                href={paths.pull(repo, existing.number)}
                className="font-medium text-on-surface hover:underline"
              >
                {existing.title} #{existing.number}
              </AppLink>
            </Panel>
          ) : data.ahead === 0 ? (
            <Panel>
              <EmptyState action={<ButtonLink href={paths.branches(repo)}>Branches</ButtonLink>}>
                {headLabel} has no commits that {baseRef} lacks
              </EmptyState>
            </Panel>
          ) : (
            <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_16rem]">
              <form onSubmit={submit} className="min-w-0 space-y-3">
                <Field label="Title">
                  {(control) => (
                    <Input
                      {...control}
                      value={title}
                      required
                      maxLength={256}
                      onChange={(event) => {
                        setTouched(true);
                        setTitle(event.target.value);
                      }}
                    />
                  )}
                </Field>
                <MarkdownEditor
                  label="Description"
                  value={body}
                  onChange={setBody}
                  rows={8}
                  actions={
                    <>
                      <InlineError
                        error={
                          create.error instanceof ApiError || create.error ? create.error : null
                        }
                      />
                      <Checkbox
                        label="Draft"
                        checked={draft}
                        onChange={(event) => setDraft(event.target.checked)}
                      />
                      <Button
                        type="submit"
                        variant="primary"
                        busy={create.isPending}
                        disabled={title.trim() === ""}
                      >
                        {draft ? "Create draft pull request" : "Create pull request"}
                      </Button>
                    </>
                  }
                />
              </form>
              <aside aria-label="Details">
                <TriageFields
                  kind="pulls"
                  value={triage}
                  onChange={setTriage}
                  canTriage={repository.viewer.canTriage}
                />
              </aside>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-on-surface-muted">
            <span className="inline-flex items-center gap-1.5">
              <Icon name="gitCommit" size={13} />
              {plural(data.ahead, "commit")}
            </span>
            <span className="inline-flex items-center gap-2">
              <Icon name="fileDiff" size={13} />
              {plural(data.stats.filesChanged, "file")} changed
              <DiffStat additions={data.stats.additions} deletions={data.stats.deletions} />
            </span>
            {data.behind > 0 ? (
              <span>
                {plural(data.behind, "commit")} behind {baseRef}
              </span>
            ) : null}
            <AppLink
              href={paths.compare(repo, baseRef, head)}
              className="ml-auto text-on-surface-secondary hover:underline"
            >
              Full comparison
            </AppLink>
          </div>

          {data.commits.length > 0 ? (
            <Panel>
              <PanelHeader>Commits</PanelHeader>
              <ul>
                {data.commits.map((commit) => (
                  <li
                    key={commit.oid}
                    className="flex items-center gap-3 border-t border-border px-3 py-1.5 text-xs first:border-t-0"
                  >
                    <CommitAuthor author={commit.author} user={commit.authorUser} />
                    <AppLink
                      href={paths.commit(headRepo, commit.oid)}
                      className="min-w-0 flex-1 truncate text-on-surface hover:underline"
                    >
                      {showBidi(commit.summary)}
                    </AppLink>
                    <CommitStatusIcon state={commit.status} size={12} />
                    <RelativeTime
                      iso={commit.committer.when}
                      className="shrink-0 text-on-surface-muted"
                    />
                    <span className="font-mono text-[11px] text-on-surface-muted">
                      {shortOid(commit.oid)}
                    </span>
                  </li>
                ))}
              </ul>
              {data.commitsTruncated ? (
                <p className="border-t border-border px-3 py-1.5 text-xs text-on-surface-muted">
                  More commits than are listed
                </p>
              ) : null}
            </Panel>
          ) : null}

          {data.files.length > 0 ? (
            <Panel>
              <PanelHeader>Files changed</PanelHeader>
              <ul>
                {data.files.map((file) => (
                  <li
                    key={file.path}
                    className="flex items-center gap-3 border-t border-border px-3 py-1.5 text-xs first:border-t-0"
                  >
                    <span className="min-w-0 flex-1 truncate font-mono text-on-surface">
                      {file.oldPath !== null && file.oldPath !== file.path
                        ? `${file.oldPath} → ${file.path}`
                        : file.path}
                    </span>
                    {file.status !== "modified" ? (
                      <Badge
                        tone={
                          file.status === "added"
                            ? "success"
                            : file.status === "deleted"
                              ? "danger"
                              : "neutral"
                        }
                      >
                        {file.status[0]!.toUpperCase() + file.status.slice(1).replace("_", " ")}
                      </Badge>
                    ) : null}
                    <DiffStat additions={file.additions} deletions={file.deletions} />
                  </li>
                ))}
              </ul>
            </Panel>
          ) : null}
        </div>
      )}
    </Page>
  );
}
