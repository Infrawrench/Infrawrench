import { useCallback, useEffect, useMemo, useState } from "react";
import { T, useGT } from "gt-react";
import {
  PR_CHECK_THRESHOLD_CONCLUSIONS,
  formatMonthlyDelta,
  normalizePrCheckDirectory,
  prCheckMissingPermissions,
  validatePrCheckRepositoryInput,
  type GithubRepoRef,
  type PrCheckPreview,
  type PrCheckRepository,
  type PrCheckRepositoryInput,
  type PrCheckRun,
  type PrCheckStatus,
  type PrCheckThresholdConclusion,
} from "@infrawrench/client-core";

import {
  GithubPermissionPrompt,
  GithubRepoPicker,
  useGithubRepos,
} from "../issue-filing/github.js";
import { useSettingsHost } from "./host.js";

const inputClass =
  "w-full px-3 py-1.5 text-sm bg-surface border border-border rounded-lg focus:outline-none focus:border-border-strong disabled:opacity-60";
const cardClass = "border border-border rounded-xl p-4 space-y-3 bg-surface-raised/50";
const buttonClass =
  "px-3 py-1.5 text-xs font-medium border border-border hover:bg-surface-overlay text-on-surface-secondary rounded-lg disabled:opacity-50";

interface Draft {
  enabled: boolean;
  commentEnabled: boolean;
  threshold: string;
  thresholdConclusion: PrCheckThresholdConclusion;
  directories: string;
}

function toDraft(r: PrCheckRepository): Draft {
  return {
    enabled: r.enabled,
    commentEnabled: r.commentEnabled,
    threshold: r.costThreshold === null ? "" : String(r.costThreshold),
    thresholdConclusion: r.thresholdConclusion,
    directories: r.directories.join(", "),
  };
}

function fromDraft(r: PrCheckRepository, d: Draft): PrCheckRepositoryInput {
  const threshold = d.threshold.trim();
  return {
    installationId: r.installationId,
    repo: r.repo,
    enabled: d.enabled,
    commentEnabled: d.commentEnabled,
    costThreshold: threshold === "" ? null : Number(threshold),
    thresholdConclusion: d.thresholdConclusion,
    directories: d.directories
      .split(",")
      .map(normalizePrCheckDirectory)
      .filter((x) => x.length > 0),
  };
}

/**
 * Pull request checks: which repositories get a cost and blast-radius check
 * run on their pull requests, with an optional summary comment and a cost
 * threshold that turns the check neutral or failed. Everything is a picker
 * over the org's GitHub App installation(s); the installations card says
 * whether each has accepted `checks` (and, for the comment,
 * `pull_requests: write`), with a link to approve them.
 *
 * Below the settings, the recent checks the github-watcher posted, and a
 * preview that runs the same analysis on one pull request without posting.
 */
