import { useCallback, useEffect, useId, useState } from "react";

import { T, Var, useGT } from "gt-react";
import {
  CHANGE_IMPACT_CONFIDENCE_LABELS,
  costBasisLabel,
  formatSignedPerDay,
  type DeploymentCostImpact,
} from "@infrawrench/client-core";
import { useDataString } from "../i18n/data-strings.js";
import { ChangeCostImpactFootnote, ChangeCostImpactLine } from "../cost/ChangeCostImpactLine.js";
import {
  DEPLOY_STAGES,
  type DeployEnvs,
  type DeployRepo,
  type DeployRunResult,
  type DeployStage,
  type DeploymentClient,
  type DeploymentRunRow,
  type DeploySession,
  type DeployTrigger,
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
  const gt = useGT();
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

  const [triggers, setTriggers] = useState<DeployTrigger[]>([]);
  const [triggerError, setTriggerError] = useState<string | null>(null);
  const [triggerBusy, setTriggerBusy] = useState(false);
  /** `select(...)` keys a run has complained about, so the form can ask for them. */
  const [selectKeys, setSelectKeys] = useState<string[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});

  const refreshTriggers = useCallback(async () => {
    try {
      setTriggers(await client.listTriggers());
    } catch (e) {
      setTriggerError(messageOf(e));
    }
  }, [client]);

  /**
   * A non-interactive run fails naming the key it could not answer, and Plan
   * runs over HTTP are non-interactive — so planning is usually the first time
   * the UI can know which selects a trigger will have to pre-answer.
   */
  const noteSelectKeys = useCallback((message: string | undefined) => {
    const found = unansweredSelectKeys(message ?? "");
    if (found.length === 0) return;
    setSelectKeys((prev) => [...prev, ...found.filter((k) => !prev.includes(k))]);
  }, []);

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
            gt(
              "This organization's GitHub App cannot see {repo}. Connect it under Settings → GitHub, or pick another repository.",
              { repo: initialRepo ?? "" },
            ),
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
    void refreshTriggers();
  }, [client, initialRepo, refreshTriggers]);

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
      noteSelectKeys(r.error?.message);
      if (mode === "deploy") {
        void client
          .listRuns()
          .then(setRuns)
          .catch(() => {});
      }
    } catch (e) {
      const message = messageOf(e);
      setError(message);
      noteSelectKeys(message);
    } finally {
      setBusy(null);
      setStopFn(null);
    }
  };

  const addTrigger = async () => {
    if (!repo || !branch || !env) return;
    setTriggerBusy(true);
    setTriggerError(null);
    try {
      // Send only keys the user actually filled in: a blank answer is worse
      // than a missing one, since it would satisfy the lookup with an option
      // the Infrafile never offered.
      const filled = Object.fromEntries(
        selectKeys.map((k) => [k, answers[k] ?? ""]).filter(([, v]) => v !== ""),
      );
      await client.createTrigger({
        repo,
        branch,
        env,
        ...(Object.keys(filled).length > 0 ? { answers: filled } : {}),
      });
      await refreshTriggers();
    } catch (e) {
      setTriggerError(messageOf(e));
    } finally {
      setTriggerBusy(false);
    }
  };

  const toggleTrigger = async (id: string, enabled: boolean) => {
    setTriggerError(null);
    try {
      const updated = await client.updateTrigger(id, { enabled });
      setTriggers((prev) => prev.map((t) => (t.id === id ? updated : t)));
    } catch (e) {
      setTriggerError(messageOf(e));
    }
  };

  const removeTrigger = async (id: string) => {
    setTriggerError(null);
    try {
      await client.deleteTrigger(id);
      setTriggers((prev) => prev.filter((t) => t.id !== id));
    } catch (e) {
      setTriggerError(messageOf(e));
    }
  };

  const canRun = Boolean(repo && branch) && busy === null;

  return (
    <div className="flex flex-col h-full min-h-0 text-on-surface">
      <div className="p-4 border-b border-white/10 space-y-3">
        <h1 className="text-sm font-semibold">{gt("Deploy")}</h1>

        <div className="flex flex-wrap items-end gap-3">
          <Field label={gt("Repository")}>
            {(id) => (
              <select
                id={id}
                value={repo}
                onChange={(e) => chooseRepo(e.target.value)}
                className={inputClass}
                disabled={busy !== null}
              >
                <option value="">{gt("Choose a repository…")}</option>
                {repos.map((r) => (
                  <option key={r.fullName} value={r.fullName}>
                    {r.fullName}
                  </option>
                ))}
              </select>
            )}
          </Field>

          <Field label={gt("Branch")}>
            {(id) => (
              <input
                id={id}
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                onBlur={() => void loadEnvs()}
                placeholder="main"
                className={inputClass}
                disabled={!repo || busy !== null}
              />
            )}
          </Field>

          <Field label={gt("Environment")}>
            {(id) => (
              <select
                id={id}
                value={env}
                onChange={(e) => setEnv(e.target.value)}
                className={inputClass}
                disabled={!envInfo || busy !== null}
              >
                {!envInfo && <option value="">{gt("Load the Infrafile first…")}</option>}
                {envInfo?.envs.length === 0 && (
                  <option value="">{gt("No environments declared")}</option>
                )}
                {envInfo && envInfo.envs.length > 0 && (
                  <option value="">{gt("Choose an environment…")}</option>
                )}
                {envInfo?.envs.map((e) => (
                  <option key={e} value={e}>
                    {e}
                  </option>
                ))}
              </select>
            )}
          </Field>

          <button
            type="button"
            onClick={() => void loadEnvs()}
            disabled={!repo || !branch || busy !== null}
            className={ghostButton}
          >
            {gt("Load Infrafile")}
          </button>
          <button
            type="button"
            onClick={() => void run("plan")}
            disabled={!canRun}
            className={ghostButton}
          >
            {busy === "plan" ? gt("Planning…") : gt("Plan")}
          </button>
          <button
            type="button"
            onClick={() => void run("deploy")}
            disabled={!canRun}
            className="text-xs px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-40"
          >
            {busy === "deploy" ? gt("Deploying…") : gt("Deploy")}
          </button>
          {busy === "deploy" && stopFn && (
            <button type="button" onClick={stopFn} className={ghostButton}>
              {gt("Stop")}
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
          <p className="text-xs text-danger whitespace-pre-wrap" role="alert">
            {error}
          </p>
        )}
      </div>

      <div className="flex-1 overflow-auto min-h-0">
        {busy === "deploy" && <LogPanel logs={liveLogs} />}
        {result && <ResultPanel result={result} />}
        {/* Stays visible after a plan on purpose: a failed non-interactive
            plan is exactly where unanswered select() keys surface, and hiding
            the form at that moment would leave nowhere to type the answers
            the plan just asked for. */}
        {busy === null && (
          <TriggersSection
            triggers={triggers}
            repo={repo}
            branch={branch}
            env={env}
            selectKeys={selectKeys}
            answers={answers}
            busy={triggerBusy}
            error={triggerError}
            onAnswer={(key, value) => setAnswers((prev) => ({ ...prev, [key]: value }))}
            onAdd={() => void addTrigger()}
            onToggle={(id, enabled) => void toggleTrigger(id, enabled)}
            onDelete={(id) => void removeTrigger(id)}
          />
        )}
        {!result && busy === null && (
          <RunHistory
            runs={runs}
            client={client}
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

/**
 * A captioned control. The caption is a real `<label htmlFor>` rather than a
 * wrapper, so the control's accessible name survives however the child is
 * composed — hence the id passed down to the render prop.
 */
function Field({ label, children }: { label: string; children: (id: string) => React.ReactNode }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-[11px] uppercase tracking-wide text-on-surface-faint">
        {label}
      </label>
      {children(id)}
    </div>
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
              ? "text-success"
              : i === index
                ? "text-warning font-semibold"
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
          className={l.level === "error" ? "text-danger" : l.level === "warn" ? "text-warning" : ""}
        >
          {l.message}
        </div>
      ))}
    </div>
  );
}

