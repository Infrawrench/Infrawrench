import { useState, type FormEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "../../api/client";
import { invalidate, queries } from "../../api/queries";
import { AppLink, useGo } from "../../components/AppLink";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/controls";
import { Checkbox, Field, Input } from "../../components/forms";
import { Icon } from "../../components/icons";
import { Page, PageHeader, Panel, PanelHeader, Table, Td, Th, Tr } from "../../components/Panel";
import { RelativeTime } from "../../components/people";
import { EmptyState, InlineError, QueryView } from "../../components/states";
import { useRepoRef, useRepository } from "../../layout/RepoLayout";
import { formatMoney } from "../../lib/amounts";
import type { TerraformAccount, TerraformRoot, TerraformWorkspace } from "../../lib/models";
import { paths } from "../../lib/paths";
import { AccountsPicker, accountLabel } from "./AccountsPicker";
import { WORKSPACE_NAME, suggestWorkspaceName } from "./backend-snippet";
import {
  PlanCounts,
  TerraformStatusIcon,
  operationLabel,
  terraformStatusLabel,
} from "./PlanSummary";

function AddWorkspaceDialog({
  root,
  taken,
  accounts,
  onClose,
}: {
  root: TerraformRoot;
  taken: ReadonlyArray<string>;
  /** Accounts the repository's other workspaces already use: what the picker can offer. */
  accounts: ReadonlyArray<TerraformAccount>;
  onClose: () => void;
}) {
  const repo = useRepoRef();
  const go = useGo();
  const [name, setName] = useState(() => suggestWorkspaceName(root.path, taken));
  const [accountIds, setAccountIds] = useState<string[]>([]);
  const [approval, setApproval] = useState(true);
  const create = useMutation({
    mutationFn: () =>
      api.terraform.createWorkspace({
        params: repo,
        payload: { name, rootPath: root.path, accountIds, applyRequiresApproval: approval },
      }),
    onSuccess: (workspace) => {
      void invalidate("terraform");
      void invalidate("repositories", "get");
      go(paths.workspace(repo, workspace.name));
    },
  });
  const problem = !WORKSPACE_NAME.test(name)
    ? "Letters, digits, dots, dashes and underscores, starting with a letter or digit"
    : taken.includes(name)
      ? "A workspace has that name"
      : null;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (problem === null) create.mutate();
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="Add workspace"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            busy={create.isPending}
            disabled={problem !== null}
            onClick={() => create.mutate()}
          >
            Add workspace
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-3">
        <p className="text-on-surface-muted">
          Root{" "}
          <span className="font-mono text-on-surface">{root.path === "" ? "/" : root.path}</span>
        </p>
        <Field label="Name" error={name === "" ? null : problem}>
          {(control) => (
            <Input
              {...control}
              value={name}
              autoFocus
              maxLength={63}
              spellCheck={false}
              onChange={(event) => setName(event.target.value)}
            />
          )}
        </Field>
        <div className="space-y-1">
          <span className="block text-xs font-medium text-on-surface">Accounts</span>
          <AccountsPicker available={accounts} selected={accountIds} onChange={setAccountIds} />
        </div>
        <Checkbox
          label="An apply waits for approval"
          checked={approval}
          onChange={(event) => setApproval(event.target.checked)}
        />
        <InlineError error={create.error} />
      </form>
    </Dialog>
  );
}

function WorkspaceRow({ workspace }: { workspace: TerraformWorkspace }) {
  const repo = useRepoRef();
  const run = workspace.lastRun;
  return (
    <Tr>
      <Td>
        <AppLink
          href={paths.workspace(repo, workspace.name)}
          className="text-sm font-medium text-on-surface hover:underline"
        >
          {workspace.name}
        </AppLink>
        <div className="font-mono text-[11px] text-on-surface-muted">
          {workspace.rootPath === "" ? "/" : workspace.rootPath}
        </div>
      </Td>
      <Td>
        {workspace.accounts.length === 0 ? (
          <span className="text-on-surface-muted">None</span>
        ) : (
          <ul className="space-y-0.5">
            {workspace.accounts.map((account) => (
              <li key={account.accountId}>{accountLabel(account)}</li>
            ))}
          </ul>
        )}
      </Td>
      <Td>
        {run === null ? (
          <span className="text-on-surface-muted">No runs</span>
        ) : (
          <AppLink
            href={paths.terraformRun(repo, workspace.name, run.id)}
            className="group inline-flex flex-col gap-0.5"
          >
            <span className="inline-flex items-center gap-1.5 text-on-surface group-hover:underline">
              <TerraformStatusIcon status={run.status} size={13} />
              {operationLabel(run)} {terraformStatusLabel(run.status).toLowerCase()}
            </span>
            <span className="inline-flex items-center gap-2 text-on-surface-muted">
              <RelativeTime iso={run.finishedAt ?? run.createdAt} />
              {run.plan !== null && run.plan.hasChanges ? <PlanCounts plan={run.plan} /> : null}
            </span>
          </AppLink>
        )}
      </Td>
      <Td>
        {workspace.lock !== null ? (
          <Badge tone="warning">
            <Icon name="lock" size={10} />
            Locked
          </Badge>
        ) : workspace.currentState === null ? (
          <span className="text-on-surface-muted">No state</span>
        ) : (
          <span className="text-on-surface-secondary">Serial {workspace.currentState.serial}</span>
        )}
        {workspace.lock !== null ? (
          <div className="mt-0.5 text-on-surface-muted">
            by {workspace.lock.holder?.username ?? workspace.lock.who ?? "a run"}
          </div>
        ) : null}
      </Td>
      <Td className="text-right">
        {workspace.resourceCount}
        {workspace.driftedCount !== null && workspace.driftedCount > 0 ? (
          <div className="text-warning">{workspace.driftedCount} drifted</div>
        ) : null}
      </Td>
      <Td className="text-right font-mono">
        {workspace.monthlyCost === null ? (
          <span className="font-sans text-on-surface-muted">Not known</span>
        ) : (
          formatMoney(workspace.monthlyCost.amount, workspace.monthlyCost.currency)
        )}
      </Td>
    </Tr>
  );
}