export function PrChecksSection() {
  const gt = useGT();
  const { orgId, api, has, openExternal } = useSettingsHost();
  const canWrite = has("org:settings:write");
  const repos = useGithubRepos(api, orgId);

  const [status, setStatus] = useState<PrCheckStatus | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [runs, setRuns] = useState<PrCheckRun[]>([]);
  const [adding, setAdding] = useState<GithubRepoRef | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [previewRepoId, setPreviewRepoId] = useState("");
  const [previewNumber, setPreviewNumber] = useState("");
  const [preview, setPreview] = useState<PrCheckPreview | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get<PrCheckStatus>(`/api/org/${orgId}/pr-checks`);
      setStatus(res);
      setDrafts(Object.fromEntries(res.repositories.map((r) => [r.id, toDraft(r)])));
      setPreviewRepoId((current) => current || res.repositories[0]?.id || "");
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to load pull request check settings"));
    } finally {
      setLoading(false);
    }
  }, [api, orgId, gt]);

  const loadRuns = useCallback(() => {
    api.get<PrCheckRun[]>(`/api/org/${orgId}/pr-checks/runs?limit=25`).then(setRuns, () => {});
  }, [api, orgId]);

  useEffect(() => {
    void load();
    loadRuns();
  }, [load, loadRuns]);

  const anyComment = useMemo(
    () => (status?.repositories ?? []).some((r) => r.commentEnabled),
    [status],
  );

  async function connect() {
    setError(null);
    try {
      const res = await api.get<{ url: string }>(
        `/api/org/${orgId}/github/install-url?return=settings/pr-checks`,
      );
      openExternal(res.url);
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Could not start the GitHub connection"));
    }
  }

  async function add() {
    if (!adding) return;
    setBusy("add");
    setError(null);
    setNotice(null);
    try {
      await api.post<PrCheckRepository>(`/api/org/${orgId}/pr-checks/repositories`, {
        installationId: adding.installationId,
        repo: adding.fullName,
        enabled: true,
        commentEnabled: false,
        costThreshold: null,
        thresholdConclusion: "neutral",
        directories: [],
      } satisfies PrCheckRepositoryInput);
      setAdding(null);
      setNotice(gt("Checks turned on. Open pull requests are checked within a minute."));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to add the repository"));
    } finally {
      setBusy(null);
    }
  }

  async function save(r: PrCheckRepository) {
    const draft = drafts[r.id];
    if (!draft) return;
    const input = fromDraft(r, draft);
    if (input.costThreshold !== null && !Number.isFinite(input.costThreshold)) {
      setError(gt("The cost threshold must be a number."));
      return;
    }
    const problem = validatePrCheckRepositoryInput(input);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(r.id);
    setError(null);
    setNotice(null);
    try {
      await api.put<PrCheckRepository>(`/api/org/${orgId}/pr-checks/repositories/${r.id}`, input);
      setNotice(gt("Saved {repo}.", { repo: r.repo }));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to save"));
    } finally {
      setBusy(null);
    }
  }

  async function remove(r: PrCheckRepository) {
    setBusy(r.id);
    setError(null);
    setNotice(null);
    try {
      await api.delete(`/api/org/${orgId}/pr-checks/repositories/${r.id}`);
      setNotice(gt("Checks turned off for {repo}.", { repo: r.repo }));
      await load();
      loadRuns();
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to remove"));
    } finally {
      setBusy(null);
    }
  }

  async function runPreview() {
    const pullNumber = Number(previewNumber);
    if (!previewRepoId || !Number.isInteger(pullNumber) || pullNumber <= 0) {
      setError(gt("Pick a repository and enter a pull request number."));
      return;
    }
    setBusy("preview");
    setError(null);
    setPreview(null);
    try {
      setPreview(
        await api.post<PrCheckPreview>(`/api/org/${orgId}/pr-checks/preview`, {
          repositoryId: previewRepoId,
          pullNumber,
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Preview failed"));
    } finally {
      setBusy(null);
    }
  }

  function patch(id: string, p: Partial<Draft>) {
    setDrafts((d) => ({ ...d, [id]: { ...d[id]!, ...p } }));
  }

  const conclusionLabels: Record<PrCheckThresholdConclusion, string> = {
    neutral: gt("Neutral (flag it, do not block)"),
    failure: gt("Failure (blocks merging when the check is required)"),
  };

  const configured = new Set((status?.repositories ?? []).map((r) => r.repo.toLowerCase()));
  const addable = (repos ?? []).filter((r) => !configured.has(r.fullName.toLowerCase()));

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold">{gt("Pull Request Checks")}</h1>
        <T>
          <p className="text-sm text-on-surface-muted mt-1">
            Post a GitHub check on pull requests that change Terraform: the estimated monthly cost
            change, what depends on each existing resource it touches, and right-sizing, tag policy
            and posture warnings. Existing resources are matched through the Terraform state
            uploaded on the IaC page.
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
                {gt("This server has no GitHub App configured, so checks cannot be posted.")}
              </p>
            )}
            {status?.installations.length === 0 && (
              <p className="text-xs text-on-surface-muted">
                {gt("No GitHub account is connected to this organization yet.")}
              </p>
            )}
            <ul className="space-y-3">
              {(status?.installations ?? []).map((i) => {
                const missing = prCheckMissingPermissions(i, anyComment);
                return (
                  <li key={i.installationId} className="space-y-2">
                    <div className="flex flex-wrap items-center gap-3 text-sm">
                      <span className="font-medium text-on-surface">
                        {i.accountLogin ?? String(i.installationId)}
                      </span>
                      <span className="text-xs text-on-surface-muted">
                        {gt("checks: {checks} · pull requests: {pulls} · contents: {contents}", {
                          checks: i.checks,
                          pulls: i.pullRequests,
                          contents: i.contents,
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
              <button type="button" onClick={() => void connect()} className={buttonClass}>
                {gt("Connect a GitHub account or add repositories")}
              </button>
            )}
          </section>

          <section className={cardClass}>
            <h2 className="text-sm font-semibold">{gt("Repositories")}</h2>
            {(status?.repositories ?? []).length === 0 && (
              <p className="text-xs text-on-surface-muted">
                {gt("No repository has pull request checks yet.")}
              </p>
            )}
            <ul className="space-y-4">
              {(status?.repositories ?? []).map((r) => {
                const d = drafts[r.id] ?? toDraft(r);
                return (
                  <li key={r.id} className="border border-border rounded-lg p-3 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium text-sm text-on-surface">{r.repo}</span>
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={d.enabled}
                          disabled={!canWrite}
                          onChange={(e) => patch(r.id, { enabled: e.target.checked })}
                        />
                        {gt("Post checks")}
                      </label>
                    </div>
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={d.commentEnabled}
                        disabled={!canWrite}
                        onChange={(e) => patch(r.id, { commentEnabled: e.target.checked })}
                      />
                      {gt(
                        "Also keep one summary comment on the pull request, updated on every push",
                      )}
                    </label>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <label className="block">
                        <span className="block text-xs text-on-surface-tertiary mb-1">
                          {gt("Cost threshold (per month)")}
                        </span>
                        <input
                          type="number"
                          min={0}
                          step="any"
                          value={d.threshold}
                          disabled={!canWrite}
                          placeholder={gt("No threshold")}
                          onChange={(e) => patch(r.id, { threshold: e.target.value })}
                          className={inputClass}
                        />
                      </label>
                      <label className="block">
                        <span className="block text-xs text-on-surface-tertiary mb-1">
                          {gt("Above the threshold, the check is")}
                        </span>
                        <select
                          value={d.thresholdConclusion}
                          disabled={!canWrite || d.threshold.trim() === ""}
                          onChange={(e) =>
                            patch(r.id, {
                              thresholdConclusion: e.target.value as PrCheckThresholdConclusion,
                            })
                          }
                          className={inputClass}
                        >
                          {PR_CHECK_THRESHOLD_CONCLUSIONS.map((c) => (
                            <option key={c} value={c}>
                              {conclusionLabels[c]}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="block">
                        <span className="block text-xs text-on-surface-tertiary mb-1">
                          {gt("Only these directories (comma-separated)")}
                        </span>
                        <input
                          type="text"
                          value={d.directories}
                          disabled={!canWrite}
                          // i18n-ignore: example repository paths
                          placeholder="infra/prod, terraform"
                          onChange={(e) => patch(r.id, { directories: e.target.value })}
                          className={inputClass}
                        />
                      </label>
                    </div>
                    {canWrite && (
                      <div className="flex gap-2">
                        <button
                          type="button"
                          disabled={busy === r.id}
                          onClick={() => void save(r)}
                          className={buttonClass}
                        >
                          {gt("Save")}
                        </button>
                        <button
                          type="button"
                          disabled={busy === r.id}
                          onClick={() => void remove(r)}
                          className={`${buttonClass} text-danger`}
                        >
                          {gt("Turn off and remove")}
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
            {canWrite && (
              <div className="flex flex-wrap items-end gap-2">
                <label className="block flex-1 min-w-[16rem]">
                  <span className="block text-xs text-on-surface-tertiary mb-1">
                    {gt("Add a repository")}
                  </span>
                  <GithubRepoPicker
                    repos={repos === null ? null : addable}
                    value={adding}
                    onChange={setAdding}
                  />
                </label>
                <button
                  type="button"
                  disabled={!adding || busy === "add"}
                  onClick={() => void add()}
                  className={buttonClass}
                >
                  {gt("Turn on checks")}
                </button>
              </div>
            )}
          </section>

          {(status?.repositories ?? []).length > 0 && (
            <section className={cardClass}>
              <h2 className="text-sm font-semibold">{gt("Preview a pull request")}</h2>
              <p className="text-xs text-on-surface-muted">
                {gt("Runs the same analysis without posting anything to GitHub.")}
              </p>
              <div className="flex flex-wrap items-end gap-2">
                <select
                  value={previewRepoId}
                  aria-label={gt("Repository")}
                  onChange={(e) => setPreviewRepoId(e.target.value)}
                  className={`${inputClass} max-w-xs`}
                >
                  {(status?.repositories ?? []).map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.repo}
                    </option>
                  ))}
                </select>
                <input
                  type="number"
                  min={1}
                  value={previewNumber}
                  aria-label={gt("Pull request number")}
                  placeholder={gt("PR number")}
                  onChange={(e) => setPreviewNumber(e.target.value)}
                  className={`${inputClass} max-w-[8rem]`}
                />
                <button
                  type="button"
                  disabled={busy === "preview"}
                  onClick={() => void runPreview()}
                  className={buttonClass}
                >
                  {busy === "preview" ? gt("Analysing…") : gt("Preview")}
                </button>
              </div>
              {preview && <PreviewResult preview={preview} />}
            </section>
          )}

          <section className={cardClass}>
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">{gt("Recent checks")}</h2>
              <button type="button" onClick={loadRuns} className={buttonClass}>
                {gt("Refresh")}
              </button>
            </div>
            {runs.length === 0 ? (
              <p className="text-xs text-on-surface-muted">
                {gt("No checks have been posted yet.")}
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {runs.map((run) => (
                  <RunRow key={run.id} run={run} openExternal={openExternal} />
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function costLine(
  totals: PrCheckPreview["report"]["totals"],
  gt: ReturnType<typeof useGT>,
): string {
  if (totals.monthlyDelta === null || !totals.currency) return gt("cost not priced");
  const delta = formatMonthlyDelta(totals.monthlyDelta, totals.currency);
  return totals.partial && totals.monthlyDelta > 0
    ? gt("at least {delta}/month", { delta })
    : gt("{delta}/month", { delta });
}

function PreviewResult({ preview }: { preview: PrCheckPreview }) {
  const gt = useGT();
  const { report } = preview;
  const conclusion: Record<PrCheckPreview["conclusion"], string> = {
    success: gt("Success"),
    neutral: gt("Neutral"),
    failure: gt("Failure"),
  };
  return (
    <div className="space-y-2 text-sm">
      <p>
        <span className="font-medium">{conclusion[preview.conclusion]}</span>
        {" · "}
        {preview.title}
      </p>
      {report.changes.length > 0 && (
        <ul className="space-y-1 text-xs">
          {report.changes.map((c) => (
            <li key={`${c.path}:${c.address}`} className="flex flex-wrap gap-2">
              <code>{c.address}</code>
              <span className="text-on-surface-muted">
                {c.monthlyDelta !== null && c.currency
                  ? formatMonthlyDelta(c.monthlyDelta, c.currency)
                  : gt("not priced")}
              </span>
              {c.blastRadius && (
                <span className="text-on-surface-muted">{c.blastRadius.headline}</span>
              )}
              {c.warnings.map((w, i) => (
                <span key={i} className={w.severity === "warning" ? "text-warning" : ""}>
                  {w.message}
                </span>
              ))}
            </li>
          ))}
        </ul>
      )}
      {report.notes.length > 0 && (
        <ul className="list-disc pl-5 text-xs text-on-surface-muted">
          {report.notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RunRow({ run, openExternal }: { run: PrCheckRun; openExternal: (url: string) => void }) {
  const gt = useGT();
  const label =
    run.status === "running"
      ? gt("Running")
      : run.status === "failed"
        ? gt("Failed")
        : run.conclusion === "failure"
          ? gt("Over threshold (failed)")
          : run.conclusion === "neutral"
            ? gt("Over threshold (neutral)")
            : gt("Passed");
  const tone =
    run.status === "failed" || run.conclusion === "failure"
      ? "text-danger"
      : run.conclusion === "neutral"
        ? "text-warning"
        : "text-on-surface-muted";
  return (
    <li className="py-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
      <span className="font-medium text-on-surface">
        {run.repo}#{run.pullNumber}
      </span>
      {run.pullTitle && <span className="text-on-surface-secondary truncate">{run.pullTitle}</span>}
      <span className={`text-xs ${tone}`}>{label}</span>
      {run.report && (
        <span className="text-xs text-on-surface-muted">
          {run.report && costLine(run.report.totals, gt)}
        </span>
      )}
      {run.error && <span className="text-xs text-danger">{run.error}</span>}
      <span className="text-xs text-on-surface-faint">
        {new Date(run.createdAt).toLocaleString()}
      </span>
      {run.checkRunUrl && (
        <button
          type="button"
          onClick={() => openExternal(run.checkRunUrl!)}
          className="text-xs text-accent hover:underline"
        >
          {gt("Check")}
        </button>
      )}
      {run.pullUrl && (
        <button
          type="button"
          onClick={() => openExternal(run.pullUrl!)}
          className="text-xs text-accent hover:underline"
        >
          {gt("Pull request")}
        </button>
      )}
    </li>
  );
}
