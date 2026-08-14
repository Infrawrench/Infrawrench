import { useCallback, useEffect, useState } from "react";
import { T, Var, useGT } from "gt-react";
import type {
  JiraIntegration,
  JiraIssueLink,
  JiraIssueType,
  JiraProject,
  JiraVerifyResult,
} from "@infrawrench/client-core";
import { useSettingsHost } from "./host.js";

/**
 * Connect the org to a Jira Cloud site, and show what has been filed there.
 *
 * The project and issue type are **pickers fed by the API**, never free text:
 * a project key and an issue type id are Jira's identifiers, not the user's,
 * and typing either by hand is a way to discover a typo as a 400 on the first
 * attempt to file. The pickers only load once credentials are saved — Jira has
 * nothing to tell us before then.
 */
export function JiraSection() {
  const gt = useGT();
  const { orgId, api, has, openExternal } = useSettingsHost();
  const canWrite = has("jira:write");

  const [integration, setIntegration] = useState<JiraIntegration | null>(null);
  const [siteUrl, setSiteUrl] = useState("");
  const [accountEmail, setAccountEmail] = useState("");
  /** Blank means "keep the stored token" — the stored one is never shown. */
  const [apiToken, setApiToken] = useState("");
  const [defaultProjectKey, setDefaultProjectKey] = useState("");
  const [defaultIssueTypeId, setDefaultIssueTypeId] = useState("");

  const [projects, setProjects] = useState<JiraProject[]>([]);
  const [issueTypes, setIssueTypes] = useState<JiraIssueType[]>([]);
  const [links, setLinks] = useState<JiraIssueLink[]>([]);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get<{ integration: JiraIntegration | null }>(`/api/org/${orgId}/jira`);
      setIntegration(res.integration);
      if (res.integration) {
        setSiteUrl(res.integration.siteUrl);
        setAccountEmail(res.integration.accountEmail);
        setDefaultProjectKey(res.integration.defaultProjectKey ?? "");
        setDefaultIssueTypeId(res.integration.defaultIssueTypeId ?? "");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to load the Jira connection"));
    } finally {
      setLoading(false);
    }
  }, [api, orgId, gt]);

  useEffect(() => {
    void load();
  }, [load]);

  // Pickers and the filed list only mean anything once a connection exists.
  // Both failures are swallowed: a Jira outage must not stop the user editing
  // and re-saving credentials, which is the most likely fix for it.
  useEffect(() => {
    if (!integration) {
      setProjects([]);
      setLinks([]);
      return;
    }
    api.get<JiraProject[]>(`/api/org/${orgId}/jira/projects`).then(setProjects, () => {});
    api.get<JiraIssueLink[]>(`/api/org/${orgId}/jira/links`).then(setLinks, () => {});
  }, [api, orgId, integration]);

  useEffect(() => {
    if (!integration || !defaultProjectKey) {
      setIssueTypes([]);
      return;
    }
    api
      .get<JiraIssueType[]>(
        `/api/org/${orgId}/jira/projects/${encodeURIComponent(defaultProjectKey)}/issue-types`,
      )
      .then(setIssueTypes, () => setIssueTypes([]));
  }, [api, orgId, integration, defaultProjectKey]);

  async function save() {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const saved = await api.put<JiraIntegration>(`/api/org/${orgId}/jira`, {
        siteUrl,
        accountEmail,
        // Omit rather than send "" — the server reads an absent token as
        // "unchanged", which is what a blank field means here.
        ...(apiToken ? { apiToken } : {}),
        defaultProjectKey: defaultProjectKey || null,
        defaultIssueTypeId: defaultIssueTypeId || null,
      });
      setIntegration(saved);
      setApiToken("");
      setNotice(gt("Jira connection saved."));
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to save the Jira connection"));
    } finally {
      setSaving(false);
    }
  }

  async function verify() {
    setVerifying(true);
    setError(null);
    setNotice(null);
    try {
      // Send the typed credentials when all three are present, so the user can
      // check a token before committing it; otherwise re-test the stored ones.
      const body = siteUrl && accountEmail && apiToken ? { siteUrl, accountEmail, apiToken } : {};
      const res = await api.post<JiraVerifyResult>(`/api/org/${orgId}/jira/verify`, body);
      setNotice(gt("Connected to Jira as {name}.", { name: res.displayName || res.accountId }));
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Could not verify the Jira credentials"));
    } finally {
      setVerifying(false);
    }
  }

  async function disconnect() {
    if (!window.confirm(gt("Disconnect Jira? Issues already filed keep their links."))) return;
    setError(null);
    setNotice(null);
    try {
      await api.delete(`/api/org/${orgId}/jira`);
      setIntegration(null);
      setApiToken("");
      setDefaultProjectKey("");
      setDefaultIssueTypeId("");
      setNotice(gt("Jira disconnected."));
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to disconnect Jira"));
    }
  }

  const inputClass =
    "px-3 py-1.5 text-sm bg-surface border border-border rounded-lg focus:outline-none focus:border-border-strong disabled:opacity-60 w-full";

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold">Jira</h1>
        <T>
          <p className="text-sm text-on-surface-muted mt-1">
            File findings — cost anomalies, orphaned and oversized resources, posture findings,
            expiring credentials, and failed probes — as Jira issues, and keep the issue link on the
            finding. Connect one Jira Cloud site per organization. Filing needs{" "}
            <Var>
              <code>jira:write</code>
            </Var>
            ; seeing what has already been filed needs{" "}
            <Var>
              <code>jira:read</code>
            </Var>
            .
          </p>
        </T>
      </div>

      {error && (
        <div className="mb-4 px-3 py-2 text-sm text-danger border border-red-900/50 bg-red-950/20 rounded-lg">
          {error}
        </div>
      )}
      {notice && (
        <div className="mb-4 px-3 py-2 text-sm text-success border border-emerald-900/50 bg-emerald-950/20 rounded-lg">
          {notice}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-on-surface-faint">{gt("Loading…")}</p>
      ) : (
        <div className="space-y-8">
          <section className="border border-border rounded-xl p-4 space-y-3 bg-surface-raised/50">
            <h2 className="text-sm font-semibold">{gt("Connection")}</h2>
            <T>
              <p className="text-xs text-on-surface-muted">
                Create an API token on your Atlassian account, then paste it here with the email you
                sign in with. The token is encrypted and never shown again — the field stays blank
                on return, and leaving it blank keeps the stored token.{" "}
                <button
                  type="button"
                  onClick={() => openExternal("https://id.atlassian.com/manage-profile/security")}
                  className="text-info hover:text-info-strong"
                >
                  Create an API token
                </button>
              </p>
            </T>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="block">
                <span className="block text-xs text-on-surface-tertiary mb-1">
                  {gt("Site URL")}
                </span>
                <input
                  type="text"
                  value={siteUrl}
                  disabled={!canWrite}
                  onChange={(e) => setSiteUrl(e.target.value)}
                  placeholder="https://your-site.atlassian.net"
                  className={inputClass}
                />
              </label>
              <label className="block">
                <span className="block text-xs text-on-surface-tertiary mb-1">
                  {gt("Account email")}
                </span>
                <input
                  type="email"
                  value={accountEmail}
                  disabled={!canWrite}
                  onChange={(e) => setAccountEmail(e.target.value)}
                  placeholder="ops@your-company.com"
                  className={inputClass}
                />
              </label>
              <label className="block sm:col-span-2">
                <span className="block text-xs text-on-surface-tertiary mb-1">
                  {gt("API token")}
                  {integration && (
                    <span className="text-on-surface-muted">
                      {" "}
                      {gt("— stored: {hint}", { hint: integration.tokenHint })}
                    </span>
                  )}
                </span>
                <input
                  type="password"
                  value={apiToken}
                  disabled={!canWrite}
                  onChange={(e) => setApiToken(e.target.value)}
                  autoComplete="new-password"
                  placeholder={
                    integration ? gt("Leave blank to keep the stored token") : gt("API token")
                  }
                  aria-label={gt("API token")}
                  className={inputClass}
                />
              </label>
            </div>
          </section>

          <section className="border border-border rounded-xl p-4 space-y-3 bg-surface-raised/50">
            <h2 className="text-sm font-semibold">{gt("Defaults")}</h2>
            <p className="text-xs text-on-surface-muted">
              {gt(
                "What the “File a Jira issue” window opens preselected. Both lists come from Jira, so there is no key or id to look up.",
              )}
              {!integration && ` ${gt("Save the connection first to load them.")}`}
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="block">
                <span className="block text-xs text-on-surface-tertiary mb-1">{gt("Project")}</span>
                <select
                  value={defaultProjectKey}
                  disabled={!canWrite || projects.length === 0}
                  onChange={(e) => {
                    setDefaultProjectKey(e.target.value);
                    // The type list is per-project; a stale id from the old
                    // project would fail the create with a confusing 400.
                    setDefaultIssueTypeId("");
                  }}
                  className={inputClass}
                >
                  <option value="">{gt("No default")}</option>
                  {projects.map((p) => (
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
                  value={defaultIssueTypeId}
                  disabled={!canWrite || issueTypes.length === 0}
                  onChange={(e) => setDefaultIssueTypeId(e.target.value)}
                  className={inputClass}
                >
                  <option value="">{gt("No default")}</option>
                  {issueTypes.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </section>

          {canWrite && (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void save()}
                disabled={saving || !siteUrl || !accountEmail}
                className="px-3 py-1.5 text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg transition-colors"
              >
                {saving ? gt("Saving…") : integration ? gt("Save changes") : gt("Connect Jira")}
              </button>
              <button
                type="button"
                onClick={() => void verify()}
                disabled={verifying || (!integration && !(siteUrl && accountEmail && apiToken))}
                className="px-3 py-1.5 text-sm font-medium border border-border hover:bg-surface-overlay disabled:opacity-50 text-on-surface-secondary rounded-lg transition-colors"
              >
                {verifying ? gt("Checking…") : gt("Verify")}
              </button>
              {integration && (
                <button
                  type="button"
                  onClick={() => void disconnect()}
                  className="px-3 py-1.5 text-sm font-medium text-danger hover:text-danger-strong"
                >
                  {gt("Disconnect")}
                </button>
              )}
            </div>
          )}

          <FiledIssuesList
            connected={integration !== null}
            links={links}
            openExternal={openExternal}
          />
        </div>
      )}
    </div>
  );
}

/**
 * What has already been filed into Jira. Read-only, and self-contained: it
 * needs the links, whether a connection exists at all (an empty list means
 * two different things either side of that), and a way to open an issue.
 */
function FiledIssuesList({
  connected,
  links,
  openExternal,
}: {
  connected: boolean;
  links: JiraIssueLink[];
  openExternal: (url: string) => void;
}) {
  const gt = useGT();
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold">{gt("Filed issues")}</h2>
      {!connected ? (
        <p className="text-sm text-on-surface-muted">
          {gt("Connect Jira to start filing findings.")}
        </p>
      ) : links.length === 0 ? (
        <p className="text-sm text-on-surface-muted">
          {gt(
            "Nothing filed yet. The “File a Jira issue” button appears on cost anomalies, savings findings, and posture findings.",
          )}
        </p>
      ) : (
        <ul className="border border-border rounded-xl divide-y divide-border/50">
          {links.map((link) => (
            <li key={link.id} className="flex items-center gap-3 px-4 py-2 text-sm">
              <button
                type="button"
                onClick={() => openExternal(link.issueUrl)}
                className="text-info hover:text-info-strong font-medium"
              >
                {link.issueKey}
              </button>
              <span className="text-xs text-on-surface-muted">
                {link.sourceKind.replace(/_/g, " ")}
              </span>
              <span className="flex-1 truncate text-xs text-on-surface-tertiary">
                {link.sourceId}
              </span>
              <span className="text-xs text-on-surface-muted shrink-0">
                {new Date(link.createdAt).toLocaleDateString()}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
