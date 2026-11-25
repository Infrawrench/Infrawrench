/** `base...head`: what head has that base does not, as commits and a diff, and the way into a pull request. */
import { useQuery } from "@tanstack/react-query";
import { api } from "../../api/client";
import { queries } from "../../api/queries";
import { AppLink, useGo } from "../../components/AppLink";
import { Badge } from "../../components/Badge";
import { ButtonLink } from "../../components/Button";
import { Icon } from "../../components/icons";
import { Page, PageHeader, Panel, PanelHeader } from "../../components/Panel";
import { RefPicker } from "../../components/RefPicker";
import { EmptyState, QueryView } from "../../components/states";
import { plural } from "../../lib/format";
import { paths } from "../../lib/paths";
import { useRepoRef, useRepository } from "../../layout/RepoLayout";
import { CommitRow } from "./CommitsPage";
import { DiffSection } from "./DiffSection";

export function ComparePage({ base, head }: { base: string | null; head: string | null }) {
  const repository = useRepository();
  const repo = useRepoRef();
  const go = useGo();
  const baseName = base ?? repository.defaultBranch;
  const headName = head ?? repository.defaultBranch;
  const same = baseName === headName;
  const request = { params: repo, query: { base: baseName, head: headName } };
  const comparison = useQuery({
    ...queries.contents.compare(request),
    enabled: !same && !repository.isEmpty,
  });

  return (
    <Page>
      <PageHeader title="Compare">
        <div className="flex flex-wrap items-center gap-2 text-xs text-on-surface-muted">
          <span>Base</span>
          <RefPicker
            repo={repo}
            value={baseName}
            label="base"
            onSelect={(name) => go(paths.compare(repo, name, headName))}
          />
          <Icon name="gitCompare" />
          <span>Head</span>
          <RefPicker
            repo={repo}
            value={headName}
            label="head"
            onSelect={(name) => go(paths.compare(repo, baseName, name))}
          />
          {same ? null : (
            <AppLink
              href={paths.compare(repo, headName, baseName)}
              className="ml-1 text-on-surface-secondary hover:underline"
            >
              Swap
            </AppLink>
          )}
        </div>
      </PageHeader>

      {repository.isEmpty ? (
        <Panel>
          <EmptyState>Nothing to compare yet</EmptyState>
        </Panel>
      ) : same ? (
        <Panel>
          <EmptyState>Pick two different branches or tags</EmptyState>
        </Panel>
      ) : (
        <QueryView query={comparison}>
          {(data) => (
            <div className="space-y-4">
              <Panel>
                <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-on-surface-secondary">
                    <span>
                      <span className="font-mono font-medium text-on-surface">
                        {data.head.name}
                      </span>{" "}
                      is {plural(data.ahead, "commit")} ahead of and {plural(data.behind, "commit")}{" "}
                      behind{" "}
                      <span className="font-mono font-medium text-on-surface">
                        {data.base.name}
                      </span>
                    </span>
                    {data.mergeBaseOid === null ? (
                      <Badge tone="warning">No common history</Badge>
                    ) : data.mergeable === true ? (
                      <Badge tone="success">
                        <Icon name="check" size={10} />
                        Merges cleanly
                      </Badge>
                    ) : data.mergeable === false ? (
                      <Badge tone="danger">Conflicts</Badge>
                    ) : null}
                  </div>
                  {data.pullRequest !== null ? (
                    <ButtonLink href={paths.pull(repo, data.pullRequest.number)}>
                      <Icon name="gitPullRequest" />
                      View pull request #{data.pullRequest.number}
                    </ButtonLink>
                  ) : data.ahead > 0 &&
                    repository.features.pullRequests &&
                    data.head.kind === "branch" &&
                    data.base.kind === "branch" ? (
                    <ButtonLink
                      variant="primary"
                      href={paths.newPull(repo, { base: data.base.name, head: data.head.name })}
                    >
                      <Icon name="gitPullRequest" />
                      Create pull request
                    </ButtonLink>
                  ) : null}
                </div>
              </Panel>

              {data.ahead === 0 ? (
                <Panel>
                  <EmptyState>
                    {data.base.name} already has everything in {data.head.name}
                  </EmptyState>
                </Panel>
              ) : (
                <>
                  <Panel>
                    <PanelHeader>
                      <Icon name="gitCommit" />
                      <h2 className="font-medium text-on-surface-secondary">
                        {plural(data.commits.length, "commit")}
                        {data.commitsTruncated ? " shown" : ""}
                      </h2>
                    </PanelHeader>
                    <ul className="divide-y divide-border">
                      {data.commits.map((commit) => (
                        <CommitRow key={commit.oid} repo={repo} commit={commit} />
                      ))}
                    </ul>
                  </Panel>
                  <DiffSection
                    repo={repo}
                    queryKey={["contents", "compareDiff", request]}
                    files={data.files}
                    filesTruncated={data.filesTruncated}
                    stats={data.stats}
                    fetchPage={(cursor) =>
                      api.contents.compareDiff({
                        params: repo,
                        query: { ...request.query, ...(cursor === undefined ? {} : { cursor }) },
                      })
                    }
                    fetchFile={async (path) =>
                      (
                        await api.contents.compareDiff({
                          params: repo,
                          query: { ...request.query, path },
                        })
                      ).files[0]
                    }
                  />
                </>
              )}
            </div>
          )}
        </QueryView>
      )}
    </Page>
  );
}
