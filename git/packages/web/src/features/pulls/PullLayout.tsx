/**
 * The frame of a pull request's pages: its title and state, the line that
 * names the branches, and the tabs. The tabs read the pull request with
 * `usePull()` rather than fetching it again.
 *
 * The same address is the branch page for someone in agent mode (the
 * default) and the pull request for someone in classic mode: the frame asks
 * which (`usePullMode()`), and the header carries the switch.
 */
import { createContext, useContext, useEffect, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { PullRequest, ReviewMode } from "@infrawrench/git-contract";
import { api, isNotFound } from "../../api/client";
import { invalidate, queries } from "../../api/queries";
import { AppLink, useGo } from "../../components/AppLink";
import { CopyButton, LinkTabs, QuietTabs, type LinkTab } from "../../components/controls";
import { DiffStat } from "../../components/DiffView";
import { Icon, type IconName } from "../../components/icons";
import { Page } from "../../components/Panel";
import { Avatar, RelativeTime, UserLink } from "../../components/people";
import { ErrorState, Loading } from "../../components/states";
import { pullKind, type ThreadKind } from "../../components/StatusIcons";
import { usePageTitle } from "../../lib/title";
import { RepoBarActions, RepoBarCrumb, useRepoRef } from "../../layout/RepoLayout";
import { useSidebarShell } from "../../lib/shell";
import { plural } from "../../lib/format";
import { paths } from "../../lib/paths";
import { ThreadHeader } from "../issues/ThreadHeader";
import { BranchNeeds, useBranchState } from "../review/BranchNeeds";
import { ModeSwitch, useReviewMode } from "../review/mode";
import { deriveMergeBox } from "./merge-box";

const PullContext = createContext<PullRequest | null>(null);
const PullModeContext = createContext<ReviewMode>("classic");

/** How the current pull request is being read. Classic outside `PullLayout`. */
export const usePullMode = (): ReviewMode => useContext(PullModeContext);

/** The pull request of the current page. Only under `PullLayout`. */
export function usePull(): PullRequest {
  const pull = useContext(PullContext);
  if (pull === null) throw new Error("usePull outside the pull request layout");
  return pull;
}

/** Refetches everything a change to a pull request can show up in. */
export function refreshPull(): void {
  void invalidate("pulls");
  void invalidate("issues");
  void invalidate("repositories", "get");
}

const branch =
  "inline-flex max-w-64 items-center rounded bg-surface-sunken px-1.5 py-px font-mono text-[11px] text-on-surface";

/** A branch's state on its page: a quiet pill, the state's colour on its glyph alone. */
const STATE_PILL: Record<
  Extract<ThreadKind, `pull-${string}`>,
  { icon: IconName; tone: string; label: string }
> = {
  "pull-open": { icon: "circleChevronUp", tone: "text-on-surface-secondary", label: "Open" },
  "pull-draft": { icon: "circleDashed", tone: "text-on-surface-muted", label: "Draft" },
  "pull-merged": { icon: "gitMerge", tone: "text-notice", label: "Merged" },
  "pull-closed": { icon: "circleSlash", tone: "text-on-surface-muted", label: "Closed" },
};

const quietChip =
  "inline-flex h-6 items-center gap-1.5 rounded-full border border-border px-2 text-xs whitespace-nowrap";

/**
 * The line above a branch's title: its state, its number, the branch and
 * where it goes, who is behind it and how old it is.
 */
function BranchMeta({
  data,
  head,
}: {
  data: PullRequest;
  /** The branch as a link, or struck through when it is gone. */
  head: ReactNode;
}) {
  const repo = useRepoRef();
  const state = useBranchState(data.number);
  const pill = STATE_PILL[pullKind(data.state, data.draft) as keyof typeof STATE_PILL];
  const merged = data.state === "merged";
  const agent = state.data?.agent ?? null;
  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-xs text-on-surface-muted">
      <span className={`${quietChip} font-medium text-on-surface`}>
        <Icon name={pill.icon} size={13} className={pill.tone} />
        {pill.label}
      </span>
      <span className="font-mono text-on-surface-muted">#{data.number}</span>
      <span className={`${quietChip} font-mono text-[11px] text-on-surface-secondary`}>
        <Icon name="gitBranch" size={12} className="text-on-surface-muted" />
        {head}
        <Icon name="arrowRight" size={12} className="text-on-surface-faint" />
        <span className="sr-only">into</span>
        <AppLink
          href={paths.tree(repo, data.baseRef)}
          className="max-w-40 truncate hover:text-on-surface hover:underline"
        >
          {data.baseRef}
        </AppLink>
      </span>
      <CopyButton text={data.headRef} label="Copy branch name" />
      {data.author !== null ? (
        <UserLink user={data.author} avatar className="!font-normal text-on-surface-secondary" />
      ) : (
        <span>Someone</span>
      )}
      {agent !== null ? (
        <span className="inline-flex items-center gap-1.5 text-on-surface-secondary">
          <span
            aria-hidden="true"
            className="inline-flex size-4 items-center justify-center rounded-full bg-surface-sunken"
          >
            <Icon name="bot" size={10} />
          </span>
          {agent.displayName}
        </span>
      ) : null}
      <span aria-hidden="true" className="text-on-surface-faint">
        ·
      </span>
      {merged && data.mergedAt !== null ? (
        <span className="inline-flex items-center gap-1.5">
          merged
          {data.mergedBy !== null ? (
            <>
              {" "}
              by
              <Avatar
                name={data.mergedBy.displayName ?? data.mergedBy.username ?? "?"}
                src={data.mergedBy.avatarUrl}
                size={16}
              />
              <UserLink user={data.mergedBy} className="!font-normal text-on-surface-secondary" />
            </>
          ) : null}
          <RelativeTime iso={data.mergedAt} />
        </span>
      ) : (
        <RelativeTime iso={data.createdAt} />
      )}
      {data.locked ? (
        <span className="inline-flex items-center gap-1">
          <Icon name="lock" size={11} /> Locked
        </span>
      ) : null}
    </div>
  );
}

