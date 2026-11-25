import { useQuery } from "@tanstack/react-query";
import { queries } from "../../api/queries";
import { AppLink } from "../../components/AppLink";
import { Badge } from "../../components/Badge";
import { ButtonLink, buttonClass } from "../../components/Button";
import { Icon } from "../../components/icons";
import { Panel } from "../../components/Panel";
import { SettingsRow, SettingsSection } from "../../components/SideNav";
import { EmptyState, QueryView } from "../../components/states";
import { useRepoRef, useRepository } from "../../layout/RepoLayout";
import { paths } from "../../lib/paths";

/**
 * CI for the repository. Whether it runs is decided by the owner's plan (the
 * API has no switch per repository), and secrets, variables and approvals
 * live in the app, so this page says what is so and links there.
 */
export function CiSettingsPage() {
  const repo = useRepoRef();
  const repository = useRepository();
  const ci = useQuery(queries.ci.status({ params: repo }));
  const namespace = useQuery(queries.namespaces.get({ params: { namespace: repo.owner } }));
  const appUrl = namespace.data?.appUrl ?? null;
  const external = (label: string) =>
    appUrl === null ? null : (
      <a href={appUrl} target="_blank" rel="noreferrer" className={buttonClass("secondary", "sm")}>
        {label}
        <Icon name="externalLink" size={11} />
      </a>
    );

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
                <Badge tone={state.enabled ? "success" : "neutral"}>
                  {state.enabled ? "On" : "Off"}
                </Badge>
              </SettingsRow>
              <SettingsRow title="Secrets and variables">
                {external("Open in Infrawrench") ?? (
                  <span className="text-xs text-on-surface-muted">Organisations only</span>
                )}
              </SettingsRow>
              <SettingsRow title="Approvals for pull requests from forks">
                {external("Open in Infrawrench") ?? (
                  <span className="text-xs text-on-surface-muted">Organisations only</span>
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
