/**
 * Setting up a workspace: an Infrawrench organisation on the Pro plan,
 * offered to someone who belongs to none, on the username page and in
 * Settings > Organisations. The person names it here and pays on Stripe's
 * page; they never see the app. The organisation exists once the payment is
 * complete, and the browser comes back to the page that asked.
 */
import { useEffect, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  WORKSPACE_NAME_MAX_LENGTH,
  WORKSPACE_PRICE_LABEL,
  workspaceNameProblem,
} from "@infrawrench/git-contract";
import { api } from "../../api/client";
import { invalidate } from "../../api/queries";
import { useGo } from "../../components/AppLink";
import { Field, Input } from "../../components/forms";

/** What the offer says of itself, and all it says. */
export const WORKSPACE_LINE = `CI and review agents run in it. Pro, ${WORKSPACE_PRICE_LABEL}.`;

/** The button that goes to the payment page. */
export const WORKSPACE_CONTINUE = `Continue to payment (${WORKSPACE_PRICE_LABEL})`;

/** What the name starts as: the person's own, when they have given one. */
export const defaultWorkspaceName = (displayName: string | null | undefined): string => {
  const name = displayName?.trim() ?? "";
  if (name === "") return "";
  const suggested = `${name}'s workspace`;
  return suggested.length <= WORKSPACE_NAME_MAX_LENGTH ? suggested : "";
};

/** Why the name as typed cannot be sent, or null. Spaces around it are not the person's problem. */
export const workspaceNameError = (name: string): string | null =>
  name === "" ? null : workspaceNameProblem(name.trim());

/*
 * The name typed, kept across the trip to the payment page, so someone who
 * comes back without paying finds it as they left it. Only in this tab, and
 * forgotten once it has been used.
 */
const KEPT_NAME = "git-workspace-name";

export function keptWorkspaceName(): string | null {
  try {
    return sessionStorage.getItem(KEPT_NAME);
  } catch {
    // No storage (a private window): the name starts as it would have.
    return null;
  }
}

function keepWorkspaceName(name: string | null): void {
  try {
    if (name === null) sessionStorage.removeItem(KEPT_NAME);
    else sessionStorage.setItem(KEPT_NAME, name);
  } catch {
    // Not kept, which is all storage was for.
  }
}

/** Send the browser to pay for a workspace named `name`, from the page that asks. */
export function useWorkspaceCheckout(
  page:
    | { readonly from: "settings" }
    | {
        readonly from: "onboarding";
        readonly username: string;
        readonly returnTo: string | undefined;
      },
) {
  const go = useGo();
  return useMutation({
    mutationFn: (name: string) => {
      keepWorkspaceName(name);
      return api.session.startWorkspaceCheckout({
        payload:
          page.from === "settings"
            ? { name: name.trim(), from: "settings" }
            : {
                name: name.trim(),
                from: "onboarding",
                ...(page.username === "" ? {} : { username: page.username }),
                ...(page.returnTo === undefined ? {} : { returnTo: page.returnTo }),
              },
      });
    },
    onSuccess: ({ checkoutUrl }) => go(checkoutUrl),
  });
}

export function WorkspaceNameField({
  value,
  onChange,
  children,
}: {
  value: string;
  onChange: (value: string) => void;
  /** The control, to put something beside it. */
  children?: (input: ReactNode) => ReactNode;
}) {
  return (
    <Field label="Organisation name" error={workspaceNameError(value)}>
      {(control) => {
        const input = (
          <Input
            {...control}
            autoComplete="organization"
            maxLength={WORKSPACE_NAME_MAX_LENGTH}
            value={value}
            onChange={(event) => onChange(event.target.value)}
          />
        );
        return children ? children(input) : input;
      }}
    </Field>
  );
}

/**
 * Shown on the page the app sends the browser back to, with the `?workspace=`
 * it added. A workspace that was paid for needs no words (the page shows the
 * organisation), and neither does leaving the payment page.
 */
export function WorkspaceCheckoutNotice({ state }: { state: string }) {
  // Whatever the page knew of the person before they left to pay is stale.
  useEffect(() => {
    void invalidate("session");
    void invalidate("namespaces");
    // The name has done its work once the organisation exists.
    if (state === "return") keepWorkspaceName(null);
  }, [state]);
  const message =
    state === "unavailable"
      ? "Payments are not available right now. Nothing was charged."
      : state === "expired"
        ? "The payment page expired before it was opened. Nothing was charged."
        : state === "failed"
          ? "Your payment went through, but the workspace could not be created. Write to astrid@infrawrench.com and we will put it right."
          : null;
  if (message === null) return null;
  return (
    <p
      role="status"
      className="mb-4 rounded border border-border px-3 py-2 text-xs text-on-surface"
    >
      {message}
    </p>
  );
}
