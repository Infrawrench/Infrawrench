import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "../../api/client";
import { invalidate, queries } from "../../api/queries";
import { AppLink } from "../../components/AppLink";
import { Button, ButtonLink } from "../../components/Button";
import { Icon } from "../../components/icons";
import { Panel, PanelHeader } from "../../components/Panel";
import { RelativeTime, UserLink } from "../../components/people";
import { EmptyState, InlineError, QueryView } from "../../components/states";
import { useRepoRef, useRepository } from "../../layout/RepoLayout";
import { durationBetween, formatDuration } from "../../lib/amounts";
import { shortOid } from "../../lib/format";
import { paths } from "../../lib/paths";
import {
  CostDelta,
  CostLines,
  ResourceChanges,
  TerraformStatusBadge,
  TerraformStatusIcon,
  operationLabel,
  planSentence,
  triggerLabel,
} from "./PlanSummary";
import { useWorkspace } from "./WorkspaceLayout";

export function TerraformRunPage({ runId }: { runId: string }) {
  const repo = useRepoRef();
  const repository = useRepository();
  const workspace = useWorkspace();
  const params = { ...repo, runId };
  const query = useQuery({
    ...queries.terraform.getRun({ params }),
    refetchInterval: (state) =>
      state.state.data !== undefined &&
      ["queued", "planning", "applying"].includes(state.state.data.status)
        ? 4000
        : false,
  });
  const done = () => void invalidate("terraform");
  const approve = useMutation({
    mutationFn: () => api.terraform.approveRun({ params }),
    onSuccess: done,
  });
  const discard = useMutation({
    mutationFn: () => api.terraform.discardRun({ params }),
    onSuccess: done,
  });

  return (
    <QueryView query={query}>
      {(run) => {
        const waiting = run.status === "awaiting_approval";
        const canDiscard =
          repository.viewer.canPush &&
          (waiting || run.status === "planned" || run.status === "queued");
        return (
          <div className="space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="space-y-1.5">
                <h2 className="flex items-center gap-2 text-sm font-semibold text-on-surface">
                  <TerraformStatusIcon status={run.status} size={16} />
                  {operationLabel(run)}
                  <TerraformStatusBadge status={run.status} />
                </h2>
                <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-on-surface-muted">
                  <span>{triggerLabel(run)}</span>
                  {run.branchPage !== null ? (
                    <AppLink
                      href={paths.branchPage(repo, run.branchPage)}
                      className="inline-flex items-center gap-1 hover:text-on-surface hover:underline"
                    >
                      <Icon name="fileDiff" size={11} />
                      Branch page
                    </AppLink>
                  ) : null}
                  <span className="inline-flex items-center gap-1 font-mono text-[11px]">
                    <Icon name="gitBranch" size={10} />
                    {run.ref}
                  </span>
                  <AppLink
                    href={paths.commit(repo, run.commitOid)}
                    className="font-mono text-[11px] text-on-surface-secondary hover:underline"
                  >
                    {shortOid(run.commitOid)}
                  </AppLink>
                  {run.actor !== null ? <UserLink user={run.actor} /> : null}
                  <RelativeTime iso={run.createdAt} />
                  {run.finishedAt !== null ? (
                    <span>{formatDuration(durationBetween(run.startedAt, run.finishedAt))}</span>
                  ) : null}
                  {run.approvedBy !== null ? (
                    <span className="inline-flex items-center gap-1">
                      approved by <UserLink user={run.approvedBy} />
                    </span>
                  ) : null}
                </div>
                {run.statusReason !== null ? (
                  <p
                    className={`font-mono text-[11px] ${
                      run.status === "errored" ? "text-danger" : "text-on-surface-secondary"
                    }`}
                  >
                    {run.statusReason}
                  </p>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {run.ciRunId !== null ? (
                  <ButtonLink href={paths.ciRun(repo, run.ciRunId)}>
                    <Icon name="listChecks" size={12} />
                    Log
                  </ButtonLink>
                ) : null}
                {run.stateVersionId !== null ? (
                  <ButtonLink href={paths.workspace(repo, workspace.name, "state")}>
                    <Icon name="history" size={12} />
                    State
                  </ButtonLink>
                ) : null}
                {canDiscard ? (
                  <Button busy={discard.isPending} onClick={() => discard.mutate()}>
                    {run.status === "queued" ? "Cancel" : "Discard"}
                  </Button>
                ) : null}
                {waiting && run.viewerCanApprove === true ? (
                  <Button
                    variant="primary"
                    busy={approve.isPending}
                    onClick={() => approve.mutate()}
                  >
                    Approve and apply
                  </Button>
                ) : null}
              </div>
            </div>
            <InlineError error={approve.error ?? discard.error} />

            <Panel>
              <PanelHeader
                actions={
                  run.costDelta !== null && run.plan?.hasChanges === true ? (
                    <CostDelta cost={run.costDelta} />
                  ) : undefined
                }
              >
                Plan
                {run.plan !== null ? (
                  <span className="font-medium text-on-surface">{planSentence(run.plan)}</span>
                ) : null}
              </PanelHeader>
              {run.plan === null ? (
                <EmptyState>
                  {run.status === "queued" || run.status === "planning"
                    ? "Planning"
                    : "This run has no plan"}
                </EmptyState>
              ) : run.plan.resourceChanges.length === 0 ? (
                <EmptyState>No resources change</EmptyState>
              ) : (
                <ResourceChanges plan={run.plan} />
              )}
              {run.plan !== null && run.plan.outputChanges > 0 ? (
                <p className="border-t border-border px-3 py-1.5 text-xs text-on-surface-muted">
                  {run.plan.outputChanges} {run.plan.outputChanges === 1 ? "output" : "outputs"}{" "}
                  change
                </p>
              ) : null}
            </Panel>

            {run.costDelta !== null && run.costDelta.lines.length > 0 ? (
              <Panel>
                <PanelHeader>Monthly cost</PanelHeader>
                <CostLines cost={run.costDelta} />
              </Panel>
            ) : null}
          </div>
        );
      }}
    </QueryView>
  );
}
