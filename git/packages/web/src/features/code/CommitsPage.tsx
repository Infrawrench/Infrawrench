/** History from a ref, optionally of one path, grouped by day. */
import type { CommitSummary } from "@infrawrench/git-contract";
import { api } from "../../api/client";
import { usePages } from "../../api/queries";
import { AppLink } from "../../components/AppLink";
import { CommitStatusIcon } from "../../components/Badge";
import { ButtonLink } from "../../components/Button";
import { CopyButton } from "../../components/controls";
import { Icon } from "../../components/icons";
import { Page, Panel, PanelHeader } from "../../components/Panel";
import { CommitAuthor, RelativeTime } from "../../components/people";
import { EmptyState, ErrorState, Loading, LoadMore } from "../../components/states";
import { dayKey, formatDate, groupConsecutive, shortOid } from "../../lib/format";
import { paths, type RepoRef } from "../../lib/paths";
import { useRepoRef } from "../../layout/RepoLayout";
import { CodeRefPicker, PathBreadcrumbs } from "./shared";

/** One commit in a list: summary, author and time on the left; status, id and browse on the right. */
export function CommitRow({
  repo,
  commit,
  path,
}: {
  repo: RepoRef;
  commit: CommitSummary;
  /** When the list is a file's history: "browse" opens the file at that commit. */
  path?: string | undefined;
}) {
  return (
    <li className="flex items-center gap-3 px-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 items-center gap-2">
          <AppLink
            href={paths.commit(repo, commit.oid)}
            className="truncate text-sm font-medium text-on-surface hover:underline"
          >
            {commit.summary}
          </AppLink>
          {commit.parents.length > 1 ? (
            <span className="rounded border border-border px-1 text-[10px] text-on-surface-muted">
              Merge
            </span>
          ) : null}
        </p>
        <p className="mt-0.5 flex items-center gap-1.5 text-xs text-on-surface-muted">
          <CommitAuthor author={commit.author} user={commit.authorUser} />
          <span>committed</span>
          <RelativeTime iso={commit.committer.when} />
        </p>
      </div>
      <CommitStatusIcon state={commit.status} />
      <div className="flex items-center rounded border border-border">
        <AppLink
          href={paths.commit(repo, commit.oid)}
          className="px-2 py-0.5 font-mono text-xs text-on-surface-secondary hover:bg-surface-sunken"
        >
          {shortOid(commit.oid)}
        </AppLink>
        <CopyButton
          text={commit.oid}
          label={`Copy commit id ${shortOid(commit.oid)}`}
          className="rounded-none border-l border-border"
        />
      </div>
      <AppLink
        href={
          path === undefined || path === ""
            ? paths.tree(repo, commit.oid)
            : paths.blob(repo, commit.oid, path)
        }
        aria-label={`Browse the repository at ${shortOid(commit.oid)}`}
        title="Browse at this commit"
        className="inline-flex size-6 items-center justify-center rounded text-on-surface-muted hover:bg-surface-sunken hover:text-on-surface"
      >
        <Icon name="code" />
      </AppLink>
    </li>
  );
}

/** Commits under a heading per day. */
export function CommitsByDay({
  repo,
  commits,
  path,
}: {
  repo: RepoRef;
  commits: ReadonlyArray<CommitSummary>;
  path?: string | undefined;
}) {
  const days = groupConsecutive(commits, (commit) => dayKey(commit.committer.when));
  return (
    <div className="space-y-4">
      {days.map((day) => (
        <section
          key={day.key}
          aria-label={`Commits on ${formatDate(day.items[0]!.committer.when)}`}
        >
          <Panel>
            <PanelHeader>
              <Icon name="gitCommit" />
              <h2 className="font-medium text-on-surface-secondary">
                {formatDate(day.items[0]!.committer.when)}
              </h2>
            </PanelHeader>
            <ul className="divide-y divide-border">
              {day.items.map((commit) => (
                <CommitRow key={commit.oid} repo={repo} commit={commit} path={path} />
              ))}
            </ul>
          </Panel>
        </section>
      ))}
    </div>
  );
}

export function CommitsPage({ refName, path }: { refName: string; path: string }) {
  const repo = useRepoRef();
  const request = {
    params: repo,
    query: { ref: refName, ...(path === "" ? {} : { path }), limit: 30 },
  };
  const commits = usePages(["contents", "listCommits", request], (cursor) =>
    api.contents.listCommits({
      ...request,
      query: { ...request.query, ...(cursor === undefined ? {} : { cursor }) },
    }),
  );
  return (
    <Page>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <CodeRefPicker
          repo={repo}
          resolved={{ name: refName, kind: /^[0-9a-f]{40}$/.test(refName) ? "commit" : "branch" }}
          to={(name) => paths.commits(repo, name, path)}
        />
        {path === "" ? (
          <h1 className="text-sm font-semibold text-on-surface">Commits</h1>
        ) : (
          <>
            <h1 className="text-sm font-semibold text-on-surface">History of</h1>
            <PathBreadcrumbs repo={repo} refName={refName} path={path} />
            <ButtonLink size="sm" variant="ghost" href={paths.commits(repo, refName)}>
              All commits
            </ButtonLink>
          </>
        )}
      </div>
      {commits.isLoading ? (
        <Loading />
      ) : commits.error ? (
        <ErrorState error={commits.error} />
      ) : commits.items.length === 0 ? (
        <Panel>
          <EmptyState>No commits</EmptyState>
        </Panel>
      ) : (
        <>
          <CommitsByDay repo={repo} commits={commits.items} path={path} />
          <LoadMore pages={commits} label="Older commits" />
        </>
      )}
    </Page>
  );
}
