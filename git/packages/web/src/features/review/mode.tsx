/**
 * How the viewer reads a branch: its branch page (`agent`, the default) or
 * the pull request as it always was (`classic`). The address is the same
 * either way, so every link to a pull request follows the choice.
 */
import { useMutation, useQuery } from "@tanstack/react-query";
import type { ReviewMode } from "@infrawrench/git-contract";
import { api } from "../../api/client";
import { queries, queryClient } from "../../api/queries";
import { Segmented } from "../../components/controls";
import { useSession } from "../../lib/session";

export const MODE_LABEL: Record<ReviewMode, string> = {
  agent: "Branch page",
  classic: "Classic",
};

export const MODE_OPTIONS: ReadonlyArray<{ value: ReviewMode; label: string }> = [
  { value: "agent", label: MODE_LABEL.agent },
  { value: "classic", label: MODE_LABEL.classic },
];

/**
 * The viewer's mode. `mode` is undefined until it is known, so a page does
 * not draw one layout and then the other. A signed-out reader, and a server
 * that cannot say, get the default.
 */
export function useReviewMode(): { mode: ReviewMode | undefined; signedIn: boolean } {
  const session = useSession();
  const signedIn = session.data !== undefined && session.data.user !== null;
  const stored = useQuery({
    ...queries.review.mode(),
    enabled: signedIn,
    staleTime: 5 * 60_000,
    retry: false,
  });
  if (session.data === undefined && !session.isError) return { mode: undefined, signedIn: false };
  if (!signedIn) return { mode: "agent", signedIn: false };
  if (stored.data !== undefined) return { mode: stored.data.mode, signedIn };
  return { mode: stored.isError ? "agent" : undefined, signedIn };
}

export function useSetReviewMode() {
  return useMutation({
    mutationFn: (mode: ReviewMode) => api.review.setMode({ payload: { mode } }),
    onSuccess: (saved) => {
      queryClient.setQueryData(queries.review.mode().queryKey, saved);
      void queryClient.invalidateQueries({ queryKey: ["review", "inbox"] });
    },
  });
}

/** The quiet switch in a pull request's header. Nothing for a signed-out reader. */
export function ModeSwitch() {
  const { mode, signedIn } = useReviewMode();
  const change = useSetReviewMode();
  if (!signedIn || mode === undefined) return null;
  return (
    <Segmented<ReviewMode>
      label="Open pull requests as"
      value={change.isPending && change.variables !== undefined ? change.variables : mode}
      onChange={(next) => {
        if (next !== mode) change.mutate(next);
      }}
      options={MODE_OPTIONS}
    />
  );
}
