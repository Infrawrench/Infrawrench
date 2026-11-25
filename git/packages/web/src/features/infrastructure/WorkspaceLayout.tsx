/**
 * The frame of a workspace's pages: its name and root, the numbers that sum
 * it up, and the tabs. The tabs read the workspace with `useWorkspace()`.
 */
import { createContext, useContext, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { queries } from "../../api/queries";
import { AppLink } from "../../components/AppLink";
import { Breadcrumbs, LinkTabs } from "../../components/controls";
import { Icon } from "../../components/icons";
import { Page } from "../../components/Panel";
import { RelativeTime } from "../../components/people";
import { ErrorState, Loading } from "../../components/states";
import { useRepoRef, useRepository } from "../../layout/RepoLayout";
import { formatMoney } from "../../lib/amounts";
import type { TerraformWorkspace } from "../../lib/models";
import { paths } from "../../lib/paths";
import { accountLabel } from "./AccountsPicker";

const WorkspaceContext = createContext<TerraformWorkspace | null>(null);

/** The workspace of the current page. Only under `WorkspaceLayout`. */
export function useWorkspace(): TerraformWorkspace {
  const workspace = useContext(WorkspaceContext);
  if (workspace === null) throw new Error("useWorkspace outside the workspace layout");
  return workspace;
}

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
  const query = useQuery(queries.terraform.getWorkspace({ params: { ...repo, workspace: name } }));

  if (query.data === undefined) {
    return query.error ? (
      <Page>
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      </Page>
    ) : (
      <Loading />
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
          <AppLink
            href={paths.tree(repo, workspace.branch, workspace.rootPath)}
            className="inline-flex items-center gap-1.5 font-mono text-[11px] text-on-surface-secondary hover:underline"
          >
            <Icon name="folder" size={12} />
            {workspace.rootPath === "" ? "/" : workspace.rootPath}
          </AppLink>
        </div>
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
