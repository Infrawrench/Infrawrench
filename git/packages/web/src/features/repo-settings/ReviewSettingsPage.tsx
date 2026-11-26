import { useMutation, useQuery } from "@tanstack/react-query";
import type { ReviewSettingsUpdate } from "@infrawrench/git-contract";
import { api } from "../../api/client";
import { queries, queryClient } from "../../api/queries";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { Checkbox } from "../../components/forms";
import { Panel } from "../../components/Panel";
import { SettingsRow, SettingsSection } from "../../components/SideNav";
import { InlineError, QueryView } from "../../components/states";
import { useRepoRef, useRepository } from "../../layout/RepoLayout";

/** What the forge's own reviewers are called on the page. Any other is shown by its name. */
const REVIEWER_LABEL: Record<string, string> = {
  general: "General",
  security: "Security",
  tests: "Tests",
  terraform: "Terraform",
  intent: "Intent",
};

function Switch({
  on,
  busy,
  disabled,
  label,
  onChange,
}: {
  on: boolean;
  busy: boolean;
  disabled: boolean;
  /** What is switched, for the button's accessible name. */
  label: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <span className="flex flex-wrap items-center gap-2">
      <Badge tone={on ? "success" : "neutral"}>
        <span role="status">{on ? "On" : "Off"}</span>
      </Badge>
      {disabled ? null : (
        <Button
          size="sm"
          busy={busy}
          aria-label={`${on ? "Switch off" : "Switch on"}: ${label}`}
          onClick={() => onChange(!on)}
        >
          {on ? "Switch off" : "Switch on"}
        </Button>
      )}
    </span>
  );
}

/**
 * How a repository's branches are reviewed: whether each gets a page at its
 * first push, whether review agents read each version and which, and
 * whether a must-fix finding holds a merge.
 */
export function ReviewSettingsPage() {
  const repo = useRepoRef();
  const repository = useRepository();
  const query = queries.reviewSettings.get({ params: repo });
  const settings = useQuery(query);
  const change = useMutation({
    mutationFn: (payload: ReviewSettingsUpdate) =>
      api.reviewSettings.update({ params: repo, payload }),
    onSuccess: (saved) => queryClient.setQueryData(query.queryKey, saved),
  });
  const saving = (key: keyof ReviewSettingsUpdate): boolean =>
    change.isPending && change.variables !== undefined && key in change.variables;
  const locked = repository.archived;

  return (
    <QueryView query={settings}>
      {(current) => (
        <>
          <SettingsSection title="Review">
            <Panel className="divide-y divide-border">
              <SettingsRow
                title="Branch pages"
                detail="A draft pull request at a branch's first push"
              >
                <Switch
                  label="Branch pages"
                  on={current.autoOpenBranchPages}
                  busy={saving("autoOpenBranchPages")}
                  disabled={locked}
                  onChange={(next) => change.mutate({ autoOpenBranchPages: next })}
                />
              </SettingsRow>
              <SettingsRow
                title="Must-fix findings block merging"
                detail="Until fixed, dismissed, or overridden by an administrator"
              >
                <Switch
                  label="Must-fix findings block merging"
                  on={current.mustFixBlocksMerge}
                  busy={saving("mustFixBlocksMerge")}
                  disabled={locked}
                  onChange={(next) => change.mutate({ mustFixBlocksMerge: next })}
                />
              </SettingsRow>
              {change.error ? (
                <div className="px-3 py-2">
                  <InlineError error={change.error} />
                </div>
              ) : null}
            </Panel>
          </SettingsSection>
          <SettingsSection title="Review agents">
            <Panel className="divide-y divide-border">
              <SettingsRow title="Review each version">
                <Switch
                  label="Review agents"
                  on={current.reviewAgentsEnabled}
                  busy={saving("reviewAgentsEnabled")}
                  disabled={locked}
                  onChange={(next) => change.mutate({ reviewAgentsEnabled: next })}
                />
              </SettingsRow>
              <fieldset
                disabled={locked || !current.reviewAgentsEnabled || change.isPending}
                className="px-3 py-2.5 disabled:opacity-60"
              >
                <legend className="sr-only">Reviewers</legend>
                <p aria-hidden="true" className="mb-2 text-xs font-medium text-on-surface">
                  Reviewers
                </p>
                <ul className="grid gap-2 sm:grid-cols-3">
                  {[...new Set([...current.availableReviewerKinds, ...current.reviewerKinds])].map(
                    (kind) => (
                      <li key={kind}>
                        <Checkbox
                          label={REVIEWER_LABEL[kind] ?? kind}
                          checked={current.reviewerKinds.includes(kind)}
                          onChange={(event) =>
                            change.mutate({
                              reviewerKinds: event.target.checked
                                ? [...current.reviewerKinds, kind]
                                : current.reviewerKinds.filter((item) => item !== kind),
                            })
                          }
                        />
                      </li>
                    ),
                  )}
                </ul>
              </fieldset>
            </Panel>
          </SettingsSection>
        </>
      )}
    </QueryView>
  );
}
