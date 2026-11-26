import { useState, type FormEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { NAME_MAX_LENGTH, type Namespace } from "@infrawrench/git-contract";
import { api } from "../../api/client";
import { invalidate, queries } from "../../api/queries";
import { Button, ButtonLink, buttonClass } from "../../components/Button";
import { Field, Input, Textarea } from "../../components/forms";
import { Icon } from "../../components/icons";
import { Panel } from "../../components/Panel";
import { Avatar } from "../../components/people";
import { SettingsRow, SettingsSection } from "../../components/SideNav";
import { EmptyState, InlineError, QueryView } from "../../components/states";
import { useDebounced } from "../../lib/name-availability";
import { paths } from "../../lib/paths";
import { useSession } from "../../lib/session";

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
  const checked = changed && username.trim() === settled ? availability.data : undefined;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (checked?.available === true) rename.mutate();
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
            <Button type="submit" busy={rename.isPending} disabled={checked?.available !== true}>
              Change username
            </Button>
            <span role="status" className="text-xs text-success">
              {checked?.available === true ? (
                <span className="inline-flex items-center gap-1">
                  <Icon name="check" size={12} />
                  Available
                </span>
              ) : null}
            </span>
          </div>
        )}
      </Field>
      <InlineError error={rename.error} />
    </form>
  );
}

function ProfileForm({ namespace }: { namespace: Namespace }) {
  const [displayName, setDisplayName] = useState(namespace.displayName ?? "");
  const [description, setDescription] = useState(namespace.description ?? "");
  const [website, setWebsite] = useState(namespace.websiteUrl ?? "");
  const [location, setLocation] = useState(namespace.location ?? "");
  const blank = (value: string) => (value.trim() === "" ? null : value.trim());
  const save = useMutation({
    mutationFn: () =>
      api.namespaces.update({
        params: { namespace: namespace.slug },
        payload: {
          displayName: blank(displayName),
          description: blank(description),
          websiteUrl: blank(website),
          location: blank(location),
        },
      }),
    onSuccess: () => {
      void invalidate("namespaces");
      void invalidate("session");
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate();
  };
  return (
    <form onSubmit={submit} className="space-y-3">
      <Field label="Name" optional>
        {(control) => (
          <Input
            {...control}
            value={displayName}
            maxLength={100}
            onChange={(event) => setDisplayName(event.target.value)}
            className="max-w-sm"
          />
        )}
      </Field>
      <Field label="Bio" optional>
        {(control) => (
          <Textarea
            {...control}
            rows={3}
            value={description}
            maxLength={500}
            onChange={(event) => setDescription(event.target.value)}
          />
        )}
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Website" optional>
          {(control) => (
            <Input
              {...control}
              type="url"
              value={website}
              maxLength={500}
              placeholder="https://"
              onChange={(event) => setWebsite(event.target.value)}
            />
          )}
        </Field>
        <Field label="Location" optional>
          {(control) => (
            <Input
              {...control}
              value={location}
              maxLength={100}
              onChange={(event) => setLocation(event.target.value)}
            />
          )}
        </Field>
      </div>
      <div className="flex items-center gap-2">
        <Button type="submit" variant="primary" busy={save.isPending}>
          Save profile
        </Button>
        <span role="status" className="text-xs text-on-surface-muted">
          {save.isSuccess && !save.isPending ? "Saved" : ""}
        </span>
        <InlineError error={save.error} />
      </div>
    </form>
  );
}

export function ProfilePage() {
  const session = useSession();
  const user = session.data?.user ?? null;
  const username = user?.username ?? null;
  const namespace = useQuery({
    ...queries.namespaces.get({ params: { namespace: username ?? "" } }),
    enabled: username !== null,
  });
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
        <div className="flex max-w-2xl flex-col gap-4 sm:flex-row-reverse sm:items-start">
          <div className="flex shrink-0 flex-col items-center gap-1">
            <Avatar name={user.displayName ?? username} src={user.avatarUrl} size={72} />
          </div>
          <div className="min-w-0 flex-1 space-y-4">
            <UsernameForm key={username} current={username} />
            <QueryView query={namespace}>
              {(data) => <ProfileForm key={data.slug} namespace={data} />}
            </QueryView>
          </div>
        </div>
      </SettingsSection>
      <SettingsSection title="Infrawrench account">
        <Panel className="max-w-2xl divide-y divide-border">
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
