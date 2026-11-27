/** A user's or an organisation's page: who they are and their repositories. */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { REPOSITORY_LIST_TYPES, REPOSITORY_SORTS, type Namespace } from "@infrawrench/git-contract";
import { api } from "../../api/client";
import { queries, usePages } from "../../api/queries";
import { ButtonLink } from "../../components/Button";
import { LinkTabs } from "../../components/controls";
import { SearchInput, Select } from "../../components/forms";
import { Icon } from "../../components/icons";
import { Page, Panel, PanelHeader } from "../../components/Panel";
import { Avatar } from "../../components/people";
import { RepoList } from "../../components/RepoList";
import { EmptyState, ErrorState, Loading, LoadMore, QueryView } from "../../components/states";
import { formatDate, plural } from "../../lib/format";
import { paths } from "../../lib/paths";
import { webUrl } from "../../lib/safe-url";
import { SORT_LABEL, type RepositorySortName } from "../explore/ExplorePage";

type ListType = (typeof REPOSITORY_LIST_TYPES)[number];

const TYPE_LABEL: Record<ListType, string> = {
  all: "All",
  sources: "Sources",
  forks: "Forks",
  archived: "Archived",
  private: "Private",
};

export function NamespacePage({ slug, tab }: { slug: string; tab: "repositories" | "stars" }) {
  const namespace = useQuery(queries.namespaces.get({ params: { namespace: slug } }));
  return (
    <Page>
      <QueryView query={namespace}>
        {(data) => (
          <div className="grid gap-6 lg:grid-cols-[16rem_minmax(0,1fr)]">
            <Profile namespace={data} />
            <div className="min-w-0">
              {data.kind === "user" ? (
                <LinkTabs
                  label="Profile"
                  className="mb-4 border-b border-border"
                  tabs={[
                    {
                      label: "Repositories",
                      href: paths.namespace(data.slug),
                      icon: <Icon name="book" />,
                      count: data.repositoryCount,
                      match: () => tab === "repositories",
                    },
                    {
                      label: "Stars",
                      href: paths.namespace(data.slug, { tab: "stars" }),
                      icon: <Icon name="star" />,
                      match: () => tab === "stars",
                    },
                  ]}
                />
              ) : null}
              {tab === "stars" && data.kind === "user" ? (
                <Stars slug={data.slug} />
              ) : (
                <Repositories namespace={data} />
              )}
            </div>
          </div>
        )}
      </QueryView>
    </Page>
  );
}

