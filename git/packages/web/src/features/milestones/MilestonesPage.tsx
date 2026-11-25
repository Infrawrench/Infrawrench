import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { queries } from "../../api/queries";
import { AppLink, useGo } from "../../components/AppLink";
import { ButtonLink } from "../../components/Button";
import { Breadcrumbs } from "../../components/controls";
import { Icon } from "../../components/icons";
import { Page, PageHeader, Panel, PanelHeader } from "../../components/Panel";
import { RelativeTime } from "../../components/people";
import { EmptyState, QueryView } from "../../components/states";
import { ThreadStateIcon, issueKind, pullKind } from "../../components/StatusIcons";
import { useRepoRef, useRepository } from "../../layout/RepoLayout";
import { paths } from "../../lib/paths";
import {
  DueDate,
  MilestoneActions,
  MilestoneForm,
  MilestoneProgress,
  MilestonesManager,
} from "./MilestonesManager";

export function MilestonesPage() {
  const repo = useRepoRef();
  return (
    <Page>
      <PageHeader
        title="Milestones"
        actions={
          <>
            <ButtonLink href={paths.issues(repo)}>Issues</ButtonLink>
            <ButtonLink href={paths.labels(repo)}>Labels</ButtonLink>
          </>
        }
      />
      <MilestonesManager />
    </Page>
  );
}

export function MilestonePage({ number }: { number: number }) {
  const repo = useRepoRef();
  const repository = useRepository();
  const go = useGo();
  const [editing, setEditing] = useState(false);
  const milestone = useQuery(queries.milestones.get({ params: { ...repo, milestone: number } }));
  const filter = { milestone: String(number), state: "all" as const, limit: 100 };
  const issues = useQuery(queries.issues.list({ params: repo, query: filter }));
  const pulls = useQuery(queries.pulls.list({ params: repo, query: filter }));

  return (
    <Page>
      <QueryView query={milestone}>
        {(item) => (
          <div className="space-y-4">
            <Breadcrumbs
              label="Milestones"
              crumbs={[
                { label: "Milestones", href: paths.milestones(repo) },
                { label: item.title },
              ]}
            />
            {editing ? (
              <Panel>
                <MilestoneForm milestone={item} onDone={() => setEditing(false)} />
              </Panel>
            ) : (
              <div className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <p className="text-xs text-on-surface-muted">
                    <DueDate milestone={item} />
                  </p>
                  {item.description !== null ? (
                    <p className="text-xs text-on-surface-secondary">{item.description}</p>
                  ) : null}
                </div>
                <div className="space-y-1.5">
                  <MilestoneProgress milestone={item} />
                  {repository.viewer.canTriage ? (
                    <MilestoneActions
                      milestone={item}
                      onEdit={() => setEditing(true)}
                      onDeleted={() => go(paths.milestones(repo))}
                    />
                  ) : null}
                </div>
              </div>
            )}
            <Panel>
              <PanelHeader>Issues and pull requests</PanelHeader>
              {issues.data === undefined || pulls.data === undefined ? (
                <EmptyState>Loading</EmptyState>
              ) : issues.data.items.length + pulls.data.items.length === 0 ? (
                <EmptyState action={<ButtonLink href={paths.issues(repo)}>Issues</ButtonLink>}>
                  Nothing is in this milestone
                </EmptyState>
              ) : (
                <ul>
                  {[
                    ...pulls.data.items.map((row) => ({
                      row,
                      href: paths.pull(repo, row.number),
                      kind: pullKind(row.state, row.draft),
                    })),
                    ...issues.data.items.map((row) => ({
                      row,
                      href: paths.issue(repo, row.number),
                      kind: issueKind(row.state, row.stateReason),
                    })),
                  ]
                    .sort(
                      (a, b) =>
                        Number(a.row.state !== "open") - Number(b.row.state !== "open") ||
                        b.row.number - a.row.number,
                    )
                    .map(({ row, href, kind }) => (
                      <li
                        key={row.id}
                        className="flex items-center gap-2.5 border-t border-border px-3 py-2 first:border-t-0 hover:bg-surface-inset"
                      >
                        <ThreadStateIcon kind={kind} />
                        <AppLink
                          href={href}
                          className="min-w-0 flex-1 truncate text-xs font-medium text-on-surface hover:underline"
                        >
                          {row.title}
                        </AppLink>
                        <span className="shrink-0 text-xs text-on-surface-muted">
                          #{row.number} · updated <RelativeTime iso={row.updatedAt} />
                        </span>
                        {row.commentCount > 0 ? (
                          <span className="inline-flex shrink-0 items-center gap-1 text-xs text-on-surface-muted">
                            <Icon name="messageSquare" size={12} />
                            {row.commentCount}
                          </span>
                        ) : null}
                      </li>
                    ))}
                </ul>
              )}
            </Panel>
          </div>
        )}
      </QueryView>
    </Page>
  );
}
