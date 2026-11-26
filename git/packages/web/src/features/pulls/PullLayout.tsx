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
import { CopyButton, LinkTabs } from "../../components/controls";
import { DiffStat } from "../../components/DiffView";
import { Icon } from "../../components/icons";
import { Page } from "../../components/Panel";
import { RelativeTime, UserLink } from "../../components/people";
import { ErrorState, Loading } from "../../components/states";
import { pullKind } from "../../components/StatusIcons";
import { usePageTitle } from "../../lib/title";
import { useRepoRef } from "../../layout/RepoLayout";
import { plural } from "../../lib/format";
import { paths } from "../../lib/paths";
import { ThreadHeader } from "../issues/ThreadHeader";
import { BranchNeeds } from "../review/BranchNeeds";
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
  return (
    <PullContext.Provider value={data}>
      <PullModeContext.Provider value={mode}>
        <Frame>
          <ThreadHeader
            large={agent}
            title={data.title}
            number={number}
            kind={pullKind(data.state, data.draft)}
            canEdit={data.viewer.canEdit}
            onRename={(title) => rename.mutateAsync(title)}
          >
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
              {data.headRefExists && headRepo !== null ? (
                <AppLink
                  href={paths.tree(headRepo, data.headRef)}
                  className={`${branch} hover:underline`}
                >
                  <span className="truncate">{headName}</span>
                </AppLink>
              ) : (
                <span
                  className={`${branch} line-through`}
                  title={
                    data.crossRepository && data.headRepository === null
                      ? "The fork was deleted"
                      : "This branch was deleted"
                  }
                >
                  <span className="truncate">{headName}</span>
                </span>
              )}
              <CopyButton text={data.headRef} label="Copy branch name" />
              {merged && data.mergedAt !== null ? <RelativeTime iso={data.mergedAt} /> : null}
              {data.locked ? (
                <span className="inline-flex items-center gap-1">
                  · <Icon name="lock" size={11} /> Locked
                </span>
              ) : null}
            </span>
          </ThreadHeader>
          {agent ? <BranchNeeds number={number} /> : null}
          <div
            className={`flex flex-wrap items-center justify-between gap-2 border-b border-border ${agent ? "mt-5 mb-6" : "mb-4"}`}
          >
            <LinkTabs
              label={agent ? "Branch" : "Pull request"}
              tabs={[
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
              ]}
            />
            <span className="mb-1.5 flex flex-wrap items-center gap-3">
              {agent ? null : (
                <DiffStat additions={data.stats.additions} deletions={data.stats.deletions} />
              )}
              <ModeSwitch />
            </span>
          </div>
          {children}
        </Frame>
      </PullModeContext.Provider>
    </PullContext.Provider>
  );
}
