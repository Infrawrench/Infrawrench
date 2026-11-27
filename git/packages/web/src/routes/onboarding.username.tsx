import { createFileRoute } from "@tanstack/react-router";
import { UsernamePage } from "../features/onboarding/UsernamePage";

function UsernameRoute() {
  const { returnTo, checkout, workspace, username } = Route.useSearch();
  return (
    <UsernamePage returnTo={returnTo} returned={checkout} workspace={workspace} chosen={username} />
  );
}

export const Route = createFileRoute("/onboarding/username")({
  component: UsernameRoute,
  // `checkout` and `workspace` are what the app adds when it sends someone
  // back from paying, for a username or for a workspace; `username` is the
  // one they had chosen before they left to pay for a workspace.
  validateSearch: (
    search: Record<string, unknown>,
  ): { returnTo?: string; checkout?: string; workspace?: string; username?: string } => ({
    ...(typeof search.returnTo === "string" ? { returnTo: search.returnTo } : {}),
    ...(typeof search.checkout === "string" ? { checkout: search.checkout } : {}),
    ...(typeof search.workspace === "string" ? { workspace: search.workspace } : {}),
    ...(typeof search.username === "string" ? { username: search.username } : {}),
  }),
});
