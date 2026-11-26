/**
 * Where a branch stands, asked once for the header and the page under it,
 * and asked again every few seconds while an agent or a review is at work.
 */
import { useQuery } from "@tanstack/react-query";
import { queries } from "../../api/queries";
import { Icon, Spinner, type IconName } from "../../components/icons";
import { useRepoRef } from "../../layout/RepoLayout";
import { isLive, needsNow, type Tone } from "./branch";

/** How often the page asks again while an agent or a review is at work. */
export const LIVE_MS = 4000;

const TONE_CLASS: Record<Tone, string> = {
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
  notice: "text-notice",
  neutral: "text-on-surface-muted",
};
const TONE_ICON: Record<Tone, IconName> = {
  success: "checkCircle",
  warning: "eye",
  danger: "alertCircle",
  notice: "bot",
  neutral: "circleDot",
};

export function useBranchState(number: number) {
  const repo = useRepoRef();
  return useQuery({
    ...queries.versions.branchState({ params: { ...repo, number } }),
    refetchInterval: (query) => (isLive(query.state.data) ? LIVE_MS : false),
  });
}

/** The line under a branch's title: what it needs now. */
export function BranchNeeds({ number }: { number: number }) {
  const state = useBranchState(number);
  if (state.data === undefined) return null;
  const { tone, text } = needsNow(state.data);
  return (
    <p role="status" className="mt-3 flex items-center gap-2 text-sm text-on-surface-secondary">
      {state.data.state === "agent_working" ? (
        <Spinner size={15} className={TONE_CLASS[tone]} />
      ) : (
        <Icon name={TONE_ICON[tone]} size={15} className={TONE_CLASS[tone]} />
      )}
      {text}
    </p>
  );
}
