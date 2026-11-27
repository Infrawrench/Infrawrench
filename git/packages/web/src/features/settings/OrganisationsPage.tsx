/**
 * The Infrawrench organisations the signed-in person belongs to, and the name
 * each has here. An administrator (`git:admin`) of one without a name claims
 * it on this page; the app's Settings > Git does the same and also renames.
 */
import { useState, type FormEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  NAME_MAX_LENGTH,
  SITE_ORIGIN,
  nameProblemMessage,
  namespaceSlugProblem,
  suggestSlug,
  type SessionOrganization,
} from "@infrawrench/git-contract";
import { ApiError, api } from "../../api/client";
import { invalidate, queries } from "../../api/queries";
import { AppLink } from "../../components/AppLink";
import { Button, ButtonLink } from "../../components/Button";
import { Field, Input } from "../../components/forms";
import { Icon } from "../../components/icons";
import { Panel } from "../../components/Panel";
import { Avatar } from "../../components/people";
import { SettingsSection } from "../../components/SideNav";
import { EmptyState, InlineError, Loading } from "../../components/states";
import { useDebounced } from "../../lib/name-availability";
import { paths } from "../../lib/paths";
import { useSession } from "../../lib/session";

const SITE_HOST = SITE_ORIGIN.replace(/^https?:\/\//, "");

/** The codes that are about the name typed, which the field shows under itself. */
const NAME_CODES = new Set(["namespace_taken", "name_invalid", "username_reserved"]);

function ClaimForm({ organization }: { organization: SessionOrganization }) {
  const [typed, setTyped] = useState<string | null>(null);
  // Lower case, as a URL reads; the person can type it otherwise.
  const value = typed ?? suggestSlug(organization.name).toLowerCase();
  const problem = namespaceSlugProblem(value);
  const settled = useDebounced(value, 300);
  // A name is one list for people and organisations: this asks it.
  const availability = useQuery({
    ...queries.session.usernameAvailability({ query: { username: settled } }),
    enabled: settled !== "" && namespaceSlugProblem(settled) === null,
    staleTime: 10_000,
  });
  const checked = availability.data?.username === value ? availability.data : undefined;

  const claim = useMutation({
    mutationFn: () =>
      api.namespaces.claimForOrganization({
        params: { orgId: organization.id },
        payload: { slug: value },
      }),
    // The session lists the organisation under its name from here on, and the
    // sidebar's workspaces are read from it.
    onSuccess: () =>
      Promise.all([invalidate("session"), invalidate("namespaces"), invalidate("repositoryLists")]),
  });

  const refused =
    claim.error instanceof ApiError && NAME_CODES.has(claim.error.code ?? "") ? claim.error : null;
  const error =
    value === ""
      ? null
      : problem !== null
        ? nameProblemMessage(problem, NAME_MAX_LENGTH)
        : refused !== null
          ? refused.message
          : checked?.available === false
            ? "That name is taken"
            : null;
  const available = problem === null && refused === null && checked?.available === true;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    // A name still being checked is the server's to refuse.
    if (problem === null && checked?.available !== false) claim.mutate();
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-2">
      <Field
        label={`Name for ${organization.name}`}
        error={error}
        hint={
          available ? (
            <span role="status" className="inline-flex items-center gap-1 text-success">
              <Icon name="check" size={12} />
              Available
            </span>
          ) : (
            `${SITE_HOST}/${value === "" ? "name" : value}`
          )
        }
      >
        {(control) => (
          <div className="flex flex-wrap items-center gap-2">
            <Input
              {...control}
              required
              autoComplete="off"
              spellCheck={false}
              maxLength={NAME_MAX_LENGTH}
              value={value}
              onChange={(event) => {
                setTyped(event.target.value);
                if (claim.error) claim.reset();
              }}
              className="max-w-xs"
            />
            <Button
              type="submit"
              variant="primary"
              busy={claim.isPending}
              disabled={value === "" || problem !== null || checked?.available === false}
            >
              Claim
            </Button>
          </div>
        )}
      </Field>
      {refused === null ? <InlineError error={claim.error} /> : null}
    </form>
  );
}

/**
 * Why nobody is asked for a name: the reader is not the organisation's
 * administrator, or its plan does not include a namespace.
 */
function Unclaimable({
  organization,
  appUrl,
}: {
  organization: SessionOrganization;
  appUrl: string;
}) {
  if (!organization.permissions.includes("git:admin")) {
    return (
      <p className="text-xs text-on-surface-muted">
        Ask an administrator of {organization.name} to claim its name
      </p>
    );
  }
  if (organization.namespacePlanRefusal === null) return null;
  return (
    <p className="text-xs text-on-surface-muted">
      {organization.namespacePlanRefusal}.{" "}
      <a
        href={`${appUrl}/org/${encodeURIComponent(organization.id)}/settings/billing`}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1 text-on-surface-secondary underline"
      >
        Open billing
        <Icon name="externalLink" size={11} />
      </a>
    </p>
  );
}

function OrganisationRow({
  organization,
  appUrl,
}: {
  organization: SessionOrganization;
  appUrl: string;
}) {
  const slug = organization.namespace;
  return (
    <li className="space-y-2.5 px-3 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <Avatar name={organization.name} src={null} size={24} square />
          <div className="min-w-0">
            <div className="truncate text-xs font-medium text-on-surface">{organization.name}</div>
            {slug !== null ? (
              <AppLink
                href={paths.namespace(slug)}
                className="text-xs text-on-surface-secondary hover:underline"
              >
                {SITE_HOST}/{slug}
              </AppLink>
            ) : organization.canClaimNamespace ? null : (
              <Unclaimable organization={organization} appUrl={appUrl} />
            )}
          </div>
        </div>
        {slug !== null && organization.permissions.includes("git:write") ? (
          <ButtonLink size="sm" href={paths.newRepository(slug)}>
            <Icon name="plus" size={12} />
            Create a repository
          </ButtonLink>
        ) : null}
      </div>
      {organization.canClaimNamespace ? <ClaimForm organization={organization} /> : null}
    </li>
  );
}

export function OrganisationsPage() {
  const session = useSession();
  if (session.data === undefined) return <Loading shape="rows" count={3} />;
  if (session.data.user === null) return null;
  const organizations = session.data.organizations;
  return (
    <SettingsSection title="Organisations">
      <Panel className="max-w-2xl">
        {organizations.length === 0 ? (
          <EmptyState
            action={
              <a
                href={session.data.appUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs text-on-surface-secondary hover:underline"
              >
                Open Infrawrench
                <Icon name="externalLink" size={11} />
              </a>
            }
          >
            You are not in an organisation
          </EmptyState>
        ) : (
          <ul aria-label="Organisations" className="divide-y divide-border">
            {organizations.map((organization) => (
              <OrganisationRow
                key={organization.id}
                organization={organization}
                appUrl={session.data.appUrl}
              />
            ))}
          </ul>
        )}
      </Panel>
    </SettingsSection>
  );
}
