/**
 * First sign-in: pick the username that becomes the person's namespace, and
 * the organisation their own repositories run CI and review agents in.
 */
import { useState, type FormEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  NAME_MAX_LENGTH,
  SITE_ORIGIN,
  nameProblemMessage,
  namespaceSlugProblem,
} from "@infrawrench/git-contract";
import { api } from "../../api/client";
import { invalidate, queries } from "../../api/queries";
import { useGo } from "../../components/AppLink";
import { Button, buttonClass } from "../../components/Button";
import { Field, Input, Select } from "../../components/forms";
import { Icon } from "../../components/icons";
import { Page, PageHeader } from "../../components/Panel";
import { EmptyState, InlineError, Loading } from "../../components/states";
import { useDebounced } from "../../lib/name-availability";
import { paths } from "../../lib/paths";
import {
  RUNS_IN_NONE,
  preselectedRunsIn,
  runsInHint,
  runsInOrganizationId,
} from "../../lib/runs-in";
import { sitePath } from "../../lib/safe-url";
import { signInHref, useSession } from "../../lib/session";

/** Only a path on this site: `returnTo` comes from the URL. */
const safeReturn = (returnTo: string | undefined): string => sitePath(returnTo) ?? paths.home();

export function UsernamePage({ returnTo }: { returnTo?: string | undefined }) {
  const session = useSession();
  const go = useGo();
  const suggested = session.data?.onboarding?.suggestedUsername ?? "";
  const [username, setUsername] = useState<string | null>(null);
  const value = username ?? suggested;
  const organizations = session.data?.organizations ?? [];
  // Asked only of someone with an organisation to name; null until they say.
  const [chosenRunsIn, setRunsIn] = useState<string | null>(null);
  const runsIn = chosenRunsIn ?? preselectedRunsIn(organizations);

  const problem = namespaceSlugProblem(value);
  const settled = useDebounced(value, 300);
  const availability = useQuery({
    ...queries.session.usernameAvailability({ query: { username: settled } }),
    enabled: settled !== "" && namespaceSlugProblem(settled) === null,
    staleTime: 10_000,
  });
  const checked = availability.data?.username === value ? availability.data : undefined;

  const claim = useMutation({
    mutationFn: () =>
      api.session.claimUsername({
        payload: {
          username: value,
          workspaceOrganizationId: runsIn === null ? null : runsInOrganizationId(runsIn),
        },
      }),
    onSuccess: async () => {
      await invalidate("session");
      go(safeReturn(returnTo), { replace: true });
    },
  });

  // Once the name is claimed, refreshing the session also asks again whether
  // the name is free, and the answer (taken, by this person) would flash
  // before the page moves on.
  if (session.data === undefined || claim.isSuccess)
    return <Loading shape="page" width="narrow" count={2} />;
  if (session.data.user === null) {
    return (
      <Page width="narrow">
        <EmptyState
          action={
            <a href={signInHref()} className={buttonClass("primary")}>
              Sign in
            </a>
          }
        >
          Sign in to pick a username
        </EmptyState>
      </Page>
    );
  }
  const current = session.data.user.username;
  if (current !== null) {
    return (
      <Page width="narrow">
        <EmptyState action={<Button onClick={() => go(safeReturn(returnTo))}>Continue</Button>}>
          Your username is {current}
        </EmptyState>
      </Page>
    );
  }

  const error =
    value === ""
      ? null
      : problem !== null
        ? nameProblemMessage(problem, NAME_MAX_LENGTH)
        : checked?.available === false
          ? checked.message
          : null;
  const available = problem === null && checked?.available === true;
  const unanswered = organizations.length > 0 && runsIn === null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (problem === null && checked?.available !== false && !unanswered) claim.mutate();
  };

  return (
    <Page width="narrow">
      <PageHeader title="Choose a username" />
      <form onSubmit={submit} noValidate className="space-y-4">
        <Field
          label="Username"
          error={error}
          hint={
            available ? (
              <span className="inline-flex items-center gap-1 text-success">
                <Icon name="check" size={12} />
                Available
              </span>
            ) : (
              `${SITE_ORIGIN.replace(/^https?:\/\//, "")}/${value === "" ? "username" : value}`
            )
          }
        >
          {(control) => (
            <Input
              {...control}
              required
              autoFocus
              autoComplete="username"
              spellCheck={false}
              maxLength={NAME_MAX_LENGTH}
              value={value}
              onChange={(event) => {
                setUsername(event.target.value);
                if (claim.error) claim.reset();
              }}
            />
          )}
        </Field>
        {organizations.length > 0 ? (
          <Field
            label="Run CI and review agents in"
            hint={runsInHint(organizations, runsIn) ?? undefined}
          >
            {(control) => (
              <Select
                {...control}
                required
                value={runsIn ?? ""}
                onChange={(event) => {
                  setRunsIn(event.target.value);
                  if (claim.error) claim.reset();
                }}
              >
                <option value="" disabled>
                  Choose an organisation
                </option>
                {organizations.map((organization) => (
                  <option key={organization.id} value={organization.id}>
                    {organization.name}
                  </option>
                ))}
                <option value={RUNS_IN_NONE}>None</option>
              </Select>
            )}
          </Field>
        ) : null}
        <InlineError error={claim.error} />
        <Button
          type="submit"
          variant="primary"
          busy={claim.isPending}
          disabled={value === "" || problem !== null || checked?.available === false || unanswered}
        >
          Continue
        </Button>
      </form>
    </Page>
  );
}
