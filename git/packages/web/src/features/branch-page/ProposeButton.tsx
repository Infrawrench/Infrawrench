/**
 * A fork's branch proposed to the repository it was forked from: a page is
 * opened for it there, and the reader goes to it. A branch that already has
 * an open page there goes to that page.
 */
import { useMutation } from "@tanstack/react-query";
import { formatBranchKey, type Repository } from "@infrawrench/git-contract";
import { ApiError, api } from "../../api/client";
import { invalidate } from "../../api/queries";
import { useGo } from "../../components/AppLink";
import { Button } from "../../components/Button";
import { Icon } from "../../components/icons";
import { InlineError } from "../../components/states";
import { paths } from "../../lib/paths";
import { useSession } from "../../lib/session";

export function ProposeButton({
  fork,
  branch,
  size = "sm",
}: {
  /** The fork the branch is in. Nothing is drawn for a repository that is not one. */
  fork: Pick<Repository, "owner" | "name" | "parent">;
  branch: string;
  size?: "sm" | "md";
}) {
  const go = useGo();
  const session = useSession();
  const parent = fork.parent;
  const target = parent === null ? null : { owner: parent.owner, repo: parent.name };
  const headRepository = `${fork.owner.slug}/${fork.name}`;
  const propose = useMutation({
    mutationFn: () =>
      api.branches.propose({ params: target!, payload: { head: branch, headRepository } }),
    onSuccess: (page) => {
      void invalidate("branches");
      go(paths.branchPage(target!, page.key));
    },
    onError: (error) => {
      // Proposed already: its open page is the one the bare key names.
      if (error instanceof ApiError && error.code === "branch_page_exists") {
        const key = formatBranchKey({
          fork: { owner: fork.owner.slug, name: fork.name },
          branch,
        });
        go(paths.branchPage(target!, key));
      }
    },
  });
  if (target === null || session.data?.user == null) return null;
  const failed =
    propose.error instanceof ApiError && propose.error.code === "branch_page_exists"
      ? null
      : propose.error;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button
        size={size}
        busy={propose.isPending}
        onClick={() => propose.mutate()}
        title={`Open a page for ${branch} in ${target.owner}/${target.repo}`}
      >
        <Icon name="gitMerge" size={12} />
        Propose to {target.owner}/{target.repo}
      </Button>
      <InlineError error={failed} />
    </span>
  );
}
