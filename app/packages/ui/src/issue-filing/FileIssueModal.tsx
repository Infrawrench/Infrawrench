import { useEffect, useState } from "react";
import type {
  CreateJiraIssueResult,
  CreateLinearIssueResult,
  JiraIssueDraft,
  JiraIssueType,
  JiraProject,
  JiraSourceKind,
  LinearTeam,
} from "@infrawrench/client-core";

import { Modal } from "../components/Modal.js";
import { useIssueFiling, type IssueFilingApi, type IssueTracker } from "./host.js";

export interface FileIssueModalProps {
  sourceKind: JiraSourceKind;
  sourceId: string;
  /** Prefilled summary/description/labels, built by the calling list. */
  draft: JiraIssueDraft;
  /**
   * Trackers to offer. With more than one, the modal opens with a tracker
   * choice; with exactly one it goes straight to that tracker's form.
   */
  trackers: readonly IssueTracker[];
  onClose: () => void;
}

const TRACKER_LABELS: Record<IssueTracker, string> = { jira: "Jira", linear: "Linear" };

/**
 * File one finding as an issue, in whichever tracker the org has connected.
 *
 * One modal rather than one per tracker because the finding-side half — the
 * summary, the description, the labels — is identical; only the destination
 * fields differ. Jira wants a project and an issue type, Linear wants a team,
 * and all of those are **pickers loaded from the tracker**, defaulting to
 * whatever the org set in Settings: they are the tracker's identifiers, not
 * the user's, and a typo in any of them comes back as an error that reads
 * like our bug.
 *
 * Unlike the ambient reads in the provider, everything here surfaces its
 * failure — the user pressed a button and is waiting, and a swallowed error
 * would tell them their work is tracked when no issue exists.
 */
