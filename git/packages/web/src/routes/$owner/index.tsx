import { createFileRoute } from "@tanstack/react-router";
import { NamespacePage } from "../../features/namespace/NamespacePage";

function NamespaceRoute() {
  const { owner } = Route.useParams();
  const { tab } = Route.useSearch();
  return (
    <NamespacePage key={owner} slug={owner} tab={tab === "stars" ? "stars" : "repositories"} />
  );
}

export const Route = createFileRoute("/$owner/")({
  component: NamespaceRoute,
  validateSearch: (search: Record<string, unknown>): { tab?: "stars" } =>
    search.tab === "stars" ? { tab: "stars" } : {},
});
