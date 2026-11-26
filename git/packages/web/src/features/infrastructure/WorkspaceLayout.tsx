/**
 * The frame of a workspace's pages: its name and root, the numbers that sum
 * it up, and the tabs. The tabs read the workspace with `useWorkspace()`.
 */
import { createContext, useContext, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "../../api/client";
import { invalidate, queries } from "../../api/queries";
import { AppLink, useGo } from "../../components/AppLink";
import { Button } from "../../components/Button";
import { Breadcrumbs, LinkTabs } from "../../components/controls";
import { Icon } from "../../components/icons";
import { Page } from "../../components/Panel";
import { RelativeTime } from "../../components/people";
import { ErrorState, InlineError, Loading } from "../../components/states";
import { useRepoRef, useRepository } from "../../layout/RepoLayout";
import { formatMoney } from "../../lib/amounts";
import type { Repository, TerraformWorkspace } from "@infrawrench/git-contract";
import { paths } from "../../lib/paths";
import { accountLabel } from "./AccountsPicker";

const WorkspaceContext = createContext<TerraformWorkspace | null>(null);

/** The workspace of the current page. Only under `WorkspaceLayout`. */
export function useWorkspace(): TerraformWorkspace {
  const workspace = useContext(WorkspaceContext);
  if (workspace === null) throw new Error("useWorkspace outside the workspace layout");
  return workspace;
}

/**
 * Whether the viewer is offered a plan by hand: `write` on a repository an
 * organisation owns. A personal namespace has the state backend only, and
 * `createRun` answers it 422 `terraform_unavailable`.
 */
export const canRunPlan = (repository: Pick<Repository, "owner" | "viewer">): boolean =>
  repository.viewer.canPush && repository.owner.kind === "org";

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] text-on-surface-muted">{label}</dt>
      <dd className="truncate text-xs font-medium text-on-surface">{children}</dd>
    </div>
  );
}

export function WorkspaceLayout({
  workspace: name,
  children,
}: {
  workspace: string;
  children: ReactNode;
}) {
  const repo = useRepoRef();
  const repository = useRepository();
  const go = useGo();
  const query = useQuery(queries.terraform.getWorkspace({ params: { ...repo, workspace: name } }));
  const plan = useMutation({
    mutationFn: () =>
      api.terraform.createRun({
        params: { ...repo, workspace: name },
        payload: { operation: "plan" },
      }),
    onSuccess: (run) => {
      void invalidate("terraform");
      go(paths.terraformRun(repo, run.workspace.name, run.id));
    },
  });

  if (query.data === undefined) {
    return query.error ? (
      <Page>
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      </Page>
    ) : (
      <Loading shape="page" />
    );
  }
  const workspace = query.data;
  const base = paths.workspace(repo, workspace.name);
  return (
    <WorkspaceContext.Provider value={workspace}>
      <Page>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h1 className="min-w-0">
            <Breadcrumbs
              label="Infrastructure"
              crumbs={[
                { label: "Infrastructure", href: paths.infrastructure(repo) },
                { label: workspace.name },
              ]}
            />
          </h1>
          <div className="flex flex-wrap items-center gap-3">
            <AppLink
              href={paths.tree(repo, workspace.branch, workspace.rootPath)}
              className="inline-flex items-center gap-1.5 font-mono text-[11px] text-on-surface-secondary hover:underline"
            >
              <Icon name="folder" size={12} />
              {workspace.rootPath === "" ? "/" : workspace.rootPath}
            </AppLink>
            {canRunPlan(repository) ? (
              <Button busy={plan.isPending} onClick={() => plan.mutate()}>
                <Icon name="play" size={12} />
                Run plan
              </Button>
            ) : null}
          </div>
        </div>
        {plan.error ? (
          <div className="mb-3">
            <InlineError error={plan.error} />
          </div>
        ) : null}
        <dl className="mb-4 grid grid-cols-2 gap-x-6 gap-y-3 rounded-md border border-border bg-surface-raised px-3 py-2.5 sm:grid-cols-3 lg:grid-cols-6">
          <Fact label="Accounts">
            {workspace.accounts.length === 0
              ? "None"
              : workspace.accounts.map(accountLabel).join(", ")}
          </Fact>
          <Fact label="Branch">{workspace.branch}</Fact>
          <Fact label="State">
            {workspace.currentState === null ? "None" : `Serial ${workspace.currentState.serial}`}
          </Fact>
          <Fact label="Lock">
            {workspace.lock === null ? (
              "Unlocked"
            ) : (
              <span className="inline-flex items-center gap-1 text-warning">
                <Icon name="lock" size={11} />
                {workspace.lock.holder?.username ?? workspace.lock.who ?? "A run"},{" "}
                <RelativeTime iso={workspace.lock.createdAt} />
              </span>
            )}
          </Fact>
          <Fact label="Resources">
            {workspace.resourceCount}
            {workspace.matchedResourceCount !== undefined && workspace.resourceCount > 0 ? (
              <span className="ml-1.5 font-normal text-on-surface-muted">
                {workspace.matchedResourceCount} matched
              </span>
            ) : null}
            {workspace.driftedCount !== null && workspace.driftedCount > 0 ? (
              <span className="ml-1.5 font-normal text-warning">
                {workspace.driftedCount} drifted
              </span>
            ) : null}
          </Fact>
          <Fact label="Monthly cost">
            {workspace.monthlyCost === null
              ? "Not known"
              : formatMoney(workspace.monthlyCost.amount, workspace.monthlyCost.currency)}
          </Fact>
        </dl>
        <LinkTabs
          label="Workspace"
          className="mb-4 border-b border-border"
          tabs={[
            {
              label: "Runs",
              href: base,
              icon: <Icon name="play" />,
              match: (pathname) => pathname === base || pathname.startsWith(`${base}/runs/`),
            },
            {
              label: "State",
              href: paths.workspace(repo, workspace.name, "state"),
              icon: <Icon name="history" />,
            },
            {
              label: "Resources",
              href: paths.workspace(repo, workspace.name, "resources"),
              icon: <Icon name="boxes" />,
              count: workspace.resourceCount,
            },
            ...(repository.viewer.canAdminister
              ? [
                  {
                    label: "Settings",
                    href: paths.workspace(repo, workspace.name, "settings"),
                    icon: <Icon name="settings" />,
                  },
                ]
              : []),
          ]}
        />
        {children}
      </Page>
    </WorkspaceContext.Provider>
  );
}