export function FileIssueModal({
  sourceKind,
  sourceId,
  draft,
  trackers,
  onClose,
}: FileIssueModalProps) {
  const filing = useIssueFiling();
  const [tracker, setTracker] = useState<IssueTracker | undefined>(
    trackers.length === 1 ? trackers[0] : undefined,
  );

  // Jira destination state.
  const [projects, setProjects] = useState<JiraProject[] | null>(null);
  const [issueTypes, setIssueTypes] = useState<JiraIssueType[] | null>(null);
  const [projectKey, setProjectKey] = useState(filing?.jiraIntegration?.defaultProjectKey ?? "");
  const [issueTypeId, setIssueTypeId] = useState(filing?.jiraIntegration?.defaultIssueTypeId ?? "");

  // Linear destination state.
  const [teams, setTeams] = useState<LinearTeam[] | null>(null);
  const [teamId, setTeamId] = useState(filing?.linearIntegration?.defaultTeamId ?? "");

  // Finding state, shared by both trackers.
  const [summary, setSummary] = useState(draft.summary);
  const [description, setDescription] = useState(draft.description);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const orgId = filing?.orgId;
  const api: IssueFilingApi | undefined = filing?.api;

  useEffect(() => {
    if (!api || !orgId || tracker !== "jira") return;
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
  }, [api, orgId, tracker]);

  // Issue types are per-project: a type from the previously selected project
  // may not exist in this one, and offering it would fail the create.
  useEffect(() => {
    if (!api || !orgId || tracker !== "jira" || !projectKey) {
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
  }, [api, orgId, tracker, projectKey]);

  useEffect(() => {
    if (!api || !orgId || tracker !== "linear") return;
    let cancelled = false;
    void (async () => {
      try {
        const rows = await api.get<LinearTeam[]>(`/api/org/${orgId}/linear/teams`);
        if (cancelled) return;
        setTeams(rows);
        // A workspace with one team should not make the user pick it.
        setTeamId((current) =>
          rows.some((t) => t.id === current) ? current : rows.length === 1 ? rows[0]!.id : "",
        );
      } catch (e: unknown) {
        if (!cancelled) {
          setTeams([]);
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, orgId, tracker]);

  if (!filing || !api || !orgId) return null;

  async function submit() {
    if (!api || !orgId || !tracker) return;
    setBusy(true);
    setError(null);
    try {
      if (tracker === "jira") {
        const res = await api.post<CreateJiraIssueResult>(`/api/org/${orgId}/jira/issues`, {
          sourceKind,
          sourceId,
          projectKey,
          issueTypeId,
          summary,
          description,
          labels: draft.labels,
        });
        filing?.onJiraFiled(res.link);
      } else {
        // No labels: Linear's issueCreate takes label *ids* of existing
        // labels, and the draft's labels are free text meant for Jira.
        const res = await api.post<CreateLinearIssueResult>(`/api/org/${orgId}/linear/issues`, {
          sourceKind,
          sourceId,
          teamId,
          title: summary,
          description,
        });
        filing?.onLinearFiled(res.link);
      }
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  const inputClass =
    "w-full px-3 py-1.5 text-sm bg-surface border border-border rounded-lg focus:outline-none focus:border-border-strong disabled:opacity-60";
  const ready =
    Boolean(summary.trim()) &&
    (tracker === "jira"
      ? Boolean(projectKey && issueTypeId)
      : tracker === "linear"
        ? Boolean(teamId)
        : false);

  const heading =
    tracker === "jira"
      ? "File a Jira issue"
      : tracker === "linear"
        ? "File a Linear issue"
        : "File an issue";
  const destination =
    tracker === "jira"
      ? (filing.jiraIntegration?.siteUrl ?? "your Jira site")
      : "your Linear workspace";

  return (
    <Modal onClose={onClose} ariaLabel={heading}>
      <div className="bg-surface-raised border border-border-strong rounded-xl shadow-2xl w-[520px] max-w-[92vw] p-6">
        <h2 className="text-base font-semibold text-on-surface mb-1">{heading}</h2>
        <p className="text-xs text-on-surface-faint mb-4">
          {tracker
            ? `Creates an issue in ${destination} and keeps the link on this finding, so it will show as filed instead of offering this button again.`
            : "Both trackers are connected — pick where this finding should be tracked."}
        </p>

        {error !== null && (
          <div role="alert" className="mb-3 text-sm text-red-500">
            {error}
          </div>
        )}

        <div className="space-y-3">
          {trackers.length > 1 && (
            <div role="radiogroup" aria-label="Tracker" className="flex gap-2">
              {trackers.map((t) => (
                <button
                  key={t}
                  type="button"
                  role="radio"
                  aria-checked={tracker === t}
                  disabled={busy}
                  onClick={() => {
                    setTracker(t);
                    setError(null);
                  }}
                  className={`px-3 py-1.5 text-sm font-medium rounded-lg border transition-colors ${
                    tracker === t
                      ? "border-blue-600 text-blue-500 bg-blue-600/10"
                      : "border-border text-on-surface-secondary hover:bg-surface-overlay"
                  }`}
                >
                  {TRACKER_LABELS[t]}
                </button>
              ))}
            </div>
          )}

          {tracker === "jira" && (
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
          )}

          {tracker === "linear" && (
            <label className="block">
              <span className="block text-xs text-on-surface-tertiary mb-1">Team</span>
              <select
                value={teamId}
                disabled={busy || teams === null}
                onChange={(e) => setTeamId(e.target.value)}
                className={inputClass}
              >
                <option value="">{teams === null ? "Loading…" : "Select a team"}</option>
                {(teams ?? []).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({t.key})
                  </option>
                ))}
              </select>
            </label>
          )}

          {tracker && (
            <>
              <label className="block">
                <span className="block text-xs text-on-surface-tertiary mb-1">
                  {tracker === "jira" ? "Summary" : "Title"}
                </span>
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

              {tracker === "jira" && draft.labels.length > 0 && (
                <p className="text-xs text-on-surface-muted">Labels: {draft.labels.join(", ")}</p>
              )}
            </>
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

export interface FileJiraIssueModalProps {
  sourceKind: JiraSourceKind;
  sourceId: string;
  /** Prefilled summary/description/labels, built by the calling list. */
  draft: JiraIssueDraft;
  onClose: () => void;
}

/** @deprecated Jira-locked mount of {@link FileIssueModal}, kept for older hosts. */
export function FileJiraIssueModal(props: FileJiraIssueModalProps) {
  return <FileIssueModal {...props} trackers={["jira"]} />;
}
