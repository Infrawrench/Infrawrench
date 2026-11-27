import { createFileRoute } from "@tanstack/react-router";
import { REPOSITORY_SORTS } from "@infrawrench/git-contract";
import { ExplorePage, type ExploreSearch } from "../features/explore/ExplorePage";

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value !== ""
    ? value
    : typeof value === "number"
      ? String(value)
      : undefined;

function ExploreRoute() {
  return <ExplorePage search={Route.useSearch()} />;
}

export const Route = createFileRoute("/explore")({
  component: ExploreRoute,
  validateSearch: (search: Record<string, unknown>): ExploreSearch => {
    const sort = REPOSITORY_SORTS.find((name) => name === search.sort);
    return {
      q: text(search.q),
      language: text(search.language),
      sort,
      forks: search.forks === true || search.forks === "true" ? true : undefined,
    };
  },
});
