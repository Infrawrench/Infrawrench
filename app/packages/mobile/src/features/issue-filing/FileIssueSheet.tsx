import { useState } from "react";
import {
  buildJiraIssueDraft,
  type BuildJiraIssueDraftArgs,
  type JiraSourceKind,
} from "@infrawrench/client-core";
import { ChipSelect, FormError, Sheet, SheetActions, TextField } from "@/components/form";
import {
  useFileJiraIssue,
  useJiraIntegration,
  useJiraIssueTypes,
  useJiraProjects,
} from "../jira/useJira";
import {
  useFileLinearIssue,
  useLinearIntegration,
  useLinearTeams,
  type IssueTracker,
} from "./useIssueFiling";

const TRACKER_LABELS: Record<IssueTracker, string> = { jira: "Jira", linear: "Linear" };

/**
 * File a finding as an issue — the native counterpart of web's
 * `FileIssueModal`, over the same `POST /jira/issues` / `POST /linear/issues`
 * contracts.
 *
 * With both trackers available the sheet opens with a tracker chip choice;
 * with exactly one it goes straight to that tracker's form. The destination
 * fields — Jira's project and issue type, Linear's team — are chip pickers
 * fed by the API, defaulting to the org's saved defaults; there is no way to
 * type a project key or a team id here, the same as on web. The summary and
 * description are editable because a phone is exactly where somebody adds
 * "this is the one paging us".
 */
