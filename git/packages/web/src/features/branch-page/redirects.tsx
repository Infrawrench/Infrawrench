/**
 * Addresses from before pages were named by their branch: a thread number
 * under the old prefix. Each goes where it now lives, the number through
 * `branches.locate`, the tab and the anchor kept.
 */
import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "@tanstack/react-router";
import { isNotFound } from "../../api/client";
import { queries } from "../../api/queries";
import { useGo } from "../../components/AppLink";
import { Page } from "../../components/Panel";
import { ErrorState, Loading } from "../../components/states";
import { useRepoRef } from "../../layout/RepoLayout";
import { paths, type BranchPageTab } from "../../lib/paths";

/** Goes to `to` in place of the address shown, keeping its anchor. */
function useReplace(to: string | null): void {
  const go = useGo();
  const hash = useLocation({ select: (location) => location.hash });
  const moved = useRef(false);
  useEffect(() => {
    if (to === null || moved.current) return;
    moved.current = true;
    go(`${to}${hash === "" ? "" : `#${hash}`}`, { replace: true });
  }, [to, hash, go]);
}

/** Where a numbered address goes: the branch's page, or the issue when the number is an issue's. */
export function NumberRedirect({ number, tab }: { number: number; tab?: string | undefined }) {
  const repo = useRepoRef();
  const located = useQuery({
    ...queries.branches.locate({ params: { ...repo, number } }),
    retry: false,
  });
  const shown: BranchPageTab | undefined = tab === "commits" || tab === "checks" ? tab : undefined;
  const to =
    located.data !== undefined
      ? paths.branchPage(repo, located.data.key, shown === undefined ? {} : { tab: shown })
      : isNotFound(located.error)
        ? paths.issue(repo, number)
        : null;
  useReplace(to);
  if (located.error && !isNotFound(located.error)) {
    return (
      <Page>
        <ErrorState error={located.error} onRetry={() => void located.refetch()} />
      </Page>
    );
  }
  return <Loading shape="page" />;
}

/**
 * An address that only moved: the list (its search kept: pages are searched
 * as the list was), the old form to open one, Start work.
 */
export function MovedRedirect({ to }: { to: "list" | "branches" | "start" }) {
  const repo = useRepoRef();
  const searchStr = useLocation({ select: (location) => location.searchStr });
  useReplace(
    to === "start"
      ? paths.startWork(repo)
      : `${paths.branches(repo)}${to === "list" ? searchStr : ""}`,
  );
  return <Loading shape="page" />;
}
