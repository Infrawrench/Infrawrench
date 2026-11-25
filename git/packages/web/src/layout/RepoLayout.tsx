/**
 * The frame of every repository page: the header (owner / name, visibility,
 * star and fork) and the tab bar. The active tab comes from the route.
 *
 * Pages under it read the repository with `useRepository()` rather than
 * fetching it again.
 */
import { createContext, useContext, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { Repository } from "@infrawrench/git-contract";
import { api } from "../api/client";
import { invalidate, queries, queryClient } from "../api/queries";
import { AppLink, useGo } from "../components/AppLink";
import { Badge, VisibilityBadge } from "../components/Badge";
import { LinkTabs, type LinkTab } from "../components/controls";
import { Icon } from "../components/icons";
import { Page } from "../components/Panel";
import { ErrorState, InlineError, Loading } from "../components/states";
import { compactCount } from "../lib/format";
import { paths, type RepoRef } from "../lib/paths";
import { signInHref, useSession } from "../lib/session";
import { isNotFound } from "../api/client";
import { buttonClass } from "../components/Button";

const RepositoryContext = createContext<Repository | null>(null);

/** The repository of the current page. Only under the repository layout. */
export function useRepository(): Repository {
  const repository = useContext(RepositoryContext);
  if (repository === null) throw new Error("useRepository outside the repository layout");
  return repository;
}

/** `{ owner, repo }` of the current page, as the API and `paths` take it. */
export function useRepoRef(): RepoRef {
  const repository = useRepository();
  return { owner: repository.owner.slug, repo: repository.name };
}

/** The first path segments that belong to the Code tab. */
const CODE_SECTIONS = new Set([
  "",
  "tree",
  "blob",
  "blame",
  "commits",
  "commit",
  "branches",
  "tags",
  "compare",
]);

/** The page's section: the path segment after `/:owner/:repo`. */
export function repoSection(pathname: string): string {
  return pathname.split("/").filter(Boolean)[2] ?? "";
}

function tabsFor(repository: Repository, repo: RepoRef): LinkTab[] {
  const section = (name: string) => (pathname: string) => repoSection(pathname) === name;
  const tabs: LinkTab[] = [
    {
      label: "Code",
      href: paths.repo(repo),
      icon: <Icon name="code" />,
      match: (pathname) => CODE_SECTIONS.has(repoSection(pathname)),
    },
  ];
  if (repository.features.issues) {
    tabs.push({
      label: "Issues",
      href: paths.issues(repo),
      icon: <Icon name="circleDot" />,
      count: repository.openIssueCount,
      match: section("issues"),
    });
  }
  if (repository.features.pullRequests) {
    tabs.push({
      label: "Pull requests",
      href: paths.pulls(repo),
      icon: <Icon name="gitPullRequest" />,
      count: repository.openPullRequestCount,
      match: section("pulls"),
    });
  }
  tabs.push({
    label: "CI",
    href: paths.ci(repo),
    icon: <Icon name="listChecks" />,
    match: section("ci"),
  });
  if (repository.hasTerraform || repository.viewer.canAdminister) {
    tabs.push({
      label: "Infrastructure",
      href: paths.infrastructure(repo),
      icon: <Icon name="boxes" />,
      match: section("infrastructure"),
    });
  }
  if (repository.viewer.canAdminister) {
    tabs.push({
      label: "Settings",
      href: paths.repoSettings(repo),
      icon: <Icon name="settings" />,
      match: section("settings"),
    });
  }
  return tabs;
}

const countButton =
  "inline-flex items-center gap-1.5 border border-border bg-surface-raised px-2.5 py-1 text-xs font-medium text-on-surface";

function StarButton({ repository, repo }: { repository: Repository; repo: RepoRef }) {
  const session = useSession();
  const signedIn = session.data?.user != null;
  const starred = repository.viewer.hasStarred;
  const toggle = useMutation({
    mutationFn: () =>
      starred ? api.repositories.unstar({ params: repo }) : api.repositories.star({ params: repo }),
    onSuccess: () => {
      // Show the new state at once; the refetch then confirms the count.
      queryClient.setQueryData<Repository>(
        queries.repositories.get({ params: repo }).queryKey,
        (current) =>
          current && {
            ...current,
            starCount: current.starCount + (starred ? -1 : 1),
            viewerHasStarred: !starred,
            viewer: { ...current.viewer, hasStarred: !starred },
          },
      );
      void invalidate("repositoryLists");
    },
  });
  const count = (
    <span
      className={`${countButton} rounded-r border-l-0 font-normal text-on-surface-secondary`}
      aria-label={`${repository.starCount} stars`}
    >
      {compactCount(repository.starCount)}
    </span>
  );
  if (!signedIn) {
    return (
      <div className="flex">
        <a href={signInHref()} className={`${countButton} rounded-l hover:bg-surface-sunken`}>
          <Icon name="star" />
          Star
        </a>
        {count}
      </div>
    );
  }
  return (
    <div className="flex">
      <button
        type="button"
        aria-pressed={starred}
        disabled={toggle.isPending}
        onClick={() => toggle.mutate()}
        className={`${countButton} rounded-l hover:bg-surface-sunken disabled:opacity-60`}
      >
        <Icon name="star" filled={starred} className={starred ? "text-warning" : ""} />
        {starred ? "Starred" : "Star"}
      </button>
      {count}
    </div>
  );
}

function ForkButton({ repository, repo }: { repository: Repository; repo: RepoRef }) {
  const go = useGo();
  const session = useSession();
  const user = session.data?.user ?? null;
  const fork = useMutation({
    // Into the person's own namespace; an organisation's is picked on the fork's settings.
    mutationFn: () =>
      api.repositories.fork({ params: repo, payload: { owner: user?.username ?? "" } }),
    onSuccess: (created) => {
      void invalidate("repositoryLists");
      void invalidate("repositories");
      go(paths.repo({ owner: created.owner.slug, repo: created.name }));
    },
  });
  const count = (
    <span
      className={`${countButton} rounded-r border-l-0 font-normal text-on-surface-secondary`}
      aria-label={`${repository.forkCount} forks`}
    >
      {compactCount(repository.forkCount)}
    </span>
  );
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex">
        {user === null ? (
          <a href={signInHref()} className={`${countButton} rounded-l hover:bg-surface-sunken`}>
            <Icon name="gitFork" />
            Fork
          </a>
        ) : (
          <button
            type="button"
            disabled={!repository.viewer.canFork || user.username === null || fork.isPending}
            onClick={() => fork.mutate()}
            className={`${countButton} rounded-l hover:bg-surface-sunken disabled:opacity-60`}
          >
            <Icon name="gitFork" />
            Fork
          </button>
        )}
        {count}
      </div>
      <InlineError error={fork.error} />
    </div>
  );
}

