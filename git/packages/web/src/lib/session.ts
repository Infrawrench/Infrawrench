/** Who is signed in, and the ways in and out. */
import { useQuery } from "@tanstack/react-query";
import { signInPath } from "@infrawrench/git-contract";
import { api } from "../api/client";
import { queries } from "../api/queries";

export const IS_MOCK = import.meta.env.VITE_GIT_MOCK === "1";

/** The session. `data.user` is null for a signed-out browser; it is never an error. */
export function useSession() {
  return useQuery({ ...queries.session.me(), staleTime: 5 * 60_000 });
}

/**
 * Where "Sign in" goes, coming back to `returnTo` (a path on this site).
 * Sign-in is a page load, not a route: link to it with a plain `<a>`.
 */
export function signInHref(returnTo: string = currentPath()): string {
  if (IS_MOCK) {
    // The mock has no AuthKit to redirect through: reload as the signed-in scenario.
    const url = new URL(returnTo, window.location.origin);
    url.searchParams.set("mock", "signed-in");
    return url.pathname + url.search + url.hash;
  }
  return signInPath(returnTo);
}

export function currentPath(): string {
  return window.location.pathname + window.location.search + window.location.hash;
}

/** Signs out and loads the page the server names, so nothing cached for the person stays on screen. */
export async function signOut(): Promise<void> {
  const { redirectTo } = await api.session.signOut();
  window.location.assign(redirectTo);
}
