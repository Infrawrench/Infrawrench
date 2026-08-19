import { useCallback, useEffect, useState } from "react";
import { T, Var, useGT } from "gt-react";
import type {
  LinearIntegration,
  LinearIssueLink,
  LinearTeam,
  LinearVerifyResult,
} from "@infrawrench/client-core";
import { useSettingsHost } from "./host.js";

/**
 * Connect the org to a Linear workspace, and show what has been filed there.
 *
 * The Jira section's sibling, with Linear's smaller surface: no site URL
 * (Linear's API lives at one fixed endpoint for every workspace) and no
 * account email (the personal API key is the whole credential). The default
 * team is a **picker fed by the API**, never free text: a team id is a UUID —
 * Linear's identifier, not the user's — and typing one by hand is a way to
 * discover a typo as a failed create. The picker only loads once a key is
 * saved, because Linear has nothing to tell us before then.
 */
export function LinearSection() {
  const gt = useGT();
  const { orgId, api, has, openExternal } = useSettingsHost();
  const canWrite = has("linear:write");

  const [integration, setIntegration] = useState<LinearIntegration | null>(null);
  /** Blank means "keep the stored key" — the stored one is never shown. */
  const [apiKey, setApiKey] = useState("");
  const [defaultTeamId, setDefaultTeamId] = useState("");

  const [teams, setTeams] = useState<LinearTeam[]>([]);
  const [links, setLinks] = useState<LinearIssueLink[]>([]);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get<{ integration: LinearIntegration | null }>(
        `/api/org/${orgId}/linear`,
      );
      setIntegration(res.integration);
      if (res.integration) {
        setDefaultTeamId(res.integration.defaultTeamId ?? "");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to load the Linear connection"));
    } finally {
      setLoading(false);
    }
  }, [api, orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  // The picker and the filed list only mean anything once a connection exists.
  // Both failures are swallowed: a Linear outage must not stop the user editing
  // and re-saving the key, which is the most likely fix for it.
  useEffect(() => {
    if (!integration) {
      setTeams([]);
      setLinks([]);
      return;
    }
    api.get<LinearTeam[]>(`/api/org/${orgId}/linear/teams`).then(setTeams, () => {});
    api.get<LinearIssueLink[]>(`/api/org/${orgId}/linear/links`).then(setLinks, () => {});
  }, [api, orgId, integration]);

  async function save() {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const saved = await api.put<LinearIntegration>(`/api/org/${orgId}/linear`, {
        // Omit rather than send "" — the server reads an absent key as
        // "unchanged", which is what a blank field means here.
        ...(apiKey ? { apiKey } : {}),
        defaultTeamId: defaultTeamId || null,
      });
      setIntegration(saved);
      setApiKey("");
      setNotice(gt("Linear connection saved."));
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to save the Linear connection"));
    } finally {
      setSaving(false);
    }
  }

  async function verify() {
    setVerifying(true);
    setError(null);
    setNotice(null);
    try {
      // Send the typed key when there is one, so the user can check it before
      // committing it; otherwise re-test the stored one.
      const body = apiKey ? { apiKey } : {};
      const res = await api.post<LinearVerifyResult>(`/api/org/${orgId}/linear/verify`, body);
      setNotice(gt("Connected to Linear as {who}.", { who: res.name || res.email || res.id }));
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Could not verify the Linear API key"));
    } finally {
      setVerifying(false);
    }
  }

  async function disconnect() {
    if (!window.confirm(gt("Disconnect Linear? Issues already filed keep their links."))) return;
    setError(null);
    setNotice(null);
    try {
      await api.delete(`/api/org/${orgId}/linear`);
      setIntegration(null);
      setApiKey("");
      setDefaultTeamId("");
      setNotice(gt("Linear disconnected."));
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to disconnect Linear"));
    }
  }

  const inputClass =
    "px-3 py-1.5 text-sm bg-surface border border-border rounded-lg focus:outline-none focus:border-border-strong disabled:opacity-60 w-full";

  return (
    <div>
      <div className="mb-6">
        {/* i18n-ignore: product name */}
        <h1 className="text-xl font-semibold">Linear</h1>
        <T>
          <p className="text-sm text-on-surface-muted mt-1">
            File findings — cost anomalies, orphaned and oversized resources, posture findings,
            expiring credentials, and failed probes — as Linear issues, and keep the issue link on
            the finding. Connect one Linear workspace per organization. Filing needs{" "}
            <code>linear:write</code>; seeing what has already been filed needs{" "}
            <code>linear:read</code>. Works alongside Jira — an org with both connected chooses the
            tracker when filing.
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
                Create a personal API key in Linear under Settings → Security &amp; access, then
                paste it here. The key is encrypted and never shown again — the field stays blank on
                return, and leaving it blank keeps the stored key. Issues are created as the Linear
                user the key belongs to.{" "}
                <button
                  type="button"
                  onClick={() => openExternal("https://linear.app/settings/account/security")}
                  className="text-info hover:text-info-strong"
                >
                  Create an API key
                </button>
              </p>
            </T>

            <label className="block">
              <span className="block text-xs text-on-surface-tertiary mb-1">
                {gt("API key")}
                {integration && (
                  <span className="text-on-surface-muted">
                    {" "}
                    — {gt("stored: {hint}", { hint: integration.keyHint })}
                  </span>
                )}
              </span>
              <input
                type="password"
                value={apiKey}
                disabled={!canWrite}
                onChange={(e) => setApiKey(e.target.value)}
                autoComplete="new-password"
                placeholder={integration ? gt("Leave blank to keep the stored key") : gt("API key")}
                className={inputClass}
              />
            </label>
          </section>

          <section className="border border-border rounded-xl p-4 space-y-3 bg-surface-raised/50">
            <h2 className="text-sm font-semibold">{gt("Defaults")}</h2>
            <T>
              <p className="text-xs text-on-surface-muted">
                The team the &ldquo;File in Linear&rdquo; window opens preselected — every Linear
                issue belongs to exactly one team. The list comes from Linear, so there is no id to
                look up.
                <Var>
                  {!integration ? <> {gt("Save the connection first to load it.")}</> : null}
                </Var>
              </p>
            </T>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="block">
                <span className="block text-xs text-on-surface-tertiary mb-1">{gt("Team")}</span>
                <select
                  value={defaultTeamId}
                  disabled={!canWrite || teams.length === 0}
                  onChange={(e) => setDefaultTeamId(e.target.value)}
                  className={inputClass}
                >
                  <option value="">{gt("No default")}</option>
                  {teams.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} ({t.key})
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
                disabled={saving || (!integration && !apiKey)}
                className="px-3 py-1.5 text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg transition-colors"
              >
                {saving ? gt("Saving…") : integration ? gt("Save changes") : gt("Connect Linear")}
              </button>
              <button
                type="button"
                onClick={() => void verify()}
                disabled={verifying || (!integration && !apiKey)}
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

          <section className="space-y-3">
            <h2 className="text-sm font-semibold">{gt("Filed issues")}</h2>
            {!integration ? (
              <p className="text-sm text-on-surface-muted">
                {gt("Connect Linear to start filing findings.")}
              </p>
            ) : links.length === 0 ? (
              <T>
                <p className="text-sm text-on-surface-muted">
                  Nothing filed yet. The file button appears on cost anomalies, savings findings,
                  and posture findings.
                </p>
              </T>
            ) : (
              <ul className="border border-border rounded-xl divide-y divide-border/50">
                {links.map((link) => (
                  <li key={link.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                    <button
                      type="button"
                      onClick={() => openExternal(link.issueUrl)}
                      className="text-info hover:text-info-strong font-medium"
                    >
                      {link.issueIdentifier}
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
        </div>
      )}
    </div>
  );
}
