/** Search across public repositories. The query, language and sort live in the URL. */
import { useEffect, useState, type FormEvent } from "react";
import { REPOSITORY_SORTS } from "@infrawrench/git-contract";
import { api } from "../../api/client";
import { usePages } from "../../api/queries";
import { useGo } from "../../components/AppLink";
import { Button } from "../../components/Button";
import { Checkbox, Input, SearchInput, Select } from "../../components/forms";
import { Page, PageHeader, Panel } from "../../components/Panel";
import { RepoList } from "../../components/RepoList";
import { EmptyState, ErrorState, Loading, LoadMore } from "../../components/states";

export type RepositorySortName = (typeof REPOSITORY_SORTS)[number];

export const SORT_LABEL: Record<RepositorySortName, string> = {
  pushed: "Recently pushed",
  stars: "Most stars",
  name: "Name",
  created: "Newest",
};

export interface ExploreSearch {
  readonly q?: string | undefined;
  readonly language?: string | undefined;
  readonly sort?: RepositorySortName | undefined;
  readonly forks?: boolean | undefined;
}

const hrefOf = (search: ExploreSearch): string => {
  const params = new URLSearchParams();
  if (search.q) params.set("q", search.q);
  if (search.language) params.set("language", search.language);
  if (search.sort && search.sort !== "stars") params.set("sort", search.sort);
  if (search.forks === true) params.set("forks", "true");
  const text = params.toString();
  return text === "" ? "/explore" : `/explore?${text}`;
};

export function ExplorePage({ search }: { search: ExploreSearch }) {
  const go = useGo();
  const [q, setQ] = useState(search.q ?? "");
  const [language, setLanguage] = useState(search.language ?? "");
  useEffect(() => setQ(search.q ?? ""), [search.q]);
  useEffect(() => setLanguage(search.language ?? ""), [search.language]);

  const sort = search.sort ?? "stars";
  const query = {
    ...(search.q ? { q: search.q } : {}),
    ...(search.language ? { language: search.language } : {}),
    sort,
    includeForks: search.forks === true ? ("true" as const) : ("false" as const),
    limit: 20,
  };
  const results = usePages(["repositoryLists", "explore", query], (cursor) =>
    api.repositoryLists.explore({
      query: { ...query, ...(cursor === undefined ? {} : { cursor }) },
    }),
  );

  const update = (next: Partial<ExploreSearch>) =>
    go(hrefOf({ ...search, ...next }), { replace: true });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    update({ q: q.trim(), language: language.trim() });
  };

  return (
    <Page>
      <PageHeader title="Explore">
        <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
          <SearchInput
            label="Search repositories"
            placeholder="Search repositories"
            value={q}
            onChange={(event) => setQ(event.target.value)}
            className="w-72"
          />
          <Input
            aria-label="Language"
            placeholder="Language"
            value={language}
            onChange={(event) => setLanguage(event.target.value)}
            className="!w-36"
          />
          <Select
            aria-label="Sort by"
            value={sort}
            onChange={(event) => update({ sort: event.target.value as RepositorySortName })}
            className="!w-40"
          >
            {REPOSITORY_SORTS.map((name) => (
              <option key={name} value={name}>
                {SORT_LABEL[name]}
              </option>
            ))}
          </Select>
          <Checkbox
            label="Include forks"
            checked={search.forks === true}
            onChange={(event) => update({ forks: event.target.checked })}
          />
          <Button type="submit">Search</Button>
        </form>
      </PageHeader>
      <Panel>
        {results.isLoading ? (
          <Loading />
        ) : results.error ? (
          <ErrorState error={results.error} />
        ) : results.items.length === 0 ? (
          <EmptyState>No repositories match</EmptyState>
        ) : (
          <RepoList repositories={results.items} label="Repositories" />
        )}
      </Panel>
      <LoadMore pages={results} />
    </Page>
  );
}