export function InfrastructurePage() {
  const repo = useRepoRef();
  const repository = useRepository();
  const admin = repository.viewer.canAdminister;
  const workspaces = useQuery(queries.terraform.listWorkspaces({ params: repo }));
  const roots = useQuery({
    ...queries.terraform.listRoots({ params: repo }),
    enabled: admin && !repository.isEmpty,
  });
  const [adding, setAdding] = useState<TerraformRoot | null>(null);

  return (
    <Page>
      <PageHeader title="Infrastructure" />
      <QueryView query={workspaces}>
        {({ workspaces: items }) => {
          const open = (roots.data?.roots ?? []).filter((root) => root.workspaces.length === 0);
          const accounts = new Map<string, TerraformAccount>();
          for (const workspace of items) {
            for (const account of workspace.accounts) accounts.set(account.accountId, account);
          }
          const totals = new Map<string, number>();
          for (const workspace of items) {
            if (workspace.monthlyCost === null) continue;
            const { currency, amount } = workspace.monthlyCost;
            totals.set(currency, (totals.get(currency) ?? 0) + amount);
          }
          return (
            <div className="space-y-4">
              <Panel>
                <PanelHeader
                  actions={
                    totals.size > 0 ? (
                      <span>
                        {[...totals]
                          .map(([currency, amount]) => formatMoney(amount, currency))
                          .join(" + ")}{" "}
                        a month
                      </span>
                    ) : undefined
                  }
                >
                  Workspaces
                </PanelHeader>
                {items.length === 0 ? (
                  <EmptyState
                    action={
                      open[0] !== undefined ? (
                        <Button onClick={() => setAdding(open[0]!)}>Add workspace</Button>
                      ) : undefined
                    }
                  >
                    {admin && roots.data !== undefined && open.length === 0
                      ? "No Terraform roots on the default branch"
                      : "No workspaces yet"}
                  </EmptyState>
                ) : (
                  <div className="overflow-x-auto">
                    <Table caption="Terraform workspaces">
                      <thead>
                        <tr>
                          <Th>Workspace</Th>
                          <Th>Accounts</Th>
                          <Th>Last run</Th>
                          <Th>State</Th>
                          <Th className="text-right">Resources</Th>
                          <Th className="text-right">Monthly cost</Th>
                        </tr>
                      </thead>
                      <tbody>
                        {items.map((workspace) => (
                          <WorkspaceRow key={workspace.id} workspace={workspace} />
                        ))}
                      </tbody>
                    </Table>
                  </div>
                )}
              </Panel>
              {open.length > 0 ? (
                <Panel>
                  <PanelHeader>Roots without a workspace</PanelHeader>
                  <ul>
                    {open.map((root) => (
                      <li
                        key={root.path}
                        className="flex flex-wrap items-center gap-3 border-t border-border px-3 py-2 text-xs first:border-t-0"
                      >
                        <Icon name="folder" size={13} className="text-on-surface-muted" />
                        <AppLink
                          href={paths.tree(repo, repository.defaultBranch, root.path)}
                          className="font-mono text-on-surface hover:underline"
                        >
                          {root.path === "" ? "/" : root.path}
                        </AppLink>
                        {root.backend !== null ? (
                          <Badge tone="outline">backend "{root.backend}"</Badge>
                        ) : null}
                        <span className="flex-1" />
                        <Button size="sm" onClick={() => setAdding(root)}>
                          <Icon name="plus" size={11} />
                          Add workspace
                        </Button>
                      </li>
                    ))}
                  </ul>
                </Panel>
              ) : null}
              {adding !== null ? (
                <AddWorkspaceDialog
                  root={adding}
                  taken={items.map((workspace) => workspace.name)}
                  accounts={[...accounts.values()]}
                  onClose={() => setAdding(null)}
                />
              ) : null}
            </div>
          );
        }}
      </QueryView>
    </Page>
  );
}
