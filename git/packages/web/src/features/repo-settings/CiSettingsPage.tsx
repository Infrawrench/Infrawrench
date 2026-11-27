import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "../../api/client";
import { invalidate, queries } from "../../api/queries";
import { AppLink } from "../../components/AppLink";
import { Badge } from "../../components/Badge";
import { Button, ButtonLink, buttonClass } from "../../components/Button";
import { Icon } from "../../components/icons";
import { Panel } from "../../components/Panel";
import { SettingsRow, SettingsSection } from "../../components/SideNav";
import { EmptyState, InlineError, QueryView } from "../../components/states";
import { useRepoRef, useRepository } from "../../layout/RepoLayout";
import { paths } from "../../lib/paths";

/**
 * CI for the repository: its own switch, which its administrators hold, and
 * what the default branch's pipelines are. Whether runs start also follows
 * the plan of the organisation it runs in, which `ci.status` answers.
 * Secrets, variables and approvals live in the app, in that organisation:
 * the one that owns the repository, or the one its owner connected their
 * own namespace to (`ci.settings` `appUrl`).
 */
export function CiSettingsPage() {
  const repo = useRepoRef();
  const repository = useRepository();
  const ci = useQuery(queries.ci.status({ params: repo }));
  const settings = useQuery(queries.ci.settings({ params: repo }));
  const change = useMutation({
    mutationFn: (enabled: boolean) => api.ci.updateSettings({ params: repo, payload: { enabled } }),
    onSuccess: () => invalidate("ci"),
  });
  const appUrl = settings.data?.appUrl ?? null;
  const external = (label: string) =>
    appUrl === null ? null : (
      <a href={appUrl} target="_blank" rel="noreferrer" className={buttonClass("secondary", "sm")}>
        {label}
        <Icon name="externalLink" size={11} />
      </a>
    );
  const switchState = settings.data;

  return (
    <QueryView query={ci}>
      {(state) => (
        <>
          <SettingsSection
            title="CI"
            actions={
              <ButtonLink size="sm" href={paths.ci(repo)}>
                Runs
              </ButtonLink>
            }
          >
            <Panel className="divide-y divide-border">
              <SettingsRow title="Infrawrench CI" detail={state.enabled ? undefined : state.reason}>
                <span className="flex flex-wrap items-center gap-2">
                  <Badge tone={state.enabled ? "success" : "neutral"}>
                    <span role="status">{state.enabled ? "On" : "Off"}</span>
                  </Badge>
                  {switchState?.available === true && !repository.archived ? (
                    <Button
                      size="sm"
                      busy={change.isPending}
                      onClick={() => change.mutate(!switchState.enabled)}
                    >
                      {switchState.enabled ? "Switch off" : "Switch on"}
                    </Button>
                  ) : null}
                </span>
              </SettingsRow>
              {change.error ? (
                <div className="px-3 py-2">
                  <InlineError error={change.error} />
                </div>
              ) : null}
              <SettingsRow title="Secrets and variables">
                {external("Open in Infrawrench") ?? (
                  <span className="text-xs text-on-surface-muted">In an organisation</span>
                )}
              </SettingsRow>
              <SettingsRow title="Approvals for branches from forks">
                {external("Open in Infrawrench") ?? (
                  <span className="text-xs text-on-surface-muted">In an organisation</span>
                )}
              </SettingsRow>
            </Panel>
          </SettingsSection>
          <SettingsSection title="Pipelines">
            <Panel>
              {state.pipelines.length === 0 ? (
                <EmptyState>No pipelines in .infrawrench/ci on the default branch</EmptyState>
              ) : (
                <ul>
                  {state.pipelines.map((pipeline) => (
                    <li
                      key={pipeline.file}
                      className="flex flex-wrap items-center gap-3 border-t border-border px-3 py-2 text-xs first:border-t-0"
                    >
                      <Icon name="listChecks" size={13} className="text-on-surface-muted" />
                      <span className="font-medium text-on-surface">{pipeline.name}</span>
                      <AppLink
                        href={paths.blob(repo, repository.defaultBranch, pipeline.file)}
                        className="font-mono text-[11px] text-on-surface-muted hover:underline"
                      >
                        {pipeline.file}
                      </AppLink>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </SettingsSection>
        </>
      )}
    </QueryView>
  );
}
