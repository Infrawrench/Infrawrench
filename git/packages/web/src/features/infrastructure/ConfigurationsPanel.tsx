import { Fragment, useState } from "react";
import { terraformStatePath } from "@infrawrench/git-contract";
import type {
  TerraformConfigurationEstimate,
  TerraformRoot,
  TerraformScan,
} from "@infrawrench/git-contract";
import { AppLink } from "../../components/AppLink";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { CopyButton } from "../../components/controls";
import { Icon } from "../../components/icons";
import { Panel, PanelHeader, Table, Td, Th, Tr } from "../../components/Panel";
import { Skeleton } from "../../components/states";
import { useRepoRef, useRepository } from "../../layout/RepoLayout";
import { formatMoney } from "../../lib/amounts";
import { paths } from "../../lib/paths";
import { useSession } from "../../lib/session";
import { backendConfiguration } from "./backend-snippet";
import {
  OTHER_KIND_LABELS,
  estimateFigure,
  inactiveTitle,
  migrationCommand,
  othersByKind,
  rootLabel,
  setupWorkspaceName,
  sortedRoots,
  stateLocation,
} from "./configurations";

/** A root's estimate as one cell: the figure, a skeleton while it is worked out. */
export function EstimateCell({ estimate }: { estimate: TerraformConfigurationEstimate }) {
  if (estimate.status === "pending") {
    return (
      <span className="inline-flex justify-end" aria-label="Estimating">
        <Skeleton className="h-3" width={64} />
      </span>
    );
  }
  const priced = estimate.status === "priced" && estimate.monthlyTotal !== null;
  return (
    <span className="inline-flex items-center justify-end gap-1.5 whitespace-nowrap">
      <span className={priced ? "font-mono text-on-surface" : "text-on-surface-muted"}>
        {estimateFigure(estimate)}
      </span>
      {estimate.status === "priced" && !estimate.complete ? (
        <span title="Some resources are not priced">
          <Badge tone="warning">Partial</Badge>
        </span>
      ) : null}
    </span>
  );
}

function SectionTitle({ children }: { children: string }) {
  return <h3 className="mb-1.5 text-xs font-semibold text-on-surface-secondary">{children}</h3>;
}

function CodeLine({ text, label }: { text: string; label: string }) {
  return (
    <div className="code-surface flex items-start gap-1 rounded border border-border bg-surface-inset">
      <pre className="min-w-0 flex-1 overflow-x-auto px-2.5 py-1.5 font-mono text-xs leading-5 text-on-surface">
        {text}
      </pre>
      <CopyButton text={text} label={label} className="m-1" />
    </div>
  );
}

