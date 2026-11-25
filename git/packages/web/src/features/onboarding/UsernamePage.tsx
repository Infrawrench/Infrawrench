/** First sign-in: pick the username that becomes the person's namespace. */
import { useEffect, useState, type FormEvent } from "react";
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
import { Field, Input } from "../../components/forms";
import { Icon } from "../../components/icons";
import { Page, PageHeader } from "../../components/Panel";
import { EmptyState, InlineError, Loading } from "../../components/states";
import { paths } from "../../lib/paths";
import { signInHref, useSession } from "../../lib/session";

/** `value`, a moment after it stops changing. */
function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/** Only a path on this site: `returnTo` comes from the URL. */
const safeReturn = (returnTo: string | undefined): string =>
  returnTo !== undefined && returnTo.startsWith("/") && !returnTo.startsWith("//")
    ? returnTo
    : paths.home();

export function UsernamePage({ returnTo }: { returnTo?: string | undefined }) {
  const session = useSession();
  const go = useGo();
  const suggested = session.data?.onboarding?.suggestedUsername ?? "";
  const [username, setUsername] = useState<string | null>(null);
  const value = username ?? suggested;

  const problem = namespaceSlugProblem(value);
  const settled = useDebounced(value, 300);
  const availability = useQuery({
    ...queries.session.usernameAvailability({ query: { username: settled } }),
    enabled: settled !== "" && namespaceSlugProblem(settled) === null,
    staleTime: 10_000,
  });
  const checked = availability.data?.username === value ? availability.data : undefined;

  const claim = useMutation({
    mutationFn: () => api.session.claimUsername({ payload: { username: value } }),
    onSuccess: async () => {
      await invalidate("session");
      go(safeReturn(returnTo), { replace: true });
    },
  });

  if (session.data === undefined) return <Loading />;
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

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (problem === null && checked?.available !== false) claim.mutate();
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
        <InlineError error={claim.error} />
        <Button
          type="submit"
          variant="primary"
          busy={claim.isPending}
          disabled={value === "" || problem !== null || checked?.available === false}
        >
          Continue
        </Button>
      </form>
    </Page>
  );
}
