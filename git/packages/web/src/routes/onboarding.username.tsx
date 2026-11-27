import { createFileRoute } from "@tanstack/react-router";
import { UsernamePage } from "../features/onboarding/UsernamePage";

function UsernameRoute() {
  const { returnTo, checkout } = Route.useSearch();
  return <UsernamePage returnTo={returnTo} returned={checkout} />;
}

export const Route = createFileRoute("/onboarding/username")({
  component: UsernameRoute,
  // `checkout` is what the app adds when it sends someone back from paying.
  validateSearch: (search: Record<string, unknown>): { returnTo?: string; checkout?: string } => ({
    ...(typeof search.returnTo === "string" ? { returnTo: search.returnTo } : {}),
    ...(typeof search.checkout === "string" ? { checkout: search.checkout } : {}),
  }),
});
