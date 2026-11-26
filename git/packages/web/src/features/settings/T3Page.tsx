import { useState, type FormEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  type T3Environment,
  type T3EnvironmentVia,
  T3_CONNECT_REFUSAL,
  isT3ConnectAddress,
} from "@infrawrench/git-contract";
import { api } from "../../api/client";
import { invalidate, queries } from "../../api/queries";
import { useGo } from "../../components/AppLink";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { ConfirmDialog, Dialog } from "../../components/controls";
import { Field, Input, RadioCards } from "../../components/forms";
import { Icon } from "../../components/icons";
import { Panel } from "../../components/Panel";
import { RelativeTime } from "../../components/people";
import { SettingsSection } from "../../components/SideNav";
import { EmptyState, InlineError, QueryView } from "../../components/states";
import { formatDate } from "../../lib/format";
import { paths } from "../../lib/paths";
import { type T3Outcome, addressProblem, connectProblem, environmentState } from "./t3";

const LOCALHOST_PROBLEM =
  "An environment on localhost cannot be reached from here. Turn T3 Connect on in T3 Code and use the address it gives.";

/** Send the browser to the environment to sign in. It comes back to this page. */
const useSignIn = () => {
  const go = useGo();
  return useMutation({
    mutationFn: async (environment: Pick<T3Environment, "id">) => {
      const { authorizeUrl } = await api.t3.beginOAuth({
        params: { environmentId: environment.id },
        payload: { returnTo: paths.settings("t3") },
      });
      // An https address leaves the site; nothing else is followed.
      go(authorizeUrl);
    },
    // Either way the row has changed: a state to finish, or why it could not start.
    onSettled: () => void invalidate("t3", "list"),
  });
};

function EnvironmentForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  // Through T3 Connect unless the person says otherwise: it is the address a
  // Worker can reach without anybody running a proxy.
  const [via, setVia] = useState<T3EnvironmentVia>("t3-connect");
  const [label, setLabel] = useState("");
  const [address, setAddress] = useState("");
  const signIn = useSignIn();
  const create = useMutation({
    mutationFn: () =>
      api.t3.create({ payload: { label: label.trim(), baseUrl: address.trim(), via } }),
    onSuccess: (created) => {
      void invalidate("t3", "list");
      // Adding one is only half of it: straight on to signing in.
      signIn.mutate(created, { onError: onDone });
    },
  });
  const problem = via === "t3-connect" ? connectProblem(address) : addressProblem(address);
  const valid = label.trim() !== "" && problem === null;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (valid) create.mutate();
  };
  return (
    <form onSubmit={submit} className="space-y-3 px-3 py-3">
      <div className="max-w-sm">
        <RadioCards
          legend="Connect through"
          name="t3-via"
          value={via}
          onChange={setVia}
          options={[
            { value: "t3-connect", label: "T3 Connect", icon: <Icon name="link" size={12} /> },
            { value: "address", label: "Use an address", icon: <Icon name="globe" size={12} /> },
          ]}
        />
      </div>
      <Field label="Name">
        {(control) => (
          <Input
            {...control}
            value={label}
            required
            autoFocus
            maxLength={100}
            onChange={(event) => setLabel(event.target.value)}
            className="max-w-sm"
          />
        )}
      </Field>
      <Field
        label={via === "t3-connect" ? "MCP URL" : "Address"}
        hint={
          via === "t3-connect"
            ? "In T3 Code, with T3 Connect on: Settings, Environments, Copy MCP URL"
            : "https, and reachable from the internet"
        }
        error={
          problem === "localhost"
            ? LOCALHOST_PROBLEM
            : problem === "not-https"
              ? "The address has to start with https://"
              : problem === "not-t3-connect"
                ? T3_CONNECT_REFUSAL
                : undefined
        }
      >
        {(control) => (
          <Input
            {...control}
            value={address}
            required
            maxLength={2048}
            inputMode="url"
            autoCapitalize="none"
            spellCheck={false}
            onChange={(event) => setAddress(event.target.value)}
            className="max-w-md font-mono"
          />
        )}
      </Field>
      <div className="flex items-center justify-end gap-2">
        <InlineError error={create.error ?? signIn.error} />
        <Button onClick={onCancel}>Cancel</Button>
        <Button
          type="submit"
          variant="primary"
          busy={create.isPending || signIn.isPending}
          disabled={!valid}
        >
          Add and sign in
        </Button>
      </div>
    </form>
  );
}

