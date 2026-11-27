/** A branch's page with the tab its address names: the review, its commits or its checks. */
import type { BranchPageTab } from "../../lib/paths";
import type { DiffMode } from "../review/branch";
import { BranchPage } from "../review/BranchPage";
import { BranchLayout } from "./BranchLayout";
import { ChecksTab } from "./ChecksTab";
import { CommitsTab } from "./CommitsTab";

export function BranchPageView({
  branchKey,
  tab,
  v,
  diff,
}: {
  branchKey: string;
  tab: BranchPageTab | undefined;
  v: number | undefined;
  diff: DiffMode | undefined;
}) {
  return (
    <BranchLayout branchKey={branchKey} tab={tab}>
      {tab === "commits" ? (
        <CommitsTab />
      ) : tab === "checks" ? (
        <ChecksTab />
      ) : (
        <BranchPage v={v} diff={diff} />
      )}
    </BranchLayout>
  );
}
