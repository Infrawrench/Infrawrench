import { useCallback, useEffect, useState } from "react";

import {
  DEPLOY_STAGES,
  type DeployEnvs,
  type DeployRepo,
  type DeployRunResult,
  type DeployStage,
  type DeploymentClient,
  type DeploymentRunRow,
  type DeploySession,
} from "./types.js";
import type { WorkflowRunLog } from "../workflows/types.js";

export interface DeploymentsPanelProps {
  client: DeploymentClient;
  /**
   * Preselect a repository, e.g. from a `/deploy/github.com/owner/name`
   * hotlink. Ignored when the org's GitHub App cannot see it — the picker then
   * stays empty rather than showing a repo no deploy could actually read.
   */
  initialRepo?: string;
}

/**
 * Deploy a repository's Infrafile, and read the history.
 *
 * The flow is deliberately plan-then-deploy: picking a repo and branch fetches
 * the environments the Infrafile declares, Plan shows what it decided and the
 * Dockerfile it rendered, and only then does Deploy build anything. That
 * ordering is the whole point of having a plan stage — you should be able to
 * see what a deploy will do before it does it.
 *
 * Prompts raised by `select(...)` are rendered by `PromptHost` at the app root,
 * not here.
 */
export function DeploymentsPanel({ client, initialRepo }: DeploymentsPanelProps) {
  const [repos, setRepos] = useState<DeployRepo[]>([]);
  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("");
  const [envInfo, setEnvInfo] = useState<DeployEnvs | null>(null);
  const [env, setEnv] = useState("");

  const [busy, setBusy] = useState<"plan" | "deploy" | null>(null);
  const [stage, setStage] = useState<DeployStage | null>(null);
  const [liveLogs, setLiveLogs] = useState<WorkflowRunLog[]>([]);
  const [result, setResult] = useState<DeployRunResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stopFn, setStopFn] = useState<(() => void) | null>(null);

  const [runs, setRuns] = useState<DeploymentRunRow[]>([]);

  useEffect(() => {
    void client
      .listRepos()
      .then((list) => {
        setRepos(list);
        // Match case-insensitively: a hotlink's casing comes from a URL bar.
        const wanted = initialRepo?.toLowerCase();
        const match = wanted && list.find((r) => r.fullName.toLowerCase() === wanted);
        if (match) {
          setRepo(match.fullName);
          setBranch(match.defaultBranch);
        } else if (wanted) {
          setError(
            `This organization's GitHub App cannot see ${initialRepo}. ` +
              `Connect it under Settings → GitHub, or pick another repository.`,
          );
        }
      })
      .catch((e: unknown) => setError(messageOf(e)));
    void client
      .listRuns()
      .then(setRuns)
      .catch(() => {
        // History is supplementary; a failure here must not block deploying.
      });
  }, [client, initialRepo]);

  /** Picking a repo seeds its default branch and clears anything downstream. */
  const chooseRepo = (fullName: string) => {
    setRepo(fullName);
    setEnvInfo(null);
    setEnv("");
    setResult(null);
    setError(null);
    setBranch(repos.find((r) => r.fullName === fullName)?.defaultBranch ?? "main");
  };

  const loadEnvs = useCallback(async () => {
    if (!repo || !branch) return;
    setError(null);
    setEnvInfo(null);
    setEnv("");
    try {
      const info = await client.listEnvs(repo, branch);
      setEnvInfo(info);
      // One environment needs no choosing — mirrors the CLI, where omitting
      // --env is fine for a single-environment project.
      if (info.envs.length === 1) setEnv(info.envs[0]!);
    } catch (e) {
      setError(messageOf(e));
    }
  }, [client, repo, branch]);

  const run = async (mode: "plan" | "deploy") => {
    if (!repo || !branch) return;
    setBusy(mode);
    setError(null);
    setResult(null);
    setLiveLogs([]);
    setStage(null);
    try {
      const opts = { repo, branch, ...(env ? { env } : {}) };
      const session: DeploySession = {
        onLog: (entry) => setLiveLogs((prev) => [...prev, entry]),
        onStage: setStage,
      };
      const { result: r } =
        mode === "plan"
          ? await client.plan({ ...opts, planOnly: true })
          : await (() => {
              const promise = client.deploy(opts, session);
              // The transport sets `stop` synchronously once the socket opens.
              if (session.stop) setStopFn(() => session.stop!);
              return promise;
            })();
      setResult(r);
      if (mode === "deploy") {
        void client
          .listRuns()
          .then(setRuns)
          .catch(() => {});
      }
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(null);
      setStopFn(null);
    }
  };

  const canRun = Boolean(repo && branch) && busy === null;

  return (
    <div className="flex flex-col h-full min-h-0 text-on-surface">
      <div className="p-4 border-b border-white/10 space-y-3">
        <h1 className="text-sm font-semibold">Deploy</h1>

        <div className="flex flex-wrap items-end gap-3">
          <Field label="Repository">
            <select
              value={repo}
              onChange={(e) => chooseRepo(e.target.value)}
              className={inputClass}
              disabled={busy !== null}
            >
              <option value="">Choose a repository…</option>
              {repos.map((r) => (
                <option key={r.fullName} value={r.fullName}>
                  {r.fullName}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Branch">
            <input
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              onBlur={() => void loadEnvs()}
              placeholder="main"
              className={inputClass}
              disabled={!repo || busy !== null}
            />
          </Field>

          <Field label="Environment">
            <select
              value={env}
              onChange={(e) => setEnv(e.target.value)}
              className={inputClass}
              disabled={!envInfo || busy !== null}
            >
              {!envInfo && <option value="">Load the Infrafile first…</option>}
              {envInfo?.envs.length === 0 && <option value="">No environments declared</option>}
              {envInfo && envInfo.envs.length > 0 && (
                <option value="">Choose an environment…</option>
              )}
              {envInfo?.envs.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </select>
          </Field>

          <button
            type="button"
            onClick={() => void loadEnvs()}
            disabled={!repo || !branch || busy !== null}
            className={ghostButton}
          >
            Load Infrafile
          </button>
          <button
            type="button"
            onClick={() => void run("plan")}
            disabled={!canRun}
            className={ghostButton}
          >
            {busy === "plan" ? "Planning…" : "Plan"}
          </button>
          <button
            type="button"
            onClick={() => void run("deploy")}
            disabled={!canRun}
            className="text-xs px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-40"
          >
            {busy === "deploy" ? "Deploying…" : "Deploy"}
          </button>
          {busy === "deploy" && stopFn && (
            <button type="button" onClick={stopFn} className={ghostButton}>
              Stop
            </button>
          )}
        </div>

        {envInfo && (
          <p className="text-xs text-on-surface-faint">
            {envInfo.repo} @ {envInfo.branch} · {envInfo.sha.slice(0, 7)}
          </p>
        )}
        {busy !== null && <StageIndicator current={stage} />}
        {error && (
          <p className="text-xs text-red-400 whitespace-pre-wrap" role="alert">
            {error}
          </p>
        )}
      </div>

      <div className="flex-1 overflow-auto min-h-0">
        {busy === "deploy" && <LogPanel logs={liveLogs} />}
        {result && <ResultPanel result={result} />}
        {!result && busy === null && (
          <RunHistory
            runs={runs}
            onRollback={async (runId) => {
              setBusy("deploy");
              setError(null);
              setResult(null);
              setLiveLogs([]);
              setStage(null);
              try {
                const { result: r } = await client.rollback(runId);
                setResult(r);
                setRuns(await client.listRuns());
              } catch (e) {
                setError(messageOf(e));
              } finally {
                setBusy(null);
              }
            }}
          />
        )}
      </div>
    </div>
  );
}

const inputClass =
  "bg-surface-overlay border border-border-strong rounded px-2 py-1.5 text-sm text-on-surface focus:outline-none focus:border-blue-500 disabled:opacity-40 min-w-[12rem]";

const ghostButton =
  "text-xs px-3 py-1.5 rounded bg-white/10 hover:bg-white/20 text-on-surface-secondary disabled:opacity-40";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] uppercase tracking-wide text-on-surface-faint">{label}</span>
      {children}
    </label>
  );
}

