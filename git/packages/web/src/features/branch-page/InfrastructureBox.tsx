import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { queries } from "../../api/queries";
import { AppLink } from "../../components/AppLink";
import { Button } from "../../components/Button";
import { Icon } from "../../components/icons";
import { Badge } from "../../components/Badge";
import { Table, Td, Th, Tr } from "../../components/Panel";
import { Skeleton } from "../../components/states";
import { useRepoRef, useRepository } from "../../layout/RepoLayout";
import type { TerraformConfigurationRootChange, TerraformRun } from "@infrawrench/git-contract";
import { formatMoney, formatMoneyDelta } from "../../lib/amounts";
import { paths } from "../../lib/paths";
import { changePending, rootLabel } from "../infrastructure/configurations";
import {
  CostDelta,
  PlanCounts,
  ResourceChanges,
  TerraformStatusIcon,
  terraformStatusLabel,
} from "../infrastructure/PlanSummary";

/** A change to the monthly bill from configuration, signed and coloured by direction. */
function ConfigurationDelta({ change }: { change: TerraformConfigurationRootChange }) {
  if (change.status === "pending") {
    return (
      <span className="inline-flex" aria-label="Estimating">
        <Skeleton className="h-3" width={72} />
      </span>
    );
  }
  if (change.monthlyDelta === null || change.currency === null) {
    return <span className="text-on-surface-muted">Not priced</span>;
  }
  const tone =
    change.monthlyDelta > 0 ? "text-danger" : change.monthlyDelta < 0 ? "text-success" : "";
  return (
    <span className={`whitespace-nowrap font-mono text-[11px] ${tone}`}>
      {formatMoneyDelta(change.monthlyDelta, change.currency)}
      <span className="font-sans text-on-surface-muted"> / month</span>
    </span>
  );
}

function ConfigurationLines({ change }: { change: TerraformConfigurationRootChange }) {
  const currency = change.currency ?? "USD";
  const amount = (value: number | null) => (value === null ? "" : formatMoney(value, currency));
  return (
    <div>
      {change.lines.length > 0 ? (
        <Table caption="Monthly estimate by resource">
          <thead>
            <tr>
              <Th>Resource</Th>
              <Th className="text-right">Before</Th>
              <Th className="text-right">After</Th>
              <Th className="text-right">Change</Th>
            </tr>
          </thead>
          <tbody>
            {change.lines.map((line) => (
              <Tr key={line.address}>
                <Td className="font-mono text-on-surface">{line.address}</Td>
                <Td className="text-right font-mono">{amount(line.monthlyBefore)}</Td>
                <Td className="text-right font-mono">{amount(line.monthlyAfter)}</Td>
                <Td
                  className={`text-right font-mono ${
                    line.monthlyDelta > 0
                      ? "text-danger"
                      : line.monthlyDelta < 0
                        ? "text-success"
                        : ""
                  }`}
                >
                  {formatMoneyDelta(line.monthlyDelta, currency)}
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      ) : null}
      {change.unpriced.length > 0 ? (
        <div className="border-t border-border px-3 py-2 text-xs first:border-t-0">
          <p className="mb-1 font-medium text-on-surface-secondary">Not priced</p>
          <ul className="space-y-0.5">
            {change.unpriced.map((item) => (
              <li key={item.address} className="flex flex-wrap gap-x-2">
                <span className="font-mono text-on-surface">{item.address}</span>
                <span className="text-on-surface-muted">{item.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The newest plan of each workspace for a branch: what merging it would
 * change, and cost. Beside them, the estimate from configuration of each
 * root the branch changes that no plan has priced (the server leaves out a
 * root a plan covers, so a root never shows two numbers).
 */
export function InfrastructureBox({ branchKey }: { branchKey: string }) {
  const repo = useRepoRef();
  const repository = useRepository();
  const runs = useQuery({
    ...queries.terraform.listRuns({ params: repo, query: { page: branchKey, limit: 50 } }),
    enabled: repository.hasTerraform,
  });
  const configuration = useQuery({
    ...queries.terraform.configurationChange({ params: repo, query: { page: branchKey } }),
    enabled: !repository.isEmpty,
    refetchInterval: (query) => (changePending(query.state.data) ? 10_000 : false),
  });
  const [open, setOpen] = useState<string | null>(null);

  // Newest first, so the first run of a workspace is its current plan.
  const newest = new Map<string, TerraformRun>();
  for (const run of runs.data?.items ?? []) {
    if (!newest.has(run.workspace.id)) newest.set(run.workspace.id, run);
  }
  const estimated = [...(configuration.data?.roots ?? [])].sort((a, b) =>
    a.path.localeCompare(b.path),
  );
  if (newest.size === 0 && estimated.length === 0) return null;

  return (
    <section
      aria-label="Infrastructure"
      className="rounded-md border border-border bg-surface-raised"
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
        {estimated.map((change) => {
          const key = `configuration:${change.path}`;
          const expanded = open === key;
          const hasDetail = change.lines.length > 0 || change.unpriced.length > 0;
          return (
            <li key={key} className="border-t border-border first:border-t-0">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-xs">
                <Icon name="folder" size={13} className="text-on-surface-muted" />
                <span className="font-mono font-medium text-on-surface">
                  {rootLabel(change.path)}
                </span>
                {change.workspace !== null ? (
                  <AppLink
                    href={paths.workspace(repo, change.workspace)}
                    className="text-on-surface-secondary hover:underline"
                  >
                    {change.workspace}
                  </AppLink>
                ) : null}
                <span className="text-on-surface-muted">Estimate from configuration</span>
                <span className="flex flex-1 flex-wrap items-center justify-end gap-3">
                  {change.status === "priced" && !change.complete ? (
                    <Badge tone="warning">Partial</Badge>
                  ) : null}
                  <ConfigurationDelta change={change} />
                  {hasDetail && change.status !== "pending" ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-expanded={expanded}
                      onClick={() => setOpen(expanded ? null : key)}
                    >
                      {expanded ? "Hide" : "Show"}
                    </Button>
                  ) : null}
                </span>
              </div>
              {expanded ? (
                <div className="border-t border-border">
                  <ConfigurationLines change={change} />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
