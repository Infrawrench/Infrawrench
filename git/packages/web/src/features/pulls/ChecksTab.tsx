import { useQuery } from "@tanstack/react-query";
import { queries } from "../../api/queries";
import { AppLink } from "../../components/AppLink";
import { Badge } from "../../components/Badge";
import { ButtonLink } from "../../components/Button";
import { Panel, PanelHeader } from "../../components/Panel";
import { RelativeTime } from "../../components/people";
import { EmptyState, QueryView } from "../../components/states";
import { CheckStateIcon } from "../../components/StatusIcons";
import { useRepoRef } from "../../layout/RepoLayout";
import { shortOid } from "../../lib/format";
import { paths } from "../../lib/paths";
import { RunRow, isActive } from "../ci/RunRow";
import { checkRows } from "./merge-box";
import { usePull } from "./PullLayout";

/** What ran on the pull request's head commit: its CI runs, and every status reported on it. */
export function ChecksTab() {
  const repo = useRepoRef();
  const pull = usePull();
  const runs = useQuery({
    ...queries.ci.listRuns({ params: repo, query: { sha: pull.headOid, limit: 50 } }),
    refetchInterval: (query) => (query.state.data?.items.some(isActive) === true ? 4000 : false),
  });
  const rows = checkRows(pull.mergeability.checks);
  const reportedAt = new Map(
    pull.mergeability.checks.statuses.map((status) => [status.context, status.updatedAt]),
  );

  return (
    <div className="space-y-4">
      <Panel>
        <PanelHeader>
          CI runs of
          <AppLink
            href={paths.commit(repo, pull.headOid)}
            className="rounded bg-surface-sunken px-1.5 py-px font-mono text-[11px] text-on-surface hover:underline"
          >
            {shortOid(pull.headOid)}
          </AppLink>
        </PanelHeader>
        <QueryView query={runs}>
          {(page) =>
            page.items.length === 0 ? (
              <EmptyState action={<ButtonLink href={paths.ci(repo)}>CI</ButtonLink>}>
                No runs for this commit
              </EmptyState>
            ) : (
              <ul aria-label="CI runs">
                {page.items.map((run) => (
                  <RunRow key={run.id} run={run} repo={repo} />
                ))}
              </ul>
            )
          }
        </QueryView>
      </Panel>
      <Panel>
        <PanelHeader>Statuses</PanelHeader>
        {rows.length === 0 ? (
          <EmptyState>Nothing has reported a status on this commit</EmptyState>
        ) : (
          <ul aria-label="Statuses">
            {rows.map((row) => {
              const at = reportedAt.get(row.context);
              return (
                <li
                  key={row.context}
                  className="flex items-center gap-2.5 border-t border-border px-3 py-2 text-xs first:border-t-0"
                >
                  <CheckStateIcon state={row.state} />
                  <span className="min-w-0 truncate font-medium text-on-surface">
                    {row.context}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-on-surface-muted">
                    {row.description}
                  </span>
                  {row.required ? <Badge tone="outline">Required</Badge> : null}
                  {at !== undefined ? (
                    <RelativeTime iso={at} className="shrink-0 text-on-surface-muted" />
                  ) : null}
                  {row.targetUrl !== null ? (
                    <AppLink
                      href={row.targetUrl}
                      className="shrink-0 text-on-surface-secondary hover:underline"
                    >
                      Details
                    </AppLink>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </div>
  );
}
