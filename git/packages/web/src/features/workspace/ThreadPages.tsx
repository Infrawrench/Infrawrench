/**
 * Someone's pull requests and issues across repositories: the lists the
 * classic sidebar leads to. Pull requests they opened, the ones waiting on
 * their review and the ones assigned to them; issues assigned to them, the
 * ones they opened and the ones that mention them. The view and the state
 * are in the address.
 */
import type { ReactNode } from "react";
import { useLocation } from "@tanstack/react-router";
import type { UserRef, WorkThread } from "@infrawrench/git-contract";
import { api } from "../../api/client";
import { type Pages, usePages } from "../../api/queries";
import { AppLink, useGo } from "../../components/AppLink";
import { buttonClass } from "../../components/Button";
import { LinkTabs, Segmented } from "../../components/controls";
import { Icon } from "../../components/icons";
import { Page, Panel } from "../../components/Panel";
import { RelativeTime, UserLink } from "../../components/people";
import { EmptyState, ErrorState, Loading, LoadMore } from "../../components/states";
import { ThreadStateIcon, issueKind, pullKind } from "../../components/StatusIcons";
import { TopBar } from "../../layout/TopBar";
import { showBidi } from "../../lib/bidi";
import { cursorQuery } from "../../lib/cursor";
import {
  type IssuesView,
  type PullsView,
  type ThreadsState,
  paths,
  type RepoRef,
} from "../../lib/paths";
import { signInHref, useSession } from "../../lib/session";

const oneOf = <T extends string>(
  value: string | null,
  options: ReadonlyArray<T>,
  fallback: T,
): T => ((options as ReadonlyArray<string>).includes(value ?? "") ? (value as T) : fallback);

const PULLS_VIEWS: ReadonlyArray<{ value: PullsView; label: string }> = [
  { value: "created", label: "Created" },
  { value: "review", label: "Review requested" },
  { value: "assigned", label: "Assigned" },
];
const ISSUES_VIEWS: ReadonlyArray<{ value: IssuesView; label: string }> = [
  { value: "assigned", label: "Assigned" },
  { value: "created", label: "Created" },
  { value: "mentioned", label: "Mentioned" },
];

/** One thread of a list across repositories: its repository named, since the list spans several. */
function Row({
  repo,
  number,
  title,
  pull,
  icon,
  author,
  detail,
  at,
  comments = 0,
}: {
  repo: RepoRef;
  number: number;
  title: string;
  pull: boolean;
  icon: ReactNode;
  author: UserRef | null;
  /** What happened at `at`: `opened`, `updated`, `waiting since`. */
  detail: string;
  at: string;
  comments?: number;
}) {
  return (
    <li className="flex items-start gap-2.5 border-t border-border px-3 py-2 first:border-t-0 hover:bg-surface-inset">
      <span className="mt-0.5">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
          <AppLink
            href={paths.repo(repo)}
            className="text-sm text-on-surface-secondary hover:underline"
          >
            {repo.owner}/{repo.repo}
          </AppLink>
          <AppLink
            href={pull ? paths.pull(repo, number) : paths.issue(repo, number)}
            className="text-sm font-medium text-on-surface hover:underline"
          >
            {showBidi(title)}
          </AppLink>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-on-surface-muted">
          <span>#{number}</span>
          <span>
            {detail} <RelativeTime iso={at} />
          </span>
          {author !== null ? (
            <span className="inline-flex items-center gap-1">
              by <UserLink user={author} className="font-normal text-on-surface-secondary" />
            </span>
          ) : null}
        </div>
      </div>
      {comments > 0 ? (
        <span className="inline-flex shrink-0 items-center gap-1 pt-0.5 text-xs text-on-surface-muted">
          <Icon name="messageSquare" size={12} />
          <span className="sr-only">Comments:</span>
          {comments}
        </span>
      ) : null}
    </li>
  );
}

function ThreadRow({ thread }: { thread: WorkThread }) {
  const kind = thread.isPullRequest
    ? pullKind(thread.state, thread.draft)
    : issueKind(thread.state === "open" ? "open" : "closed", null);
  return (
    <Row
      repo={{ owner: thread.repository.owner, repo: thread.repository.name }}
      number={thread.number}
      title={thread.title}
      pull={thread.isPullRequest}
      icon={<ThreadStateIcon kind={kind} size={15} />}
      author={thread.author}
      detail="updated"
      at={thread.updatedAt}
      comments={thread.commentCount}
    />
  );
}

