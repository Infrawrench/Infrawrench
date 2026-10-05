import { useEffect, useState } from "react";
import { useGT } from "gt-react";
import {
  GithubPermissionRequiredClientError,
  remediationCommandLines,
  type BuildJiraIssueDraftArgs,
  type FileGithubIssueResult,
  type GithubIssueRouteResolution,
  type GithubPermissionRequiredPayload,
  type GithubRepoRef,
} from "@infrawrench/client-core";
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
import {
  GithubAssigneesPicker,
  GithubLabelsPicker,
  GithubPermissionPrompt,
  GithubRepoPicker,
  missingGithubPermissions,
  permissionPayloadFor,
  useGithubRepos,
} from "./github.js";

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
  /**
   * The raw finding, for GitHub: its issue body is built server-side from the
   * evidence (a table) rather than from the plain-text draft.
   */
  finding?:
    | (Omit<BuildJiraIssueDraftArgs, "sourceKind"> & {
        resourceId?: string | undefined;
        monthlyCost?: { amount: number; currency: string } | undefined;
      })
    | undefined;
  onClose: () => void;
}

const TRACKER_LABELS: Record<IssueTracker, string> = {
  jira: "Jira",
  linear: "Linear",
  github: "GitHub",
};

/**
 * File one finding as an issue, in whichever tracker the org has connected.
 *
 * One modal rather than one per tracker because the finding-side half (the
 * summary, the description, the labels) is identical; only the destination
 * fields differ. Jira wants a project and an issue type, Linear wants a team,
 * and all of those are **pickers loaded from the tracker**, defaulting to
 * whatever the org set in Settings: they are the tracker's identifiers, not
 * the user's, and a typo in any of them comes back as an error that reads
 * like our bug.
 *
 * Unlike the ambient reads in the provider, everything here surfaces its
 * failure: the user pressed a button and is waiting, and a swallowed error
 * would tell them their work is tracked when no issue exists.
 */
