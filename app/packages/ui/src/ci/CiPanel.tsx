import { useCallback, useEffect, useMemo, useState } from "react";
import { useGT } from "gt-react";
import {
  CI_RUN_STATUSES,
  type CiAccount,
  type CiJobOutput,
  type CiRun,
  type CiRunDetail,
  type CiRunStatus,
  type CiStatus,
  type CiUsage,
} from "@infrawrench/client-core";
import type { CiClient } from "./types.js";
import { CiValuesCard } from "./CiValuesCard.js";
import { CiRunView, useCiLiveRun } from "./CiRunView.js";
import { formatDuration } from "./format.js";

export interface CiPanelProps {
  client: CiClient;
  /** The run shown in detail, remembered by the tab; `null` for the list. */
  selectedRunId: string | null;
  onSelectRun: (id: string | null) => void;
  /** `ci:write`: choose which GitHub accounts run CI. */
  canWrite: boolean;
  /** `ci:approve`: approve or reject forks' pull requests. */
  canApprove: boolean;
  /**
   * Open a link (GitHub, the App install page). Desktop passes its
   * `openExternal`; without it links open in a new tab.
   */
  onOpenUrl?: ((url: string) => void) | undefined;
}

type Gt = ReturnType<typeof useGT>;

const ACTIVE: readonly CiRunStatus[] = ["queued", "running"];

export function ciRunStatusLabel(status: CiRunStatus, gt: Gt): string {
  switch (status) {
    case "awaiting_approval":
      return gt("Awaiting approval");
    case "queued":
      return gt("Queued");
    case "running":
      return gt("Running");
    case "passed":
      return gt("Passed");
    case "failed":
      return gt("Failed");
    case "error":
      return gt("Error");
    case "rejected":
      return gt("Rejected");
  }
}

function statusClass(status: CiRunStatus | CiJobOutput["status"]): string {
  switch (status) {
    case "passed":
      return "bg-success/15 text-success";
    case "failed":
    case "error":
      return "bg-danger/15 text-danger";
    case "awaiting_approval":
      return "bg-warning/15 text-warning";
    case "running":
    case "queued":
      return "bg-accent-muted text-accent-on-muted";
    default:
      return "bg-surface-sunken text-on-surface-faint";
  }
}

function runDuration(run: CiRun): number | null {
  if (!run.startedAt) return null;
  const end = run.finishedAt ? Date.parse(run.finishedAt) : Date.now();
  return end - Date.parse(run.startedAt);
}

function ExternalLink({
  href,
  onOpenUrl,
  children,
}: {
  href: string;
  onOpenUrl?: ((url: string) => void) | undefined;
  children: React.ReactNode;
}) {
  if (onOpenUrl) {
    return (
      <button type="button" className="text-accent hover:underline" onClick={() => onOpenUrl(href)}>
        {children}
      </button>
    );
  }
  return (
    <a href={href} target="_blank" rel="noreferrer" className="text-accent hover:underline">
      {children}
    </a>
  );
}

