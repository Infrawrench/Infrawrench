import { useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import type { RepositorySummary } from "@infrawrench/git-contract";
import { queries } from "../../api/queries";
import { AppLink } from "../../components/AppLink";
import { CommitStatusIcon } from "../../components/Badge";
import { ButtonLink, buttonClass } from "../../components/Button";
import { SearchInput } from "../../components/forms";
import { Icon } from "../../components/icons";
import { Page, Panel, PanelHeader } from "../../components/Panel";
import { CommitAuthors, RelativeTime } from "../../components/people";
import { RepoList } from "../../components/RepoList";
import { EmptyState, Loading, QueryView } from "../../components/states";
import { shortOid } from "../../lib/format";
import { paths } from "../../lib/paths";
import { signInHref, useSession } from "../../lib/session";
import { InboxSection } from "../review/Inbox";
import { useReviewMode } from "../review/mode";
import { showBidi } from "../../lib/bidi";

export function HomePage() {
  const session = useSession();
  if (session.data === undefined) return <Loading shape="page" />;
  const user = session.data.user;
  if (user === null) return <SignedOutHome />;
  return <SignedInHome username={user.username} />;
}

function SignedOutHome() {
  const explore = useQuery(
    queries.repositoryLists.explore({ query: { sort: "stars", limit: 10 } }),
  );
  return (
    <Page>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-base font-semibold text-on-surface">Repositories</h1>
        <div className="flex items-center gap-2">
          <ButtonLink href={paths.explore()}>Explore</ButtonLink>
          <a href={signInHref()} className={buttonClass("primary")}>
            Sign in
          </a>
        </div>
      </div>
      <Panel>
        <QueryView query={explore}>
          {(page) =>
            page.items.length === 0 ? (
              <EmptyState>No public repositories yet</EmptyState>
            ) : (
              <RepoList repositories={page.items} label="Public repositories" />
            )
          }
        </QueryView>
      </Panel>
    </Page>
  );
}

function SignedInHome({ username }: { username: string | null }) {
  const [filter, setFilter] = useState("");
  // The inbox is the branch page's: someone in classic mode keeps the home page as it was.
  const { mode } = useReviewMode();
  const mine = useQuery(
    queries.repositoryLists.listMine({ query: { sort: "pushed", limit: 100 } }),
  );
  const starred = useQuery({
    ...queries.repositoryLists.listStarredBy({
      params: { namespace: username ?? "" },
      query: { limit: 10 },
    }),
    enabled: username !== null,
  });
  const words = filter.toLowerCase().trim();
  return (
    <Page>
      <div className="grid gap-6 lg:grid-cols-[18rem_1fr]">
        <section aria-labelledby="home-repositories" className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h2 id="home-repositories" className="text-sm font-semibold text-on-surface">
              Your repositories
            </h2>
            <ButtonLink href={paths.newRepository()} variant="primary" size="sm">
              <Icon name="plus" size={12} />
              New
            </ButtonLink>
          </div>
          <SearchInput
            label="Filter your repositories"
            placeholder="Find a repository"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
          <QueryView query={mine}>
            {(page) => {
              const shown = page.items.filter((r) =>
                `${r.owner.slug}/${r.name}`.toLowerCase().includes(words),
              );
              return shown.length === 0 ? (
                <EmptyState
                  action={
                    page.items.length === 0 ? (
                      <ButtonLink href={paths.newRepository()}>New repository</ButtonLink>
                    ) : undefined
                  }
                >
                  {page.items.length === 0 ? "No repositories yet" : "No repositories match"}
                </EmptyState>
              ) : (
                <ul className="space-y-0.5">
                  {shown.map((repository) => (
                    <li key={repository.id}>
                      <AppLink
                        href={paths.repo({ owner: repository.owner.slug, repo: repository.name })}
                        className="flex items-center gap-2 rounded px-2 py-1 text-xs hover:bg-surface-sunken"
                      >
                        <Icon
                          name={
                            repository.visibility === "private"
                              ? "lock"
                              : repository.isFork
                                ? "gitFork"
                                : "book"
                          }
                          size={13}
                          className="text-on-surface-muted"
                        />
                        <span className="truncate">
                          <span className="text-on-surface-secondary">
                            {repository.owner.slug}/
                          </span>
                          <span className="font-medium text-on-surface">{repository.name}</span>
                        </span>
                      </AppLink>
                    </li>
                  ))}
                </ul>
              );
            }}
          </QueryView>
        </section>

        <div className="min-w-0 space-y-6">
          {mode === "agent" ? <InboxSection /> : null}
          <section aria-labelledby="home-activity" className="space-y-2">
            <h2 id="home-activity" className="text-sm font-semibold text-on-surface">
              Recent pushes
            </h2>
            <QueryView query={mine}>
              {(page) => (
                <RecentPushes
                  repositories={page.items.filter((r) => r.pushedAt !== null).slice(0, 4)}
                />
              )}
            </QueryView>
          </section>

          {username !== null ? (
            <section aria-labelledby="home-starred" className="space-y-2">
              <div className="flex items-center justify-between">
                <h2 id="home-starred" className="text-sm font-semibold text-on-surface">
                  Starred
                </h2>
                <AppLink
                  href={paths.namespace(username, { tab: "stars" })}
                  className="text-xs text-on-surface-muted hover:underline"
                >
                  All stars
                </AppLink>
              </div>
              <Panel>
                <QueryView query={starred}>
                  {(page) =>
                    page.items.length === 0 ? (
                      <EmptyState
                        action={
                          <ButtonLink href={paths.explore()}>Explore repositories</ButtonLink>
                        }
                      >
                        No starred repositories
                      </EmptyState>
                    ) : (
                      <RepoList repositories={page.items} label="Starred repositories" />
                    )
                  }
                </QueryView>
              </Panel>
            </section>
          ) : null}
        </div>
      </div>
    </Page>
  );
}

/** The newest commits on the default branch of the repositories pushed to last. */
function RecentPushes({ repositories }: { repositories: ReadonlyArray<RepositorySummary> }) {
  const results = useQueries({
    queries: repositories.map((repository) =>
      queries.contents.listCommits({
        params: { owner: repository.owner.slug, repo: repository.name },
        query: { limit: 3 },
      }),
    ),
  });
  if (repositories.length === 0) {
    return (
      <Panel>
        <EmptyState>Nothing pushed yet</EmptyState>
      </Panel>
    );
  }
  return (
    <div className="space-y-3">
      {repositories.map((repository, index) => {
        const repo = { owner: repository.owner.slug, repo: repository.name };
        const commits = results[index]?.data?.items ?? [];
        return (
          <Panel key={repository.id}>
            <PanelHeader
              actions={
                repository.pushedAt !== null ? (
                  <RelativeTime iso={repository.pushedAt} />
                ) : undefined
              }
            >
              <Icon name="gitCommit" />
              <AppLink
                href={paths.repo(repo)}
                className="font-medium text-on-surface hover:underline"
              >
                {repository.owner.slug}/{repository.name}
              </AppLink>
              <span className="inline-flex items-center gap-1">
                <Icon name="gitBranch" size={12} />
                {repository.defaultBranch}
              </span>
            </PanelHeader>
            {results[index]?.isPending === true ? (
              <Loading framed={false} count={4} />
            ) : (
              <ul className="divide-y divide-border">
                {commits.map((commit) => (
                  <li key={commit.oid} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                    <CommitAuthors commit={commit} />
                    <AppLink
                      href={paths.commit(repo, commit.oid)}
                      className="min-w-0 flex-1 truncate text-on-surface-secondary hover:underline"
                    >
                      {showBidi(commit.summary)}
                    </AppLink>
                    <CommitStatusIcon state={commit.status} />
                    <AppLink
                      href={paths.commit(repo, commit.oid)}
                      className="font-mono text-on-surface-muted hover:underline"
                    >
                      {shortOid(commit.oid)}
                    </AppLink>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        );
      })}
    </div>
  );
}
