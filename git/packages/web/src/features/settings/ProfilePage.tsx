import { useState, type FormEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { NAME_MAX_LENGTH } from "@infrawrench/git-contract";
import { api } from "../../api/client";
import { invalidate, queries } from "../../api/queries";
import { Button, ButtonLink, buttonClass } from "../../components/Button";
import { Field, Input, Select } from "../../components/forms";
import { Icon } from "../../components/icons";
import { Panel } from "../../components/Panel";
import { Avatar } from "../../components/people";
import { SettingsRow, SettingsSection } from "../../components/SideNav";
import { EmptyState, InlineError, QueryView } from "../../components/states";
import { useDebounced } from "../../lib/name-availability";
import { paths } from "../../lib/paths";
import { RUNS_IN_NONE, runsInHint, runsInOrganizationId } from "../../lib/runs-in";
import { type SessionData, useSession } from "../../lib/session";
import { ProfileForm } from "../namespace/ProfileForm";
import { UsernameCheckoutNotice, priceLabel } from "../onboarding/username-checkout";
import { useGo } from "../../components/AppLink";
import { CommitEmails, useCommitEmails } from "./CommitEmails";

function UsernameForm({ current }: { current: string }) {
  const [username, setUsername] = useState(current);
  const settled = useDebounced(username.trim(), 300);
  const changed = settled !== "" && settled !== current;
  const availability = useQuery({
    ...queries.session.usernameAvailability({ query: { username: settled } }),
    enabled: changed,
    staleTime: 0,
  });
  const rename = useMutation({
    mutationFn: () => api.session.renameUsername({ payload: { username: username.trim() } }),
    onSuccess: () => {
      void invalidate("session");
      void invalidate("namespaces");
      void invalidate("repositoryLists");
    },
  });
  const go = useGo();
  // A change to a short username is paid for: the browser goes to the payment
  // page and comes back here with the new name.
  const checkout = useMutation({
    mutationFn: () => api.session.startUsernameCheckout({ payload: { username: username.trim() } }),
    onSuccess: ({ checkoutUrl }) => go(checkoutUrl),
  });
  const checked = changed && username.trim() === settled ? availability.data : undefined;
  const price = checked?.available === true ? checked.priceCents : null;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (checked?.available !== true) return;
    if (price === null) rename.mutate();
    else checkout.mutate();
  };
  return (
    <form onSubmit={submit} className="space-y-2">
      <Field
        label="Username"
        hint="Old links to your repositories stop working when it changes"
        error={checked?.available === false ? checked.message : null}
      >
        {(control) => (
          <div className="flex flex-wrap items-center gap-2">
            <Input
              {...control}
              value={username}
              maxLength={NAME_MAX_LENGTH}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => setUsername(event.target.value)}
              className="max-w-xs"
            />
            <Button
              type="submit"
              busy={rename.isPending || checkout.isPending || checkout.isSuccess}
              disabled={checked?.available !== true}
            >
              {price === null ? "Change username" : `Continue to payment (${priceLabel(price)})`}
            </Button>
            <span role="status" className="text-xs">
              {checked?.available === true ? (
                <span className="inline-flex items-center gap-2">
                  <span className="inline-flex items-center gap-1 text-success">
                    <Icon name="check" size={12} />
                    Available
                  </span>
                  {price === null ? null : (
                    <span className="text-on-surface-faint">{priceLabel(price)}, paid once</span>
                  )}
                </span>
              ) : null}
            </span>
          </div>
        )}
      </Field>
      <InlineError error={rename.error ?? checkout.error} />
    </form>
  );
}

/**
 * The organisation the person's own repositories run CI and review agents
 * in. Saved as it is changed, like a switch.
 */
function RunsInRow({ session }: { session: SessionData }) {
  const organizations = session.organizations;
  const current = session.personal?.workspace?.id ?? null;
  const change = useMutation({
    mutationFn: (organizationId: string | null) =>
      api.session.setWorkspace({ payload: { organizationId } }),
    onSuccess: () => {
      void invalidate("session");
      void invalidate("ci");
    },
  });
  // What was asked for shows while it is saved; a refusal puts the old answer back.
  const shown = change.isPending ? (change.variables ?? null) : current;
  const hint = runsInHint(organizations, shown);
  return (
    <>
      <SettingsRow title="Run CI and review agents in" detail={hint ?? undefined}>
        <Select
          aria-label="Run CI and review agents in"
          value={shown ?? RUNS_IN_NONE}
          disabled={change.isPending}
          onChange={(event) => change.mutate(runsInOrganizationId(event.target.value))}
          className="w-52"
        >
          {organizations.map((organization) => (
            <option key={organization.id} value={organization.id}>
              {organization.name}
            </option>
          ))}
          <option value={RUNS_IN_NONE}>None</option>
        </Select>
      </SettingsRow>
      {change.error ? (
        <div className="px-3 py-2">
          <InlineError error={change.error} />
        </div>
      ) : null}
    </>
  );
}

export function ProfilePage({ returned }: { returned?: string | undefined } = {}) {
  const session = useSession();
  const user = session.data?.user ?? null;
  const username = user?.username ?? null;
  const namespace = useQuery({
    ...queries.namespaces.get({ params: { namespace: username ?? "" } }),
    enabled: username !== null,
  });
  // The ones for the reader's own repositories: an organisation's are on its row of Organisations.
  const commitEmails = useCommitEmails(username !== null);
  if (user === null) return null;
  if (username === null) {
    return (
      <Panel>
        <EmptyState
          action={
            <ButtonLink href={paths.onboardingUsername(paths.settings())}>
              Choose a username
            </ButtonLink>
          }
        >
          You have no username yet
        </EmptyState>
      </Panel>
    );
  }
  return (
    <>
      <SettingsSection title="Profile">
        <div className="flex flex-col gap-4 sm:flex-row-reverse sm:items-start">
          <div className="flex shrink-0 flex-col items-center gap-1">
            <Avatar name={user.displayName ?? username} src={user.avatarUrl} size={72} />
          </div>
          <div className="min-w-0 flex-1 space-y-4">
            {returned === undefined ? null : <UsernameCheckoutNotice state={returned} />}
            <UsernameForm key={username} current={username} />
            <QueryView query={namespace}>
              {(data) => <ProfileForm key={data.slug} namespace={data} />}
            </QueryView>
          </div>
        </div>
      </SettingsSection>
      {commitEmails.data === undefined ? null : (
        <SettingsSection title="Commit emails">
          <CommitEmails
            organization={null}
            emails={commitEmails.data.emails.filter((email) => email.organizationId === null)}
          />
        </SettingsSection>
      )}
      <SettingsSection title="Infrawrench account">
        <Panel className="divide-y divide-border">
          {session.data && session.data.organizations.length > 0 ? (
            <RunsInRow session={session.data} />
          ) : null}
          <SettingsRow title="Email" detail={user.email}>
            <a
              href={session.data?.appUrl}
              target="_blank"
              rel="noreferrer"
              className={buttonClass("secondary", "sm")}
            >
              Open in Infrawrench
              <Icon name="externalLink" size={11} />
            </a>
          </SettingsRow>
          <SettingsRow title="Picture, password and sign-in methods">
            <a
              href={session.data?.appUrl}
              target="_blank"
              rel="noreferrer"
              className={buttonClass("secondary", "sm")}
            >
              Open in Infrawrench
              <Icon name="externalLink" size={11} />
            </a>
          </SettingsRow>
        </Panel>
      </SettingsSection>
    </>
  );
}
