/**
 * First sign-in: pick the username that becomes the person's namespace, and
 * the organisation their own repositories run CI and review agents in.
 * Someone who belongs to none is offered a workspace to run them in
 * (`workspace-offer.tsx`), or goes on without.
 */
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  NAME_MAX_LENGTH,
  SITE_ORIGIN,
  nameProblemMessage,
  namespaceSlugProblem,
  usernamePriceCents,
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
import { UsernameCheckoutNotice, priceLabel } from "./username-checkout";
import {
  WORKSPACE_CONTINUE,
  WORKSPACE_LINE,
  WorkspaceCheckoutNotice,
  WorkspaceNameField,
  defaultWorkspaceName,
  keptWorkspaceName,
  useWorkspaceCheckout,
  workspaceNameError,
} from "./workspace-offer";

/** Only a path on this site: `returnTo` comes from the URL. */
const safeReturn = (returnTo: string | undefined): string => sitePath(returnTo) ?? paths.home();

export function UsernamePage({
  returnTo,
  returned,
  workspace,
  chosen,
}: {
  returnTo?: string | undefined;
  /** Set when the browser came back from paying for a username: how (`?checkout=`). */
  returned?: string | undefined;
  /** Set when the browser came back from paying for a workspace: how (`?workspace=`). */
  workspace?: string | undefined;
  /** The username they had chosen before they left to pay for a workspace (`?username=`). */
  chosen?: string | undefined;
}) {
  const session = useSession();
  const go = useGo();
  const suggested = chosen ?? session.data?.onboarding?.suggestedUsername ?? "";
  const [username, setUsername] = useState<string | null>(null);
  const value = username ?? suggested;
  const organizations = session.data?.organizations ?? [];
  // Asked only of someone with an organisation to name; null until they say.
  const [chosenRunsIn, setRunsIn] = useState<string | null>(null);
  // Back from paying for a workspace, it is the one they have: that is what it is for.
  const theirWorkspace =
    workspace === "return" && organizations.length === 1 ? organizations[0]!.id : null;
  const runsIn = chosenRunsIn ?? preselectedRunsIn(organizations) ?? theirWorkspace;

  // Offered to someone in no organisation; the name as they left it, if they are back.
  const [typedWorkspaceName, setWorkspaceName] = useState<string | null>(() => keptWorkspaceName());
  const workspaceName = typedWorkspaceName ?? defaultWorkspaceName(session.data?.user?.displayName);

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

  // A short username is paid for: the name is kept for them and the browser
  // goes to the payment page, which sends it back here.
  const checkout = useMutation({
    mutationFn: () =>
      api.session.startUsernameCheckout({
        payload: {
          username: value,
          workspaceOrganizationId: runsIn === null ? null : runsInOrganizationId(runsIn),
          ...(returnTo === undefined ? {} : { returnTo }),
        },
      }),
    onSuccess: ({ checkoutUrl }) => go(checkoutUrl),
  });

  // A workspace is paid for too, on the same kind of page; the browser comes
  // back here with the username they chose, and the organisation is theirs.
  const workspaceCheckout = useWorkspaceCheckout({
    from: "onboarding",
    username: problem === null ? value : "",
    returnTo,
  });

  // Back with a workspace and the username they had chosen: nothing is left
  // to ask, so the page finishes by itself. A username that is paid for, or
  // one they have changed since, waits for them.
  const finishes =
    workspace === "return" &&
    chosen !== undefined &&
    (username === null || username === chosen) &&
    session.data?.user != null &&
    session.data.user.username === null &&
    theirWorkspace !== null &&
    runsIn === theirWorkspace &&
    problem === null &&
    usernamePriceCents(value) === null;
  const finished = useRef(false);
  const { mutate: claimNow } = claim;
  useEffect(() => {
    if (!finishes || finished.current) return;
    finished.current = true;
    claimNow();
  }, [finishes, claimNow]);

  // Once the name is claimed, refreshing the session also asks again whether
  // the name is free, and the answer (taken, by this person) would flash
  // before the page moves on.
  if (session.data === undefined || claim.isSuccess || (finishes && !claim.isError))
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
  const offered = organizations.length === 0;
  const unanswered = !offered && runsIn === null;
  // The server's price once it has answered; the rule itself until then.
  const price =
    value === "" || problem !== null
      ? null
      : checked
        ? checked.priceCents
        : usernamePriceCents(value);
  const reset = () => {
    if (claim.error) claim.reset();
    if (checkout.error) checkout.reset();
    if (workspaceCheckout.error) workspaceCheckout.reset();
  };
  const usernameRefused = value === "" || problem !== null || checked?.available === false;
  const busy =
    claim.isPending ||
    checkout.isPending ||
    checkout.isSuccess ||
    workspaceCheckout.isPending ||
    workspaceCheckout.isSuccess;

  /** With the username alone, in the organisation chosen or in none. */
  const goOn = () => {
    if (usernameRefused || unanswered) return;
    if (price === null) claim.mutate();
    else checkout.mutate();
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!offered) return goOn();
    if (usernameRefused || workspaceName.trim() === "" || workspaceNameError(workspaceName)) return;
    workspaceCheckout.mutate(workspaceName);
  };

  return (
    <Page width="narrow">
      <PageHeader title="Choose a username" />
      {returned === undefined ? null : <UsernameCheckoutNotice state={returned} />}
      {workspace === undefined ? null : <WorkspaceCheckoutNotice state={workspace} />}
      <form onSubmit={submit} noValidate className="space-y-4">
        <Field
          label="Username"
          error={error}
          hint={
            available ? (
              <span className="inline-flex items-center gap-2">
                <span className="inline-flex items-center gap-1 text-success">
                  <Icon name="check" size={12} />
                  Available
                </span>
                {price === null ? null : <span>{priceLabel(price)}, paid once</span>}
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
                reset();
              }}
            />
          )}
        </Field>
        {offered ? (
          <section aria-labelledby="workspace-offer" className="space-y-2">
            <div>
              <h2 id="workspace-offer" className="text-xs font-medium text-on-surface">
                Set up a workspace
              </h2>
              <p className="text-xs text-on-surface-muted">{WORKSPACE_LINE}</p>
            </div>
            <WorkspaceNameField
              value={workspaceName}
              onChange={(next) => {
                setWorkspaceName(next);
                reset();
              }}
            />
          </section>
        ) : (
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
                  reset();
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
        )}
        <InlineError error={claim.error ?? checkout.error ?? workspaceCheckout.error} />
        {offered ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="submit"
              variant="primary"
              busy={workspaceCheckout.isPending || workspaceCheckout.isSuccess}
              disabled={
                busy ||
                usernameRefused ||
                workspaceName.trim() === "" ||
                workspaceNameError(workspaceName) !== null
              }
            >
              {WORKSPACE_CONTINUE}
            </Button>
            {/* Without a workspace: the username alone, running nowhere. */}
            <Button
              type="button"
              busy={claim.isPending || checkout.isPending || checkout.isSuccess}
              disabled={busy || usernameRefused}
              onClick={goOn}
            >
              Not now
            </Button>
          </div>
        ) : (
          <Button
            type="submit"
            variant="primary"
            busy={busy}
            disabled={usernameRefused || unanswered}
          >
            {price === null ? "Continue" : `Continue to payment (${priceLabel(price)})`}
          </Button>
        )}
      </form>
    </Page>
  );
}
