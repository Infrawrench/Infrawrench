import { useCallback, useEffect, useMemo, useState } from "react";
import { T, useGT } from "gt-react";
import {
  GITHUB_RESOLVE_ACTIONS,
  validateGithubIssueSettings,
  type CostCentre,
  type GithubIacSource,
  type GithubIssueLink,
  type GithubIssueRoute,
  type GithubIssueSettings,
  type GithubIssueSettingsInput,
  type GithubIssuesStatus,
  type GithubRepoRef,
  type GithubResolveAction,
  type IacStateSummary,
} from "@infrawrench/client-core";

import {
  GithubAssigneesPicker,
  GithubLabelsPicker,
  GithubPermissionPrompt,
  GithubRepoPicker,
  missingGithubPermissions,
  useGithubRepos,
} from "../issue-filing/github.js";
import { useSettingsHost } from "./host.js";

type RouteDraft = Omit<GithubIssueRoute, "id"> & { id?: string; key: string };
type SourceDraft = Omit<GithubIacSource, "id"> & { id?: string; key: string };

let draftSeq = 0;
const nextKey = () => `d${++draftSeq}`;

const inputClass =
  "w-full px-3 py-1.5 text-sm bg-surface border border-border rounded-lg focus:outline-none focus:border-border-strong disabled:opacity-60";
const cardClass = "border border-border rounded-xl p-4 space-y-3 bg-surface-raised/50";

/**
 * GitHub issue filing settings: the default repository and its labels and
 * assignees, cost-centre / tag routes to other repositories, what happens to
 * an issue when its finding goes away, and the IaC pull-request switch with
 * the repositories that hold each Terraform state's code.
 *
 * Everything is a picker fed by the org's GitHub App installation(s), never a
 * typed identifier. The installations card says, per installation, whether it
 * has accepted the `issues` / `contents` / `pull_requests` permissions this
 * needs, with a link to approve them; an installation made before this feature
 * existed keeps serving workflows and agents until then.
 */