function Profile({ namespace }: { namespace: Namespace }) {
  const name = namespace.displayName ?? namespace.slug;
  // The address is the person's own text: a link only when it is a web address.
  const website = webUrl(namespace.websiteUrl);
  return (
    <aside aria-label="Profile" className="space-y-3 text-xs">
      <div className="flex items-center gap-3 lg:flex-col lg:items-start">
        <Avatar name={name} src={namespace.avatarUrl} size={72} square={namespace.kind === "org"} />
        <div>
          <h1 className="text-base font-semibold text-on-surface">{name}</h1>
          <p className="text-on-surface-muted">{namespace.slug}</p>
        </div>
      </div>
      {namespace.description !== null && namespace.description !== "" ? (
        <p className="text-on-surface-secondary">{namespace.description}</p>
      ) : null}
      <dl className="space-y-1.5 text-on-surface-muted">
        <div className="flex items-center gap-1.5">
          <Icon name={namespace.kind === "org" ? "building" : "user"} size={12} />
          <dt className="sr-only">Kind</dt>
          <dd>{namespace.kind === "org" ? "Organisation" : "User"}</dd>
        </div>
        {namespace.location !== null && namespace.location !== "" ? (
          <div className="flex items-center gap-1.5">
            <Icon name="mapPin" size={12} />
            <dt className="sr-only">Location</dt>
            <dd>{namespace.location}</dd>
          </div>
        ) : null}
        {namespace.websiteUrl !== null && namespace.websiteUrl !== "" ? (
          <div className="flex items-center gap-1.5">
            <Icon name="link" size={12} />
            <dt className="sr-only">Website</dt>
            <dd className="min-w-0 truncate">
              {website !== null ? (
                <a href={website} rel="noopener noreferrer nofollow" className="text-accent">
                  {namespace.websiteUrl.replace(/^https?:\/\//, "")}
                </a>
              ) : (
                namespace.websiteUrl
              )}
            </dd>
          </div>
        ) : null}
        <div className="flex items-center gap-1.5">
          <Icon name="clock" size={12} />
          <dt>Joined</dt>
          <dd>{formatDate(namespace.createdAt)}</dd>
        </div>
      </dl>
      {namespace.appUrl !== null ? (
        <a
          href={namespace.appUrl}
          className="inline-flex items-center gap-1.5 text-on-surface-secondary hover:underline"
        >
          <Icon name="externalLink" size={12} />
          Open in Infrawrench
        </a>
      ) : null}
    </aside>
  );
}

function Repositories({ namespace }: { namespace: Namespace }) {
  const [q, setQ] = useState("");
  const [type, setType] = useState<ListType>("all");
  const [sort, setSort] = useState<RepositorySortName>("pushed");
  const [language, setLanguage] = useState("");
  const query = { ...(q === "" ? {} : { q }), type, sort, limit: 100 };
  const list = usePages(["repositoryLists", "listForNamespace", namespace.slug, query], (cursor) =>
    api.repositoryLists.listForNamespace({
      params: { namespace: namespace.slug },
      query: { ...query, ...(cursor === undefined ? {} : { cursor }) },
    }),
  );
  // The API has no language filter for this list, so it narrows what has loaded.
  const languages = [
    ...new Set(list.items.map((r) => r.primaryLanguage).filter((l): l is string => l !== null)),
  ].sort();
  const shown =
    language === "" ? list.items : list.items.filter((r) => r.primaryLanguage === language);
  const types = REPOSITORY_LIST_TYPES.filter(
    (name) => name !== "private" || namespace.viewer.isOwner,
  );

  return (
    <section aria-label="Repositories" className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput
          label="Find a repository"
          placeholder="Find a repository"
          value={q}
          onChange={(event) => setQ(event.target.value)}
          className="w-40"
        />
        <Select
          aria-label="Type"
          value={type}
          onChange={(event) => setType(event.target.value as ListType)}
          className="!w-28"
        >
          {types.map((name) => (
            <option key={name} value={name}>
              {TYPE_LABEL[name]}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Language"
          value={language}
          onChange={(event) => setLanguage(event.target.value)}
          className="!w-32"
        >
          <option value="">Any language</option>
          {languages.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Sort by"
          value={sort}
          onChange={(event) => setSort(event.target.value as RepositorySortName)}
          className="!w-36"
        >
          {REPOSITORY_SORTS.map((name) => (
            <option key={name} value={name}>
              {SORT_LABEL[name]}
            </option>
          ))}
        </Select>
        <div className="flex-1" />
        {namespace.viewer.canCreateRepository ? (
          <ButtonLink variant="primary" href={paths.newRepository(namespace.slug)}>
            <Icon name="plus" />
            New
          </ButtonLink>
        ) : null}
      </div>
      <Panel>
        {namespace.kind === "org" ? (
          <PanelHeader>
            <h2>{plural(namespace.repositoryCount, "repository", "repositories")}</h2>
          </PanelHeader>
        ) : null}
        {list.isLoading ? (
          <Loading framed={false} />
        ) : list.error ? (
          <ErrorState error={list.error} />
        ) : shown.length === 0 ? (
          <EmptyState
            action={
              list.items.length === 0 &&
              q === "" &&
              type === "all" &&
              namespace.viewer.canCreateRepository ? (
                <ButtonLink href={paths.newRepository(namespace.slug)}>New repository</ButtonLink>
              ) : undefined
            }
          >
            {list.items.length === 0 && q === "" && type === "all"
              ? "No repositories yet"
              : "No repositories match"}
          </EmptyState>
        ) : (
          <RepoList repositories={shown} showOwner={false} label="Repositories" />
        )}
      </Panel>
      <LoadMore pages={list} />
    </section>
  );
}

function Stars({ slug }: { slug: string }) {
  const list = usePages(["repositoryLists", "listStarredBy", slug], (cursor) =>
    api.repositoryLists.listStarredBy({
      params: { namespace: slug },
      query: { limit: 30, ...(cursor === undefined ? {} : { cursor }) },
    }),
  );
  return (
    <section aria-label="Starred repositories">
      <Panel>
        {list.isLoading ? (
          <Loading framed={false} />
        ) : list.error ? (
          <ErrorState error={list.error} />
        ) : list.items.length === 0 ? (
          <EmptyState>No starred repositories</EmptyState>
        ) : (
          <RepoList repositories={list.items} label="Starred repositories" />
        )}
      </Panel>
      <LoadMore pages={list} />
    </section>
  );
}
