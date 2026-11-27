import { createFileRoute } from "@tanstack/react-router";
import { OrganisationsPage } from "../features/settings/OrganisationsPage";

function OrganisationsRoute() {
  const { workspace } = Route.useSearch();
  return <OrganisationsPage returned={workspace} />;
}

export const Route = createFileRoute("/settings/organisations")({
  component: OrganisationsRoute,
  // `workspace` is what the app adds when it sends someone back from paying for a workspace.
  validateSearch: (search: Record<string, unknown>): { workspace?: string } =>
    typeof search.workspace === "string" ? { workspace: search.workspace } : {},
});
