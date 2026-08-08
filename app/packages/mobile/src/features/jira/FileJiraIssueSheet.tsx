import { useEffect, useState } from "react";
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
} from "./useJira";

/**
 * File a finding as a Jira issue — the native counterpart of web's
 * `FileJiraIssueModal`, over the same `POST /jira/issues` contract.
 *
 * Project and issue type are chip pickers fed by the API, defaulting to the
 * org's saved defaults; there is no way to type a project key here, the same
 * as on web. The summary and description are editable because a phone is
 * exactly where somebody adds "this is the one paging us".
 */
export function FileJiraIssueSheet({
  visible,
  sourceKind,
  sourceId,
  draft,
  onClose,
}: {
  visible: boolean;
  sourceKind: JiraSourceKind;
  sourceId: string;
  draft: Omit<BuildJiraIssueDraftArgs, "sourceKind">;
  onClose: () => void;
}) {
  const integration = useJiraIntegration();
  const projects = useJiraProjects(visible);
  const prefill = buildJiraIssueDraft({ sourceKind, ...draft });

  const [projectKey, setProjectKey] = useState(integration.data?.defaultProjectKey ?? "");
  const [issueTypeId, setIssueTypeId] = useState(integration.data?.defaultIssueTypeId ?? "");
  const [summary, setSummary] = useState(prefill.summary);
  const [description, setDescription] = useState(prefill.description);
  const [error, setError] = useState<string | null>(null);
  const issueTypes = useJiraIssueTypes(projectKey);
  const file = useFileJiraIssue();

  // Issue types are per-project: a type carried over from another project
  // would fail the create, so fall back to the first this project offers.
  useEffect(() => {
    const rows = issueTypes.data;
    if (!rows) return;
    setIssueTypeId((current) =>
      rows.some((t) => t.id === current) ? current : (rows[0]?.id ?? ""),
    );
  }, [issueTypes.data]);

  async function submit() {
    setError(null);
    try {
      await file.mutateAsync({
        sourceKind,
        sourceId,
        projectKey,
        issueTypeId,
        summary,
        description,
        labels: prefill.labels,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to file the issue");
    }
  }

  const ready = Boolean(projectKey && issueTypeId && summary.trim());

  return (
    <Sheet
      visible={visible}
      title="File a Jira issue"
      description={
        integration.data
          ? `Creates an issue in ${integration.data.siteUrl} and keeps the link on this finding.`
          : "Connect Jira from the web or desktop app first."
      }
      onClose={onClose}
      footer={
        <SheetActions
          onCancel={onClose}
          onSubmit={() => void submit()}
          submitLabel="Create issue"
          submitting={file.isPending || !ready}
        />
      }
    >
      <ChipSelect
        label="Project"
        hint={projects.isLoading ? "Loading projects…" : undefined}
        options={(projects.data ?? []).map((p) => ({
          value: p.key,
          label: `${p.name} (${p.key})`,
        }))}
        value={projectKey || null}
        onChange={(key) => {
          setProjectKey(key);
          setIssueTypeId("");
        }}
      />
      <ChipSelect
        label="Issue type"
        hint={!projectKey ? "Pick a project first" : undefined}
        options={(issueTypes.data ?? []).map((t) => ({ value: t.id, label: t.name }))}
        value={issueTypeId || null}
        onChange={setIssueTypeId}
      />
      <TextField
        label="Summary"
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
      <FormError message={error} />
    </Sheet>
  );
}