function RepoHeader({ repository, repo }: { repository: Repository; repo: RepoRef }) {
  return (
    <div className="border-b border-border bg-surface-inset">
      <div className="mx-auto w-full max-w-6xl px-4 pt-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-base">
              <Icon
                name={repository.isFork ? "gitFork" : "book"}
                size={16}
                className="text-on-surface-muted"
              />
              <AppLink
                href={paths.namespace(repository.owner.slug)}
                className="text-on-surface-secondary hover:underline"
              >
                {repository.owner.slug}
              </AppLink>
              <span aria-hidden="true" className="text-on-surface-faint">
                /
              </span>
              <AppLink
                href={paths.repo(repo)}
                className="font-semibold text-on-surface hover:underline"
              >
                {repository.name}
              </AppLink>
              <span className="ml-1 flex items-center gap-1.5">
                <VisibilityBadge visibility={repository.visibility} />
                {repository.archived ? (
                  <Badge tone="warning">
                    <Icon name="archive" size={10} />
                    Archived
                  </Badge>
                ) : null}
              </span>
            </h1>
            {repository.parent !== null ? (
              <p className="mt-1 text-xs text-on-surface-muted">
                Forked from{" "}
                <AppLink
                  href={paths.repo({
                    owner: repository.parent.owner,
                    repo: repository.parent.name,
                  })}
                  className="text-on-surface-secondary hover:underline"
                >
                  {repository.parent.owner}/{repository.parent.name}
                </AppLink>
              </p>
            ) : null}
          </div>
          <div className="flex items-start gap-2">
            <StarButton repository={repository} repo={repo} />
            <ForkButton repository={repository} repo={repo} />
          </div>
        </div>
        <LinkTabs label="Repository" tabs={tabsFor(repository, repo)} className="mt-3" />
      </div>
    </div>
  );
}

export function RepoLayout({
  owner,
  name,
  children,
}: {
  owner: string;
  name: string;
  children: ReactNode;
}) {
  const repo: RepoRef = { owner, repo: name };
  const query = useQuery(queries.repositories.get({ params: repo }));
  const session = useSession();

  if (query.data === undefined) {
    if (query.error) {
      const signedOut = session.data !== undefined && session.data.user === null;
      return (
        <Page>
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
          {isNotFound(query.error) && signedOut ? (
            <p className="text-center">
              <a href={signInHref()} className={buttonClass("primary")}>
                Sign in
              </a>
            </p>
          ) : null}
        </Page>
      );
    }
    return <Loading />;
  }
  const repository = query.data;
  // The API matches names case-insensitively; link with the repository's own spelling.
  const canonical: RepoRef = { owner: repository.owner.slug, repo: repository.name };
  return (
    <RepositoryContext.Provider value={repository}>
      <RepoHeader repository={repository} repo={canonical} />
      {children}
    </RepositoryContext.Provider>
  );
}
