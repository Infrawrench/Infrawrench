import { createFileRoute } from "@tanstack/react-router";
import { ProfilePage } from "../features/settings/ProfilePage";

function ProfileRoute() {
  const { checkout } = Route.useSearch();
  return <ProfilePage returned={checkout} />;
}

export const Route = createFileRoute("/settings/")({
  component: ProfileRoute,
  // `checkout` is what the app adds when it sends someone back from paying for a username.
  validateSearch: (search: Record<string, unknown>): { checkout?: string } =>
    typeof search.checkout === "string" ? { checkout: search.checkout } : {},
});
