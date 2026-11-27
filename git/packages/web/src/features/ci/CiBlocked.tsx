import type { CiRepositoryStatus } from "@infrawrench/git-contract";
import { ButtonLink, buttonClass } from "../../components/Button";
import { Icon } from "../../components/icons";
import { EmptyState } from "../../components/states";
import { paths } from "../../lib/paths";

/** What a repository's CI status says when CI does not run, as this page reads it. */
export type CiBlockedState = Pick<CiRepositoryStatus, "reason" | "code" | "upgradeUrl">;

/** Whether the plan is why CI does not run: the pages that would show runs ask before they show none. */
export const planBlocks = (state: CiBlockedState | undefined): boolean =>
  state?.code === "plan_required";

/**
 * Why CI does not run for the repository, and the way out where there is
 * one: an upgrade in the app for a member of the organisation it runs in,
 * and Settings > Profile for someone whose own namespace runs in none. The
 * forge links out; billing is the app's.
 */
export function CiBlocked({
  state,
  ownNamespace,
  className,
}: {
  state: CiBlockedState;
  /** The repository is in the reader's own namespace, so the choice in Settings > Profile is theirs. */
  ownNamespace: boolean;
  className?: string;
}) {
  if (state.code === "plan_required") {
    return (
      <EmptyState
        {...(className === undefined ? {} : { className })}
        action={
          state.upgradeUrl === null ? (
            <p className="text-xs text-on-surface-muted">
              Someone who manages billing in its organisation can upgrade
            </p>
          ) : (
            <a
              href={state.upgradeUrl}
              target="_blank"
              rel="noreferrer"
              className={buttonClass("primary", "md")}
            >
              Upgrade to Pro
              <Icon name="externalLink" size={11} />
            </a>
          )
        }
      >
        Infrawrench CI is part of Pro
      </EmptyState>
    );
  }
  return (
    <EmptyState
      {...(className === undefined ? {} : { className })}
      action={
        state.code === "needs_organisation" && ownNamespace ? (
          <ButtonLink href={paths.settings()}>Choose an organisation</ButtonLink>
        ) : undefined
      }
    >
      {state.reason ?? "CI is not available for this repository"}
    </EmptyState>
  );
}
