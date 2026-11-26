import { useEffect } from "react";
import { Outlet, createRootRoute, useLocation } from "@tanstack/react-router";
import { useGo } from "../components/AppLink";
import { ErrorState } from "../components/states";
import { SidebarShell } from "../layout/SidebarShell";
import { paths } from "../lib/paths";
import { useDocumentTitle } from "../lib/title";
import { useSession } from "../lib/session";

/** Someone signed in without a username is sent to pick one, and comes back afterwards. */
function useUsernameOnboarding(): void {
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
}

function Root() {
  useUsernameOnboarding();
  useDocumentTitle();
  const session = useSession();
  // Not one sidebar and then the other: nothing is drawn until the reader is known.
  if (session.data === undefined) {
    return (
      <div className="min-h-screen bg-surface">
        {session.error ? (
          <ErrorState error={session.error} onRetry={() => void session.refetch()} />
        ) : null}
      </div>
    );
  }
  return (
    <SidebarShell session={session.data}>
      <Outlet />
    </SidebarShell>
  );
}

export const Route = createRootRoute({ component: Root });
