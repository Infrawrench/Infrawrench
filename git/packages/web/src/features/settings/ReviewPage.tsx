import type { ReviewMode } from "@infrawrench/git-contract";
import { RadioCards } from "../../components/forms";
import { SettingsSection } from "../../components/SideNav";
import { InlineError, Loading } from "../../components/states";
import { MODE_LABEL, useReviewMode, useSetReviewMode } from "../review/mode";

/** How pull requests open for the signed-in person: the branch page, or the pull request as it was. */
export function ReviewPage() {
  const { mode } = useReviewMode();
  const change = useSetReviewMode();
  return (
    <SettingsSection title="Review">
      {mode === undefined ? (
        <Loading shape="rows" count={2} />
      ) : (
        <div className="max-w-md">
          <RadioCards<ReviewMode>
            legend="Open pull requests as"
            name="review-mode"
            value={change.isPending && change.variables !== undefined ? change.variables : mode}
            onChange={(next) => {
              if (next !== mode) change.mutate(next);
            }}
            options={[
              {
                value: "agent",
                label: MODE_LABEL.agent,
                detail: "Versions, traces and findings",
              },
              {
                value: "classic",
                label: MODE_LABEL.classic,
                detail: "Conversation, commits, checks and files",
              },
            ]}
          />
          <div role="status" className="pt-2">
            <InlineError error={change.error} />
          </div>
        </div>
      )}
    </SettingsSection>
  );
}
