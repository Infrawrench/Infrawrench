import { api } from "../../api/client";
import { usePages } from "../../api/queries";
import { AppLink } from "../../components/AppLink";
import { Icon } from "../../components/icons";
import { Panel } from "../../components/Panel";
import { RelativeTime, UserLink } from "../../components/people";
import { EmptyState, ErrorState, Loading, LoadMore } from "../../components/states";
import { useRepoRef } from "../../layout/RepoLayout";
import { durationBetween, formatDuration } from "../../lib/amounts";
import { shortOid } from "../../lib/format";
import type { TerraformRun } from "@infrawrench/git-contract";
import { paths } from "../../lib/paths";
import {
  CostDelta,
  PlanCounts,
  TerraformStatusIcon,
  operationLabel,
  terraformStatusLabel,
  triggerLabel,
} from "./PlanSummary";
import { useWorkspace } from "./WorkspaceLayout";
import { cursorQuery } from "../../lib/cursor";

export function RunsTab() {
  const repo = useRepoRef();
  const workspace = useWorkspace();
  const filter = { workspace: workspace.name };
  const runs = usePages(["terraform", "listRuns", repo, filter], (cursor) =>
    api.terraform.listRuns({
      params: repo,
      query: { ...filter, ...cursorQuery(cursor), limit: 25 },
    }),
  );
  if (runs.error) return <ErrorState error={runs.error} />;
  if (runs.isLoading) return <Loading />;
  return (
    <>
      <Panel>
        {runs.items.length === 0 ? (
          <EmptyState>No runs yet</EmptyState>
        ) : (
          <ul aria-label="Runs">
            {runs.items.map((run) => (
              <li
                key={run.id}
                className="flex items-start gap-2.5 border-t border-border px-3 py-2 first:border-t-0 hover:bg-surface-inset"
              >
                <span className="mt-0.5">
                  <TerraformStatusIcon status={run.status} size={15} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                    <AppLink
                      href={paths.terraformRun(repo, workspace.name, run.id)}
                      className="text-sm font-medium text-on-surface hover:underline"
                    >
                      {operationLabel(run)} {terraformStatusLabel(run.status).toLowerCase()}
                    </AppLink>
                    {run.plan !== null && run.plan.hasChanges ? (
                      <PlanCounts plan={run.plan} />
                    ) : null}
                    {run.costDelta !== null && run.costDelta.monthlyDelta !== 0 ? (
                      <CostDelta cost={run.costDelta} />
                    ) : null}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-on-surface-muted">
                    <span>{triggerLabel(run)}</span>
                    {run.pullNumber !== null ? (
                      <AppLink
                        href={paths.pull(repo, run.pullNumber)}
                        className="inline-flex items-center gap-1 hover:text-on-surface hover:underline"
                      >
                        <Icon name="gitPullRequest" size={11} />#{run.pullNumber}
                      </AppLink>
                    ) : null}
                    <span className="inline-flex items-center gap-1 font-mono text-[11px]">
                      <Icon name="gitBranch" size={10} />
                      {run.ref}
                    </span>
                    <AppLink
                      href={paths.commit(repo, run.commitOid)}
                      className="font-mono text-[11px] hover:underline"
                    >
                      {shortOid(run.commitOid)}
                    </AppLink>
                    {run.actor !== null ? (
                      <UserLink
                        user={run.actor}
                        className="font-normal text-on-surface-secondary"
                      />
                    ) : null}
                  </div>
                  {run.statusReason !== null && run.status === "errored" ? (
                    <p className="mt-1 truncate font-mono text-[11px] text-danger">
                      {run.statusReason}
                    </p>
                  ) : null}
                </div>
                <div className="flex shrink-0 flex-col items-end gap-0.5 pt-0.5 text-xs text-on-surface-muted">
                  <RelativeTime iso={run.createdAt} />
                  <span>
                    {run.finishedAt === null
                      ? ""
                      : formatDuration(durationBetween(run.startedAt, run.finishedAt))}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <LoadMore pages={runs} />
    </>
  );
}
