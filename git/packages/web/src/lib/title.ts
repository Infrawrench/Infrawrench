/**
 * The tab's title, following the page: `Issues · acme/infra · Infrawrench
 * Git`. The root route sets it from the path (`titleForPath`), which covers
 * every page; a page that knows something better (an issue's title, the
 * folder a ref resolved to) says so with `usePageTitle`, which wins for as
 * long as that page is shown.
 */
import { useEffect, useSyncExternalStore } from "react";
import { useLocation } from "@tanstack/react-router";

export const SITE_TITLE = "Infrawrench Git";

const decode = (segment: string): string => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

const join = (...parts: ReadonlyArray<string | null | undefined>): string =>
  [
    ...parts.filter((part): part is string => part !== null && part !== undefined && part !== ""),
    SITE_TITLE,
  ].join(" · ");

/** What a repository's sections are called in a title. */
const SECTIONS: Record<string, string> = {
  issues: "Issues",
  pulls: "Pull requests",
  ci: "CI",
  infrastructure: "Infrastructure",
  settings: "Settings",
  branches: "Branches",
  tags: "Tags",
  compare: "Compare",
  commits: "Commits",
  commit: "Commit",
  tree: "",
  blob: "",
  blame: "Blame",
};

/** The title for a path, from the path alone. */
export function titleForPath(pathname: string): string {
  const parts = pathname.split("/").filter(Boolean).map(decode);
  const [first, second, third, fourth, fifth] = parts;
  if (first === undefined) return SITE_TITLE;
  if (first === "explore") return join("Explore");
  if (first === "new") return join("New repository");
  if (first === "onboarding") return join("Choose a username");
  if (first === "settings") {
    const page =
      second === "keys"
        ? "SSH keys"
        : second === "tokens"
          ? "Access tokens"
          : second === "review"
            ? "Review"
            : null;
    return join(page, "Settings");
  }
  if (second === undefined) return join(first);
  const repo = `${first}/${second}`;
  if (third === undefined) return join(repo);
  const section = SECTIONS[third];
  if (section === undefined) return join(repo);
  if (third === "issues") {
    if (fourth === "new") return join("New issue", repo);
    if (fourth === "labels") return join("Labels", repo);
    if (fourth === "milestones") return join(fifth ? `Milestone ${fifth}` : "Milestones", repo);
    if (fourth !== undefined) return join(`Issue #${fourth}`, repo);
  }
  if (third === "pulls") {
    if (fourth === "new") return join("New pull request", repo);
    if (fourth === "start") return join("Start work", repo);
    if (fourth !== undefined) return join(`Pull request #${fourth}`, repo);
  }
  if (third === "ci" && fourth === "runs" && fifth !== undefined) return join("CI run", repo);
  if (third === "commit" && fourth !== undefined) return join(`Commit ${fourth.slice(0, 7)}`, repo);
  if (third === "infrastructure" && fourth !== undefined)
    return join(fourth, "Infrastructure", repo);
  if (third === "settings" && fourth !== undefined) {
    return join(`${fourth.charAt(0).toUpperCase()}${fourth.slice(1)}`, "Settings", repo);
  }
  return join(section, repo);
}

// A page's own title, by the path it was set for.
const overrides = new Map<string, string>();
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};

/** Sets the tab's title while this page is shown. `null` leaves the path's own. */
export function usePageTitle(...parts: ReadonlyArray<string | null | undefined>): void {
  const { pathname } = useLocation();
  const title = parts.some((part) => part === undefined || part === null) ? null : join(...parts);
  useEffect(() => {
    if (title === null) return;
    overrides.set(pathname, title);
    notify();
    return () => {
      if (overrides.get(pathname) === title) overrides.delete(pathname);
      notify();
    };
  }, [pathname, title]);
}

/** For the root route: keeps `document.title` on the page shown. */
export function useDocumentTitle(): void {
  const { pathname } = useLocation();
  const override = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => overrides.get(pathname),
  );
  const title = override ?? titleForPath(pathname);
  useEffect(() => {
    document.title = title;
  }, [title]);
}