/** Where the run has got to. Stages always advance in a fixed order. */
function StageIndicator({ current }: { current: DeployStage | null }) {
  const index = current ? DEPLOY_STAGES.indexOf(current) : -1;
  return (
    <div className="flex items-center gap-2 text-[11px]">
      {DEPLOY_STAGES.map((s, i) => (
        <span
          key={s}
          className={
            i < index
              ? "text-green-400"
              : i === index
                ? "text-amber-400 font-semibold"
                : "text-on-surface-faint"
          }
        >
          {i > 0 && <span className="mr-2 text-on-surface-faint">→</span>}
          {s}
        </span>
      ))}
    </div>
  );
}

function LogPanel({ logs }: { logs: WorkflowRunLog[] }) {
  return (
    <div className="p-2 font-mono text-[11px] leading-relaxed">
      {logs.map((l, i) => (
        <div
          key={i}
          className={
            l.level === "error" ? "text-red-400" : l.level === "warn" ? "text-yellow-400" : ""
          }
        >
          {l.message}
        </div>
      ))}
    </div>
  );
}

function ResultPanel({ result }: { result: DeployRunResult }) {
  return (
    <div className="p-4 space-y-4 text-xs">
      <div className="flex items-center gap-3">
        <span
          className={
            result.status === "success"
              ? "text-green-400 font-semibold"
              : "text-red-400 font-semibold"
          }
        >
          {result.status}
        </span>
        <span className="text-on-surface-faint">
          {result.env} · {Math.round(result.durationMs / 1000)}s
          {result.reachedStage ? ` · stopped at ${result.reachedStage}` : ""}
        </span>
      </div>

      {result.error && (
        <pre className="whitespace-pre-wrap text-red-400 bg-surface-overlay rounded p-2">
          {result.error.message}
        </pre>
      )}
      {result.image && (
        <Section title="Image">
          <code className="text-on-surface">{result.image}</code>
        </Section>
      )}
      {result.plan !== undefined && (
        <Section title="Plan">
          <pre className="whitespace-pre-wrap font-mono">
            {JSON.stringify(result.plan, null, 2)}
          </pre>
        </Section>
      )}
      {result.dockerfile && (
        <Section title="Dockerfile">
          <pre className="whitespace-pre-wrap font-mono">{result.dockerfile}</pre>
        </Section>
      )}
      {result.notes.length > 0 && (
        <Section title="Notes">
          {result.notes.map((n, i) => (
            <div key={i}>{n}</div>
          ))}
        </Section>
      )}
      {result.logs.length > 0 && (
        <Section title="Logs">
          <LogPanel logs={result.logs} />
        </Section>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h2 className="text-[11px] uppercase tracking-wide text-on-surface-faint mb-1">{title}</h2>
      <div className="bg-surface-overlay rounded p-2 overflow-auto max-h-80">{children}</div>
    </div>
  );
}

function RunHistory({
  runs,
  onRollback,
}: {
  runs: DeploymentRunRow[];
  onRollback: (runId: string) => void | Promise<void>;
}) {
  if (runs.length === 0) {
    return (
      <p className="p-4 text-xs text-on-surface-faint">
        No deploys yet. Pick a repository above, or run <code>infrawrench deploy</code>.
      </p>
    );
  }
  return (
    <table className="w-full text-xs">
      <thead className="text-[11px] uppercase tracking-wide text-on-surface-faint">
        <tr className="border-b border-white/10">
          <Th>When</Th>
          <Th>Env</Th>
          <Th>Repo</Th>
          <Th>Commit</Th>
          <Th>Image</Th>
          <Th>Status</Th>
          <Th>From</Th>
          <Th />
        </tr>
      </thead>
      <tbody>
        {runs.map((r) => (
          <tr key={r.id} className="border-b border-white/5">
            <Td>{new Date(r.startedAt).toLocaleString()}</Td>
            <Td>{r.env || "—"}</Td>
            <Td>{r.repo ?? "—"}</Td>
            <Td>{r.gitSha ? r.gitSha.slice(0, 7) : "—"}</Td>
            <Td>{r.image ?? "—"}</Td>
            <Td>
              <span
                className={
                  r.status === "success"
                    ? "text-green-400"
                    : r.status === "failure"
                      ? "text-red-400"
                      : "text-on-surface-secondary"
                }
              >
                {r.status}
              </span>
            </Td>
            <Td>{r.origin}</Td>
            <Td>
              {/* Only a successful run has an artifact worth shipping again. */}
              {r.status === "success" && r.image && r.repo && r.gitSha && (
                <button type="button" onClick={() => void onRollback(r.id)} className={ghostButton}>
                  Roll back
                </button>
              )}
            </Td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Th({ children }: { children?: React.ReactNode }) {
  return <th className="text-left font-normal px-3 py-1.5">{children}</th>;
}

function Td({ children }: { children: React.ReactNode }) {
  return <td className="px-3 py-1.5 align-top">{children}</td>;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
