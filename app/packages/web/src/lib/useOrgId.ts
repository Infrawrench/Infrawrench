import { useRouterState } from "@tanstack/react-router";

/**
 * Extract the active orgId from the current URL path.
 * Works in any component rendered under /org/:orgId/* routes.
 */
export function useOrgId(): string {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const match = pathname.match(/^\/org\/([^/]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : "";
}