function EstimateDetail({ estimate }: { estimate: TerraformConfigurationEstimate }) {
  if (estimate.status === "pending") {
    return (
      <div className="space-y-1.5" aria-label="Estimating">
        <Skeleton className="h-3" width="60%" />
        <Skeleton className="h-3" width="45%" />
      </div>
    );
  }
  if (estimate.status === "unavailable") {
    return <p className="text-on-surface-muted">No price data on this server</p>;
  }
  const currency = estimate.currency ?? "USD";
  const groups = othersByKind(estimate.others);
  return (
    <div className="space-y-3">
      {estimate.monthlyTotal === null ? (
        <p className="text-on-surface-muted">{estimateFigure(estimate)}</p>
      ) : (
        <p className="flex flex-wrap items-baseline gap-x-2 text-on-surface-muted">
          <span className="font-mono text-sm text-on-surface">{estimateFigure(estimate)}</span>
          <span>a month, from configuration at list prices</span>
          {!estimate.complete ? <Badge tone="warning">Partial</Badge> : null}
        </p>
      )}
      {estimate.lines.length > 0 ? (
        <div className="overflow-hidden rounded border border-border">
          <Table caption="Priced resources">
            <thead>
              <tr>
                <Th>Resource</Th>
                <Th>Priced as</Th>
                <Th className="text-right">Monthly</Th>
              </tr>
            </thead>
            <tbody>
              {estimate.lines.slice(0, 20).map((line) => (
                <Tr key={line.address}>
                  <Td className="font-mono text-on-surface">{line.address}</Td>
                  <Td className="text-on-surface-muted">{line.detail}</Td>
                  <Td className="text-right font-mono">{formatMoney(line.monthly, currency)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
          {estimate.lines.length > 20 ? (
            <p className="border-t border-border px-3 py-1.5 text-on-surface-muted">
              {estimate.lines.length - 20} more priced resources
            </p>
          ) : null}
        </div>
      ) : null}
      {estimate.unpriced.length > 0 ? (
        <div>
          <SectionTitle>Not priced</SectionTitle>
          <ul className="space-y-0.5">
            {estimate.unpriced.map((item) => (
              <li key={item.address} className="flex flex-wrap gap-x-2">
                <span className="font-mono text-on-surface">{item.address}</span>
                <span className="text-on-surface-muted">{item.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {groups.length > 0 ? (
        <dl className="grid gap-x-3 gap-y-1 sm:grid-cols-[max-content_1fr]">
          {groups.map((group) => (
            <Fragment key={group.kind}>
              <dt className="text-on-surface-secondary">
                {OTHER_KIND_LABELS[group.kind]} ({group.total})
              </dt>
              <dd className="font-mono text-[11px] text-on-surface-muted">
                {group.types.join(", ")}
              </dd>
            </Fragment>
          ))}
        </dl>
      ) : null}
    </div>
  );
}

function StateSetup({ root, onAdd }: { root: TerraformRoot; onAdd: (() => void) | null }) {
  const repo = useRepoRef();
  const session = useSession();
  const workspace = setupWorkspaceName(root);
  const stateUrl = `${window.location.origin}${terraformStatePath(repo, workspace)}`;
  const username = session.data?.user?.username ?? "your-username";
  const existing = root.workspaces[0];
  return (
    <div className="max-w-4xl space-y-2.5">
      <ol className="list-decimal space-y-2.5 pl-4 marker:text-on-surface-muted">
        <li className="space-y-1">
          <span className="text-on-surface-secondary">
            Replace the backend in <span className="font-mono">{rootLabel(root.path)}</span>
          </span>
          <CodeLine
            text={backendConfiguration(stateUrl, username)}
            label="Copy backend configuration"
          />
        </li>
        <li className="space-y-1">
          <span className="text-on-surface-secondary">
            Sign in over HTTPS: username <span className="font-mono">{username}</span>, password an{" "}
            <AppLink href={paths.settings("tokens")} className="hover:underline">
              access token
            </AppLink>{" "}
            with <span className="font-mono">repo:write</span>
          </span>
          <CodeLine text="export TF_HTTP_PASSWORD=<access token>" label="Copy the variable" />
        </li>
        <li className="space-y-1">
          <span className="text-on-surface-secondary">
            {root.backend === null
              ? "Move the local state"
              : `Move the state from ${root.backend.type}`}
          </span>
          <CodeLine text={migrationCommand(root)} label="Copy the command" />
        </li>
        <li className="space-y-1">
          <span className="text-on-surface-secondary">
            Plans on branch pages: a workspace on this root, with plans on branches on and the
            accounts its providers use linked
          </span>
          <div>
            {existing !== undefined ? (
              <AppLink
                href={paths.workspace(repo, existing, "settings")}
                className="inline-flex items-center gap-1 text-on-surface-secondary hover:underline"
              >
                <Icon name="settings" size={12} />
                {existing} settings
              </AppLink>
            ) : onAdd !== null ? (
              <Button size="sm" onClick={onAdd}>
                <Icon name="plus" size={11} />
                Add workspace {workspace}
              </Button>
            ) : (
              <span className="text-on-surface-muted">
                An administrator of the repository adds it
              </span>
            )}
          </div>
        </li>
      </ol>
    </div>
  );
}

/** Addresses a count or for_each of zero switches off: the first ten, then all on asking. */
function InactiveList({ addresses, total }: { addresses: readonly string[]; total: number }) {
  const [all, setAll] = useState(false);
  const shown = all ? addresses : addresses.slice(0, 10);
  return (
    <div className="space-y-1">
      <ul className="grid gap-x-3 gap-y-0.5 font-mono text-[11px] text-on-surface-muted sm:grid-cols-2">
        {shown.map((address) => (
          <li key={address} className="min-w-0 truncate" title={address}>
            {address}
          </li>
        ))}
      </ul>
      {addresses.length > shown.length ? (
        <Button size="sm" variant="ghost" onClick={() => setAll(true)}>
          {addresses.length - shown.length} more
        </Button>
      ) : null}
      {total > addresses.length ? (
        <p className="text-on-surface-muted">{total - addresses.length} more not listed</p>
      ) : null}
    </div>
  );
}

function RootDetail({ root, onAdd }: { root: TerraformRoot; onAdd: (() => void) | null }) {
  const repo = useRepoRef();
  const repository = useRepository();
  return (
    <div className="grid gap-4 px-3 py-3 text-xs lg:grid-cols-2">
      <div className="space-y-4">
        <section>
          <SectionTitle>Estimate</SectionTitle>
          <EstimateDetail estimate={root.estimate} />
        </section>
        {root.inactiveResources > 0 ? (
          <section>
            <SectionTitle>{inactiveTitle(root.inactiveResources)}</SectionTitle>
            <InactiveList addresses={root.inactiveAddresses} total={root.inactiveResources} />
          </section>
        ) : null}
      </div>
      <div className="space-y-4">
        <section>
          <SectionTitle>Providers</SectionTitle>
          {root.providers.length === 0 ? (
            <p className="text-on-surface-muted">None</p>
          ) : (
            <ul className="space-y-0.5">
              {root.providers.map((provider) => (
                <li key={provider.name} className="flex flex-wrap items-center gap-x-2">
                  <Icon name="cloud" size={12} className="text-on-surface-muted" />
                  <span className="font-medium text-on-surface">{provider.name}</span>
                  {provider.source !== null ? (
                    <span className="font-mono text-on-surface-muted">{provider.source}</span>
                  ) : null}
                  {provider.version !== null ? (
                    <span className="font-mono text-on-surface-muted">{provider.version}</span>
                  ) : null}
                  <span className="flex-1" />
                  <span className="text-on-surface-muted">
                    {provider.resources} {provider.resources === 1 ? "resource" : "resources"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
        {root.modules.length > 0 ? (
          <section>
            <SectionTitle>Modules</SectionTitle>
            <ul className="space-y-0.5">
              {root.modules.map((module) => (
                <li key={module.name} className="flex flex-wrap items-center gap-x-2">
                  <span className="font-mono text-on-surface">{module.name}</span>
                  {module.localPath !== null ? (
                    <AppLink
                      href={paths.tree(repo, repository.defaultBranch, module.localPath)}
                      className="font-mono text-on-surface-secondary hover:underline"
                    >
                      {rootLabel(module.localPath)}
                    </AppLink>
                  ) : (
                    <span className="font-mono text-on-surface-muted">
                      {module.source ?? "source not a plain string"}
                    </span>
                  )}
                  {module.version !== null ? (
                    <span className="font-mono text-on-surface-muted">{module.version}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {root.resourceTypes.length > 0 ? (
          <section>
            <SectionTitle>Resource types</SectionTitle>
            <ul className="grid gap-x-3 gap-y-0.5 sm:grid-cols-2">
              {root.resourceTypes.slice(0, 12).map((item) => (
                <li key={item.type} className="flex gap-2">
                  <span className="min-w-0 truncate font-mono text-on-surface">{item.type}</span>
                  <span className="text-on-surface-muted">{item.count}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        <section>
          <SectionTitle>Files</SectionTitle>
          <ul className="space-y-0.5 text-on-surface-muted">
            <li>
              {root.variableCount} variables
              {root.requiredVariables.length > 0
                ? `, ${root.requiredVariables.length} without a value`
                : ""}
              , {root.outputCount} outputs
            </li>
            <li>{root.lockFile ? "Lock file committed" : "No lock file"}</li>
            {root.tfvarsFiles.length > 0 ? (
              <li className="font-mono">{root.tfvarsFiles.join(", ")}</li>
            ) : null}
            {root.requiredVersion !== null ? (
              <li>
                Terraform <span className="font-mono">{root.requiredVersion}</span>
              </li>
            ) : null}
            {root.usesWorkspace ? <li>Reads terraform.workspace</li> : null}
            {root.unreadable.map((item) => (
              <li key={item.file} className="text-warning">
                <span className="font-mono">{item.file}</span>: {item.reason}
              </li>
            ))}
          </ul>
        </section>
      </div>
      <section className="border-t border-border pt-3 lg:col-span-2">
        <SectionTitle>Use git.infrawrench.com for state</SectionTitle>
        <StateSetup root={root} onAdd={onAdd} />
      </section>
    </div>
  );
}

/** Every Terraform root the scan found, with or without a workspace. */
export function ConfigurationsPanel({
  scan,
  onAdd,
}: {
  scan: TerraformScan;
  /** Null for a viewer who may not add a workspace. */
  onAdd: ((root: TerraformRoot) => void) | null;
}) {
  const repo = useRepoRef();
  const repository = useRepository();
  const [open, setOpen] = useState<string | null>(null);
  const roots = sortedRoots(scan.roots);
  return (
    <Panel>
      <PanelHeader>Configurations</PanelHeader>
      {scan.truncated ? (
        <p className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs text-warning">
          <Icon name="alertCircle" size={13} />
          The repository is larger than a scan reads: some roots may be missing
        </p>
      ) : null}
      <Table caption="Terraform configurations">
        <thead>
          <tr>
            <Th>Root</Th>
            <Th>State</Th>
            <Th>Providers</Th>
            <Th className="text-right">Resources</Th>
            <Th className="text-right">Modules</Th>
            <Th className="text-right">Estimate</Th>
            <Th>
              <span className="sr-only">Details</span>
            </Th>
          </tr>
        </thead>
        <tbody>
          {roots.map((root) => {
            const expanded = open === root.path;
            const workspace = root.workspaces[0];
            return (
              <Fragment key={root.path}>
                <Tr>
                  <Td>
                    <span className="inline-flex items-center gap-1.5">
                      <Icon name="folder" size={13} className="text-on-surface-muted" />
                      <AppLink
                        href={paths.tree(repo, repository.defaultBranch, root.path)}
                        className="font-mono font-medium text-on-surface hover:underline"
                      >
                        {rootLabel(root.path)}
                      </AppLink>
                    </span>
                    <div className="mt-0.5 pl-5">
                      {workspace !== undefined ? (
                        <AppLink
                          href={paths.workspace(repo, workspace)}
                          className="text-on-surface-secondary hover:underline"
                        >
                          {root.workspaces.join(", ")}
                        </AppLink>
                      ) : (
                        <span className="text-on-surface-muted">No workspace</span>
                      )}
                    </div>
                  </Td>
                  <Td className="text-on-surface-secondary">{stateLocation(root)}</Td>
                  <Td>
                    {root.providers.length === 0 ? (
                      <span className="text-on-surface-muted">None</span>
                    ) : (
                      <span className="flex flex-wrap gap-1">
                        {root.providers.map((provider) => (
                          <Badge key={provider.name} tone="outline">
                            <Icon name="cloud" size={10} />
                            {provider.name}
                          </Badge>
                        ))}
                      </span>
                    )}
                  </Td>
                  <Td className="text-right">
                    {root.resourceCount}
                    {root.dataSourceCount > 0 ? (
                      <div className="text-on-surface-muted">{root.dataSourceCount} data</div>
                    ) : null}
                    {root.inactiveResources > 0 ? (
                      <div className="text-on-surface-muted">
                        {root.inactiveResources} switched off
                      </div>
                    ) : null}
                  </Td>
                  <Td className="text-right">{root.modules.length}</Td>
                  <Td className="text-right">
                    <EstimateCell estimate={root.estimate} />
                  </Td>
                  <Td className="text-right">
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-expanded={expanded}
                      aria-label={`${expanded ? "Hide" : "Show"} ${rootLabel(root.path)}`}
                      onClick={() => setOpen(expanded ? null : root.path)}
                    >
                      <Icon name={expanded ? "chevronDown" : "chevronRight"} size={12} />
                    </Button>
                  </Td>
                </Tr>
                {expanded ? (
                  <tr className="border-t border-border bg-surface">
                    <td colSpan={7}>
                      <RootDetail
                        root={root}
                        onAdd={
                          onAdd !== null && root.workspaces.length === 0 ? () => onAdd(root) : null
                        }
                      />
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </Table>
    </Panel>
  );
}
