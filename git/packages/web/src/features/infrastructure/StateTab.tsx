import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api } from "../../api/client";
import { invalidate, usePages } from "../../api/queries";
import { AppLink } from "../../components/AppLink";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { ConfirmDialog, CopyButton } from "../../components/controls";
import { Icon } from "../../components/icons";
import { Panel, PanelHeader, Table, Td, Th, Tr } from "../../components/Panel";
import { RelativeTime, UserLink } from "../../components/people";
import { EmptyState, ErrorState, InlineError, Loading, LoadMore } from "../../components/states";
import { useRepoRef, useRepository } from "../../layout/RepoLayout";
import { formatBytes } from "../../lib/format";
import type { TerraformStateVersion } from "@infrawrench/git-contract";
import { paths } from "../../lib/paths";
import { useSession } from "../../lib/session";
import { backendConfiguration } from "./backend-snippet";
import { downloadStateVersion, restoreStateVersion } from "./state-actions";
import { useWorkspace } from "./WorkspaceLayout";
import { cursorQuery } from "../../lib/cursor";

/** The `backend "http"` block that points Terraform at this workspace's state. */
export function BackendSnippet() {
  const workspace = useWorkspace();
  const session = useSession();
  const snippet = backendConfiguration(
    workspace.stateAddress,
    session.data?.user?.username ?? "your-username",
  );
  return (
    <Panel>
      <PanelHeader actions={<CopyButton text={snippet} label="Copy backend configuration" />}>
        Backend
        <AppLink
          href={paths.settings("tokens")}
          className="ml-auto text-on-surface-secondary hover:underline"
        >
          Access tokens
        </AppLink>
      </PanelHeader>
      <pre className="overflow-x-auto bg-surface-inset px-3 py-2.5 font-mono text-xs leading-5 text-on-surface">
        {snippet}
      </pre>
    </Panel>
  );
}

function LockPanel() {
  const repo = useRepoRef();
  const repository = useRepository();
  const workspace = useWorkspace();
  const [confirming, setConfirming] = useState(false);
  const unlock = useMutation({
    mutationFn: () => api.terraform.forceUnlock({ params: { ...repo, workspace: workspace.name } }),
    onSuccess: () => {
      setConfirming(false);
      void invalidate("terraform");
    },
  });
  const { lock } = workspace;
  if (lock === null) return null;
  return (
    <Panel className="flex flex-wrap items-center gap-3 px-3 py-2.5 text-xs">
      <Icon name="lock" size={14} className="text-warning" />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-on-surface">
          Locked by {lock.holder?.username ?? lock.who ?? "a run"}{" "}
          <RelativeTime iso={lock.createdAt} className="font-normal text-on-surface-muted" />
        </p>
        <p className="truncate font-mono text-[11px] text-on-surface-muted">
          {[lock.operation, lock.who, lock.id].filter(Boolean).join(" · ")}
        </p>
      </div>
      {lock.runId !== null ? (
        <AppLink
          href={paths.terraformRun(repo, workspace.name, lock.runId)}
          className="text-on-surface-secondary hover:underline"
        >
          Run
        </AppLink>
      ) : null}
      {repository.viewer.canAdminister ? (
        <Button variant="danger" onClick={() => setConfirming(true)}>
          Force unlock
        </Button>
      ) : null}
      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Force unlock"
        confirmLabel="Force unlock"
        busy={unlock.isPending}
        onConfirm={() => unlock.mutate()}
      >
        <p>
          A run that still holds this lock can then write state at the same time as another one.
        </p>
        <InlineError error={unlock.error} />
      </ConfirmDialog>
    </Panel>
  );
}