function StatusBadge({ status }: { status: CiRunStatus }) {
  const gt = useGT();
  return (
    <span
      className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-medium ${statusClass(status)}`}
    >
      {ciRunStatusLabel(status, gt)}
    </span>
  );
}

function Notice({
  children,
  tone = "info",
}: {
  children: React.ReactNode;
  tone?: "info" | "warning";
}) {
  return (
    <div
      role="status"
      className={`rounded border px-3 py-2 text-xs ${
        tone === "warning"
          ? "border-warning/40 bg-warning/10 text-on-surface"
          : "border-border bg-surface-raised text-on-surface-muted"
      }`}
    >
      {children}
    </div>
  );
}

function AccountsCard({
  status,
  client,
  canWrite,
  onOpenUrl,
  onChanged,
}: {
  status: CiStatus;
  client: CiClient;
  canWrite: boolean;
  onOpenUrl?: ((url: string) => void) | undefined;
  onChanged: () => void;
}) {
  const gt = useGT();
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const toggle = async (account: CiAccount) => {
    setBusy(account.installationId);
    setError(null);
    try {
      await client.setAccount(account.installationId, !account.ciEnabled);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Could not change the account"));
    } finally {
      setBusy(null);
    }
  };

  const connect = async () => {
    setError(null);
    try {
      const url = await client.installUrl();
      if (!url) return;
      if (onOpenUrl) onOpenUrl(url);
      else window.open(url, "_blank", "noopener,noreferrer");
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Could not open GitHub"));
    }
  };

  return (
    <section
      className="rounded border border-border bg-surface-raised p-4 space-y-3"
      aria-labelledby="ci-accounts"
    >
      <div className="flex items-center justify-between gap-2">
        <div>
          <h3 id="ci-accounts" className="text-sm font-semibold text-on-surface">
            {gt("GitHub accounts")}
          </h3>
          <p className="text-xs text-on-surface-faint">
            {gt(
              "Pushes and pull requests to these accounts' repositories run their .infrawrench/ci pipelines.",
            )}
          </p>
        </div>
        {canWrite && status.githubConfigured ? (
          <button
            type="button"
            onClick={() => void connect()}
            className="rounded border border-border px-2.5 py-1 text-xs text-on-surface hover:bg-surface-sunken"
          >
            {gt("Connect a GitHub account")}
          </button>
        ) : null}
      </div>
      {!status.githubConfigured ? (
        <Notice tone="warning">{gt("The GitHub App is not configured on this server.")}</Notice>
      ) : status.accounts.length === 0 ? (
        <p className="text-xs text-on-surface-muted">
          {gt("No GitHub account is connected yet. Connect one to choose its repositories for CI.")}
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {status.accounts.map((account) => (
            <li
              key={account.installationId}
              className="flex items-center justify-between gap-3 py-2"
            >
              <span className="text-sm text-on-surface">{account.accountLogin}</span>
              <label className="flex items-center gap-2 text-xs text-on-surface-muted">
                <input
                  type="checkbox"
                  checked={account.ciEnabled}
                  disabled={!canWrite || busy === account.installationId}
                  onChange={() => void toggle(account)}
                />
                {gt("Run CI")}
              </label>
            </li>
          ))}
        </ul>
      )}
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function UsageCard({ usage }: { usage: CiUsage }) {
  const gt = useGT();
  const cells: Array<[string, string]> = [
    [gt("Runs"), String(usage.runs)],
    [gt("vCPU hours"), (usage.vcpuSeconds / 3600).toFixed(2)],
    [gt("Memory GiB-hours"), (usage.memoryGibSeconds / 3600).toFixed(2)],
    [gt("Cache GiB-hours"), usage.storageGibHours.toFixed(1)],
    [
      gt("Cache now"),
      usage.storageBytes === null ? "" : `${(usage.storageBytes / 1024 ** 3).toFixed(2)} GiB`,
    ],
  ];
  return (
    <section
      className="rounded border border-border bg-surface-raised p-4"
      aria-labelledby="ci-usage"
    >
      <h3 id="ci-usage" className="text-sm font-semibold text-on-surface">
        {gt("Usage in {month}", { month: usage.month })}
      </h3>
      <p className="text-xs text-on-surface-faint">
        {gt("Billed as compute and cache storage on your plan's invoice.")}
      </p>
      <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
        {cells.map(([label, value]) => (
          <div key={label}>
            <dt className="text-[11px] text-on-surface-faint">{label}</dt>
            <dd className="text-sm font-medium text-on-surface">{value || "-"}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function ApprovalButtons({
  run,
  client,
  onDecided,
}: {
  run: CiRun;
  client: CiClient;
  onDecided: () => void;
}) {
  const gt = useGT();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const decide = async (approve: boolean) => {
    setBusy(true);
    setError(null);
    try {
      if (approve) await client.approveRun(run.id);
      else await client.rejectRun(run.id);
      onDecided();
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Could not record the decision"));
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      {confirming ? (
        <>
          <span className="text-xs text-on-surface-muted">
            {gt("Run this fork's code on your runners, without secrets?")}
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={() => void decide(true)}
            className="rounded bg-accent px-2 py-0.5 text-xs text-on-accent disabled:opacity-50"
          >
            {gt("Approve and run")}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setConfirming(false)}
            className="rounded border border-border px-2 py-0.5 text-xs text-on-surface"
          >
            {gt("Cancel")}
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            disabled={busy}
            onClick={() => setConfirming(true)}
            className="rounded border border-border px-2 py-0.5 text-xs text-on-surface hover:bg-surface-sunken"
          >
            {gt("Approve")}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void decide(false)}
            className="rounded border border-border px-2 py-0.5 text-xs text-on-surface hover:bg-surface-sunken"
          >
            {gt("Reject")}
          </button>
        </>
      )}
      {error ? (
        <span role="alert" className="text-xs text-danger">
          {error}
        </span>
      ) : null}
    </div>
  );
}

function RunSource({ run }: { run: CiRun }) {
  const gt = useGT();
  if (run.pullNumber !== null) {
    return (
      <span>
        {gt("Pull request #{number} from {branch}", {
          number: String(run.pullNumber),
          branch: run.headRef,
        })}
        {run.fromFork ? (
          <span className="ml-1 rounded bg-warning/15 px-1 text-[10px] text-warning">
            {run.headRepoFullName
              ? gt("fork: {repo}", { repo: run.headRepoFullName })
              : gt("deleted fork")}
          </span>
        ) : null}
      </span>
    );
  }
  return <span>{run.headRef}</span>;
}

function RunDetailView({
  runId,
  client,
  canApprove,
  onOpenUrl,
  onBack,
}: {
  runId: string;
  client: CiClient;
  canApprove: boolean;
  onOpenUrl?: ((url: string) => void) | undefined;
  onBack: () => void;
}) {
  const gt = useGT();
  // A string, not `gt`, in the effect's deps: `gt` is not referentially
  // stable, and depending on it refetched on every render.
  const loadFailed = gt("Failed to load the run");
  const [detail, setDetail] = useState<CiRunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    client
      .getRun(runId)
      .then((d) => !cancelled && setDetail(d))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : loadFailed));
    return () => {
      cancelled = true;
    };
  }, [client, runId, nonce, loadFailed]);

  // A running run's jobs come from its live log; when the log ends the run
  // has finished, so load it again for its jobs' reports.
  const live = useCiLiveRun(client, runId, detail?.run.status === "running", () =>
    setNonce((n) => n + 1),
  );

  // Follow a run that has not finished.
  const status = detail?.run.status;
  useEffect(() => {
    if (!status || !ACTIVE.includes(status)) return;
    const timer = setInterval(() => setNonce((n) => n + 1), 5000);
    return () => clearInterval(timer);
  }, [status]);

  const run = detail?.run;
  return (
    <div className="space-y-4">
      <button type="button" onClick={onBack} className="text-xs text-accent hover:underline">
        {gt("All runs")}
      </button>
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : !run ? (
        <p role="status" className="text-xs text-on-surface-faint">
          {gt("Loading…")}
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <h3 className="text-sm font-semibold text-on-surface">{run.repoFullName}</h3>
            <StatusBadge status={run.status} />
            <span className="font-mono text-xs text-on-surface-muted">{run.sha.slice(0, 12)}</span>
            <ExternalLink href={run.githubUrl} onOpenUrl={onOpenUrl}>
              {gt("Open on GitHub")}
            </ExternalLink>
          </div>
          <p className="text-xs text-on-surface-muted">
            <RunSource run={run} />
            {run.statusReason ? <span className="ml-2">{run.statusReason}</span> : null}
          </p>
          {run.status === "awaiting_approval" ? (
            <Notice tone="warning">
              <p className="mb-2">
                {gt(
                  "This pull request comes from a fork. CI runs only once a maintainer approves this commit, and it runs without your secrets.",
                )}
              </p>
              {canApprove ? (
                <ApprovalButtons
                  run={run}
                  client={client}
                  onDecided={() => setNonce((n) => n + 1)}
                />
              ) : (
                <p>{gt("Someone with permission to approve CI runs can approve it.")}</p>
              )}
            </Notice>
          ) : null}
          {run.status === "running" ? (
            <CiRunView run={run} jobs={null} live={live.run} liveError={live.error} />
          ) : (detail.jobs ?? run.jobs) === null ? (
            <p className="text-xs text-on-surface-faint">
              {ACTIVE.includes(run.status)
                ? gt("Jobs show here when the run starts.")
                : gt("No jobs ran.")}
            </p>
          ) : (detail.jobs ?? run.jobs)!.length === 0 ? (
            <p className="text-xs text-on-surface-faint">{gt("No pipeline ran for this event.")}</p>
          ) : (
            <CiRunView run={run} jobs={detail.jobs ?? run.jobs} live={null} liveError={null} />
          )}
        </>
      )}
    </div>
  );
}

export function CiPanel({
  client,
  selectedRunId,
  onSelectRun,
  canWrite,
  canApprove,
  onOpenUrl,
}: CiPanelProps) {
  const gt = useGT();
  // A string, not `gt`, in the effect's deps: `gt` is not referentially
  // stable, and depending on it refetched on every render.
  const loadFailed = gt("Failed to load CI");
  const [status, setStatus] = useState<CiStatus | null>(null);
  const [runs, setRuns] = useState<CiRun[] | null>(null);
  const [usage, setUsage] = useState<CiUsage | null>(null);
  const [filter, setFilter] = useState<CiRunStatus | "">("");
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    client
      .status()
      .then(async (s) => {
        if (cancelled) return;
        setStatus(s);
        if (!s.enabled) return;
        const [r, u] = await Promise.all([client.listRuns(filter || undefined), client.usage()]);
        if (cancelled) return;
        setRuns(r);
        setUsage(u);
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : loadFailed));
    return () => {
      cancelled = true;
    };
  }, [client, filter, nonce, loadFailed]);

  // Keep the list current while the tab is open: new runs arrive from
  // webhooks at any time, so it polls even when nothing is running, faster
  // while something is. Not while a run's detail is open (it follows its own
  // run) or while the window is hidden.
  const anyActive = useMemo(() => (runs ?? []).some((r) => ACTIVE.includes(r.status)), [runs]);
  useEffect(() => {
    if (selectedRunId || status?.enabled !== true) return;
    const timer = setInterval(
      () => {
        if (typeof document === "undefined" || document.visibilityState === "visible") refresh();
      },
      anyActive ? 5_000 : 15_000,
    );
    return () => clearInterval(timer);
  }, [anyActive, selectedRunId, status?.enabled, refresh]);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-semibold text-on-surface">{gt("CI")}</h2>
        <p className="max-w-2xl text-xs text-on-surface-faint">
          {gt(
            "Pipelines in .infrawrench/ci run on every push and pull request, each job in its own WebAssembly sandbox. Pull requests from forks wait for a maintainer and never get secrets.",
          )}
        </p>
      </div>

      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}

      {status === null && !error ? (
        <p role="status" className="text-xs text-on-surface-faint">
          {gt("Loading…")}
        </p>
      ) : null}

      {status && !status.enabled ? (
        <Notice>
          {gt(
            "CI is not turned on for this organization yet. It is being rolled out to organizations one at a time.",
          )}
        </Notice>
      ) : null}

      {status?.enabled ? (
        <>
          {!status.configured ? (
            <Notice tone="warning">
              {gt("The CI runner pool is not configured on this server, so no run will start.")}
            </Notice>
          ) : null}
          {!status.planIncludesCi ? (
            <Notice tone="warning">
              {gt("CI needs a paid plan. Runs are recorded but not started until you upgrade.")}
            </Notice>
          ) : null}

          {selectedRunId ? (
            <RunDetailView
              runId={selectedRunId}
              client={client}
              canApprove={canApprove}
              onOpenUrl={onOpenUrl}
              onBack={() => {
                onSelectRun(null);
                refresh();
              }}
            />
          ) : (
            <>
              <AccountsCard
                status={status}
                client={client}
                canWrite={canWrite}
                onOpenUrl={onOpenUrl}
                onChanged={refresh}
              />
              {canWrite ? <CiValuesCard client={client} accounts={status.accounts} /> : null}
              {usage ? <UsageCard usage={usage} /> : null}

              <section className="space-y-2" aria-labelledby="ci-runs">
                <div className="flex items-center justify-between gap-2">
                  <h3 id="ci-runs" className="text-sm font-semibold text-on-surface">
                    {gt("Runs")}
                  </h3>
                  <label className="flex items-center gap-2 text-xs text-on-surface-muted">
                    {gt("Show")}
                    <select
                      value={filter}
                      onChange={(e) => setFilter(e.target.value as CiRunStatus | "")}
                      className="rounded border border-border bg-surface px-1.5 py-0.5 text-xs text-on-surface"
                    >
                      <option value="">{gt("All runs")}</option>
                      {CI_RUN_STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {ciRunStatusLabel(s, gt)}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                {runs === null ? null : runs.length === 0 ? (
                  <p className="text-xs text-on-surface-muted">
                    {gt("No runs yet. Push to a repository of an account that runs CI.")}
                  </p>
                ) : (
                  <table className="w-full text-xs">
                    <caption className="sr-only">{gt("CI runs")}</caption>
                    <thead>
                      <tr className="text-left text-on-surface-faint">
                        <th scope="col" className="py-1">
                          {gt("Repository")}
                        </th>
                        <th scope="col">{gt("Status")}</th>
                        <th scope="col">{gt("Source")}</th>
                        <th scope="col">{gt("Commit")}</th>
                        <th scope="col">{gt("Duration")}</th>
                        <th scope="col">
                          <span className="sr-only">{gt("Actions")}</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {runs.map((run) => (
                        <tr
                          key={run.id}
                          className="border-t border-border align-top hover:bg-surface-sunken"
                        >
                          <td className="py-1.5">
                            <button
                              type="button"
                              onClick={() => onSelectRun(run.id)}
                              className="text-left text-on-surface hover:underline"
                            >
                              {run.repoFullName}
                            </button>
                          </td>
                          <td className="py-1.5">
                            <StatusBadge status={run.status} />
                          </td>
                          <td className="py-1.5 text-on-surface-muted">
                            <RunSource run={run} />
                          </td>
                          <td className="py-1.5 font-mono text-on-surface-muted">
                            {run.sha.slice(0, 7)}
                          </td>
                          <td className="py-1.5 text-on-surface-muted">
                            {formatDuration(runDuration(run))}
                          </td>
                          <td className="py-1.5">
                            {run.status === "awaiting_approval" && canApprove ? (
                              <ApprovalButtons run={run} client={client} onDecided={refresh} />
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </section>
            </>
          )}
        </>
      ) : null}
    </div>
  );
}
