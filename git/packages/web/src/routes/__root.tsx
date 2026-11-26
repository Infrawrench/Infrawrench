import { useEffect } from "react";
import { Outlet, createRootRoute, useLocation } from "@tanstack/react-router";
import { useGo } from "../components/AppLink";
import { useReviewMode } from "../features/review/mode";
import { SidebarShell } from "../layout/SidebarShell";
import { AppShell } from "../layout/AppShell";
import { paths } from "../lib/paths";
import { useDocumentTitle } from "../lib/title";
import { useSession } from "../lib/session";

/** Someone signed in without a username is sent to pick one, and comes back afterwards. */
function useUsernameOnboarding(): boolean {
  const session = useSession();
  const go = useGo();
  const location = useLocation();
  const needsUsername =
    session.data?.onboarding?.needsUsername === true &&
    // git-feature-flag: nobody is sent to a username page they cannot use.
    session.data.onboarding.signupsOpen;
  const onPage = location.pathname === "/onboarding/username";
  const here = location.href;
  useEffect(() => {
    if (needsUsername && !onPage) go(paths.onboardingUsername(here), { replace: true });
  }, [needsUsername, onPage, here, go]);
  return needsUsername;
}

function Root() {
  const needsUsername = useUsernameOnboarding();
  useDocumentTitle();
  const session = useSession();
  const { mode } = useReviewMode();
  const user = session.data?.user ?? null;
  // Not one frame and then the other: nothing is drawn until the mode is known.
  if (mode === undefined) return <div className="min-h-screen bg-surface" />;
  // The sidebar is the frame of anyone signed in who has a name to work under: what it holds follows their mode.
  if (session.data !== undefined && user !== null && !needsUsername) {
    return (
      <SidebarShell user={user} appUrl={session.data.appUrl} mode={mode}>
        <Outlet />
      </SidebarShell>
    );
  }
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}

export const Route = createRootRoute({ component: Root });