function ResultPanel({ result }: { result: DeployRunResult }) {
  const gt = useGT();
  return (
    <div className="p-4 space-y-4 text-xs">
      <div className="flex items-center gap-3">
        <span
          className={
            result.status === "success" ? "text-success font-semibold" : "text-danger font-semibold"
          }
        >
          {result.status}
        </span>
        <span className="text-on-surface-faint">
          {result.env} · {Math.round(result.durationMs / 1000)}s
          {result.reachedStage
            ? ` · ${gt("stopped at {stage}", { stage: result.reachedStage })}`
            : ""}
        </span>
      </div>

      {result.error && (
        <pre className="whitespace-pre-wrap text-danger bg-surface-overlay rounded p-2">
          {result.error.message}
        </pre>
      )}
      {result.image && (
        <Section title={gt("Image")}>
          <code className="text-on-surface">{result.image}</code>
        </Section>
      )}
      {result.plan !== undefined && (
        <Section title={gt("Plan")}>
          <pre className="whitespace-pre-wrap font-mono">
            {JSON.stringify(result.plan, null, 2)}
          </pre>
        </Section>
      )}
      {result.dockerfile && (
        <Section title={gt("Dockerfile")}>
          <pre className="whitespace-pre-wrap font-mono">{result.dockerfile}</pre>
        </Section>
      )}
      {result.notes.length > 0 && (
        <Section title={gt("Notes")}>
          {result.notes.map((n, i) => (
            <div key={i}>{n}</div>
          ))}
        </Section>
      )}
      {result.logs.length > 0 && (
        <Section title={gt("Logs")}>
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

/**
 * Deploy-on-push triggers: "when this branch moves, ship this environment".
 *
 * The form deliberately has no repo/branch/env inputs of its own — it watches
 * whatever the header is pointed at, so you add a trigger for something you
 * have just planned or deployed rather than typing a repo name twice.
 */
function TriggersSection({
  triggers,
  repo,
  branch,
  env,
  selectKeys,
  answers,
  busy,
  error,
  onAnswer,
  onAdd,
  onToggle,
  onDelete,
}: {
  triggers: DeployTrigger[];
  repo: string;
  branch: string;
  env: string;
  /** `select(...)` keys a run has already reported as unanswered, if any. */
  selectKeys: string[];
  answers: Record<string, string>;
  busy: boolean;
  error: string | null;
  onAnswer: (key: string, value: string) => void;
  onAdd: () => void;
  onToggle: (id: string, enabled: boolean) => void;
  onDelete: (id: string) => void;
}) {
  const gt = useGT();
  const targeted = Boolean(repo && branch && env);
  const duplicate = triggers.some((t) => t.repo === repo && t.branch === branch && t.env === env);

  return (
    <div className="p-4 border-b border-white/10 space-y-3">
      <h2 className="text-[11px] uppercase tracking-wide text-on-surface-faint">
        {gt("Deploy on push")}
      </h2>

      {triggers.length === 0 ? (
        <p className="text-xs text-on-surface-faint">{gt("No branches are watched yet.")}</p>
      ) : (
        <table className="w-full text-xs">
          <thead className="text-[11px] uppercase tracking-wide text-on-surface-faint">
            <tr className="border-b border-white/10">
              <Th>{gt("Watching")}</Th>
              <Th>{gt("Deploys")}</Th>
              <Th>{gt("Last commit seen")}</Th>
              <Th>{gt("Last fired")}</Th>
              <Th>{gt("Enabled")}</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {triggers.map((t) => (
              <tr key={t.id} className="border-b border-white/5">
                <Td>
                  {t.repo} @ {t.branch}
                </Td>
                <Td>{t.env}</Td>
                <Td>{t.lastSha ? t.lastSha.slice(0, 7) : "—"}</Td>
                <Td>
                  {t.lastRunAt ? (
                    new Date(t.lastRunAt).toLocaleString()
                  ) : (
                    <span className="text-on-surface-faint">{gt("Waiting for the next push")}</span>
                  )}
                </Td>
                <Td>
                  <input
                    type="checkbox"
                    checked={t.enabled}
                    onChange={(e) => onToggle(t.id, e.target.checked)}
                    aria-label={gt("Deploy {env} when {repo} @ {branch} moves", {
                      env: t.env,
                      repo: t.repo,
                      branch: t.branch,
                    })}
                    className="accent-blue-500"
                  />
                </Td>
                <Td>
                  <button type="button" onClick={() => onDelete(t.id)} className={ghostButton}>
                    {gt("Delete")}
                  </button>
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="flex flex-wrap items-end gap-3">
        {selectKeys.map((key) => (
          <Field key={key} label={gt("Answer for {key}", { key })}>
            {(id) => (
              <input
                id={id}
                value={answers[key] ?? ""}
                onChange={(e) => onAnswer(key, e.target.value)}
                placeholder={gt("value")}
                className={inputClass}
                disabled={busy}
              />
            )}
          </Field>
        ))}
        <button
          type="button"
          onClick={onAdd}
          disabled={!targeted || duplicate || busy}
          className={ghostButton}
        >
          {busy ? gt("Adding…") : gt("Watch this branch")}
        </button>
        <p className="text-xs text-on-surface-faint">
          {duplicate
            ? gt("{repo} @ {branch} → {env} is already watched.", { repo, branch, env })
            : targeted
              ? gt("Deploy {env} whenever {repo} @ {branch} moves.", { env, repo, branch })
              : gt("Choose a repository, branch and environment above to watch one.")}
        </p>
      </div>

      {selectKeys.length > 0 && (
        <T>
          <p className="text-xs text-warning">
            A run reported no answer for{" "}
            <Var>{selectKeys.map((k) => `select("${k}")`).join(", ")}</Var>. Fill those in above — a
            triggered deploy cannot ask.
          </p>
        </T>
      )}

      <T>
        <p className="text-xs text-on-surface-faint">
          A triggered deploy runs unattended, so every <code>select(…)</code> the Infrafile reaches
          must be answered here; an unanswered key fails the run instead of prompting. Adding a
          trigger does not deploy the current commit — the watcher records where the branch is now
          and deploys on the <em>next</em> push to it.
        </p>
      </T>

      {error && (
        <p className="text-xs text-danger whitespace-pre-wrap" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function RunHistory({
  runs,
  client,
  onRollback,
}: {
  runs: DeploymentRunRow[];
  client: DeploymentClient;
  onRollback: (runId: string) => void | Promise<void>;
}) {
  const gt = useGT();
  // One run's breakdown at a time, fetched on demand: computing an impact is
  // two ClickHouse reads per run and a history page has fifty of them.
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const [impact, setImpact] = useState<DeploymentCostImpact | null>(null);
  const [impactState, setImpactState] = useState<"idle" | "loading" | "error">("idle");
  const showCosts = Boolean(client.costImpact);

  const toggleImpact = useCallback(
    async (runId: string) => {
      const fetchImpact = client.costImpact;
      if (!fetchImpact) return;
      if (openRunId === runId) {
        setOpenRunId(null);
        return;
      }
      setOpenRunId(runId);
      setImpact(null);
      setImpactState("loading");
      try {
        setImpact(await fetchImpact.call(client, runId));
        setImpactState("idle");
      } catch {
        setImpactState("error");
      }
    },
    [client, openRunId],
  );

  if (runs.length === 0) {
    return (
      <T>
        <p className="p-4 text-xs text-on-surface-faint">
          No deploys yet. Pick a repository above, or run <code>infrawrench deploy</code>.
        </p>
      </T>
    );
  }
  return (
    <table className="w-full text-xs">
      <caption className="sr-only">{gt("Deploy history")}</caption>
      <thead className="text-[11px] uppercase tracking-wide text-on-surface-faint">
        <tr className="border-b border-white/10">
          <Th>{gt("When")}</Th>
          <Th>{gt("Env")}</Th>
          <Th>{gt("Repo")}</Th>
          <Th>{gt("Commit")}</Th>
          <Th>{gt("Image")}</Th>
          <Th>{gt("Status")}</Th>
          <Th>{gt("From")}</Th>
          <Th />
        </tr>
      </thead>
      <tbody>
        {runs.flatMap((r) => [
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
                    ? "text-success"
                    : r.status === "failure"
                      ? "text-danger"
                      : "text-on-surface-secondary"
                }
              >
                {r.status}
              </span>
            </Td>
            <Td>{r.origin}</Td>
            <Td>
              <span className="flex gap-2">
                {showCosts && r.status === "success" && (
                  <button
                    type="button"
                    onClick={() => void toggleImpact(r.id)}
                    aria-expanded={openRunId === r.id}
                    className={ghostButton}
                    title={gt("What this deploy did to the run rate")}
                  >
                    {openRunId === r.id ? gt("Hide cost") : gt("Cost impact")}
                  </button>
                )}
                {/* Only a successful run has an artifact worth shipping again. */}
                {r.status === "success" && r.image && r.repo && r.gitSha && (
                  <button
                    type="button"
                    onClick={() => void onRollback(r.id)}
                    className={ghostButton}
                  >
                    {gt("Roll back")}
                  </button>
                )}
              </span>
            </Td>
          </tr>,
          openRunId === r.id ? (
            <tr key={`${r.id}-cost`} className="border-b border-white/5">
              <td colSpan={8} className="px-3 py-3 bg-surface-raised/40">
                <DeploymentCostImpactPanel
                  state={impactState}
                  impact={impact}
                  onAnnotate={
                    client.annotateCostImpact
                      ? () => client.annotateCostImpact!.call(client, r.id)
                      : undefined
                  }
                />
              </td>
            </tr>
          ) : null,
        ])}
      </tbody>
    </table>
  );
}

/**
 * A deploy's per-resource cost breakdown.
 *
 * The breakdown sums to the total by construction — unmeasurable resources are
 * counted separately rather than folded in as zero — and that is stated on
 * screen, because a total that silently omits rows is worse than no total.
 */
function DeploymentCostImpactPanel({
  state,
  impact,
  onAnnotate,
}: {
  state: "idle" | "loading" | "error";
  impact: DeploymentCostImpact | null;
  onAnnotate?: (() => Promise<void>) | undefined;
}) {
  const gt = useGT();
  const gtData = useDataString();
  const [annotating, setAnnotating] = useState(false);
  const [annotated, setAnnotated] = useState(false);
  const [annotateError, setAnnotateError] = useState<string | null>(null);

  if (state === "loading")
    return <p className="text-xs text-on-surface-faint">{gt("Measuring…")}</p>;
  if (state === "error") {
    return <p className="text-xs text-danger">{gt("Could not read cost for this run.")}</p>;
  }
  if (!impact) {
    return <p className="text-xs text-on-surface-faint">{gt("No cost data for this run.")}</p>;
  }
  if (impact.resources.length === 0) {
    return (
      <T>
        <p className="text-xs text-on-surface-faint">
          This deploy provisioned no resources, so there is nothing to attribute to it. Resources it
          merely updated are not linked to a run.
        </p>
      </T>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-xs text-on-surface-secondary font-medium">
          {impact.total.length === 0
            ? gt("No measurable cost impact")
            : impact.total.map((t) => formatSignedPerDay(t.deltaPerDay, t.currency)).join(", ")}
        </span>
        <span className="text-xs text-on-surface-faint">
          {gtData(costBasisLabel(impact.costBasis))},{" "}
          {gt("{days}d before/after", { days: impact.windowDays })} ·{" "}
          {gtData(CHANGE_IMPACT_CONFIDENCE_LABELS[impact.confidence].toLowerCase())}
          {impact.unknownResources > 0
            ? ` · ${gt("{count} resource{plural} could not be measured and are not in the total", {
                count: impact.unknownResources,
                plural: impact.unknownResources === 1 ? "" : "s",
              })}`
            : ""}
        </span>
        {onAnnotate && impact.total.length > 0 && (
          <button
            type="button"
            className={ghostButton}
            disabled={annotating}
            onClick={() => {
              setAnnotating(true);
              setAnnotateError(null);
              void onAnnotate()
                .then(() => setAnnotated(true))
                .catch((e: unknown) => setAnnotateError(e instanceof Error ? e.message : String(e)))
                .finally(() => setAnnotating(false));
            }}
          >
            {annotated
              ? gt("Annotated")
              : annotating
                ? gt("Annotating…")
                : gt("Annotate cost graph")}
          </button>
        )}
      </div>
      {annotateError && <p className="text-xs text-danger">{annotateError}</p>}
      <ul className="space-y-1">
        {impact.resources.map((r) => (
          <li key={r.resourceId} className="flex flex-wrap items-baseline gap-x-3">
            <span className="text-xs text-on-surface-secondary truncate max-w-[16rem]">
              {r.displayName}
            </span>
            <span className="text-[11px] text-on-surface-faint font-mono">
              {r.pluginId}/{r.resourceTypeId}
            </span>
            <ChangeCostImpactLine impact={r.impact} />
          </li>
        ))}
      </ul>
      <ChangeCostImpactFootnote />
    </div>
  );
}

function Th({ children }: { children?: React.ReactNode }) {
  return (
    <th scope="col" className="text-left font-normal px-3 py-1.5">
      {children}
    </th>
  );
}

function Td({ children }: { children: React.ReactNode }) {
  return <td className="px-3 py-1.5 align-top">{children}</td>;
}

/**
 * The keys named by a `select(…) has no answer` failure. Matching the message
 * is deliberate: the runtime only discovers a select by executing up to it, so
 * a failed run is the only place the set of keys is ever stated.
 */
function unansweredSelectKeys(message: string): string[] {
  const keys: string[] = [];
  const pattern = /select\("([^"]+)"[^)]*\)\s*has no answer/g;
  for (const match of message.matchAll(pattern)) {
    const key = match[1];
    if (key && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
