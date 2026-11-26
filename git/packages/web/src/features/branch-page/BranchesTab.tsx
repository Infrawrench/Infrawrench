/**
 * A repository's Branches tab. Its first view is the branches' pages, open,
 * merged and closed, searched as the issue list is; the other (`?view=all`)
 * is every Git branch, to create, delete, compare and, on a fork, propose.
 */
import { QuietTabs } from "../../components/controls";
import { useRepoRef, useRepository } from "../../layout/RepoLayout";
import { paths } from "../../lib/paths";
import { ThreadList } from "../issues/ThreadList";
import { AllBranches } from "./AllBranches";

export function BranchesTab({ q, view }: { q: string | undefined; view: "all" | undefined }) {
  const repo = useRepoRef();
  const repository = useRepository();
  const lead = (
    <QuietTabs
      label="Branches"
      className="-ml-2 mb-4"
      tabs={[
        {
          label: "Branch pages",
          href: paths.branches(repo),
          count: repository.openBranchCount,
          active: view === undefined,
        },
        {
          label: "All branches",
          href: paths.branches(repo, { view: "all" }),
          count: repository.branchCount,
          active: view === "all",
        },
      ]}
    />
  );
  return view === "all" ? (
    <AllBranches lead={lead} />
  ) : (
    <ThreadList kind="branches" q={q} lead={lead} />
  );
}
