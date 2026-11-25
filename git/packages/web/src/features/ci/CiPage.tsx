import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { CI_RUN_STATUSES, type CiRun, type CiRunStatus } from "@infrawrench/git-contract";
import { api } from "../../api/client";
import { invalidate, queries, usePages } from "../../api/queries";
import { AppLink, useGo } from "../../components/AppLink";
import { ButtonLink } from "../../components/Button";
import { Icon } from "../../components/icons";
import { Page, PageHeader, Panel, PanelHeader } from "../../components/Panel";
import { Picker, PickerButton } from "../../components/Picker";
import { EmptyState, ErrorState, Loading, LoadMore, QueryView } from "../../components/states";
import { CiStatusIcon, ciStatusLabel } from "../../components/StatusIcons";
import { useRepoRef, useRepository } from "../../layout/RepoLayout";
import { paths } from "../../lib/paths";
import { RunRow, isActive } from "./RunRow";
import { cursorQuery } from "../../lib/cursor";

const isStatus = (value: string | undefined): value is CiRunStatus =>
  value !== undefined && (CI_RUN_STATUSES as ReadonlyArray<string>).includes(value);

export function CiPage({
  branch,
  status,
}: {
  branch: string | undefined;
  status: string | undefined;
}) {
  const repo = useRepoRef();
  const repository = useRepository();
  const go = useGo();
  const wanted = isStatus(status) ? status : undefined;
  const ci = useQuery(queries.ci.status({ params: repo }));
  const refs = useQuery({
    ...queries.contents.listRefs({ params: repo, query: { limit: 100 } }),
    enabled: !repository.isEmpty,
  });
  const filter = {
    ...(branch === undefined ? {} : { ref: branch }),
    ...(wanted === undefined ? {} : { status: wanted }),
  };
  const runs = usePages(["ci", "listRuns", repo, filter], (cursor) =>
    api.ci.listRuns({ params: repo, query: { ...filter, ...cursorQuery(cursor), limit: 25 } }),
  );

  // Runs in progress change on their own: ask again while any is.
  const anyActive = runs.items.some(isActive);
  useEffect(() => {
    if (!anyActive) return;
    const timer = setInterval(() => void invalidate("ci", "listRuns"), 5000);
    return () => clearInterval(timer);
  }, [anyActive]);

  const href = (next: { branch?: string | undefined; status?: string | undefined }) =>
    paths.ciRuns(repo, {
      ...(next.branch === undefined ? {} : { branch: next.branch }),
      ...(next.status === undefined ? {} : { status: next.status }),
    });
  const filtered = branch !== undefined || wanted !== undefined;

  return (
    <Page>
      <PageHeader title="CI" />
      <QueryView query={ci}>
        {(state) =>
          !state.enabled ? (
            <Panel>
              <EmptyState>{state.reason ?? "CI is not available for this repository"}</EmptyState>
            </Panel>
          ) : (
            <div className="space-y-3">
              {state.pipelines.length > 0 ? (
                <ul aria-label="Pipelines" className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                  {state.pipelines.map((pipeline) => (
                    <li key={pipeline.file} className="inline-flex items-center gap-1.5">
                      <Icon name="listChecks" size={12} className="text-on-surface-muted" />
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
              ) : null}
              <Panel className="overflow-visible">
                <PanelHeader
                  className="rounded-t-md"
                  actions={
                    <>
                      <Picker
                        label="Branches"
                        align="end"
                        options={(refs.data?.branches ?? []).map((item) => ({
                          value: item.name,
                          label: item.name,
                        }))}
                        selected={branch === undefined ? [] : [branch]}
                        onChange={([next]) => go(href({ branch: next, status: wanted }))}
                        loading={refs.isLoading}
                        emptyText="No branches match"
                        trigger={({ props }) => (
                          <PickerButton {...props} active={branch !== undefined}>
                            <Icon name="gitBranch" size={12} />
                            {branch ?? "Branch"}
                          </PickerButton>
                        )}
                      />
                      <Picker
                        label="Status"
                        align="end"
                        filterable={false}
                        options={CI_RUN_STATUSES.map((value) => ({
                          value,
                          label: ciStatusLabel(value),
                          leading: <CiStatusIcon status={value} size={12} />,
                        }))}
                        selected={wanted === undefined ? [] : [wanted]}
                        onChange={([next]) => go(href({ branch, status: next }))}
                        trigger={({ props }) => (
                          <PickerButton {...props} active={wanted !== undefined}>
                            {wanted === undefined ? "Status" : ciStatusLabel(wanted)}
                          </PickerButton>
                        )}
                      />
                    </>
                  }
                >
                  Runs
                  {filtered ? (
                    <AppLink
                      href={paths.ci(repo)}
                      className="inline-flex items-center gap-1 hover:text-on-surface"
                    >
                      <Icon name="x" size={11} />
                      Clear filters
                    </AppLink>
                  ) : null}
                </PanelHeader>
                {runs.error ? (
                  <ErrorState error={runs.error} />
                ) : runs.isLoading ? (
                  <Loading />
                ) : runs.items.length === 0 ? (
                  <EmptyState
                    action={
                      filtered ? (
                        <ButtonLink href={paths.ci(repo)}>Clear filters</ButtonLink>
                      ) : undefined
                    }
                  >
                    {filtered
                      ? "No runs match"
                      : state.pipelines.length === 0
                        ? "No pipelines in .infrawrench/ci on the default branch"
                        : "No runs yet"}
                  </EmptyState>
                ) : (
                  <ul aria-label="Runs">
                    {runs.items.map((run) => (
                      <RunRow key={run.id} run={run} repo={repo} />
                    ))}
                  </ul>
                )}
              </Panel>
              <LoadMore pages={runs} />
            </div>
          )
        }
      </QueryView>
    </Page>
  );
}
