import { createFileRoute } from "@tanstack/react-router";
import { NewRepositoryPage } from "../features/new-repository/NewRepositoryPage";

function NewRepositoryRoute() {
  const { owner } = Route.useSearch();
  return <NewRepositoryPage owner={owner} />;
}

export const Route = createFileRoute("/new")({
  component: NewRepositoryRoute,
  validateSearch: (search: Record<string, unknown>): { owner?: string } =>
    typeof search.owner === "string" && search.owner !== "" ? { owner: search.owner } : {},
});
