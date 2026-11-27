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
import { EmptyState, InlineError, Loading, QueryView } from "../../components/states";
import { useRepoRef, useRepository } from "../../layout/RepoLayout";
import { formatMoney } from "../../lib/amounts";
import type { TerraformRoot, TerraformWorkspace } from "@infrawrench/git-contract";
import { paths } from "../../lib/paths";
import { AccountsPicker, accountLabel } from "./AccountsPicker";
import { WORKSPACE_NAME, WORKSPACE_NAME_RULE, suggestWorkspaceName } from "./backend-snippet";
import { ConfigurationsPanel } from "./ConfigurationsPanel";
import { infrastructureView, rootLabel, scanPending } from "./configurations";
import {
  PlanCounts,
  TerraformStatusIcon,
  operationLabel,
  terraformStatusLabel,
} from "./PlanSummary";

function AddWorkspaceDialog({
  root,
  taken,
  onClose,
}: {
  root: TerraformRoot;
  taken: ReadonlyArray<string>;
  onClose: () => void;
}) {
  const repo = useRepoRef();
  const go = useGo();
  const [name, setName] = useState(() =>
    taken.includes(root.suggestedWorkspace)
      ? suggestWorkspaceName(root.path, taken)
      : root.suggestedWorkspace,
  );
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
    ? WORKSPACE_NAME_RULE
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
          Root <span className="font-mono text-on-surface">{rootLabel(root.path)}</span>
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
          <AccountsPicker selected={accountIds} onChange={setAccountIds} />
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
        {workspace.matchedResourceCount !== undefined && workspace.resourceCount > 0 ? (
          <div className="text-on-surface-muted">{workspace.matchedResourceCount} matched</div>
        ) : null}
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
  const scan = useQuery({
    ...queries.terraform.scan({ params: repo }),
    enabled: !repository.isEmpty,
    // An estimate is worked out by the app in the background: ask again until it is.
    refetchInterval: (query) => (scanPending(query.state.data) ? 10_000 : false),
  });
  const [adding, setAdding] = useState<TerraformRoot | null>(null);
  const scanSettled = repository.isEmpty || scan.isSuccess || scan.isError;

  return (
    <Page>
      <PageHeader title="Infrastructure" />
      <QueryView query={workspaces}>
        {({ workspaces: items }) => {
          const view = infrastructureView(items.length, scan.data, scanSettled);
          const totals = new Map<string, number>();
          for (const workspace of items) {
            if (workspace.monthlyCost === null) continue;
            const { currency, amount } = workspace.monthlyCost;
            totals.set(currency, (totals.get(currency) ?? 0) + amount);
          }
          return (
            <div className="space-y-4">
              {items.length > 0 ? (
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
                </Panel>
              ) : null}
              {view === "loading" ? (
                <Panel>
                  <PanelHeader>Configurations</PanelHeader>
                  <Loading shape="rows" count={2} framed={false} />
                </Panel>
              ) : view === "empty" ? (
                <Panel>
                  {scan.isError ? (
                    <InlineError error={scan.error} />
                  ) : (
                    <EmptyState>No Terraform on the default branch</EmptyState>
                  )}
                </Panel>
              ) : scan.data !== undefined && scan.data.roots.length > 0 ? (
                <ConfigurationsPanel
                  scan={scan.data}
                  onAdd={admin && !repository.archived ? setAdding : null}
                />
              ) : scan.isError ? (
                <InlineError error={scan.error} />
              ) : null}
              {adding !== null ? (
                <AddWorkspaceDialog
                  root={adding}
                  taken={items.map((workspace) => workspace.name)}
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
