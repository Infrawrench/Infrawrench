import { createFileRoute } from "@tanstack/react-router";
import { UsernamePage } from "../features/onboarding/UsernamePage";

function UsernameRoute() {
  const { returnTo } = Route.useSearch();
  return <UsernamePage returnTo={returnTo} />;
}

export const Route = createFileRoute("/onboarding/username")({
  component: UsernameRoute,
  validateSearch: (search: Record<string, unknown>): { returnTo?: string } =>
    typeof search.returnTo === "string" ? { returnTo: search.returnTo } : {},
});
