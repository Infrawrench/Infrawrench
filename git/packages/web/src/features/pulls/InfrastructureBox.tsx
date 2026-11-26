import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { queries } from "../../api/queries";
import { AppLink } from "../../components/AppLink";
import { Button } from "../../components/Button";
import { Icon } from "../../components/icons";
import { useRepoRef, useRepository } from "../../layout/RepoLayout";
import type { TerraformRun } from "@infrawrench/git-contract";
import { paths } from "../../lib/paths";
import {
  CostDelta,
  PlanCounts,
  ResourceChanges,
  TerraformStatusIcon,
  terraformStatusLabel,
} from "../infrastructure/PlanSummary";

/** The newest plan of each workspace for a pull request: what merging it would change, and cost. */
export function InfrastructureBox({
  number,
  flush = false,
}: {
  number: number;
  /** Without the timeline's indent: on the branch page. */
  flush?: boolean;
}) {
  const repo = useRepoRef();
  const repository = useRepository();
  const runs = useQuery({
    ...queries.terraform.listRuns({ params: repo, query: { pull: number, limit: 50 } }),
    enabled: repository.hasTerraform,
  });
  const [open, setOpen] = useState<string | null>(null);

  // Newest first, so the first run of a workspace is its current plan.
  const newest = new Map<string, TerraformRun>();
  for (const run of runs.data?.items ?? []) {
    if (!newest.has(run.workspace.id)) newest.set(run.workspace.id, run);
  }
  if (newest.size === 0) return null;

  return (
    <section
      aria-label="Infrastructure"
      className={`rounded-md border border-border bg-surface-raised ${flush ? "" : "sm:ml-10"}`}
    >
      <h2 className="flex items-center gap-2 rounded-t-md border-b border-border bg-surface-inset px-3 py-1.5 text-xs font-semibold text-on-surface-secondary">
        <Icon name="boxes" size={13} />
        Infrastructure
      </h2>
      <ul>
        {[...newest.values()]
          .sort((a, b) => a.workspace.name.localeCompare(b.workspace.name))
          .map((run) => {
            const expanded = open === run.id;
            const hasChanges = run.plan !== null && run.plan.resourceChanges.length > 0;
            return (
              <li key={run.id} className="border-t border-border first:border-t-0">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-xs">
                  <TerraformStatusIcon status={run.status} />
                  <AppLink
                    href={paths.terraformRun(repo, run.workspace.name, run.id)}
                    className="font-medium text-on-surface hover:underline"
                  >
                    {run.workspace.name}
                  </AppLink>
                  <span className="text-on-surface-muted">{terraformStatusLabel(run.status)}</span>
                  <span className="flex flex-1 flex-wrap items-center justify-end gap-3">
                    {run.plan !== null && run.plan.hasChanges ? (
                      <PlanCounts plan={run.plan} />
                    ) : null}
                    {run.costDelta !== null && run.plan?.hasChanges === true ? (
                      <CostDelta cost={run.costDelta} />
                    ) : null}
                    {hasChanges ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-expanded={expanded}
                        onClick={() => setOpen(expanded ? null : run.id)}
                      >
                        {expanded ? "Hide" : "Show"}
                      </Button>
                    ) : null}
                  </span>
                </div>
                {expanded && run.plan !== null ? (
                  <div className="border-t border-border">
                    <ResourceChanges plan={run.plan} />
                  </div>
                ) : null}
              </li>
            );
          })}
      </ul>
    </section>
  );
}