export function FileIssueSheet({
  visible,
  sourceKind,
  sourceId,
  draft,
  trackers,
  onClose,
}: {
  visible: boolean;
  sourceKind: JiraSourceKind;
  sourceId: string;
  draft: Omit<BuildJiraIssueDraftArgs, "sourceKind">;
  /** Trackers to offer — from `useFilableTrackers`. */
  trackers: readonly IssueTracker[];
  onClose: () => void;
}) {
  const [tracker, setTracker] = useState<IssueTracker | null>(
    trackers.length === 1 ? (trackers[0] ?? null) : null,
  );

  const jiraIntegration = useJiraIntegration();
  const linearIntegration = useLinearIntegration();
  const projects = useJiraProjects(visible && tracker === "jira");
  const teams = useLinearTeams(visible && tracker === "linear");
  const prefill = buildJiraIssueDraft({ sourceKind, ...draft });

  // Null means "the user has not chosen yet", so the organization's saved
  // default can still apply. Seeding these from `integration.data` instead
  // would silently discard those defaults: this sheet stays mounted and is
  // toggled with `visible`, so its initializers run at the parent's first
  // render — long before the integration query resolves. (The web modal does
  // not have this problem: its button only renders once the integration has
  // loaded, so by the time it mounts the defaults are already there.)
  const [projectChoice, setProjectChoice] = useState<string | null>(null);
  const [issueTypeChoice, setIssueTypeChoice] = useState<string | null>(null);
  const [teamChoice, setTeamChoice] = useState<string | null>(null);
  const projectKey = projectChoice ?? jiraIntegration.data?.defaultProjectKey ?? "";
  const [summary, setSummary] = useState(prefill.summary);
  const [description, setDescription] = useState(prefill.description);
  const [error, setError] = useState<string | null>(null);
  const issueTypes = useJiraIssueTypes(tracker === "jira" ? projectKey : "");
  const fileJira = useFileJiraIssue();
  const fileLinear = useFileLinearIssue();

  // Both destinations are *derived* from the loaded rows rather than corrected
  // by an effect after they arrive: an effect renders the stale choice once
  // before fixing it, and on a phone that one frame is a visible flicker of
  // the wrong project's issue type.

  // Issue types are per-project: a type carried over from another project
  // would fail the create, so fall back to the first this project offers.
  const issueTypeRows = issueTypes.data;
  const issueTypeSeed = issueTypeChoice ?? jiraIntegration.data?.defaultIssueTypeId ?? "";
  const issueTypeId = !issueTypeRows
    ? issueTypeSeed
    : issueTypeRows.some((t) => t.id === issueTypeSeed)
      ? issueTypeSeed
      : (issueTypeRows[0]?.id ?? "");

  // A workspace with one team should not make the user pick it.
  const teamRows = teams.data;
  const teamSeed = teamChoice ?? linearIntegration.data?.defaultTeamId ?? "";
  const teamId = !teamRows
    ? teamSeed
    : teamRows.some((t) => t.id === teamSeed)
      ? teamSeed
      : teamRows.length === 1
        ? (teamRows[0]?.id ?? "")
        : "";

  async function submit() {
    setError(null);
    try {
      if (tracker === "jira") {
        await fileJira.mutateAsync({
          sourceKind,
          sourceId,
          projectKey,
          issueTypeId,
          summary,
          description,
          labels: prefill.labels,
        });
      } else if (tracker === "linear") {
        // No labels: Linear's issueCreate takes label ids of existing labels,
        // and the draft's labels are free text meant for Jira.
        await fileLinear.mutateAsync({
          sourceKind,
          sourceId,
          teamId,
          title: summary,
          description,
        });
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to file the issue");
    }
  }

  const ready =
    Boolean(summary.trim()) &&
    (tracker === "jira" ? Boolean(projectKey && issueTypeId) : Boolean(tracker && teamId));
  const pending = fileJira.isPending || fileLinear.isPending;

  const title =
    tracker === "jira"
      ? "File a Jira issue"
      : tracker === "linear"
        ? "File a Linear issue"
        : "File an issue";
  const description_ =
    tracker === "jira"
      ? jiraIntegration.data
        ? `Creates an issue in ${jiraIntegration.data.siteUrl} and keeps the link on this finding.`
        : "Connect Jira from the web or desktop app first."
      : tracker === "linear"
        ? "Creates an issue in your Linear workspace and keeps the link on this finding."
        : "Both trackers are connected — pick where this finding should be tracked.";

  return (
    <Sheet
      visible={visible}
      title={title}
      description={description_}
      onClose={onClose}
      footer={
        <SheetActions
          onCancel={onClose}
          onSubmit={() => void submit()}
          submitLabel="Create issue"
          submitting={pending || !ready}
        />
      }
    >
      {trackers.length > 1 && (
        <ChipSelect
          label="Tracker"
          options={trackers.map((t) => ({ value: t, label: TRACKER_LABELS[t] }))}
          value={tracker}
          onChange={(t) => {
            setTracker(t as IssueTracker);
            setError(null);
          }}
        />
      )}
      {tracker === "jira" && (
        <>
          <ChipSelect
            label="Project"
            hint={projects.isLoading ? "Loading projects…" : undefined}
            options={(projects.data ?? []).map((p) => ({
              value: p.key,
              label: `${p.name} (${p.key})`,
            }))}
            value={projectKey || null}
            onChange={(key) => {
              setProjectChoice(key);
              // Empty string, not null: null would re-apply the organization's
              // default issue type, which belongs to the project just left.
              setIssueTypeChoice("");
            }}
          />
          <ChipSelect
            label="Issue type"
            hint={!projectKey ? "Pick a project first" : undefined}
            options={(issueTypeRows ?? []).map((t) => ({ value: t.id, label: t.name }))}
            value={issueTypeId || null}
            onChange={setIssueTypeChoice}
          />
        </>
      )}
      {tracker === "linear" && (
        <ChipSelect
          label="Team"
          hint={teams.isLoading ? "Loading teams…" : undefined}
          options={(teamRows ?? []).map((t) => ({ value: t.id, label: `${t.name} (${t.key})` }))}
          value={teamId || null}
          onChange={setTeamChoice}
        />
      )}
      {tracker && (
        <>
          <TextField
            label={tracker === "jira" ? "Summary" : "Title"}
            value={summary}
            onChangeText={setSummary}
            autoCapitalize="sentences"
          />
          <TextField
            label="Description"
            value={description}
            onChangeText={setDescription}
            multiline
            autoCapitalize="sentences"
          />
        </>
      )}
      <FormError message={error} />
    </Sheet>
  );
}