function RenameDialog({
  environment,
  onClose,
}: {
  environment: T3Environment | null;
  onClose: () => void;
}) {
  const [label, setLabel] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  // A dialog opened for another environment starts from that one's name.
  if (environment !== null && editing !== environment.id) {
    setEditing(environment.id);
    setLabel(environment.label);
  }
  const rename = useMutation({
    mutationFn: (target: T3Environment) =>
      api.t3.update({ params: { environmentId: target.id }, payload: { label: label.trim() } }),
    onSuccess: () => {
      void invalidate("t3", "list");
      onClose();
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (environment !== null && label.trim() !== "") rename.mutate(environment);
  };
  return (
    <Dialog open={environment !== null} onClose={onClose} title="Rename environment">
      <form onSubmit={submit} className="space-y-3 px-4 py-3">
        <Field label="Name">
          {(control) => (
            <Input
              {...control}
              value={label}
              required
              autoFocus
              maxLength={100}
              onChange={(event) => setLabel(event.target.value)}
            />
          )}
        </Field>
        <div className="flex items-center justify-end gap-2">
          <InlineError error={rename.error} />
          <Button onClick={onClose}>Cancel</Button>
          <Button
            type="submit"
            variant="primary"
            busy={rename.isPending}
            disabled={label.trim() === ""}
          >
            Rename
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function EnvironmentRow({
  environment,
  onRename,
  onRemove,
}: {
  environment: T3Environment;
  onRename: () => void;
  onRemove: () => void;
}) {
  const signIn = useSignIn();
  const state = environmentState(environment);
  return (
    <li className="flex flex-wrap items-start gap-3 border-t border-border px-3 py-2.5 first:border-t-0">
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="flex flex-wrap items-center gap-2 text-xs font-medium text-on-surface">
          {environment.label}
          <Badge tone={state.tone}>{state.label}</Badge>
          {isT3ConnectAddress(environment.baseUrl) ? (
            <Badge tone="neutral">T3 Connect</Badge>
          ) : null}
        </p>
        <p className="break-all font-mono text-[11px] text-on-surface-muted">
          {environment.baseUrl}
        </p>
        <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-on-surface-muted">
          <span>
            added <RelativeTime iso={environment.createdAt} />
          </span>
          {environment.status === "connected" && environment.tokenExpiresAt !== null ? (
            <>
              <span>·</span>
              <span>signed in until {formatDate(environment.tokenExpiresAt)}</span>
            </>
          ) : null}
          <span>·</span>
          {environment.lastUsedAt === null ? (
            <span>never used</span>
          ) : (
            <span>
              last used <RelativeTime iso={environment.lastUsedAt} />
            </span>
          )}
        </p>
        {environment.lastError !== null ? (
          <p role="alert" className="text-xs text-danger">
            {environment.lastError}
          </p>
        ) : null}
        <InlineError error={signIn.error} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {state.action !== null ? (
          <Button
            size="sm"
            variant="primary"
            busy={signIn.isPending}
            aria-label={`${state.action} to ${environment.label}`}
            onClick={() => signIn.mutate(environment)}
          >
            {state.action}
          </Button>
        ) : null}
        <Button size="sm" aria-label={`Rename ${environment.label}`} onClick={onRename}>
          Rename
        </Button>
        <Button
          size="sm"
          variant="danger"
          aria-label={`Remove ${environment.label}`}
          onClick={onRemove}
        >
          Remove
        </Button>
      </div>
    </li>
  );
}

export function T3Page({ outcome }: { outcome?: T3Outcome }) {
  const environments = useQuery(queries.t3.list());
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState<T3Environment | null>(null);
  const [removing, setRemoving] = useState<T3Environment | null>(null);
  const remove = useMutation({
    mutationFn: (environment: T3Environment) =>
      api.t3.remove({ params: { environmentId: environment.id } }),
    onSuccess: () => {
      setRemoving(null);
      void invalidate("t3", "list");
    },
  });
  return (
    <SettingsSection
      title="T3 Code"
      actions={
        <Button variant="primary" size="sm" onClick={() => setAdding(true)}>
          Add environment
        </Button>
      }
    >
      {outcome === "connected" ? (
        <p role="status" className="text-xs text-success">
          Signed in
        </p>
      ) : outcome === "failed" ? (
        <p role="alert" className="text-xs text-danger">
          The sign-in did not complete
        </p>
      ) : null}
      {adding ? (
        <Panel>
          <EnvironmentForm onCancel={() => setAdding(false)} onDone={() => setAdding(false)} />
        </Panel>
      ) : null}
      <QueryView query={environments}>
        {({ environments: items }) => (
          <Panel>
            {items.length === 0 ? (
              <EmptyState action={<Button onClick={() => setAdding(true)}>Add environment</Button>}>
                No T3 Code environments
              </EmptyState>
            ) : (
              <ul>
                {items.map((environment) => (
                  <EnvironmentRow
                    key={environment.id}
                    environment={environment}
                    onRename={() => setRenaming(environment)}
                    onRemove={() => setRemoving(environment)}
                  />
                ))}
              </ul>
            )}
          </Panel>
        )}
      </QueryView>
      <RenameDialog environment={renaming} onClose={() => setRenaming(null)} />
      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title="Remove environment"
        confirmLabel="Remove"
        busy={remove.isPending}
        onConfirm={() => removing && remove.mutate(removing)}
      >
        <p>
          <span className="font-medium">{removing?.label}</span> and its sign-in are forgotten here.
          Branches its threads write stop being sent instructions. The sign-in stays listed in T3
          Code until it is removed there.
        </p>
        <InlineError error={remove.error} />
      </ConfirmDialog>
    </SettingsSection>
  );
}
