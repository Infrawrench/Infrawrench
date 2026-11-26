/**
 * The frame of a branch's page, `/:owner/:repo/branches/<key>`: its title
 * and state, the line that names the branch and where it goes, what it needs
 * now, and the Review, Commits and Checks tabs (`?tab=`). The tabs read the
 * page with `useBranchPage()` rather than fetching it again.
 */
import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useLocation } from "@tanstack/react-router";
import type { BranchPage } from "@infrawrench/git-contract";
import { api } from "../../api/client";
import { invalidate, queries } from "../../api/queries";
import { AppLink, useGo } from "../../components/AppLink";
import { CopyButton, QuietTabs, type LinkTab } from "../../components/controls";
import { Icon } from "../../components/icons";
import { Page } from "../../components/Panel";
import { Avatar, RelativeTime, UserLink } from "../../components/people";
import { ErrorState, Loading } from "../../components/states";
import { ThreadStateBadge, pageKind } from "../../components/StatusIcons";
import { usePageTitle } from "../../lib/title";
import { RepoBarCrumb, useRepoRef } from "../../layout/RepoLayout";
import { paths, type BranchPageTab } from "../../lib/paths";
import { ThreadHeader } from "../issues/ThreadHeader";
import { BranchNeeds, useBranchState } from "../review/BranchNeeds";
import { deriveMergeBox } from "./merge-box";

const PageContext = createContext<BranchPage | null>(null);

/** The branch page of the current page. Only under `BranchLayout`. */
export function useBranchPage(): BranchPage {
  const page = useContext(PageContext);
  if (page === null) throw new Error("useBranchPage outside the branch page layout");
  return page;
}

/** Refetches everything a change to a branch's page can show up in. */
export function refreshBranchPage(): void {
  void invalidate("branches");
  void invalidate("issues");
  void invalidate("repositories", "get");
}

const quietChip =
  "inline-flex h-6 items-center gap-1.5 rounded-full border border-border px-2 text-xs whitespace-nowrap";

/** The head as a key writes it: `owner/name:branch` for a fork's, the branch alone otherwise. */
export function headLabel(page: BranchPage): string {
  if (!page.crossRepository) return page.headRef;
  return page.headRepository === null
    ? page.headRef
    : `${page.headRepository.owner}/${page.headRepository.name}:${page.headRef}`;
}

/**
 * The line above a branch's title: its state, the branch and where it goes,
 * who is behind it and how old it is.
 */
function BranchMeta({ data }: { data: BranchPage }) {
  const repo = useRepoRef();
  const state = useBranchState(data.key);
  const merged = data.state === "merged";
  const agent = state.data?.agent ?? null;
  // A fork's branch names the fork it is in, and links there.
  const headRepo =
    data.headRepository === null
      ? null
      : { owner: data.headRepository.owner, repo: data.headRepository.name };
  const name = headLabel(data);
  const head =
    data.headRefExists && headRepo !== null ? (
      <AppLink
        href={paths.tree(headRepo, data.headRef)}
        className="max-w-64 truncate text-on-surface hover:underline"
      >
        {name}
      </AppLink>
    ) : (
      <span
        className="max-w-64 truncate line-through"
        title={
          data.crossRepository && data.headRepository === null
            ? "The fork was deleted"
            : "This branch was deleted"
        }
      >
        {name}
      </span>
    );
  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-xs text-on-surface-muted">
      <ThreadStateBadge kind={pageKind(data.state, data.draft)} />
      <span className={`${quietChip} font-mono text-[11px] text-on-surface-secondary`}>
        <Icon
          name={data.crossRepository ? "gitFork" : "gitBranch"}
          size={12}
          className="text-on-surface-muted"
        />
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

export function BranchLayout({
  branchKey,
  tab,
  children,
}: {
  /** The key the address names: the page's own, or another that resolves to it (`~2`). */
  branchKey: string;
  tab: BranchPageTab | undefined;
  children: ReactNode;
}) {
  const repo = useRepoRef();
  const go = useGo();
  const request = { params: { ...repo, branch: branchKey } };
  const page = useQuery({
    ...queries.branches.get(request),
    // While a trial merge or a check runs, the merge box asks again.
    refetchInterval: (query) =>
      query.state.data !== undefined &&
      query.state.data.state === "open" &&
      deriveMergeBox(query.state.data.mergeability, query.state.data.baseRef).poll
        ? 4000
        : false,
  });
  usePageTitle(
    page.data && `${page.data.title} · ${headLabel(page.data)}`,
    `${repo.owner}/${repo.repo}`,
  );

  // An address with another key for the same page (`feature/a~2` for the open one) settles on its own.
  const canonical = page.data?.key;
  const { searchStr, hash } = useLocation();
  const moved = useRef(false);
  useEffect(() => {
    if (canonical !== undefined && canonical !== branchKey && !moved.current) {
      moved.current = true;
      go(`${paths.branchPage(repo, canonical)}${searchStr}${hash === "" ? "" : `#${hash}`}`, {
        replace: true,
      });
    }
  }, [canonical, branchKey, searchStr, hash, go, repo]);

  const rename = useMutation({
    mutationFn: (title: string) =>
      api.branches.update({
        params: { ...repo, branch: page.data?.key ?? branchKey },
        payload: { title },
      }),
    onSuccess: refreshBranchPage,
  });

  if (page.data === undefined) {
    if (page.error) {
      return (
        <Page>
          <ErrorState error={page.error} onRetry={() => void page.refetch()} />
        </Page>
      );
    }
    return <Loading shape="page" />;
  }
  const data = page.data;
  const key = data.key;
  const tabs: LinkTab[] = [
    { label: "Review", href: paths.branchPage(repo, key), active: tab === undefined },
    {
      label: "Commits",
      href: paths.branchPage(repo, key, { tab: "commits" }),
      count: data.commitCount,
      active: tab === "commits",
    },
    {
      label: "Checks",
      href: paths.branchPage(repo, key, { tab: "checks" }),
      count: data.mergeability.checks.statuses.length,
      active: tab === "checks",
    },
  ];
  return (
    <PageContext.Provider value={data}>
      <ReviewFrame>
        <RepoBarCrumb>{data.title}</RepoBarCrumb>
        <ThreadHeader
          large
          title={data.title}
          kind={pageKind(data.state, data.draft)}
          canEdit={data.viewer.canEdit}
          onRename={(title) => rename.mutateAsync(title)}
        >
          <BranchMeta data={data} />
        </ThreadHeader>
        <BranchNeeds branchKey={key} />
        <div className="mt-5 mb-7 flex flex-wrap items-center justify-between gap-2">
          <QuietTabs label="Branch" tabs={tabs} className="-ml-2" />
        </div>
        {children}
      </ReviewFrame>
    </PageContext.Provider>
  );
}