export function FileIssueModal({
  sourceKind,
  sourceId,
  draft,
  trackers,
  finding,
  onClose,
}: FileIssueModalProps) {
  const gt = useGT();
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

  // GitHub destination state: preselected from the org's routing.
  const githubRepos = useGithubRepos(filing?.api, filing?.orgId ?? "", trackers.includes("github"));
  const [githubRepo, setGithubRepo] = useState<GithubRepoRef | null>(null);
  const [githubLabels, setGithubLabels] = useState<string[]>([]);
  const [githubAssignees, setGithubAssignees] = useState<string[]>([]);
  const [githubNote, setGithubNote] = useState(finding?.note ?? "");
  const [permissionError, setPermissionError] = useState<GithubPermissionRequiredPayload | null>(
    null,
  );

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
    if (!api || !orgId || tracker !== "github") return;
    let cancelled = false;
    void (async () => {
      try {
        const q = finding?.resourceId
          ? `?resourceId=${encodeURIComponent(finding.resourceId)}`
          : "";
        const route = await api.get<GithubIssueRouteResolution>(
          `/api/org/${orgId}/github-issues/route${q}`,
        );
        if (cancelled) return;
        setGithubRepo((current) => current ?? route.repo);
        setGithubLabels(
          [...route.labels, "infrawrench", sourceKind.replace(/_/g, "-")].filter(
            (v, i, a) => a.indexOf(v) === i,
          ),
        );
        setGithubAssignees(route.assignees);
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, orgId, tracker, finding?.resourceId, sourceKind]);

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
      if (tracker === "github") {
        const res = await api.post<FileGithubIssueResult>(
          `/api/org/${orgId}/github-issues/issues`,
          {
            sourceKind,
            sourceId,
            title: summary,
            details: (finding?.details ?? []).filter(
              (d) => d.value !== null && d.value !== undefined && d.value !== "",
            ),
            ...(githubNote.trim() ? { note: githubNote } : {}),
            ...(finding?.resourceId ? { resourceId: finding.resourceId } : {}),
            ...(finding?.monthlyCost ? { monthlyCost: finding.monthlyCost } : {}),
            ...(remediationCommandLines(finding?.remediation).length > 0
              ? { remediation: remediationCommandLines(finding?.remediation) }
              : {}),
            ...(finding?.appUrl ? { appUrl: finding.appUrl } : {}),
            ...(githubRepo ? { repo: githubRepo } : {}),
            labels: githubLabels,
            assignees: githubAssignees,
          },
        );
        filing?.onGithubFiled(res.link);
      } else if (tracker === "jira") {
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
      if (e instanceof GithubPermissionRequiredClientError) {
        setPermissionError(e.payload);
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
      setBusy(false);
    }
  }

  const githubAccess = filing.githubStatus?.installations.find(
    (i) => i.installationId === githubRepo?.installationId,
  );
  const githubPrompt =
    tracker === "github"
      ? (permissionError ??
        permissionPayloadFor(githubAccess, missingGithubPermissions(githubAccess, "issues")))
      : null;

  const inputClass =
    "w-full px-3 py-1.5 text-sm bg-surface border border-border rounded-lg focus:outline-none focus:border-border-strong disabled:opacity-60";
  const ready =
    Boolean(summary.trim()) &&
    (tracker === "jira"
      ? Boolean(projectKey && issueTypeId)
      : tracker === "linear"
        ? Boolean(teamId)
        : tracker === "github"
          ? Boolean(githubRepo) && !githubPrompt
          : false);

  const heading =
    tracker === "jira"
      ? gt("File a Jira issue")
      : tracker === "linear"
        ? gt("File a Linear issue")
        : tracker === "github"
          ? gt("File a GitHub issue")
          : gt("File an issue");
  const destination =
    tracker === "jira"
      ? (filing.jiraIntegration?.siteUrl ?? gt("your Jira site"))
      : tracker === "github"
        ? (githubRepo?.fullName ?? gt("your GitHub repository"))
        : gt("your Linear workspace");

  return (
    <Modal onClose={onClose} ariaLabel={heading}>
      <div className="bg-surface-raised border border-border-strong rounded-xl shadow-2xl w-[520px] max-w-[92vw] p-6">
        <h2 className="text-base font-semibold text-on-surface mb-1">{heading}</h2>
        <p className="text-xs text-on-surface-faint mb-4">
          {tracker
            ? gt(
                "Creates an issue in {destination} and keeps the link on this finding, so it will show as filed instead of offering this button again.",
                { destination },
              )
            : gt("Several trackers are connected. Pick where this finding should be tracked.")}
        </p>

        {error !== null && (
          <div role="alert" className="mb-3 text-sm text-danger">
            {error}
          </div>
        )}

        <div className="space-y-3">
          {trackers.length > 1 && (
            <div role="radiogroup" aria-label={gt("Tracker")} className="flex gap-2">
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
                      ? "border-blue-600 text-info bg-blue-600/10"
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
                <span className="block text-xs text-on-surface-tertiary mb-1">{gt("Project")}</span>
                <select
                  value={projectKey}
                  disabled={busy || projects === null}
                  onChange={(e) => setProjectKey(e.target.value)}
                  className={inputClass}
                >
                  <option value="">
                    {projects === null ? gt("Loading…") : gt("Select a project")}
                  </option>
                  {(projects ?? []).map((p) => (
                    <option key={p.id} value={p.key}>
                      {p.name} ({p.key})
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="block text-xs text-on-surface-tertiary mb-1">
                  {gt("Issue type")}
                </span>
                <select
                  value={issueTypeId}
                  disabled={busy || !projectKey || issueTypes === null}
                  onChange={(e) => setIssueTypeId(e.target.value)}
                  className={inputClass}
                >
                  <option value="">
                    {!projectKey
                      ? gt("Pick a project first")
                      : issueTypes === null
                        ? gt("Loading…")
                        : gt("Select a type")}
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
              <span className="block text-xs text-on-surface-tertiary mb-1">{gt("Team")}</span>
              <select
                value={teamId}
                disabled={busy || teams === null}
                onChange={(e) => setTeamId(e.target.value)}
                className={inputClass}
              >
                <option value="">{teams === null ? gt("Loading…") : gt("Select a team")}</option>
                {(teams ?? []).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({t.key})
                  </option>
                ))}
              </select>
            </label>
          )}

          {tracker === "github" && (
            <>
              <label className="block">
                <span className="block text-xs text-on-surface-tertiary mb-1">
                  {gt("Repository")}
                </span>
                <GithubRepoPicker
                  repos={githubRepos}
                  value={githubRepo}
                  disabled={busy}
                  onChange={(r) => {
                    setGithubRepo(r);
                    setPermissionError(null);
                  }}
                />
              </label>
              {githubPrompt && (
                <GithubPermissionPrompt
                  accountLogin={githubPrompt.accountLogin}
                  permissions={githubPrompt.permissions}
                  manageUrl={githubPrompt.manageUrl}
                  openExternal={filing.openExternal}
                />
              )}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <span className="block text-xs text-on-surface-tertiary mb-1">
                    {gt("Labels")}
                  </span>
                  <GithubLabelsPicker
                    api={api}
                    orgId={orgId}
                    repo={githubRepo}
                    value={githubLabels}
                    onChange={setGithubLabels}
                  />
                </div>
                <div>
                  <span className="block text-xs text-on-surface-tertiary mb-1">
                    {gt("Assignees")}
                  </span>
                  <GithubAssigneesPicker
                    api={api}
                    orgId={orgId}
                    repo={githubRepo}
                    value={githubAssignees}
                    onChange={setGithubAssignees}
                  />
                </div>
              </div>
              <p className="text-xs text-on-surface-muted">
                {gt(
                  "If an open issue already exists for this finding, Infrawrench comments on it instead of opening another.",
                )}
              </p>
            </>
          )}

          {tracker && (
            <>
              <label className="block">
                <span className="block text-xs text-on-surface-tertiary mb-1">
                  {tracker === "jira" ? gt("Summary") : gt("Title")}
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
                <span className="block text-xs text-on-surface-tertiary mb-1">
                  {tracker === "github"
                    ? gt("Note (the evidence table is added for you)")
                    : gt("Description")}
                </span>
                <textarea
                  value={tracker === "github" ? githubNote : description}
                  disabled={busy}
                  rows={tracker === "github" ? 4 : 8}
                  onChange={(e) =>
                    tracker === "github"
                      ? setGithubNote(e.target.value)
                      : setDescription(e.target.value)
                  }
                  className={`${inputClass} font-mono text-xs`}
                />
              </label>

              {tracker === "jira" && draft.labels.length > 0 && (
                <p className="text-xs text-on-surface-muted">
                  {gt("Labels: {labels}", { labels: draft.labels.join(", ") })}
                </p>
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
            {gt("Cancel")}
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy || !ready}
            className="px-3 py-1.5 text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg transition-colors"
          >
            {busy ? gt("Filing…") : gt("Create issue")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