/**
 * The branch page is a document the width of the window: its diff wants the
 * room. `--review-sticky-top` is how far down the page a sticky row of it
 * stops, under the shell's own bar.
 */
function ReviewFrame({ children }: { children: ReactNode }) {
  return (
    <div className="review-page mx-auto w-full max-w-[112rem] px-4 py-6 sm:px-6 lg:px-10">
      {children}
    </div>
  );
}

export function PullLayout({ number, children }: { number: number; children: ReactNode }) {
  const repo = useRepoRef();
  const go = useGo();
  const { mode } = useReviewMode();
  const sidebar = useSidebarShell();
  const request = { params: { ...repo, number } };
  const pull = useQuery({
    ...queries.pulls.get(request),
    // While a trial merge or a check runs, the merge box asks again.
    refetchInterval: (query) =>
      query.state.data !== undefined &&
      query.state.data.state === "open" &&
      deriveMergeBox(query.state.data.mergeability, query.state.data.baseRef).poll
        ? 4000
        : false,
  });

  // The number may be an issue's: the two share one sequence.
  const missing = isNotFound(pull.error);
  usePageTitle(
    pull.data &&
      mode &&
      (mode === "agent"
        ? `${pull.data.title} · ${pull.data.headRef} #${pull.data.number}`
        : `${pull.data.title} · Pull request #${pull.data.number}`),
    `${repo.owner}/${repo.repo}`,
  );
  const asIssue = useQuery({ ...queries.issues.get(request), enabled: missing, retry: false });
  const isIssue = asIssue.data !== undefined;
  useEffect(() => {
    if (isIssue) go(paths.issue(repo, number), { replace: true });
  }, [isIssue, go, repo, number]);

  const rename = useMutation({
    mutationFn: (title: string) => api.pulls.update({ ...request, payload: { title } }),
    onSuccess: refreshPull,
  });

  if (pull.data === undefined || mode === undefined) {
    if (pull.error && (!missing || asIssue.error)) {
      return (
        <Page>
          <ErrorState error={pull.error} onRetry={() => void pull.refetch()} />
        </Page>
      );
    }
    return <Loading shape="page" />;
  }
  const data = pull.data;
  const merged = data.state === "merged";
  // A fork's pull request names the fork its branch is in, and links there.
  const headRepo =
    data.headRepository === null
      ? null
      : { owner: data.headRepository.owner, repo: data.headRepository.name };
  const headName =
    data.crossRepository && data.headRepository !== null
      ? `${data.headRepository.owner}:${data.headRef}`
      : data.headRef;

  const agent = mode === "agent";
  const Frame = agent ? ReviewFrame : Page;
  const tabs: LinkTab[] = [
    agent
      ? {
          label: "Review",
          href: paths.pull(repo, number),
          icon: <Icon name="fileDiff" />,
          match: (pathname: string) => pathname === paths.pull(repo, number),
        }
      : {
          label: "Conversation",
          href: paths.pull(repo, number),
          icon: <Icon name="messageSquare" />,
          count: data.commentCount,
          match: (pathname: string) => pathname === paths.pull(repo, number),
        },
    {
      label: "Commits",
      href: paths.pullTab(repo, number, "commits"),
      icon: <Icon name="gitCommit" />,
      count: data.commitCount,
    },
    {
      label: "Checks",
      href: paths.pullTab(repo, number, "checks"),
      icon: <Icon name="listChecks" />,
      count: data.mergeability.checks.statuses.length,
    },
    // The branch page has the diff in it.
    ...(agent
      ? []
      : [
          {
            label: "Files changed",
            href: paths.pullTab(repo, number, "files"),
            icon: <Icon name="fileDiff" />,
            count: data.stats.filesChanged,
          },
        ]),
  ];
  const head =
    data.headRefExists && headRepo !== null ? (
      <AppLink
        href={paths.tree(headRepo, data.headRef)}
        className={
          agent ? "max-w-64 truncate text-on-surface hover:underline" : `${branch} hover:underline`
        }
      >
        <span className="truncate">{headName}</span>
      </AppLink>
    ) : (
      <span
        className={agent ? "max-w-64 truncate line-through" : `${branch} line-through`}
        title={
          data.crossRepository && data.headRepository === null
            ? "The fork was deleted"
            : "This branch was deleted"
        }
      >
        <span className="truncate">{headName}</span>
      </span>
    );
  return (
    <PullContext.Provider value={data}>
      <PullModeContext.Provider value={mode}>
        <Frame>
          {sidebar ? (
            <>
              <RepoBarCrumb>{data.title}</RepoBarCrumb>
              <RepoBarActions>
                <ModeSwitch />
              </RepoBarActions>
            </>
          ) : null}
          <ThreadHeader
            large={agent}
            title={data.title}
            number={number}
            kind={pullKind(data.state, data.draft)}
            canEdit={data.viewer.canEdit}
            onRename={(title) => rename.mutateAsync(title)}
          >
            {agent ? (
              <BranchMeta data={data} head={head} />
            ) : (
              <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                {merged && data.mergedBy !== null ? (
                  <UserLink user={data.mergedBy} />
                ) : data.author !== null ? (
                  <UserLink user={data.author} />
                ) : (
                  "Someone"
                )}
                <span>
                  {merged ? "merged" : "wants to merge"} {plural(data.commitCount, "commit")} into
                </span>
                <AppLink
                  href={paths.tree(repo, data.baseRef)}
                  className={`${branch} hover:underline`}
                >
                  <span className="truncate">{data.baseRef}</span>
                </AppLink>
                <span>from</span>
                {head}
                <CopyButton text={data.headRef} label="Copy branch name" />
                {merged && data.mergedAt !== null ? <RelativeTime iso={data.mergedAt} /> : null}
                {data.locked ? (
                  <span className="inline-flex items-center gap-1">
                    · <Icon name="lock" size={11} /> Locked
                  </span>
                ) : null}
              </span>
            )}
          </ThreadHeader>
          {agent ? (
            <>
              <BranchNeeds number={number} />
              <div className="mt-5 mb-7 flex flex-wrap items-center justify-between gap-2">
                <QuietTabs
                  label="Branch"
                  tabs={tabs.map(({ icon: _icon, ...tab }) => tab)}
                  className="-ml-2"
                />
                {/* In the sidebar shell the switch is in the bar. */}
                {sidebar ? null : <ModeSwitch />}
              </div>
            </>
          ) : (
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2 border-b border-border">
              <LinkTabs label="Pull request" tabs={tabs} />
              <span className="mb-1.5 flex flex-wrap items-center gap-3">
                <DiffStat additions={data.stats.additions} deletions={data.stats.deletions} />
                <ModeSwitch />
              </span>
            </div>
          )}
          {children}
        </Frame>
      </PullModeContext.Provider>
    </PullContext.Provider>
  );
}