/** The frame of both pages: the name in the bar, the views as tabs, one panel of rows. */
function Frame({
  title,
  tabs,
  actions,
  pages,
  empty,
  children,
}: {
  title: string;
  tabs: ReadonlyArray<{ label: string; href: string; current: boolean }>;
  actions?: ReactNode;
  pages: Pages<unknown> & { readonly isLoading: boolean; readonly error: unknown };
  empty: string;
  children: ReactNode;
}) {
  const session = useSession();
  const signedOut = session.data !== undefined && session.data.user === null;
  return (
    <>
      <TopBar title={title} actions={signedOut ? undefined : actions} />
      <Page>
        {signedOut ? (
          <EmptyState
            action={
              <a href={signInHref()} className={buttonClass("primary")}>
                Sign in
              </a>
            }
          >
            Sign in to see your work
          </EmptyState>
        ) : (
          <>
            <div className="mb-3 border-b border-border">
              <LinkTabs
                label={`${title} views`}
                tabs={tabs.map((tab) => ({
                  label: tab.label,
                  href: tab.href,
                  match: () => tab.current,
                }))}
              />
            </div>
            {pages.error ? (
              <ErrorState error={pages.error} />
            ) : pages.isLoading ? (
              <Loading count={6} />
            ) : (
              <Panel>
                {pages.items.length === 0 ? (
                  <EmptyState>{empty}</EmptyState>
                ) : (
                  <ul aria-label={title}>{children}</ul>
                )}
              </Panel>
            )}
            <LoadMore pages={pages} />
          </>
        )}
      </Page>
    </>
  );
}

function StateSwitch({
  state,
  onChange,
}: {
  state: ThreadsState;
  onChange: (next: ThreadsState) => void;
}) {
  return (
    <Segmented<ThreadsState>
      label="State"
      value={state}
      onChange={onChange}
      options={[
        { value: "open", label: "Open" },
        { value: "closed", label: "Closed" },
        { value: "all", label: "All" },
      ]}
    />
  );
}

function useThreads(
  kind: "issues" | "pulls",
  involvement: "created" | "assigned" | "mentioned",
  state: ThreadsState,
  enabled: boolean,
) {
  const session = useSession();
  const signedIn = session.data !== undefined && session.data.user !== null;
  return usePages(
    ["workspace", "threads", kind, involvement, state],
    (cursor) =>
      api.workspace.threads({
        query: { ...cursorQuery(cursor), limit: 30, kind, involvement, state },
      }),
    { enabled: signedIn && enabled },
  );
}

const readSearch = (searchStr: string) => {
  const params = new URLSearchParams(searchStr);
  return {
    view: params.get("view"),
    state: oneOf<ThreadsState>(params.get("state"), ["open", "closed", "all"], "open"),
  };
};

export function MyPullsPage() {
  const go = useGo();
  const search = readSearch(useLocation({ select: (location) => location.searchStr }));
  const view = oneOf<PullsView>(search.view, ["created", "review", "assigned"], "created");
  const { state } = search;
  const session = useSession();
  const signedIn = session.data !== undefined && session.data.user !== null;
  const waiting = view === "review";
  const threads = useThreads("pulls", waiting ? "created" : view, state, !waiting);
  // There is no request for a review here: these are the branches with a version they have not reviewed.
  const inbox = usePages(
    ["review", "inbox", "list"],
    (cursor) => api.review.inbox({ query: { ...cursorQuery(cursor), limit: 30 } }),
    { enabled: signedIn && waiting },
  );
  return (
    <Frame
      title="Pull requests"
      tabs={PULLS_VIEWS.map((option) => ({
        label: option.label,
        href: paths.myPulls({ view: option.value, state }),
        current: option.value === view,
      }))}
      actions={
        waiting ? undefined : (
          <StateSwitch
            state={state}
            onChange={(next) => go(paths.myPulls({ view, state: next }), { replace: true })}
          />
        )
      }
      pages={waiting ? inbox : threads}
      empty={waiting ? "Nothing is waiting on your review" : "No pull requests"}
    >
      {waiting
        ? inbox.items.map((item) => (
            <Row
              key={`${item.repository.id}#${item.number}`}
              repo={{ owner: item.repository.owner, repo: item.repository.name }}
              number={item.number}
              title={item.title}
              pull
              icon={<ThreadStateIcon kind={pullKind("open", item.draft)} size={15} />}
              author={item.author}
              detail="waiting since"
              at={item.waitingSince}
            />
          ))
        : threads.items.map((thread) => <ThreadRow key={thread.id} thread={thread} />)}
    </Frame>
  );
}

export function MyIssuesPage() {
  const go = useGo();
  const search = readSearch(useLocation({ select: (location) => location.searchStr }));
  const view = oneOf<IssuesView>(search.view, ["assigned", "created", "mentioned"], "assigned");
  const { state } = search;
  const threads = useThreads("issues", view, state, true);
  return (
    <Frame
      title="Issues"
      tabs={ISSUES_VIEWS.map((option) => ({
        label: option.label,
        href: paths.myIssues({ view: option.value, state }),
        current: option.value === view,
      }))}
      actions={
        <StateSwitch
          state={state}
          onChange={(next) => go(paths.myIssues({ view, state: next }), { replace: true })}
        />
      }
      pages={threads}
      empty="No issues"
    >
      {threads.items.map((thread) => (
        <ThreadRow key={thread.id} thread={thread} />
      ))}
    </Frame>
  );
}
