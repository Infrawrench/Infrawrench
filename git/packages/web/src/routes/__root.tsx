import { useEffect } from "react";
import { Outlet, createRootRoute, useLocation } from "@tanstack/react-router";
import { useGo } from "../components/AppLink";
import { AppShell } from "../layout/AppShell";
import { paths } from "../lib/paths";
import { useSession } from "../lib/session";

/** Someone signed in without a username is sent to pick one, and comes back afterwards. */
function useUsernameOnboarding() {
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
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}

export const Route = createRootRoute({ component: Root });
