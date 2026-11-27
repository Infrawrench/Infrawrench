import { useEffect } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { Issue } from "@infrawrench/git-contract";
import { api, isNotFound } from "../../api/client";
import { invalidate, queries } from "../../api/queries";
import { useGo } from "../../components/AppLink";
import { Button } from "../../components/Button";
import { Icon } from "../../components/icons";
import { Menu } from "../../components/Menu";
import { Page } from "../../components/Panel";
import { RelativeTime, UserLink } from "../../components/people";
import { ErrorState, InlineError, Loading } from "../../components/states";
import { issueKind } from "../../components/StatusIcons";
import { usePageTitle } from "../../lib/title";
import { useRepoRef } from "../../layout/RepoLayout";
import { plural } from "../../lib/format";
import { paths } from "../../lib/paths";
import { CommentCard } from "./CommentCard";
import { CommentForm } from "./CommentForm";
import { ThreadHeader } from "./ThreadHeader";
import { LockControl, TriageFields } from "./ThreadSidebar";
import { Timeline } from "./Timeline";

type IssuePatch = Parameters<typeof api.issues.update>[0]["payload"];

export function IssuePage({ number }: { number: number }) {
  const repo = useRepoRef();
  const go = useGo();
  const request = { params: { ...repo, number } };
  const issue = useQuery(queries.issues.get(request));
  usePageTitle(
    issue.data && `${issue.data.title} · Issue #${issue.data.number}`,
    `${repo.owner}/${repo.repo}`,
  );

  // The number may be a branch page's: the two share one sequence.
  const missing = isNotFound(issue.error);
  const asPage = useQuery({
    ...queries.branches.locate(request),
    enabled: missing,
    retry: false,
  });
  const pageKey = asPage.data?.key;
  useEffect(() => {
    if (pageKey !== undefined) go(paths.branchPage(repo, pageKey), { replace: true });
  }, [pageKey, go, repo]);

  if (issue.data === undefined) {
    if (issue.error && (!missing || asPage.error)) {
      return (
        <Page>
          <ErrorState error={issue.error} onRetry={() => void issue.refetch()} />
        </Page>
      );
    }
    return <Loading shape="page" />;
  }
  return <IssueView issue={issue.data} />;
}

function IssueView({ issue }: { issue: Issue }) {
  const repo = useRepoRef();
  const { number } = issue;
  const update = useMutation({
    mutationFn: (payload: IssuePatch) =>
      api.issues.update({ params: { ...repo, number }, payload }),
    onSuccess: () => {
      void invalidate("issues");
      void invalidate("repositories", "get");
      void invalidate("milestones");
    },
  });
  const open = issue.state === "open";

  return (
    <Page width="reading">
      <ThreadHeader
        title={issue.title}
        number={number}
        kind={issueKind(issue.state, issue.stateReason)}
        canEdit={issue.viewer.canEdit}
        onRename={(title) => update.mutateAsync({ title })}
      >
        <span>
          {issue.author !== null ? <UserLink user={issue.author} /> : "Someone"} opened this{" "}
          <RelativeTime iso={issue.createdAt} />
        </span>
        <span>· {plural(issue.commentCount, "comment")}</span>
        {issue.locked ? (
          <span className="inline-flex items-center gap-1">
            · <Icon name="lock" size={11} /> Locked
            {issue.lockReason !== null ? ` as ${issue.lockReason}` : ""}
          </span>
        ) : null}
      </ThreadHeader>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_16rem]">
        <div className="min-w-0 space-y-3">
          <CommentCard
            author={issue.author}
            createdAt={issue.createdAt}
            body={issue.body}
            edited={issue.bodyEditedAt !== null}
            access="author"
            canEdit={issue.viewer.canEdit}
            onSave={(body) => update.mutateAsync({ body })}
          />
          <Timeline number={number} kind="issues" />
          <CommentForm
            number={number}
            canComment={issue.viewer.canComment}
            locked={issue.locked}
            stateActions={({ body, post }) =>
              !issue.viewer.canClose ? null : open ? (
                <div className="flex">
                  <Button
                    busy={update.isPending}
                    className="rounded-r-none"
                    onClick={() =>
                      void post().then(() =>
                        update.mutate({ state: "closed", stateReason: "completed" }),
                      )
                    }
                  >
                    <Icon name="checkCircle" size={13} className="text-notice" />
                    {body.trim() === "" ? "Close issue" : "Close with comment"}
                  </Button>
                  <Menu
                    label="Close as"
                    align="end"
                    items={[
                      {
                        label: "Close as completed",
                        icon: <Icon name="checkCircle" size={13} className="text-notice" />,
                        onSelect: () =>
                          void post().then(() =>
                            update.mutate({ state: "closed", stateReason: "completed" }),
                          ),
                      },
                      {
                        label: "Close as not planned",
                        icon: <Icon name="circleSlash" size={13} />,
                        onSelect: () =>
                          void post().then(() =>
                            update.mutate({ state: "closed", stateReason: "not_planned" }),
                          ),
                      },
                    ]}
                    trigger={({ props }) => (
                      <button
                        {...props}
                        type="button"
                        aria-label="Choose how to close"
                        aria-haspopup="menu"
                        className="inline-flex items-center h-[30px] rounded-r border border-l-0 border-border bg-surface-raised px-1.5 text-on-surface hover:bg-surface-sunken"
                      >
                        <Icon name="chevronDown" size={12} />
                      </button>
                    )}
                  />
                </div>
              ) : (
                <Button
                  busy={update.isPending}
                  onClick={() => void post().then(() => update.mutate({ state: "open" }))}
                >
                  <Icon name="circleDot" size={13} className="text-success" />
                  Reopen issue
                </Button>
              )
            }
          />
          <InlineError error={update.error} />
        </div>
        <aside aria-label="Details">
          <TriageFields
            kind="issues"
            canTriage={issue.viewer.canTriage}
            shown={issue}
            value={{
              labels: issue.labels.map((label) => label.name),
              assignees: issue.assignees.flatMap((user) => user.username ?? []),
              milestone: issue.milestone?.number ?? null,
            }}
            onChange={(next) =>
              update.mutate({
                labels: [...next.labels],
                assignees: [...next.assignees],
                milestone: next.milestone,
              })
            }
          />
          {issue.viewer.canTriage ? <LockControl number={number} locked={issue.locked} /> : null}
        </aside>
      </div>
    </Page>
  );
}
