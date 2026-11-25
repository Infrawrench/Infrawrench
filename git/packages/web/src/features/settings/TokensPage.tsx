import { useState, type FormEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { TOKEN_SCOPES, type TokenScope } from "@infrawrench/git-contract";
import { api } from "../../api/client";
import { invalidate, queries } from "../../api/queries";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { ConfirmDialog, CopyButton } from "../../components/controls";
import { Checkbox, Field, Input, Select } from "../../components/forms";
import { Icon } from "../../components/icons";
import { Panel } from "../../components/Panel";
import { RelativeTime } from "../../components/people";
import { SettingsSection } from "../../components/SideNav";
import { EmptyState, InlineError, QueryView } from "../../components/states";
import { formatDate } from "../../lib/format";
import type { AccessToken } from "../../lib/models";
import { expiryOf } from "./keys";

const SCOPE_LABEL: Record<TokenScope, string> = {
  "repo:read": "Read repositories",
  "repo:write": "Write repositories",
};

const EXPIRY_CHOICES = [
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "366", label: "One year" },
  { value: "custom", label: "A number of days" },
  { value: "never", label: "No expiry" },
] as const;

function TokenForm({
  onCreated,
  onCancel,
}: {
  onCreated: (created: { token: AccessToken; secret: string }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<TokenScope[]>(["repo:read"]);
  const [expiry, setExpiry] = useState<(typeof EXPIRY_CHOICES)[number]["value"]>("90");
  const [days, setDays] = useState(60);
  const create = useMutation({
    mutationFn: () =>
      api.account.createToken({
        payload: {
          name: name.trim(),
          scopes,
          expiresInDays: expiry === "never" ? null : expiry === "custom" ? days : Number(expiry),
        },
      }),
    onSuccess: (created) => {
      void invalidate("account", "listTokens");
      onCreated(created);
    },
  });
  const valid =
    name.trim() !== "" &&
    scopes.length > 0 &&
    (expiry !== "custom" || (Number.isInteger(days) && days >= 1 && days <= 366));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (valid) create.mutate();
  };
  return (
    <form onSubmit={submit} className="space-y-3 px-3 py-3">
      <Field label="Name">
        {(control) => (
          <Input
            {...control}
            value={name}
            required
            autoFocus
            maxLength={100}
            onChange={(event) => setName(event.target.value)}
            className="max-w-sm"
          />
        )}
      </Field>
      <fieldset className="space-y-1.5">
        <legend className="mb-1 text-xs font-medium text-on-surface">Scopes</legend>
        {TOKEN_SCOPES.map((scope) => (
          <Checkbox
            key={scope}
            label={
              <>
                {SCOPE_LABEL[scope]}{" "}
                <span className="font-mono text-[11px] text-on-surface-muted">{scope}</span>
              </>
            }
            checked={scopes.includes(scope)}
            // Writing includes reading: the scopes are not picked apart.
            disabled={scope === "repo:read" && scopes.includes("repo:write")}
            onChange={(event) =>
              setScopes(
                event.target.checked
                  ? scope === "repo:write"
                    ? ["repo:read", "repo:write"]
                    : [...scopes, scope]
                  : scopes.filter((item) => item !== scope),
              )
            }
          />
        ))}
      </fieldset>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Expires">
          {(control) => (
            <Select
              {...control}
              value={expiry}
              onChange={(event) => setExpiry(event.target.value as typeof expiry)}
              className="!w-44"
            >
              {EXPIRY_CHOICES.map((choice) => (
                <option key={choice.value} value={choice.value}>
                  {choice.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {expiry === "custom" ? (
          <Field label="Days" hint="1 to 366">
            {(control) => (
              <Input
                {...control}
                type="number"
                min={1}
                max={366}
                value={days}
                onChange={(event) => setDays(Math.round(Number(event.target.value)))}
                className="!w-24"
              />
            )}
          </Field>
        ) : null}
      </div>
      <div className="flex items-center justify-end gap-2">
        <InlineError error={create.error} />
        <Button onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant="primary" busy={create.isPending} disabled={!valid}>
          Create token
        </Button>
      </div>
    </form>
  );
}

function Expires({ token }: { token: AccessToken }) {
  const state = expiryOf(token.expiresAt);
  if (token.expiresAt === null) return <span>no expiry</span>;
  if (state === "expired") return <Badge tone="danger">Expired</Badge>;
  return (
    <span className={state === "soon" ? "text-warning" : ""}>
      expires {formatDate(token.expiresAt)}
    </span>
  );
}

export function TokensPage() {
  const tokens = useQuery(queries.account.listTokens());
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{ token: AccessToken; secret: string } | null>(null);
  const [revoking, setRevoking] = useState<AccessToken | null>(null);
  const revoke = useMutation({
    mutationFn: (token: AccessToken) => api.account.revokeToken({ params: { tokenId: token.id } }),
    onSuccess: (_ok, token) => {
      setRevoking(null);
      if (created?.token.id === token.id) setCreated(null);
      void invalidate("account", "listTokens");
    },
  });
  return (
    <SettingsSection
      title="Access tokens"
      actions={
        <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
          New token
        </Button>
      }
    >
      {created !== null ? (
        <Panel role="status" className="space-y-2 px-3 py-3">
          <p className="flex items-center gap-2 text-xs font-medium text-on-surface">
            <Icon name="check" size={13} className="text-success" />
            {created.token.name}
          </p>
          <div className="flex items-center gap-1 rounded border border-border bg-surface-inset py-1 pl-2.5 pr-1">
            <code className="min-w-0 flex-1 select-all break-all font-mono text-xs text-on-surface">
              {created.secret}
            </code>
            <CopyButton text={created.secret} label="Copy token" />
          </div>
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-warning">This is the only time the token is shown.</p>
            <Button size="sm" onClick={() => setCreated(null)}>
              Done
            </Button>
          </div>
        </Panel>
      ) : null}
      {creating ? (
        <Panel>
          <TokenForm
            onCancel={() => setCreating(false)}
            onCreated={(next) => {
              setCreating(false);
              setCreated(next);
            }}
          />
        </Panel>
      ) : null}
      <QueryView query={tokens}>
        {({ tokens: items }) => (
          <Panel>
            {items.length === 0 ? (
              <EmptyState action={<Button onClick={() => setCreating(true)}>New token</Button>}>
                No access tokens
              </EmptyState>
            ) : (
              <ul>
                {items.map((token) => (
                  <li
                    key={token.id}
                    className="flex flex-wrap items-center gap-3 border-t border-border px-3 py-2.5 first:border-t-0"
                  >
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <p className="flex flex-wrap items-center gap-2 text-xs font-medium text-on-surface">
                        {token.name}
                        {token.scopes.map((scope) => (
                          <Badge key={scope} tone="outline">
                            {scope}
                          </Badge>
                        ))}
                      </p>
                      <p className="font-mono text-[11px] text-on-surface-muted">{token.prefix}…</p>
                      <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-on-surface-muted">
                        <span>
                          created <RelativeTime iso={token.createdAt} />
                        </span>
                        <span>·</span>
                        <Expires token={token} />
                        <span>·</span>
                        {token.lastUsedAt === null ? (
                          <span>never used</span>
                        ) : (
                          <span>
                            last used <RelativeTime iso={token.lastUsedAt} />
                          </span>
                        )}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="danger"
                      aria-label={`Revoke ${token.name}`}
                      onClick={() => setRevoking(token)}
                    >
                      Revoke
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        )}
      </QueryView>
      <ConfirmDialog
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        title="Revoke token"
        confirmLabel="Revoke"
        busy={revoke.isPending}
        onConfirm={() => revoking && revoke.mutate(revoking)}
      >
        <p>
          Anything that signs in with <span className="font-medium">{revoking?.name}</span> stops
          working at once.
        </p>
        <InlineError error={revoke.error} />
      </ConfirmDialog>
    </SettingsSection>
  );
}
