import { useState, type FormEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "../../api/client";
import { invalidate, queries } from "../../api/queries";
import { useGo } from "../../components/AppLink";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/controls";
import { Checkbox, Field, Input, Select } from "../../components/forms";
import { Panel } from "../../components/Panel";
import { SettingsRow, SettingsSection } from "../../components/SideNav";
import { EmptyState, InlineError } from "../../components/states";
import { useRepoRef, useRepository } from "../../layout/RepoLayout";
import { paths } from "../../lib/paths";
import { AccountsPicker } from "./AccountsPicker";
import { WORKSPACE_NAME, WORKSPACE_NAME_RULE } from "./backend-snippet";
import { useWorkspace } from "./WorkspaceLayout";

export function SettingsTab() {
  const repo = useRepoRef();
  const repository = useRepository();
  const workspace = useWorkspace();
  const go = useGo();
  const params = { ...repo, workspace: workspace.name };
  const [name, setName] = useState(workspace.name);
  const [branch, setBranch] = useState(workspace.branch);
  const [version, setVersion] = useState(workspace.terraformVersion ?? "");
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");

  const refs = useQuery(queries.contents.listRefs({ params: repo, query: { limit: 100 } }));

  const update = useMutation({
    mutationFn: (payload: Parameters<typeof api.terraform.updateWorkspace>[0]["payload"]) =>
      api.terraform.updateWorkspace({ params, payload }),
    onSuccess: (next) => {
      void invalidate("terraform");
      if (next.name !== workspace.name) {
        go(paths.workspace(repo, next.name, "settings"), { replace: true });
      }
    },
  });
  const remove = useMutation({
    mutationFn: () => api.terraform.deleteWorkspace({ params }),
    onSuccess: () => {
      void invalidate("terraform");
      void invalidate("repositories", "get");
      go(paths.infrastructure(repo));
    },
  });

  if (!repository.viewer.canAdminister) {
    return (
      <Panel>
        <EmptyState>Only administrators change a workspace's settings</EmptyState>
      </Panel>
    );
  }

  const nameProblem = WORKSPACE_NAME.test(name) ? null : WORKSPACE_NAME_RULE;
  const dirty =
    name !== workspace.name ||
    branch !== workspace.branch ||
    version.trim() !== (workspace.terraformVersion ?? "");
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (nameProblem !== null || !dirty) return;
    update.mutate({
      ...(name !== workspace.name ? { name } : {}),
      ...(branch !== workspace.branch ? { branch } : {}),
      terraformVersion: version.trim() === "" ? null : version.trim(),
    });
  };

  return (
    <div className="max-w-2xl space-y-6">
      <SettingsSection title="Workspace">
        <form onSubmit={save} className="space-y-3">
          <Field label="Name" error={nameProblem}>
            {(control) => (
              <Input
                {...control}
                value={name}
                maxLength={63}
                spellCheck={false}
                onChange={(event) => setName(event.target.value)}
              />
            )}
          </Field>
          <Field label="Branch that applies">
            {(control) => (
              <Select
                {...control}
                value={branch}
                onChange={(event) => setBranch(event.target.value)}
              >
                {[
                  ...new Set([branch, ...(refs.data?.branches ?? []).map((item) => item.name)]),
                ].map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field
            label="Terraform version"
            optional
            hint="A version or a constraint, as in required_version"
          >
            {(control) => (
              <Input
                {...control}
                value={version}
                placeholder="~> 1.10"
                spellCheck={false}
                onChange={(event) => setVersion(event.target.value)}
                className="max-w-48 font-mono"
              />
            )}
          </Field>
          <div className="flex items-center gap-2">
            <Button
              type="submit"
              variant="primary"
              busy={update.isPending}
              disabled={!dirty || nameProblem !== null}
            >
              Save
            </Button>
            <InlineError error={update.error} />
          </div>
        </form>
      </SettingsSection>

      <SettingsSection title="Runs">
        <Panel className="divide-y divide-border">
          <SettingsRow title="Plan every branch">
            <Checkbox
              label={<span className="sr-only">Plan every branch</span>}
              checked={workspace.planOnBranch}
              disabled={update.isPending}
              onChange={(event) => update.mutate({ planOnBranch: event.target.checked })}
            />
          </SettingsRow>
          <SettingsRow title={`Apply when ${workspace.branch} changes`}>
            <Checkbox
              label={<span className="sr-only">Apply on merge</span>}
              checked={workspace.applyOnMerge}
              disabled={update.isPending}
              onChange={(event) => update.mutate({ applyOnMerge: event.target.checked })}
            />
          </SettingsRow>
          <SettingsRow
            title="Apply without approval"
            detail={workspace.applyOnMerge ? undefined : "Applies are off"}
          >
            <Checkbox
              label={<span className="sr-only">Apply without approval</span>}
              checked={!workspace.applyRequiresApproval}
              disabled={update.isPending || !workspace.applyOnMerge}
              onChange={(event) => update.mutate({ applyRequiresApproval: !event.target.checked })}
            />
          </SettingsRow>
        </Panel>
      </SettingsSection>

      <SettingsSection title="Accounts">
        <AccountsPicker
          linked={workspace.accounts}
          selected={workspace.accounts.map((account) => account.accountId)}
          disabled={update.isPending}
          onChange={(accountIds) => update.mutate({ accountIds })}
        />
      </SettingsSection>

      <SettingsSection title="Delete workspace" danger>
        <Panel>
          <SettingsRow
            title="Delete this workspace"
            detail="Its state versions are kept for thirty days"
          >
            <Button variant="danger" onClick={() => setConfirming(true)}>
              Delete
            </Button>
          </SettingsRow>
        </Panel>
      </SettingsSection>

      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Delete workspace"
        footer={
          <>
            <Button onClick={() => setConfirming(false)}>Cancel</Button>
            <Button
              variant="danger"
              busy={remove.isPending}
              disabled={typed !== workspace.name}
              onClick={() => remove.mutate()}
            >
              Delete workspace
            </Button>
          </>
        }
      >
        <p>
          The resources it manages are left as they are. Nothing plans or applies{" "}
          <span className="font-mono">{workspace.rootPath}</span> afterwards.
        </p>
        <Field label={`Type ${workspace.name} to confirm`}>
          {(control) => (
            <Input
              {...control}
              value={typed}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => setTyped(event.target.value)}
            />
          )}
        </Field>
        <InlineError error={remove.error} />
      </Dialog>
    </div>
  );
}