export function GithubIssuesSection() {
  const gt = useGT();
  const { orgId, api, has, openExternal } = useSettingsHost();
  const canWrite = has("org:settings:write");

  const [status, setStatus] = useState<GithubIssuesStatus | null>(null);
  const [links, setLinks] = useState<GithubIssueLink[]>([]);
  const [costCentres, setCostCentres] = useState<CostCentre[]>([]);
  const [iacStates, setIacStates] = useState<IacStateSummary[]>([]);
  const repos = useGithubRepos(api, orgId);

  const [enabled, setEnabled] = useState(false);
  const [defaultRepo, setDefaultRepo] = useState<GithubRepoRef | null>(null);
  const [labels, setLabels] = useState<string[]>([]);
  const [assignees, setAssignees] = useState<string[]>([]);
  const [resolveAction, setResolveAction] = useState<GithubResolveAction>("comment");
  const [routes, setRoutes] = useState<RouteDraft[]>([]);
  const [pullRequestsEnabled, setPullRequestsEnabled] = useState(false);
  const [sources, setSources] = useState<SourceDraft[]>([]);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const apply = useCallback((s: GithubIssueSettings) => {
    setEnabled(s.enabled);
    setDefaultRepo(s.defaultRepo);
    setLabels(s.labels);
    setAssignees(s.assignees);
    setResolveAction(s.resolveAction);
    setRoutes(s.routes.map((r) => ({ ...r, key: nextKey() })));
    setPullRequestsEnabled(s.pullRequestsEnabled);
    setSources(s.iacSources.map((x) => ({ ...x, key: nextKey() })));
  }, []);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get<GithubIssuesStatus>(`/api/org/${orgId}/github-issues`);
      setStatus(res);
      apply(res.settings);
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to load GitHub issue settings"));
    } finally {
      setLoading(false);
    }
  }, [api, orgId, apply, gt]);

  useEffect(() => {
    void load();
    // Pickers and the filed list fail soft: a missing permission on one of
    // them must not stop the rest of the page.
    api.get<GithubIssueLink[]>(`/api/org/${orgId}/github-issues/links`).then(setLinks, () => {});
    api.get<CostCentre[]>(`/api/org/${orgId}/cost-centres`).then(setCostCentres, () => {});
    api.get<{ states: IacStateSummary[] }>(`/api/org/${orgId}/iac/states`).then(
      (r) => setIacStates(r.states),
      () => {},
    );
  }, [api, orgId, load]);

  /** One option per IaC state scope (an account, or the org-wide state). */
  const scopes = useMemo(() => {
    const seen = new Map<string, { accountId: string | null; label: string }>();
    for (const s of iacStates) {
      const key = s.accountId ?? "";
      if (!seen.has(key)) {
        seen.set(key, {
          accountId: s.accountId,
          label: s.accountId
            ? `${s.accountName ?? s.accountId} (${s.label})`
            : `${gt("Organization-wide")} (${s.label})`,
        });
      }
    }
    return [...seen.values()];
  }, [iacStates, gt]);

  async function connect() {
    setError(null);
    try {
      const res = await api.get<{ url: string }>(
        `/api/org/${orgId}/github/install-url?return=settings/github-issues`,
      );
      openExternal(res.url);
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Could not start the GitHub connection"));
    }
  }

  async function save() {
    const input: GithubIssueSettingsInput = {
      enabled,
      defaultRepo,
      labels,
      assignees,
      resolveAction,
      pullRequestsEnabled,
      routes: routes.map(({ key: _key, ...r }) => r),
      iacSources: sources.map(({ key: _key, ...x }) => x),
    };
    const problem = validateGithubIssueSettings(input);
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const saved = await api.put<GithubIssueSettings>(
        `/api/org/${orgId}/github-issues/settings`,
        input,
      );
      apply(saved);
      setStatus((s) => (s ? { ...s, settings: saved } : s));
      setNotice(gt("GitHub issue settings saved."));
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to save GitHub issue settings"));
    } finally {
      setSaving(false);
    }
  }

  function updateRoute(key: string, patch: Partial<RouteDraft>) {
    setRoutes((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }
  function moveRoute(key: string, delta: number) {
    setRoutes((rs) => {
      const i = rs.findIndex((r) => r.key === key);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= rs.length) return rs;
      const next = [...rs];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
  }
  function updateSource(key: string, patch: Partial<SourceDraft>) {
    setSources((xs) => xs.map((x) => (x.key === key ? { ...x, ...patch } : x)));
  }

  const resolveLabels: Record<GithubResolveAction, string> = {
    close: gt("Close the issue with a comment"),
    comment: gt("Comment on the issue, leave it open"),
    none: gt("Do nothing"),
  };

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold">{gt("GitHub Issues")}</h1>
        <T>
          <p className="text-sm text-on-surface-muted mt-1">
            File savings findings (orphaned and oversized resources, cost anomalies, idle
            commitments) as GitHub issues through the organization&apos;s GitHub App. Filing the
            same finding again comments on its open issue instead of opening another, and when a
            finding goes away its issue is closed or commented on. For resources managed by
            Terraform, Infrawrench can also open a pull request with the fix. To file every new
            finding automatically, add an alert routing rule with the GitHub issues destination
            under Notifications.
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
          <section className={cardClass}>
            <h2 className="text-sm font-semibold">{gt("GitHub App installations")}</h2>
            {status && !status.appConfigured && (
              <p className="text-xs text-warning">
                {gt("This server has no GitHub App configured, so issues cannot be filed.")}
              </p>
            )}
            {status?.installations.length === 0 && (
              <p className="text-xs text-on-surface-muted">
                {gt("No GitHub account is connected to this organization yet.")}
              </p>
            )}
            <ul className="space-y-3">
              {(status?.installations ?? []).map((i) => {
                const missing = missingGithubPermissions(
                  i,
                  pullRequestsEnabled ? "pull-requests" : "issues",
                );
                return (
                  <li key={i.installationId} className="space-y-2">
                    <div className="flex flex-wrap items-center gap-3 text-sm">
                      <span className="font-medium text-on-surface">
                        {i.accountLogin ?? String(i.installationId)}
                      </span>
                      <span className="text-xs text-on-surface-muted">
                        {gt("issues: {issues} · contents: {contents} · pull requests: {pulls}", {
                          issues: i.issues,
                          contents: i.contents,
                          pulls: i.pullRequests,
                        })}
                      </span>
                      {!i.checked && (
                        <span className="text-xs text-warning">{gt("Could not ask GitHub")}</span>
                      )}
                      {i.suspended && (
                        <span className="text-xs text-danger">{gt("Suspended")}</span>
                      )}
                    </div>
                    {missing.length > 0 && (
                      <GithubPermissionPrompt
                        accountLogin={i.accountLogin}
                        permissions={missing}
                        manageUrl={i.manageUrl}
                        openExternal={openExternal}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
            {has("dashboards:write") && status?.appConfigured && (
              <button
                type="button"
                onClick={() => void connect()}
                className="px-3 py-1.5 text-xs font-medium border border-border hover:bg-surface-overlay text-on-surface-secondary rounded-lg"
              >
                {gt("Connect a GitHub account or add repositories")}
              </button>
            )}
          </section>

          <section className={cardClass}>
            <h2 className="text-sm font-semibold">{gt("Filing")}</h2>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={enabled}
                disabled={!canWrite}
                onChange={(e) => setEnabled(e.target.checked)}
              />
              {gt("Allow findings to be filed as GitHub issues")}
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="block">
                <span className="block text-xs text-on-surface-tertiary mb-1">
                  {gt("Default repository")}
                </span>
                <GithubRepoPicker
                  repos={repos}
                  value={defaultRepo}
                  disabled={!canWrite}
                  allowNone
                  onChange={setDefaultRepo}
                />
              </label>
              <label className="block">
                <span className="block text-xs text-on-surface-tertiary mb-1">
                  {gt("When a finding goes away")}
                </span>
                <select
                  value={resolveAction}
                  disabled={!canWrite}
                  onChange={(e) => setResolveAction(e.target.value as GithubResolveAction)}
                  className={inputClass}
                >
                  {GITHUB_RESOLVE_ACTIONS.map((a) => (
                    <option key={a} value={a}>
                      {resolveLabels[a]}
                    </option>
                  ))}
                </select>
              </label>
              <div>
                <span className="block text-xs text-on-surface-tertiary mb-1">{gt("Labels")}</span>
                <GithubLabelsPicker
                  api={api}
                  orgId={orgId}
                  repo={defaultRepo}
                  value={labels}
                  onChange={setLabels}
                />
              </div>
              <div>
                <span className="block text-xs text-on-surface-tertiary mb-1">
                  {gt("Assignees")}
                </span>
                <GithubAssigneesPicker
                  api={api}
                  orgId={orgId}
                  repo={defaultRepo}
                  value={assignees}
                  onChange={setAssignees}
                />
              </div>
            </div>
          </section>

          <section className={cardClass}>
            <h2 className="text-sm font-semibold">{gt("Routes")}</h2>
            <p className="text-xs text-on-surface-muted">
              {gt(
                "Send findings about some resources to another repository, by the cost centre the resource is allocated to or by one of its tags. The first matching route wins; anything unmatched goes to the default repository.",
              )}
            </p>
            {routes.map((r, idx) => (
              <div key={r.key} className="rounded-lg border border-border p-3 space-y-2">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <select
                    value={r.match.kind}
                    aria-label={gt("Match by")}
                    disabled={!canWrite}
                    onChange={(e) =>
                      updateRoute(r.key, {
                        match:
                          e.target.value === "tag"
                            ? { kind: "tag", tagKey: "", tagValue: null }
                            : { kind: "cost_centre", costCentreId: costCentres[0]?.id ?? "" },
                      })
                    }
                    className={inputClass}
                  >
                    <option value="cost_centre">{gt("Cost centre")}</option>
                    <option value="tag">{gt("Tag")}</option>
                  </select>
                  {r.match.kind === "cost_centre" ? (
                    <select
                      value={r.match.costCentreId}
                      aria-label={gt("Cost centre")}
                      disabled={!canWrite}
                      onChange={(e) =>
                        updateRoute(r.key, {
                          match: { kind: "cost_centre", costCentreId: e.target.value },
                        })
                      }
                      className={`${inputClass} sm:col-span-2`}
                    >
                      <option value="">{gt("Select a cost centre")}</option>
                      {costCentres.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <>
                      <input
                        value={r.match.tagKey}
                        disabled={!canWrite}
                        placeholder={gt("Tag key")}
                        onChange={(e) =>
                          updateRoute(r.key, {
                            match: {
                              kind: "tag",
                              tagKey: e.target.value,
                              tagValue: r.match.kind === "tag" ? r.match.tagValue : null,
                            },
                          })
                        }
                        className={inputClass}
                      />
                      <input
                        value={r.match.tagValue ?? ""}
                        disabled={!canWrite}
                        placeholder={gt("Any value")}
                        onChange={(e) =>
                          updateRoute(r.key, {
                            match: {
                              kind: "tag",
                              tagKey: r.match.kind === "tag" ? r.match.tagKey : "",
                              tagValue: e.target.value || null,
                            },
                          })
                        }
                        className={inputClass}
                      />
                    </>
                  )}
                </div>
                <GithubRepoPicker
                  repos={repos}
                  value={r.repo}
                  disabled={!canWrite}
                  onChange={(repo) => repo && updateRoute(r.key, { repo })}
                />
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <GithubLabelsPicker
                    api={api}
                    orgId={orgId}
                    repo={r.repo}
                    value={r.labels}
                    onChange={(v) => updateRoute(r.key, { labels: v })}
                  />
                  <GithubAssigneesPicker
                    api={api}
                    orgId={orgId}
                    repo={r.repo}
                    value={r.assignees}
                    onChange={(v) => updateRoute(r.key, { assignees: v })}
                  />
                </div>
                {canWrite && (
                  <div className="flex gap-3 text-xs">
                    <button
                      type="button"
                      disabled={idx === 0}
                      onClick={() => moveRoute(r.key, -1)}
                      className="text-on-surface-muted disabled:opacity-40"
                    >
                      {gt("Move up")}
                    </button>
                    <button
                      type="button"
                      disabled={idx === routes.length - 1}
                      onClick={() => moveRoute(r.key, 1)}
                      className="text-on-surface-muted disabled:opacity-40"
                    >
                      {gt("Move down")}
                    </button>
                    <button
                      type="button"
                      onClick={() => setRoutes((rs) => rs.filter((x) => x.key !== r.key))}
                      className="text-danger"
                    >
                      {gt("Remove")}
                    </button>
                  </div>
                )}
              </div>
            ))}
            {canWrite && (
              <button
                type="button"
                disabled={!repos || repos.length === 0}
                onClick={() => {
                  const first = repos?.[0];
                  if (!first) return;
                  setRoutes((rs) => [
                    ...rs,
                    {
                      key: nextKey(),
                      match: { kind: "cost_centre", costCentreId: costCentres[0]?.id ?? "" },
                      repo: { installationId: first.installationId, fullName: first.fullName },
                      labels: [],
                      assignees: [],
                    },
                  ]);
                }}
                className="px-3 py-1.5 text-xs font-medium border border-border hover:bg-surface-overlay disabled:opacity-50 text-on-surface-secondary rounded-lg"
              >
                {gt("Add route")}
              </button>
            )}
          </section>

          <section className={cardClass}>
            <h2 className="text-sm font-semibold">{gt("Terraform pull requests")}</h2>
            <p className="text-xs text-on-surface-muted">
              {gt(
                "When a finding's resource is managed by Terraform (see IaC) and the fix is mechanical, a single size attribute or deleting a confirmed orphan's block, members who can file issues may open a pull request with the change. Each pull request takes a click and is never merged automatically. Needs the contents and pull requests permissions on the installation.",
              )}
            </p>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={pullRequestsEnabled}
                disabled={!canWrite}
                onChange={(e) => setPullRequestsEnabled(e.target.checked)}
              />
              {gt("Allow pull requests for IaC-managed findings")}
            </label>
            {scopes.length === 0 && (
              <p className="text-xs text-on-surface-muted">
                {gt("Upload a Terraform state on the IaC page first; its scope then appears here.")}
              </p>
            )}
            {sources.map((x) => (
              <IacSourceRow
                key={x.key}
                source={x}
                scopes={scopes}
                repos={repos}
                canWrite={canWrite}
                onChange={(patch) => updateSource(x.key, patch)}
                onRemove={() => setSources((xs) => xs.filter((y) => y.key !== x.key))}
              />
            ))}
            {canWrite && scopes.length > 0 && (
              <button
                type="button"
                disabled={!repos || repos.length === 0}
                onClick={() => {
                  const first = repos?.[0];
                  const used = new Set(sources.map((x) => x.iacAccountId ?? ""));
                  const scope = scopes.find((s) => !used.has(s.accountId ?? ""));
                  if (!first || !scope) return;
                  setSources((xs) => [
                    ...xs,
                    {
                      key: nextKey(),
                      iacAccountId: scope.accountId,
                      repo: { installationId: first.installationId, fullName: first.fullName },
                      baseBranch: null,
                      directory: "",
                    },
                  ]);
                }}
                className="px-3 py-1.5 text-xs font-medium border border-border hover:bg-surface-overlay disabled:opacity-50 text-on-surface-secondary rounded-lg"
              >
                {gt("Map a Terraform state to a repository")}
              </button>
            )}
          </section>

          {canWrite && (
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving}
              className="px-3 py-1.5 text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg transition-colors"
            >
              {saving ? gt("Saving…") : gt("Save changes")}
            </button>
          )}

          <section className={cardClass}>
            <h2 className="text-sm font-semibold">{gt("Filed issues")}</h2>
            {links.length === 0 ? (
              <p className="text-xs text-on-surface-muted">{gt("Nothing has been filed yet.")}</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {links.slice(0, 50).map((l) => (
                  <li key={l.id} className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => openExternal(l.issueUrl)}
                      className="text-info hover:text-info-strong"
                    >
                      {l.repo}#{l.issueNumber}
                    </button>
                    <span className="text-xs text-on-surface-muted">
                      {l.state === "open" ? gt("open") : gt("closed")}
                      {l.autoFiled ? ` · ${gt("filed by a routing rule")}` : ""}
                    </span>
                    {l.pullRequestUrl && (
                      <button
                        type="button"
                        onClick={() => openExternal(l.pullRequestUrl!)}
                        className="text-xs text-info hover:text-info-strong"
                      >
                        {gt("PR #{number}", { number: l.pullRequestNumber ?? 0 })}
                      </button>
                    )}
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

function IacSourceRow({
  source,
  scopes,
  repos,
  canWrite,
  onChange,
  onRemove,
}: {
  source: SourceDraft;
  scopes: Array<{ accountId: string | null; label: string }>;
  repos: ReturnType<typeof useGithubRepos>;
  canWrite: boolean;
  onChange: (patch: Partial<SourceDraft>) => void;
  onRemove: () => void;
}) {
  const gt = useGT();
  const { orgId, api } = useSettingsHost();
  const [branches, setBranches] = useState<string[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    setBranches(null);
    api
      .get<string[]>(
        `/api/org/${orgId}/github-issues/branches?installationId=${source.repo.installationId}&repo=${encodeURIComponent(source.repo.fullName)}`,
      )
      .then(
        (b) => !cancelled && setBranches(b),
        () => !cancelled && setBranches([]),
      );
    return () => {
      cancelled = true;
    };
  }, [api, orgId, source.repo.installationId, source.repo.fullName]);

  return (
    <div className="rounded-lg border border-border p-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
      <label className="block">
        <span className="block text-xs text-on-surface-tertiary mb-1">{gt("IaC state")}</span>
        <select
          value={source.iacAccountId ?? ""}
          disabled={!canWrite}
          onChange={(e) => onChange({ iacAccountId: e.target.value || null })}
          className={inputClass}
        >
          {scopes.map((s) => (
            <option key={s.accountId ?? ""} value={s.accountId ?? ""}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="block text-xs text-on-surface-tertiary mb-1">{gt("Repository")}</span>
        <GithubRepoPicker
          repos={repos}
          value={source.repo}
          disabled={!canWrite}
          onChange={(repo) => repo && onChange({ repo, baseBranch: null })}
        />
      </label>
      <label className="block">
        <span className="block text-xs text-on-surface-tertiary mb-1">{gt("Base branch")}</span>
        <select
          value={source.baseBranch ?? ""}
          disabled={!canWrite || branches === null}
          onChange={(e) => onChange({ baseBranch: e.target.value || null })}
          className={inputClass}
        >
          <option value="">{branches === null ? gt("Loading…") : gt("Default branch")}</option>
          {source.baseBranch && !(branches ?? []).includes(source.baseBranch) && (
            <option value={source.baseBranch}>{source.baseBranch}</option>
          )}
          {(branches ?? []).map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="block text-xs text-on-surface-tertiary mb-1">
          {gt("Directory of the root module")}
        </span>
        <input
          value={source.directory}
          disabled={!canWrite}
          // i18n-ignore: example path
          placeholder="infra/prod"
          onChange={(e) => onChange({ directory: e.target.value })}
          className={inputClass}
        />
      </label>
      {canWrite && (
        <button type="button" onClick={onRemove} className="text-xs text-danger text-left">
          {gt("Remove")}
        </button>
      )}
    </div>
  );
}