export function StateTab() {
  const repo = useRepoRef();
  const repository = useRepository();
  const workspace = useWorkspace();
  const request = { params: { ...repo, workspace: workspace.name } };
  const versions = usePages(["terraform", "listStateVersions", request], (cursor) =>
    api.terraform.listStateVersions({ ...request, query: { ...cursorQuery(cursor), limit: 25 } }),
  );
  const [restoring, setRestoring] = useState<TerraformStateVersion | null>(null);
  const restore = useMutation({
    mutationFn: (version: TerraformStateVersion) =>
      restoreStateVersion(repo, workspace.name, version.id),
    onSuccess: () => {
      setRestoring(null);
      void invalidate("terraform");
    },
  });
  const download = useMutation({
    mutationFn: (version: TerraformStateVersion) =>
      downloadStateVersion(repo, workspace.name, version),
  });
  // The state document holds secrets: the backend only serves it to `write` and above.
  const canDownload = repository.viewer.canPush || repository.viewer.canAdminister;
  const canRestore = repository.viewer.canAdminister;

  return (
    <div className="space-y-4">
      <LockPanel />
      <BackendSnippet />
      <Panel>
        <PanelHeader>State versions</PanelHeader>
        {versions.error ? (
          <ErrorState error={versions.error} />
        ) : versions.isLoading ? (
          <Loading />
        ) : versions.items.length === 0 ? (
          <EmptyState>No state yet</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <Table caption="State versions">
              <thead>
                <tr>
                  <Th>Serial</Th>
                  <Th>Written by</Th>
                  <Th>When</Th>
                  <Th className="text-right">Resources</Th>
                  <Th className="text-right">Size</Th>
                  <Th>Terraform</Th>
                  <Th>
                    <span className="sr-only">Actions</span>
                  </Th>
                </tr>
              </thead>
              <tbody>
                {versions.items.map((version) => (
                  <Tr key={version.id}>
                    <Td className="whitespace-nowrap font-mono text-on-surface">
                      {version.serial}
                      {version.current ? (
                        <Badge tone="success" className="ml-2 font-sans">
                          Current
                        </Badge>
                      ) : null}
                    </Td>
                    <Td>
                      {version.createdBy !== null ? (
                        <UserLink user={version.createdBy} avatar />
                      ) : version.runId !== null ? (
                        <AppLink
                          href={paths.terraformRun(repo, workspace.name, version.runId)}
                          className="inline-flex items-center gap-1.5 text-on-surface-secondary hover:underline"
                        >
                          <Icon name="play" size={11} />
                          Run
                        </AppLink>
                      ) : (
                        <span className="text-on-surface-muted">CI</span>
                      )}
                    </Td>
                    <Td className="whitespace-nowrap text-on-surface-muted">
                      <RelativeTime iso={version.createdAt} />
                    </Td>
                    <Td className="text-right">{version.resourceCount}</Td>
                    <Td className="whitespace-nowrap text-right text-on-surface-muted">
                      {formatBytes(version.sizeBytes)}
                    </Td>
                    <Td className="font-mono text-[11px] text-on-surface-muted">
                      {version.terraformVersion ?? ""}
                    </Td>
                    <Td className="w-px whitespace-nowrap text-right">
                      <span className="inline-flex items-center gap-1">
                        {canDownload ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={`Download serial ${version.serial}`}
                            disabled={download.isPending}
                            onClick={() => download.mutate(version)}
                          >
                            <Icon name="download" size={12} />
                            Download
                          </Button>
                        ) : null}
                        {canRestore && !version.current ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={`Restore serial ${version.serial}`}
                            onClick={() => setRestoring(version)}
                          >
                            <Icon name="history" size={12} />
                            Restore
                          </Button>
                        ) : null}
                      </span>
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </div>
        )}
        <InlineError error={download.error} />
      </Panel>
      <LoadMore pages={versions} />
      <ConfirmDialog
        open={restoring !== null}
        onClose={() => setRestoring(null)}
        title="Restore state"
        confirmLabel="Restore"
        busy={restore.isPending}
        onConfirm={() => restoring && restore.mutate(restoring)}
      >
        <p>
          Serial {restoring?.serial} is written again as a new version, and becomes what the next
          plan compares against. Nothing is changed in the cloud accounts.
        </p>
        {workspace.lock !== null ? <p className="text-warning">The state is locked.</p> : null}
        <InlineError error={restore.error} />
      </ConfirmDialog>
    </div>
  );
}
