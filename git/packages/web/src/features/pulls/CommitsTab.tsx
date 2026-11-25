import type { CommitSummary } from "@infrawrench/git-contract";
import { api } from "../../api/client";
import { usePages } from "../../api/queries";
import { AppLink } from "../../components/AppLink";
import { CommitStatusIcon } from "../../components/Badge";
import { CopyButton } from "../../components/controls";
import { Panel, PanelHeader } from "../../components/Panel";
import { CommitAuthor, RelativeTime } from "../../components/people";
import { EmptyState, ErrorState, Loading, LoadMore } from "../../components/states";
import { useRepoRef } from "../../layout/RepoLayout";
import { dayKey, formatDate, groupConsecutive, shortOid } from "../../lib/format";
import { paths } from "../../lib/paths";
import { usePull } from "./PullLayout";
import { cursorQuery } from "../../lib/cursor";

export function CommitsTab() {
  const repo = useRepoRef();
  const pull = usePull();
  const request = { params: { ...repo, number: pull.number } };
  const commits = usePages<CommitSummary>(["pulls", "commits", request, pull.headOid], (cursor) =>
    api.pulls.commits({ ...request, query: { ...cursorQuery(cursor), limit: 50 } }),
  );
  if (commits.error) return <ErrorState error={commits.error} />;
  if (commits.isLoading) return <Loading />;
  if (commits.items.length === 0) {
    return (
      <Panel>
        <EmptyState>No commits</EmptyState>
      </Panel>
    );
  }
  return (
    <div className="space-y-3">
      {groupConsecutive(commits.items, (commit) => dayKey(commit.committer.when)).map((day) => (
        <Panel key={day.key}>
          <PanelHeader>Commits on {formatDate(day.items[0]!.committer.when)}</PanelHeader>
          <ul>
            {day.items.map((commit) => (
              <li
                key={commit.oid}
                className="flex items-center gap-3 border-t border-border px-3 py-2 first:border-t-0 hover:bg-surface-inset"
              >
                <div className="min-w-0 flex-1">
                  <AppLink
                    href={paths.commit(repo, commit.oid)}
                    className="block truncate text-xs font-medium text-on-surface hover:underline"
                  >
                    {commit.summary}
                  </AppLink>
                  <div className="mt-0.5 flex items-center gap-1.5 text-xs text-on-surface-muted">
                    <CommitAuthor author={commit.author} user={commit.authorUser} />
                    <span>
                      committed <RelativeTime iso={commit.committer.when} />
                    </span>
                    <CommitStatusIcon state={commit.status} size={12} />
                  </div>
                </div>
                <AppLink
                  href={paths.commit(repo, commit.oid)}
                  className="rounded bg-surface-sunken px-1.5 py-px font-mono text-[11px] text-on-surface hover:underline"
                >
                  {shortOid(commit.oid)}
                </AppLink>
                <CopyButton text={commit.oid} label="Copy commit id" />
              </li>
            ))}
          </ul>
        </Panel>
      ))}
      <LoadMore pages={commits} />
    </div>
  );
}
