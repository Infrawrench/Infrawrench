import { useEffect, useState } from "react";
import type {
  CreateJiraIssueResult,
  JiraIssueDraft,
  JiraIssueType,
  JiraProject,
  JiraSourceKind,
} from "@infrawrench/client-core";

import { Modal } from "../components/Modal.js";
import { useJiraFiling, type JiraFilingApi } from "./host.js";

export interface FileJiraIssueModalProps {
  sourceKind: JiraSourceKind;
  sourceId: string;
  /** Prefilled summary/description/labels, built by the calling list. */
  draft: JiraIssueDraft;
  onClose: () => void;
}

/**
 * File one finding as a Jira issue.
 *
 * Project and issue type are pickers loaded from Jira, defaulting to whatever
 * the org set in Settings → Jira. Nobody types a project key or an issue type
 * id: those are Jira's identifiers, and a typo in either comes back as a 400
 * that reads like our bug.
 *
 * Unlike the ambient reads in the provider, everything here surfaces its
 * failure — the user pressed a button and is waiting, and a swallowed error
 * would tell them their work is tracked when no issue exists.
 */
export function FileJiraIssueModal({
  sourceKind,
  sourceId,
  draft,
  onClose,
}: FileJiraIssueModalProps) {
  const filing = useJiraFiling();
  const [projects, setProjects] = useState<JiraProject[] | null>(null);
  const [issueTypes, setIssueTypes] = useState<JiraIssueType[] | null>(null);
  const [projectKey, setProjectKey] = useState(filing?.integration?.defaultProjectKey ?? "");
  const [issueTypeId, setIssueTypeId] = useState(filing?.integration?.defaultIssueTypeId ?? "");
  const [summary, setSummary] = useState(draft.summary);
  const [description, setDescription] = useState(draft.description);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const orgId = filing?.orgId;
  const api: JiraFilingApi | undefined = filing?.api;

  useEffect(() => {
    if (!api || !orgId) return;
    let cancelled = false;
    void (async () => {
      try {
        const rows = await api.get<JiraProject[]>(`/api/org/${orgId}/jira/projects`);
        if (!cancelled) setProjects(rows);
      } catch (e: unknown) {
        if (!cancelled) {
          setProjects([]);
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, orgId]);

  // Issue types are per-project: a type from the previously selected project
  // may not exist in this one, and offering it would fail the create.
  useEffect(() => {
    if (!api || !orgId || !projectKey) {
      setIssueTypes(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const rows = await api.get<JiraIssueType[]>(
          `/api/org/${orgId}/jira/projects/${encodeURIComponent(projectKey)}/issue-types`,
        );
        if (cancelled) return;
        setIssueTypes(rows);
        // Keep the current selection only if this project actually has it.
        setIssueTypeId((current) =>
          rows.some((t) => t.id === current) ? current : (rows[0]?.id ?? ""),
        );
      } catch (e: unknown) {
        if (!cancelled) {
          setIssueTypes([]);
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, orgId, projectKey]);

  if (!filing || !api || !orgId) return null;

  async function submit() {
    if (!api || !orgId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<CreateJiraIssueResult>(`/api/org/${orgId}/jira/issues`, {
        sourceKind,
        sourceId,
        projectKey,
        issueTypeId,
        summary,
        description,
        labels: draft.labels,
      });
      filing?.onFiled(res.link);
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  const inputClass =
    "w-full px-3 py-1.5 text-sm bg-surface border border-border rounded-lg focus:outline-none focus:border-border-strong disabled:opacity-60";
  const ready = Boolean(projectKey && issueTypeId && summary.trim());

  return (
    <Modal onClose={onClose} ariaLabel="File a Jira issue">
      <div className="bg-surface-raised border border-border-strong rounded-xl shadow-2xl w-[520px] max-w-[92vw] p-6">
        <h2 className="text-base font-semibold text-on-surface mb-1">File a Jira issue</h2>
        <p className="text-xs text-on-surface-faint mb-4">
          Creates an issue in {filing.integration?.siteUrl ?? "your Jira site"} and keeps the link
          on this finding, so it will show as filed instead of offering this button again.
        </p>

        {error !== null && (
          <div role="alert" className="mb-3 text-sm text-red-500">
            {error}
          </div>
        )}

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="block text-xs text-on-surface-tertiary mb-1">Project</span>
              <select
                value={projectKey}
                disabled={busy || projects === null}
                onChange={(e) => setProjectKey(e.target.value)}
                className={inputClass}
              >
                <option value="">{projects === null ? "Loading…" : "Select a project"}</option>
                {(projects ?? []).map((p) => (
                  <option key={p.id} value={p.key}>
                    {p.name} ({p.key})
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="block text-xs text-on-surface-tertiary mb-1">Issue type</span>
              <select
                value={issueTypeId}
                disabled={busy || !projectKey || issueTypes === null}
                onChange={(e) => setIssueTypeId(e.target.value)}
                className={inputClass}
              >
                <option value="">
                  {!projectKey
                    ? "Pick a project first"
                    : issueTypes === null
                      ? "Loading…"
                      : "Select a type"}
                </option>
                {(issueTypes ?? []).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="block">
            <span className="block text-xs text-on-surface-tertiary mb-1">Summary</span>
            <input
              type="text"
              value={summary}
              disabled={busy}
              maxLength={255}
              onChange={(e) => setSummary(e.target.value)}
              className={inputClass}
            />
          </label>

          <label className="block">
            <span className="block text-xs text-on-surface-tertiary mb-1">Description</span>
            <textarea
              value={description}
              disabled={busy}
              rows={8}
              onChange={(e) => setDescription(e.target.value)}
              className={`${inputClass} font-mono text-xs`}
            />
          </label>

          {draft.labels.length > 0 && (
            <p className="text-xs text-on-surface-muted">Labels: {draft.labels.join(", ")}</p>
          )}
        </div>

        <div className="flex justify-end gap-2 mt-5">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="px-3 py-1.5 text-sm font-medium border border-border hover:bg-surface-overlay disabled:opacity-50 text-on-surface-secondary rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy || !ready}
            className="px-3 py-1.5 text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg transition-colors"
          >
            {busy ? "Filing…" : "Create issue"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
